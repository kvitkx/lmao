#!/usr/bin/env bash
# Quick Python and JavaScript tests for the loop while you work.
# Extra arguments go to pytest: make test ARGS="-k export -x".
# Both suites always run; the exit status is non-zero if either failed.
# CI runs scripts/ci/test-py.sh (coverage, no network) and test-js.sh instead.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

status=0

log "pytest"
dev_run \
    --env PYTHON_DOTENV_DISABLED=1 \
    app pytest -p no:cacheprovider "$@" || status=1

scripts/ci/test-js.sh || status=1

exit "$status"