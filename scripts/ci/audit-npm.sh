#!/usr/bin/env bash
# Audit the locked npm packages (package-lock.json) with npm audit.
# Every package is a devDependency (build tools, never shipped), so dev
# packages are audited too.
# Only HIGH and CRITICAL findings count. They are sorted like in scan-image.sh:
#   to fix   a fix exists: bump the package in package.json. Fails the check.
#            Dependabot security updates open that pull request on their own.
#   waiting  no fix exists yet, so nothing in this repository can remove it.
#            A warning and a report section, never a failure.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env NODE_IMAGE

temporary_dir="$(mktemp -d)"

# shellcheck disable=SC2317,SC2329
remove_temporary_dir() {
    rm -rf -- "$temporary_dir"
}
on_exit remove_temporary_dir

# Runs in the node image: one row per HIGH/CRITICAL finding, tab-separated:
# package, severity, vulnerable range, fix ("" when there is none).
parser='
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("/out/audit.json", "utf8"));
if (data.error) {
  console.error(data.error.summary || "npm audit failed");
  process.exit(2);
}
const rows = Object.values(data.vulnerabilities || {})
  .filter((v) => v.severity === "high" || v.severity === "critical")
  .map((v) => {
    const fix = v.fixAvailable;
    let text = "";
    if (fix === true) text = "yes";
    else if (fix) text = fix.name + "@" + fix.version + (fix.isSemVerMajor ? " (major)" : "");
    return [v.name, v.severity, v.range, text].join("\t");
  });
fs.writeFileSync("/out/findings.tsv", rows.map((row) => row + "\n").join(""));
'

log "npm audit"
# The only step here that needs the network (the advisory database).
# --audit-level=none: the exit status of npm says nothing, the parser decides.
docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --env PARSER="$parser" \
    --volume "$REPO_ROOT:/repo:ro" \
    --volume "$temporary_dir:/out" \
    --workdir /repo \
    "$NODE_IMAGE" \
    sh -ec '
        npm audit --package-lock-only --json --audit-level=none > /out/audit.json || true
        node -e "$PARSER"
    ' || die "npm audit failed. See the log above."

findings="$temporary_dir/findings.tsv"
to_fix_rows="$temporary_dir/to-fix.tsv"
waiting_rows="$temporary_dir/waiting.tsv"
: > "$to_fix_rows"
: > "$waiting_rows"

# The fourth column is the fix: empty means there is none.
awk -F'\t' -v to_fix="$to_fix_rows" -v waiting="$waiting_rows" \
    '{ print > ($4 == "" ? waiting : to_fix) }' "$findings"

count_rows() {
    local lines
    lines="$(wc -l < "$1")"
    echo "$((lines))"
}

markdown_table() {
    echo "| Package | Severity | Vulnerable range | Fix |"
    echo "|---|---|---|---|"
    awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, ($4 == "" ? "–" : $4) }' "$1"
}

to_fix="$(count_rows "$to_fix_rows")"
waiting="$(count_rows "$waiting_rows")"

{
    echo "### Dependency audit (npm)"
    echo
    if ((to_fix + waiting == 0)); then
        echo "No HIGH or CRITICAL vulnerabilities."
        echo
    fi
    if ((to_fix > 0)); then
        printf '**%s HIGH/CRITICAL vulnerabilities with a fix.** Bump the package in package.json (Dependabot opens a pull request for security fixes).\n\n' "$to_fix"
        markdown_table "$to_fix_rows"
        echo
    fi
    if ((waiting > 0)); then
        printf '**%s HIGH/CRITICAL vulnerabilities without a fix yet.** They do not fail the check.\n\n' "$waiting"
        markdown_table "$waiting_rows"
        echo
    fi
} | report_details

if ((waiting > 0)); then
    warn "$waiting npm vulnerabilities have no fix yet."
fi

((to_fix == 0)) || die "$to_fix HIGH/CRITICAL npm vulnerabilities have a fix. Bump the packages in package.json."

log "No npm vulnerabilities with a fix."