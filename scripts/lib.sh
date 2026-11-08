# shellcheck shell=bash
# Shared helpers for all scripts. Source it, do not execute it.
# Scripts are started by make, which exports their configuration
# as environment variables.
#
# Sourcing installs the EXIT, INT and TERM traps. Register cleanup
# with `on_exit FUNCTION` instead of setting traps in a script.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1


# ---------- Output ----------

in_ci() {
    [[ -n "${GITHUB_ACTIONS:-}" ]]
}

# ci_format IN_CI LOCAL: print the first value in GitHub Actions, the second locally.
ci_format() {
    if in_ci; then
        printf '%s' "$1"
    else
        printf '%s' "$2"
    fi
}

log() {
    printf '==> %s\n' "$*" >&2
}

warn() {
    if in_ci; then
        printf '::warning::%s\n' "$*" >&2
    else
        printf 'WARNING: %s\n' "$*" >&2
    fi
}

die() {
    if in_ci; then
        printf '::error::%s\n' "$*" >&2
    else
        printf 'ERROR: %s\n' "$*" >&2
    fi
    exit 1
}

# Fail early with a clear message when a script is run outside make.
require_env() {
    local name
    for name in "$@"; do
        [[ -n "${!name:-}" ]] || die "$name is not set. Run this through make."
    done
}

# GitHub token for online audits, printed to stdout: GH_TOKEN from the
# environment (GitHub Actions), otherwise the gh login. It is never exported
# here: the caller hands it to the one command that needs it, for example
# `token="$(gh_token)"` and then `GH_TOKEN="$token" docker_tool --env GH_TOKEN ...`.
gh_token() {
    local token="${GH_TOKEN:-}"
    if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
        token="$(gh auth token 2>/dev/null || true)"
    fi
    [[ -n "$token" ]] \
        || die "No GitHub token: run 'gh auth login' or set GH_TOKEN."
    printf '%s' "$token"
}


# ---------- Exit hooks ----------

_exit_hooks=()

# on_exit FUNCTION: call FUNCTION with the exit status when the script exits.
# Hooks run in reverse order of registration; a failing hook is ignored.
on_exit() {
    _exit_hooks+=("$1")
}

# shellcheck disable=SC2317,SC2329
_run_exit_hooks() {
    local status=$?
    local i
    trap - EXIT
    for (( i = ${#_exit_hooks[@]} - 1; i >= 0; i-- )); do
        "${_exit_hooks[i]}" "$status" || true
    done
    exit "$status"
}

trap _run_exit_hooks EXIT
trap 'exit 130' INT
trap 'exit 143' TERM


# ---------- Project ----------

project_version() {
    local version
    version="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' pyproject.toml)"
    [[ -n "$version" ]] || die "Cannot find version in pyproject.toml."
    printf '%s\n' "$version"
}

# Run a one-off command in the dev service as the current user,
# without starting Ollama: dev_run [RUN OPTIONS] SERVICE COMMAND...
dev_run() {
    docker compose -f compose.yaml -f compose.dev.yaml \
        run --rm --no-deps --build \
        --user "$(id -u):$(id -g)" \
        "$@"
}

# Run a tool container with the repository mounted read-only.
docker_tool() {
    docker run --rm \
        --volume "$REPO_ROOT:/repo:ro" \
        --workdir /repo \
        "$@"
}


# ---------- Check report ----------
# `scripts/ci/report.sh begin` opens a report by creating $REPORT_DIR/checks.tsv.
# While it is open, every script that sources lib.sh records one row on exit
# (label, exit status, seconds); `report.sh render` turns the rows into a table.

REPORT_DIR="${REPORT_DIR:-$REPO_ROOT/reports}"
_report_label="$(basename "$0" .sh)"
_report_start=$SECONDS

report_open() {
    [[ -f "$REPORT_DIR/checks.tsv" ]]
}

# report_label TEXT: the name of this check in the report ("" = do not record).
report_label() {
    _report_label="$1"
}

# Append Markdown from stdin to the report details. Dropped when no report is open.
report_details() {
    if report_open; then
        cat >> "$REPORT_DIR/details.md"
    else
        cat > /dev/null
    fi
}

# shellcheck disable=SC2317,SC2329
_record_check() {
    if [[ -z "$_report_label" ]] || ! report_open; then
        return 0
    fi
    printf '%s\t%s\t%s\n' "$_report_label" "$1" "$((SECONDS - _report_start))" \
        >> "$REPORT_DIR/checks.tsv"
}

# Registered first, so it runs last: the duration includes the cleanup.
on_exit _record_check