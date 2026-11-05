#!/usr/bin/env bash
# Collect check results into one report.
#   report.sh begin TITLE   open an empty report
#   report.sh render        print the report, write reports/summary.md,
#                           append it to the GitHub job summary, close it
# Rows are recorded by lib.sh when each check script exits.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# This script is not a check.
report_label ""

checks="$REPORT_DIR/checks.tsv"
details="$REPORT_DIR/details.md"
title_file="$REPORT_DIR/title"
summary="$REPORT_DIR/summary.md"

begin() {
    mkdir -p "$REPORT_DIR"
    rm -f -- "$details" "$summary"
    printf '%s\n' "${1:-Checks}" > "$title_file"
    : > "$checks"
}

result_markdown() {
    case "$1" in
        0) printf '✅ pass' ;;
        130 | 143) printf '⏹️ interrupted' ;;
        *) printf '❌ fail (exit %s)' "$1" ;;
    esac
}

result_text() {
    case "$1" in
        0) printf 'pass' ;;
        130 | 143) printf 'interrupted' ;;
        *) printf 'FAIL (exit %s)' "$1" ;;
    esac
}

render() {
    report_open || die "No report is open. Run 'report.sh begin TITLE' first."

    local title label status seconds
    local total=0 failed=0
    title="$(cat "$title_file" 2>/dev/null || echo Checks)"

    {
        printf '## %s\n\n' "$title"
        echo "| Check | Result | Time |"
        echo "|---|---|---|"
        while IFS=$'\t' read -r label status seconds; do
            total=$((total + 1))
            [[ "$status" == 0 ]] || failed=$((failed + 1))
            printf '| %s | %s | %ss |\n' "$label" "$(result_markdown "$status")" "$seconds"
        done < "$checks"
        echo

        if [[ "$total" == 0 ]]; then
            echo "_No checks were recorded._"
        elif [[ "$failed" == 0 ]]; then
            echo "**All $total checks passed.**"
        else
            echo "**$failed of $total checks failed.**"
        fi
        echo

        if [[ -s "$details" ]]; then
            cat "$details"
        fi
    } > "$summary"

    {
        echo
        echo "$title"
        while IFS=$'\t' read -r label status seconds; do
            printf '  %-55s %-16s %5ss\n' "$label" "$(result_text "$status")" "$seconds"
        done < "$checks"
        echo
    } >&2

    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        cat "$summary" >> "$GITHUB_STEP_SUMMARY"
    fi

    # Close the report: later standalone runs must not append to it.
    rm -f -- "$checks" "$title_file"

    log "Report: ${summary#"$REPO_ROOT"/}"
}

case "${1:-}" in
    begin) begin "${2:-}" ;;
    render) render ;;
    *) die "Usage: report.sh begin TITLE | render" ;;
esac