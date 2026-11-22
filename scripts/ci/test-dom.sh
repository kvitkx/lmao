#!/usr/bin/env bash
# Browser smoke test: start CI_IMAGE and drive its page with Chromium
# (Playwright, tests/dom/). Every /api call is mocked, so no Ollama is needed.
# The browser lives in its own image (the dom-test stage of the Dockerfile) and
# shares the network of the app container.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_IMAGE

test_image="lmao:dom-test"
container=""
temporary_dir="$(mktemp -d)"

# shellcheck disable=SC2317,SC2329
remove_container() {
    if [[ -n "$container" ]]; then
        if [[ "$1" != 0 ]]; then
            echo "=== App logs ==="
            docker logs "$container" 2>&1 || true
        fi
        docker rm -f "$container" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$temporary_dir"
}
on_exit remove_container

cache_args=()

if in_ci; then
    cache_args=(
        --cache-from "type=gha,version=2,scope=lmao-dom-test"
        --cache-to "type=gha,version=2,scope=lmao-dom-test,mode=max,ignore-error=true"
    )
fi

log "Building the browser test image"
docker buildx build \
    ${cache_args[@]+"${cache_args[@]}"} \
    --target dom-test \
    --tag "$test_image" \
    --pull \
    --load \
    --provenance=false \
    --sbom=false \
    .

log "Starting $CI_IMAGE"
container="$(
    docker run --detach \
        --health-interval=2s \
        --health-timeout=3s \
        --health-start-period=5s \
        --health-retries=30 \
        "$CI_IMAGE"
)"

health=starting

for _ in {1..60}; do
    running="$(docker inspect --format '{{.State.Running}}' "$container")"
    [[ "$running" == true ]] || die "Container exited prematurely."

    health="$(
        docker inspect \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
            "$container"
    )"
    [[ "$health" != healthy ]] || break
    [[ "$health" != unhealthy && "$health" != missing ]] || die "Container health: $health"
    sleep 2
done

[[ "$health" == healthy ]] || die "Application failed to become healthy."

log "Running the browser tests"
status=0
docker run --rm --init --ipc=host \
    --network "container:$container" \
    --env BASE_URL=http://localhost:5000 \
    "$test_image" \
    | tee "$temporary_dir/playwright.log" || status=$?

# The last lines of the list reporter: "  4 passed (6.1s)".
summary="$(
    grep -E '^[[:space:]]+[0-9]+ (passed|failed|flaky|skipped)' "$temporary_dir/playwright.log" \
        | sed -E 's/^[[:space:]]+//' \
        | paste -sd ',' - \
        | sed 's/,/, /g' \
        || true
)"

{
    echo "### Browser smoke test"
    echo
    printf '**%s**\n\n' "${summary:-playwright did not report a result}"
} | report_details

exit "$status"
