#!/usr/bin/env bash
# Audit GitHub workflows with zizmor (online) and write a SARIF report.
# Findings do not fail the script: they go to Code scanning.
# Needs a GitHub token (GH_TOKEN or `gh auth login`). SARIF_FILE is the output path.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env ZIZMOR_IMAGE SARIF_FILE
require_gh_token

mkdir -p "$(dirname "$SARIF_FILE")"

log "zizmor (online, SARIF: $SARIF_FILE)"
docker_tool \
    --env GH_TOKEN \
    --entrypoint zizmor \
    "$ZIZMOR_IMAGE" \
    --format=sarif \
    --no-exit-codes \
    . > "$SARIF_FILE"