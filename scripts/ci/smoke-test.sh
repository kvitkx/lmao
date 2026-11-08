#!/usr/bin/env bash
# Start CI_IMAGE, wait for its HEALTHCHECK and verify it does not run as root.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_IMAGE

container=""

# shellcheck disable=SC2317,SC2329
remove_container() {
    [[ -n "$container" ]] || return 0

    if [[ "$1" != 0 ]]; then
        echo "=== Container health ==="
        docker inspect --format '{{json .State.Health}}' "$container" || true
        echo "=== Container logs ==="
        docker logs "$container" 2>&1 || true
    fi

    docker rm -f "$container" >/dev/null 2>&1 || true
}
on_exit remove_container

log "Starting $CI_IMAGE"
started=$SECONDS

container="$(
    docker run --detach \
        --health-interval=2s \
        --health-timeout=3s \
        --health-start-period=5s \
        --health-retries=30 \
        "$CI_IMAGE"
)"

health=starting

for i in {1..60}; do
    running="$(docker inspect --format '{{.State.Running}}' "$container")"
    [[ "$running" == true ]] || die "Container exited prematurely."

    health="$(
        docker inspect \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
            "$container"
    )"

    case "$health" in
        healthy) break ;;
        unhealthy|missing) die "Container health: $health" ;;
    esac

    echo "Waiting for application... ($i/60)"
    sleep 2
done

[[ "$health" == healthy ]] || die "Application failed to become healthy."
healthy_after=$((SECONDS - started))
log "Application is healthy after ${healthy_after}s."

user_id="$(docker exec "$container" id -u)"
[[ "$user_id" != 0 ]] || die "Container is running as root."
log "Container runs as UID $user_id."

for asset in css/app.css vendor/alpine.min.js fonts/inter-latin-300.woff2; do
    docker exec "$container" python -c 'import sys, urllib.request as u; b = u.urlopen("http://localhost:5000/static/" + sys.argv[1]).read(); assert len(b) > 1000, "empty"' "$asset" \
        || die "The static file /static/$asset is not served."
    log "Served: /static/$asset"
done

size_bytes="$(docker image inspect --format '{{.Size}}' "$CI_IMAGE")"

{
    echo "### Smoke test"
    echo
    echo "| Image | Healthy after | UID | Size |"
    echo "|---|---|---|---|"
    printf '| %s | %ss | %s | %s MiB |\n' \
        "$CI_IMAGE" "$healthy_after" "$user_id" "$((size_bytes / 1024 / 1024))"
    echo
} | report_details