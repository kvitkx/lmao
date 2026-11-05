#!/usr/bin/env bash
# Audit locked production dependencies with pip-audit.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_DEV_IMAGE

output="$(mktemp)"

# shellcheck disable=SC2317,SC2329
remove_output() {
    rm -f -- "$output"
}
on_exit remove_output

status=0
docker run --rm \
    --env XDG_CACHE_HOME=/tmp/.cache \
    --workdir /app \
    "$CI_DEV_IMAGE" \
    sh -ec '
        uv export \
            --quiet \
            --locked \
            --no-dev \
            --no-emit-project \
            --format requirements-txt \
            --output-file /tmp/requirements-audit.txt
        pip-audit \
            --require-hashes \
            --progress-spinner off \
            --format markdown \
            -r /tmp/requirements-audit.txt
    ' | tee "$output" || status=$?

{
    echo "### Dependency audit"
    echo
    if [[ -s "$output" ]]; then
        cat "$output"
    elif [[ "$status" == 0 ]]; then
        echo "No known vulnerabilities found."
    else
        echo "pip-audit failed (exit $status). See the job log."
    fi
    echo
} | report_details

exit "$status"