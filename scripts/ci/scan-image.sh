#!/usr/bin/env bash
# Scan an image with Trivy. Fails on fixable HIGH/CRITICAL vulnerabilities.
# The image is SCAN_IMAGE, or CI_IMAGE when SCAN_IMAGE is not set.
# SARIF_FILE (optional): also write a SARIF report there. Writing it never fails.
#
# The image is scanned once, to JSON. The log table, SARIF, the report details
# and the pass/fail decision are derived from that JSON offline (trivy convert).
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env TRIVY_IMAGE TRIVY_CACHE_DIR

image="${SCAN_IMAGE:-${CI_IMAGE:-}}"
[[ -n "$image" ]] || die "SCAN_IMAGE or CI_IMAGE is not set. Run this through make."

report_label "trivy ($image)"

temporary_dir="$(mktemp -d)"

# shellcheck disable=SC2317,SC2329
remove_temporary_dir() {
    rm -rf -- "$temporary_dir"
}
on_exit remove_temporary_dir

mkdir -p "$TRIVY_CACHE_DIR" "$temporary_dir/image" "$temporary_dir/report"

# Writable directory mounted at /out for the optional SARIF report.
if [[ -n "${SARIF_FILE:-}" ]]; then
    mkdir -p "$(dirname "$SARIF_FILE")"
    out_dir="$(cd "$(dirname "$SARIF_FILE")" && pwd)"
else
    out_dir="$temporary_dir/out"
    mkdir -p "$out_dir"
fi

trivy_docker_args=(
    --rm
    --user "$(id -u):$(id -g)"
    --env HOME=/tmp
    --volume "$temporary_dir/image:/scan:ro"
    --volume "$temporary_dir/report:/report"
    --volume "$out_dir:/out"
    --volume "$REPO_ROOT:/repo:ro"
    --workdir /repo
    --entrypoint trivy
)

# The only step that needs the network (vulnerability DB updates).
trivy_scan() {
    docker run "${trivy_docker_args[@]}" \
        --volume "$TRIVY_CACHE_DIR:/cache" \
        "$TRIVY_IMAGE" \
        "$@"
}

# Re-renders the JSON report. No network needed.
trivy_convert() {
    docker run "${trivy_docker_args[@]}" \
        --network none \
        "$TRIVY_IMAGE" \
        convert "$@" /report/trivy.json
}

log "Exporting $image"
docker image save --output "$temporary_dir/image/image.tar" "$image"

log "Scanning $image with Trivy"
trivy_scan image \
    --cache-dir /cache \
    --input /scan/image.tar \
    --severity CRITICAL,HIGH \
    --ignore-unfixed \
    --pkg-types os,library \
    --scanners vuln \
    --timeout 10m \
    --format json \
    --output /report/trivy.json \
    --exit-code 0

# Only the detailed table: the summary table needs scanner info that
# `convert` does not have, and the report already has a summary.
trivy_convert --format table --table-mode detailed

if [[ -n "${SARIF_FILE:-}" ]]; then
    log "Writing SARIF report: $SARIF_FILE"
    trivy_convert --format sarif --output "/out/$(basename "$SARIF_FILE")"
fi

# One number per result (target); the JSON already holds only fixable HIGH/CRITICAL.
counts="$(trivy_convert --format template --template '{{ range . }}{{ len .Vulnerabilities }} {{ end }}')"
found=0
for count in $counts; do
    [[ "$count" =~ ^[0-9]+$ ]] || die "Unexpected Trivy template output: $counts"
    found=$((found + count))
done

{
    printf '### Trivy: %s\n\n' "$image"
    if [[ "$found" == 0 ]]; then
        echo "No fixable HIGH or CRITICAL vulnerabilities."
    else
        trivy_convert \
            --format template \
            --template "@/repo/scripts/ci/trivy-summary.tpl" \
            --output /report/trivy.md
        printf '**%s fixable HIGH/CRITICAL vulnerabilities.**\n\n' "$found"
        cat "$temporary_dir/report/trivy.md"
    fi
    echo
} | report_details

[[ "$found" == 0 ]] || die "$found fixable HIGH/CRITICAL vulnerabilities in $image."
log "No fixable HIGH/CRITICAL vulnerabilities in $image."