#!/usr/bin/env bash
# Scan an image with Trivy. Fails on fixable HIGH/CRITICAL vulnerabilities
# that a change in this repository can remove.
# The image is SCAN_IMAGE, or CI_IMAGE when SCAN_IMAGE is not set.
# SARIF_FILE (optional): also write a SARIF report there. Writing it never fails.
#
# Trivy reports a vulnerability as soon as the distribution publishes the fix,
# but the official base image is rebuilt days later, and until then nothing in
# this repository can remove the finding. So the newest base image (the tag of
# `FROM ... AS base` in the Dockerfile, pulled fresh) is scanned too, with the
# same options, and every finding of the image is sorted:
#   to fix   the newest base image does not have it: rebuild the image or bump
#            the base image or a dependency. Fails the scan.
#   waiting  the newest base image has it too: only a base image rebuild fixes
#            it. A warning and a report section; it fails the scan only when the
#            base image is older than BASE_MAX_AGE_DAYS, because a base image
#            that stays behind for that long is a real problem again.
#
# Each image is scanned once, to JSON. The log table, SARIF, the report details
# and the pass/fail decision are derived from that JSON offline (trivy convert).
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env TRIVY_IMAGE TRIVY_CACHE_DIR BASE_MAX_AGE_DAYS

image="${SCAN_IMAGE:-${CI_IMAGE:-}}"
[[ -n "$image" ]] || die "SCAN_IMAGE or CI_IMAGE is not set. Run this through make."

# The Dockerfile pins the base image by digest (what Dependabot bumps). The
# tag without the digest is what the registry rebuilds.
base_ref="$(
    sed -nE 's/^FROM[[:space:]]+([^@[:space:]]+)@[^[:space:]]+[[:space:]]+AS[[:space:]]+base[[:space:]]*$/\1/p' \
        Dockerfile | head -n1
)"
[[ -n "$base_ref" ]] || die "Cannot parse the base image (FROM ... AS base) from the Dockerfile."

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

# scan_image TAR REPORT: scans /scan/TAR and writes /report/REPORT (JSON).
# One set of options for both images, so findings are compared like with like.
scan_image() {
    trivy_scan image \
        --cache-dir /cache \
        --input "/scan/$1" \
        --severity CRITICAL,HIGH \
        --ignore-unfixed \
        --pkg-types os,library \
        --scanners vuln \
        --timeout 10m \
        --format json \
        --output "/report/$2" \
        --exit-code 0
}

# trivy_convert REPORT OPTIONS...: re-renders /report/REPORT. No network needed.
trivy_convert() {
    local report="$1"
    shift
    docker run "${trivy_docker_args[@]}" \
        --network none \
        "$TRIVY_IMAGE" \
        convert "$@" "/report/$report"
}

# One tab-separated row per finding:
# id, package, installed version, fixed version, severity, target.
# Single quotes on purpose: $target is a Go template variable, not a shell one.
# shellcheck disable=SC2016
rows_template='{{ range . }}{{ $target := .Target }}{{ range .Vulnerabilities }}{{ .VulnerabilityID }}{{ "\t" }}{{ .PkgName }}{{ "\t" }}{{ .InstalledVersion }}{{ "\t" }}{{ .FixedVersion }}{{ "\t" }}{{ .Severity }}{{ "\t" }}{{ $target }}{{ "\n" }}{{ end }}{{ end }}'

# findings REPORT OUTPUT: writes the sorted rows of REPORT to OUTPUT.
findings() {
    local rows
    rows="$(trivy_convert "$1" --format template --template "$rows_template")"

    if [[ -z "$rows" ]]; then
        : > "$2"
        return 0
    fi
    awk -F'\t' 'NF != 6 { exit 1 }' <<<"$rows" \
        || die "Unexpected Trivy template output: $rows"
    LC_ALL=C sort -u <<<"$rows" > "$2"
}

count_rows() {
    local lines
    lines="$(wc -l < "$1")"
    echo "$((lines))"
}

markdown_table() {
    echo "| ID | Package | Installed | Fixed | Severity | Target |"
    echo "|---|---|---|---|---|---|"
    awk -F'\t' '{ printf "| %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6 }' "$1"
}

# Docker's image date (2026-11-04T05:12:33.123456789Z) as epoch seconds.
# GNU date first, BSD date (macOS) as the fallback.
epoch_of() {
    local stamp="${1%%.*}"
    stamp="${stamp%Z}"
    date -u -d "${stamp}Z" +%s 2>/dev/null \
        || date -u -j -f '%Y-%m-%dT%H:%M:%S' "$stamp" +%s 2>/dev/null \
        || die "Cannot read the date of the base image: $1"
}

# --- the image --------------------------------------------------------------

log "Exporting $image"
docker image save --output "$temporary_dir/image/image.tar" "$image"

log "Scanning $image with Trivy"
scan_image image.tar trivy.json

# Only the detailed table: the summary table needs scanner info that
# `convert` does not have, and the report already has a summary.
trivy_convert trivy.json --format table --table-mode detailed

if [[ -n "${SARIF_FILE:-}" ]]; then
    log "Writing SARIF report: $SARIF_FILE"
    trivy_convert trivy.json --format sarif --output "/out/$(basename "$SARIF_FILE")"
fi

image_rows="$temporary_dir/report/image.tsv"
findings trivy.json "$image_rows"

# --- the newest base image --------------------------------------------------

base_rows="$temporary_dir/report/base.tsv"
: > "$base_rows"
base_created=""

log "Pulling the newest $base_ref"
if docker pull --quiet "$base_ref" >/dev/null; then
    docker image save --output "$temporary_dir/image/base.tar" "$base_ref"
    log "Scanning $base_ref with Trivy"
    scan_image base.tar base.json
    findings base.json "$base_rows"
    base_created="$(docker image inspect --format '{{.Created}}' "$base_ref")"
else
    warn "Cannot pull $base_ref: every finding counts as one to fix."
fi

# --- sort the findings ------------------------------------------------------

to_fix_rows="$temporary_dir/report/to-fix.tsv"
waiting_rows="$temporary_dir/report/waiting.tsv"
: > "$to_fix_rows"
: > "$waiting_rows"

# The key is (id, package). FILENAME, not NR == FNR: the base file can be empty.
awk -F'\t' -v to_fix="$to_fix_rows" -v waiting="$waiting_rows" '
    FILENAME == ARGV[1] { known[$1 FS $2] = 1; next }
    { print > (($1 FS $2) in known ? waiting : to_fix) }
' "$base_rows" "$image_rows"

to_fix="$(count_rows "$to_fix_rows")"
waiting="$(count_rows "$waiting_rows")"

stale=0
base_age_days=0
if ((waiting > 0)); then
    base_epoch="$(epoch_of "$base_created")"
    base_age_days=$((($(date -u +%s) - base_epoch) / 86400))
    if ((base_age_days > BASE_MAX_AGE_DAYS)); then
        stale=1
    fi
fi

{
    printf '### Trivy: %s\n\n' "$image"
    if ((to_fix + waiting == 0)); then
        echo "No fixable HIGH or CRITICAL vulnerabilities."
    fi
    if ((to_fix > 0)); then
        printf '**%s fixable HIGH/CRITICAL vulnerabilities that the newest %s does not have.** Rebuild the image or bump the base image or a dependency.\n\n' \
            "$to_fix" "$base_ref"
        markdown_table "$to_fix_rows"
        echo
    fi
    if ((waiting > 0)); then
        printf '**%s fixable HIGH/CRITICAL vulnerabilities wait for a base image rebuild.** The newest %s has them too and is %s days old (limit: %s days).' \
            "$waiting" "$base_ref" "$base_age_days" "$BASE_MAX_AGE_DAYS"
        if ((stale)); then
            printf ' **The limit is exceeded, so they fail the scan.**'
        fi
        printf '\n\n'
        markdown_table "$waiting_rows"
        echo
    fi
} | report_details

if ((waiting > 0 && !stale)); then
    warn "$waiting fixable vulnerabilities wait for a rebuild of $base_ref (${base_age_days} days old, limit $BASE_MAX_AGE_DAYS)."
fi

((to_fix == 0)) \
    || die "$to_fix fixable HIGH/CRITICAL vulnerabilities in $image that the newest $base_ref does not have."
((!stale)) \
    || die "$waiting fixable HIGH/CRITICAL vulnerabilities in $image, and $base_ref is $base_age_days days old (limit $BASE_MAX_AGE_DAYS): the base image is not being rebuilt."

log "No fixable HIGH/CRITICAL vulnerabilities to fix in $image."