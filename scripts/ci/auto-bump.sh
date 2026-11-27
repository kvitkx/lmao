#!/usr/bin/env bash
# Open the patch release PR when main carries only shippable commits.
#
# Runs weekly (auto-bump.yml) and by hand (workflow_dispatch). Every commit
# since the newest tag must be `fix`, `ci` or `docs` (any scope), `chore(deps)`
# or `chore(ci)`: the last two are the prefixes of the Dependabot groups.
# `feat`, a `!` suffix and every other type keep the release a human decision.
# The script skips with a logged reason (green run, no pull request) when:
#   - the last release.yml run on main is not a success: the tag is immutable,
#     so a broken release needs a human, not another bump;
#   - a bump pull request is already open;
#   - nothing is unreleased.
# An open alert issue does not block it: a published image with a fixable
# vulnerability (scan-published) is exactly what a release fixes.
#
# DRY_RUN=1 makes the decisions and logs them, then stops before anything is
# pushed.
#
# The pull request is created with MAINTENANCE_TOKEN: created with
# GITHUB_TOKEN it would never run its required checks, because events from
# GITHUB_TOKEN start no workflows. This script fails (red run) when that
# token is not in effect. Merging the PR stays manual: it is the release
# button. See docs/MAINTENANCE.md.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

skip() {
    log "Auto bump skipped: $*."
    exit 0
}

# keeps_manual SUBJECTS: the commit subjects (one per line) that keep the
# release a human decision, as "- subject" lines. Nothing is printed when
# every subject is shippable.
keeps_manual() {
    local breaking_re='^[a-z]+(\([^)]*\))?!:'
    local subject_re='^([a-z]+)(\(([^)]*)\))?:'
    local subject type scope
    while IFS= read -r subject; do
        [[ -n "$subject" ]] || continue
        if [[ "$subject" =~ $breaking_re ]]; then
            printf -- '- breaking: %s\n' "$subject"
        elif [[ "$subject" =~ $subject_re ]]; then
            type="${BASH_REMATCH[1]}"
            scope="${BASH_REMATCH[3]:-}"
            case "$type:$scope" in
                fix:* | ci:* | docs:* | chore:deps | chore:ci) ;;
                *) printf -- '- %s\n' "$subject" ;;
            esac
        else
            printf -- '- unparsable: %s\n' "$subject"
        fi
    done <<<"$1"
}

main() {
    require_env GH_TOKEN GITHUB_REPOSITORY

    # A PR created with GITHUB_TOKEN never runs its required checks. That token
    # is refused by `gh api user`, so an empty answer means the same.
    local actor
    actor="$(gh api user --jq .login 2>/dev/null || true)"
    [[ -n "$actor" && "$actor" != "github-actions[bot]" ]] \
        || die "MAINTENANCE_TOKEN is not in effect (actor: ${actor:-none}). Set the secret (docs/MAINTENANCE.md): a PR created with GITHUB_TOKEN would hang on its required checks."

    # Never stack a bump on a broken or still-running release.
    local last
    last="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow release.yml --branch main \
        --limit 1 --json status,conclusion \
        --jq 'if length == 0 then "absent" else .[0] | "\(.status)/\(.conclusion)" end')" \
        || die "Cannot list the Release runs: MAINTENANCE_TOKEN needs the Actions read permission."
    [[ "$last" == "completed/success" ]] || skip "the last Release run on main is $last"

    # One bump PR at a time.
    local open_bump_prs
    open_bump_prs="$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json title \
        --jq '[.[] | select(.title | startswith("chore: bump version"))] | length')"
    ((open_bump_prs == 0)) || skip "a bump pull request is already open"

    # The nearest tag in the history: unlike a version sort, it is not fooled
    # by a prerelease tag of the same version.
    local tag
    tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
    [[ -n "$tag" ]] || skip "no tags yet"

    # Squash-only main keeps one subject per PR.
    local unreleased not_ok
    unreleased="$(git log --format=%s "$tag"..HEAD)"
    [[ -n "$unreleased" ]] || skip "nothing unreleased since $tag"

    not_ok="$(keeps_manual "$unreleased")"
    if [[ -n "$not_ok" ]]; then
        log "Commits since $tag that keep the release manual:"
        printf '%s\n' "$not_ok" >&2
        skip "main holds commits outside fix/ci/docs/chore(deps)/chore(ci)"
    fi

    log "All commits since $tag are patch-releasable."
    if [[ "${DRY_RUN:-}" == 1 ]]; then
        log "Dry run: the release PR would be opened now."
        exit 0
    fi
    log "Opening the release PR."

    # bump.sh pushes and opens the PR; the checkout has persist-credentials off,
    # so hand the token to git for that push. The helper stores no secret: the
    # password is read from the environment when git asks for it.
    # shellcheck disable=SC2016  # the helper must expand GH_TOKEN at query time
    git config --local credential.helper \
        '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'

    make bump PART=patch
}

# Sourced by tests/test_ci_scripts.py: only the functions above are used.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main
fi
