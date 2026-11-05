#!/usr/bin/env bash
# Apply Ruff fixes and formatting to the working tree using the dev service.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# The script is expanded by sh inside the container, not here.
# shellcheck disable=SC2016
dev_run app sh -c '
    status=0
    ruff check --fix --no-cache . || status=1
    ruff format --no-cache . || status=1
    exit "$status"
'

log "Formatted. Review git diff before committing."