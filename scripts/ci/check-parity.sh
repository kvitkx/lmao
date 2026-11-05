#!/usr/bin/env bash
# Check that every workflow runs exactly the make targets ci.mk declares for it:
#   ci.yml -> CI_JOBS, security.yml -> SECURITY_JOBS, release.yml -> RELEASE_JOBS.
# Workflows call make only as a single-line `run: make report-TARGET`,
# so `make ci` and `make security` run the same checks as GitHub.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_JOBS SECURITY_JOBS RELEASE_JOBS

# Words from stdin, sorted and unique, on one line.
normalize() {
    tr -s '[:space:]' '\n' | sed '/^$/d' | sort -u | paste -sd ' ' -
}

check_workflow() {
    local workflow="$1"
    local expected="$2"
    local stray actual

    [[ -f "$workflow" ]] || die "$workflow not found."

    stray="$(
        grep -nE '^[[:space:]]*run:[[:space:]]*make([[:space:]]|$)' "$workflow" \
            | grep -vE 'run:[[:space:]]*make report-[a-z0-9-]+[[:space:]]*$' \
            || true
    )"
    [[ -z "$stray" ]] \
        || die "$workflow: call make as 'run: make report-TARGET'. Found: $stray"

    actual="$(
        sed -nE 's/^[[:space:]]*run:[[:space:]]*make report-([a-z0-9-]+)[[:space:]]*$/\1/p' "$workflow" \
            | normalize
    )"
    expected="$(normalize <<<"$expected")"

    [[ "$actual" == "$expected" ]] \
        || die "$workflow runs [$actual], but ci.mk declares [$expected]."

    log "$workflow: $actual"
}

check_workflow .github/workflows/ci.yml "$CI_JOBS"
check_workflow .github/workflows/security.yml "$SECURITY_JOBS"
check_workflow .github/workflows/release.yml "$RELEASE_JOBS"