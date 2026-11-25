#!/usr/bin/env bash
# One alert issue per workflow. Opened or updated on failure, closed on the
# next success: a standing problem (for example a CVE that waits for a base
# image rebuild) means one open issue, not one notification per run.
#
# Needs from the workflow environment:
#   GH_TOKEN     the GITHUB_TOKEN, needs `issues: write`
#   GITHUB_REPOSITORY  set by GitHub Actions
#   ALERT_TITLE  the exact issue title, one per workflow
#   ALERT_JOBS   'job=result, job=result, ...' with the `needs` results;
#                anything but success and skipped counts as failed
#   RUN_URL      the URL of this run
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env GH_TOKEN GITHUB_REPOSITORY ALERT_TITLE ALERT_JOBS RUN_URL

LABEL=maintenance

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

report_dir="$(mktemp -d)"
# shellcheck disable=SC2317,SC2329
remove_report_dir() {
    rm -rf -- "$report_dir"
}
on_exit remove_report_dir

# open_issue: number of the open issue for ALERT_TITLE, or empty.
open_issue() {
    gh issue list --repo "$GITHUB_REPOSITORY" \
        --state open --label "$LABEL" --limit 200 \
        --json number,title \
        --jq ".[] | select(.title == \"$ALERT_TITLE\") | .number" \
        | head -n 1
}

# failed_jobs: the entries of ALERT_JOBS that did not succeed.
failed_jobs() {
    local failed=""
    local entry entry_job entry_result
    for entry in ${ALERT_JOBS//,/ }; do
        entry_job="${entry%%=*}"
        entry_result="${entry#*=}"
        if [[ "$entry_result" != success && "$entry_result" != skipped ]]; then
            failed+="${failed:+, }$entry_job ($entry_result)"
        fi
    done
    printf '%s\n' "$failed"
}

failed="$(failed_jobs)"

if [[ -z "$failed" ]]; then
    issue="$(open_issue)"
    if [[ -n "$issue" ]]; then
        log "Closing alert issue #$issue: the workflow passed."
        gh issue close "$issue" --repo "$GITHUB_REPOSITORY" \
            --comment "Passed in $RUN_URL ($timestamp)."
    else
        log "The workflow passed, no open alert issue."
    fi
    exit 0
fi

body="$report_dir/body.md"
cat > "$body" <<__BODY__
Failed jobs: $failed

Run: $RUN_URL

The issue closes itself on the first green run; every further failure
appends a comment here. The runbook maps each signal to its action:
MAINTENANCE.md.
__BODY__

issue="$(open_issue)"
if [[ -z "$issue" ]]; then
    log "Opening alert issue: $ALERT_TITLE"
    gh issue create --repo "$GITHUB_REPOSITORY" \
        --label "$LABEL" --title "$ALERT_TITLE" --body-file "$body"
else
    log "Updating alert issue #$issue"
    comment="${report_dir}/comment.md"
    { printf 'Failed again at %s.\n\n' "$timestamp"; cat "$body"; } > "$comment"
    gh issue comment "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$comment"
fi
