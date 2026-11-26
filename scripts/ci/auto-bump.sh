#!/usr/bin/env bash
# Open the patch release PR when main carries only shippable commits.
#
# Runs weekly (auto-bump.yml) and by hand (workflow_dispatch). Every commit
# since the newest tag must be `fix`, `ci`, `docs` or `chore(deps)`. `feat`,
# a `!` suffix and every other type keep the release a human decision. The
# script skips with a logged reason (green run, no pull request) when:
#   - the last release.yml run on main is not a success: the tag is immutable,
#     so a broken release needs a human, not another bump;
#   - an issue labelled `maintenance` is open: an alert outranks a release;
#   - a bump pull request is already open;
#   - nothing is unreleased.
#
# The pull request is created with MAINTENANCE_TOKEN: created with
# GITHUB_TOKEN it would never run its required checks, because events from
# GITHUB_TOKEN start no workflows. This script fails (red run) when that
# token is not in effect. Merging the PR stays manual: it is the release
# button. See docs/MAINTENANCE.md.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env GH_TOKEN GITHUB_REPOSITORY

skip() {
    log "Auto bump skipped: $*."
    exit 0
}

# A PR created with GITHUB_TOKEN never runs its required checks.
actor="$(gh api user --jq .login)"
[[ "$actor" != "github-actions[bot]" ]] \
    || die "MAINTENANCE_TOKEN is not in effect (actor: $actor). Set the secret (docs/MAINTENANCE.md): a PR created with GITHUB_TOKEN would hang on its required checks."

# Never stack a bump on a broken or still-running release.
last="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow release.yml --branch main \
    --limit 1 --json status,conclusion --jq '.[0] | "\(.status)/\(.conclusion)"')"
[[ "$last" == "completed/success" ]] || skip "the last Release run on main is ${last:-absent}"

# An alert outranks a release.
open_issues="$(gh issue list --repo "$GITHUB_REPOSITORY" --label maintenance \
    --state open --json number --jq 'length')"
((open_issues == 0)) || skip "$open_issues maintenance issue(s) open"

# One bump PR at a time.
open_bump_prs="$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json title \
    --jq '[.[] | select(.title | startswith("chore: bump version"))] | length')"
((open_bump_prs == 0)) || skip "a bump pull request is already open"

tag="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
[[ -n "$tag" ]] || skip "no tags yet"

# Classify every unreleased subject. Squash-only main keeps one subject per PR.
unreleased="$(git log --format=%s "$tag"..HEAD)"
[[ -n "$unreleased" ]] || skip "nothing unreleased since $tag"

breaking_re='^[a-z]+(\([^)]*\))?!:'
subject_re='^([a-z]+)(\(([^)]*)\))?:'
not_ok=""
while IFS= read -r subject; do
    [[ -n "$subject" ]] || continue
    if [[ "$subject" =~ $breaking_re ]]; then
        not_ok+="- breaking: $subject"$'\n'
    elif [[ "$subject" =~ $subject_re ]]; then
        type="${BASH_REMATCH[1]}"
        scope="${BASH_REMATCH[3]:-}"
        case "$type:$scope" in
            fix: | ci: | docs: | chore:deps) ;;
            *) not_ok+="- $subject"$'\n' ;;
        esac
    else
        not_ok+="- unparsable: $subject"$'\n'
    fi
done <<<"$unreleased"

if [[ -n "$not_ok" ]]; then
    log "Commits since $tag that keep the release manual:"
    printf '%s' "$not_ok"
    skip "main holds commits outside fix/ci/docs/chore(deps)"
fi

log "All commits since $tag are patch-releasable. Opening the release PR."

# bump.sh pushes and opens the PR; the checkout has persist-credentials off,
# so hand the token to git for that push. The helper stores no secret: the
# password is read from the environment when git asks for it.
# shellcheck disable=SC2016  # the helper must expand GH_TOKEN at query time
git config --local credential.helper \
    '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'

make bump PART=patch
