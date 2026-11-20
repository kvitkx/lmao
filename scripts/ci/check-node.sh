#!/usr/bin/env bash
# Check that the Dockerfile (build) and docker/tools.Dockerfile (CI tools) use the same Node image. Never changes source.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env NODE_IMAGE

build="$(sed -nE 's/^FROM[[:space:]]+(node:[^[:space:]]+)[[:space:]]+AS[[:space:]]+css-deps[[:space:]]*$/\1/p' Dockerfile | head -n1)"
[[ -n "$build" ]] || die "Cannot parse the Node image (FROM node:... AS css-deps) from the Dockerfile."

[[ "$build" == "$NODE_IMAGE" ]] \
    || die "The Dockerfile uses $build, but docker/tools.Dockerfile uses $NODE_IMAGE. Bump both together."

log "Node image: Dockerfile and docker/tools.Dockerfile agree."
