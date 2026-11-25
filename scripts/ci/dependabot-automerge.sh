#!/usr/bin/env bash
# Classifies a Dependabot pull request and enables auto-merge for it.
# Auto-merge is a repository setting; `gh pr merge --auto --squash` only
# arms the merge: the required checks of the main ruleset decide, so
# nothing merges that CI rejected. Majors merge too when the pull request
# carries the `security` label (Dependabot sets it on vulnerability fixes).
#
# Needs from the workflow environment:
#   GH_TOKEN        the GITHUB_TOKEN, needs `pull_requests: write`
#   GITHUB_REPOSITORY      set by GitHub Actions
#   PR_NUMBER       the pull request number
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env GH_TOKEN GITHUB_REPOSITORY PR_NUMBER

LABEL_SECURITY=security

comment_file="$(mktemp)"
# shellcheck disable=SC2317,SC2329
remove_comment_file() {
    rm -f -- "$comment_file"
}
on_exit remove_comment_file

# version_of TOKEN: the dotted numeric version of a Dependabot version
# token, without a digest (`3.15.2-slim@sha256:...` -> `3.15.2`), without
# an OS suffix (`26.13.1-alpine` -> `26.13.1`) and without a `v` prefix.
version_of() {
    local version="${1%%@*}"
    version="${version#v}"
    version="${version%%-*}"
    [[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
    printf '%s\n' "$version"
}

# bump_level FROM TO: patch, minor or major; fails when either token is
# not a version. A bump without a version change is a digest or rebuild
# bump, and counts as patch.
bump_level() {
    local from to i a b
    local -a first second
    from="$(version_of "$1")" || return 1
    to="$(version_of "$2")" || return 1
    IFS='.' read -r -a first <<<"$from"
    IFS='.' read -r -a second <<<"$to"
    for i in 0 1 2; do
        a="${first[i]:-0}"
        b="${second[i]:-0}"
        [[ "$a" == "$b" ]] && continue
        if ((i == 0)); then
            printf 'major\n'
        elif ((i == 1)); then
            printf 'minor\n'
        else
            printf 'patch\n'
        fi
        return 0
    done
    printf 'patch\n'
}

# worst_level UPDATES: the highest bump level in the Dependabot text,
# where UPDATES is the commit messages of the pull request. A commit
# without a compareable version pair counts as manual. No such line at
# all (a rebuild or digest bump) stays at patch.
worst_level() {
    local rank=0 line pair level from to
    local i
    while IFS= read -r line; do
        [[ "$line" == *" from "* ]] || continue
        pair="$(sed -nE 's/.* from ([^ "]+) to ([^ "]+).*/\1 \2/p' <<<"$line")"
        from="${pair%% *}"
        to="${pair##* }"
        # Dependabot sentences end in a period: 'from 0.14.0 to 0.15.0.'
        from="${from%[.,;:]}"
        to="${to%[.,;:]}"
        if [[ -z "$pair" ]] || ! level="$(bump_level "$from" "$to")"; then
            level=manual
        fi
        case "$level" in
            patch) i=0 ;;
            minor) i=1 ;;
            major) i=2 ;;
            manual) i=3 ;;
        esac
        ((i > rank)) && rank="$i"
    done <<<"$1"
    printf '%s\n' "patch minor major manual" | cut -d' ' -f$((rank + 1))
}

# The Dependabot markdown lists every update of the group, so the commit
# messages decide for one grouped pull request as well as for a single one.
updates="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \
    --json commits \
    --jq '.commits[] | .messageHeadline + "\n" + (.messageBody // "")')"
labels="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \
    --json labels --jq '[.labels[].name] | join(" ")')"

if [[ " $labels " == *" $LABEL_SECURITY "* ]]; then
    decision=merge
    level=security
elif worst="$(worst_level "$updates")" && [[ "$worst" == patch || "$worst" == minor ]]; then
    decision=merge
    level="$worst"
else
    decision=manual
    level="${worst:-manual}"
fi

if [[ "$decision" == merge ]]; then
    log "Enable auto-merge for #$PR_NUMBER: $level update."
    if ! gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --squash; then
        warn "Auto-merge is already enabled for #$PR_NUMBER."
    fi
    exit 0
fi

log "Leave #$PR_NUMBER manual: a $level update."
cat > "$comment_file" <<__BODY__
This pull request holds a major update: it stays manual by design
(all-patch/minor Dependabot pull requests auto-merge once CI is green).

Revert from Dependabot, merge with review, or fix forward.
Runbook: MAINTENANCE.md.
__BODY__
gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body-file "$comment_file"
