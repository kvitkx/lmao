#!/usr/bin/env bash
# Check that package.json (@playwright/test) and the Dockerfile (the browsers of
# the dom-test stage) use the same Playwright version. Never changes source.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

image="$(sed -nE 's/^FROM[[:space:]]+mcr\.microsoft\.com\/playwright:v([0-9]+\.[0-9]+\.[0-9]+)-[a-z]+@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+dom-test[[:space:]]*$/\1/p' Dockerfile | head -n1)"
[[ -n "$image" ]] || die "Cannot parse the Playwright image (FROM mcr.microsoft.com/playwright:vX.Y.Z-... AS dom-test) from the Dockerfile."

package="$(sed -nE 's/^[[:space:]]*"@playwright\/test":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n1)"
[[ -n "$package" ]] || die "Cannot find @playwright/test in package.json."

[[ "$package" == "$image" ]] \
    || die "package.json has @playwright/test $package, but the Dockerfile image is Playwright $image. Bump both together."

log "Playwright $image: package.json and the Dockerfile agree."
