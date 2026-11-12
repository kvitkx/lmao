#!/usr/bin/env bash
# Type-check the front end and its tests (tsc --noEmit, the typecheck stage of the Dockerfile).
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

cache_args=()

if in_ci; then
    cache_args=(
        --cache-from "type=gha,version=2,scope=lmao-typecheck"
        --cache-to "type=gha,version=2,scope=lmao-typecheck,mode=max,ignore-error=true"
    )
fi

log "tsc --noEmit"
docker buildx build \
    ${cache_args[@]+"${cache_args[@]}"} \
    --target typecheck \
    --progress=plain \
    --output type=cacheonly \
    .