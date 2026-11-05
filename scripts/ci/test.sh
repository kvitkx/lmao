#!/usr/bin/env bash
# Run tests inside the dev image without network access,
# then copy coverage reports (coverage.xml, htmlcov/) to the repo root.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_DEV_IMAGE

container=""
temporary_dir="$(mktemp -d)"

# shellcheck disable=SC2317,SC2329
remove_container() {
    if [[ -n "$container" ]]; then
        docker rm -f "$container" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$temporary_dir"
}
on_exit remove_container

# Remove old reports so a failed run cannot leave misleading results.
rm -f -- coverage.xml .coverage
rm -rf -- htmlcov

container="$(
    docker create \
        --network none \
        --env PYTHON_DOTENV_DISABLED=1 \
        --env FLASK_DEBUG=0 \
        --env OLLAMA_BASE_URL=http://127.0.0.1:11434 \
        --env COVERAGE_FILE=/tmp/ci-reports/.coverage \
        --workdir /app \
        "$CI_DEV_IMAGE" \
        sh -ec '
            mkdir -p /tmp/ci-reports
            status=0
            pytest \
                -p no:cacheprovider \
                --cov \
                --cov-report=term-missing \
                --cov-report=xml:/tmp/ci-reports/coverage.xml \
                --cov-report=html:/tmp/ci-reports/htmlcov \
                || status=$?
            coverage report --format=total > /tmp/ci-reports/coverage-total.txt 2>/dev/null || true
            coverage report --format=markdown > /tmp/ci-reports/coverage.md 2>/dev/null || true
            exit "$status"
        '
)"

run_status=0
docker start --attach "$container" | tee "$temporary_dir/pytest.log" || run_status=$?

test_status="$(docker inspect --format '{{.State.ExitCode}}' "$container")"

# Without -a, docker cp creates files owned by the invoking user.
if docker cp "$container:/tmp/ci-reports/." "$temporary_dir/reports"; then
    for name in coverage.xml htmlcov .coverage; do
        if [[ -e "$temporary_dir/reports/$name" ]]; then
            mv -- "$temporary_dir/reports/$name" .
        fi
    done
else
    warn "No coverage reports were produced."
fi

# The last pytest line: "==== 141 passed, 2 skipped in 3.21s ====".
result="$(
    grep -E '^=+ .+ in [0-9.]+s' "$temporary_dir/pytest.log" \
        | tail -n 1 \
        | sed -E 's/^=+ //; s/ =+$//' \
        || true
)"
coverage_total="$(cat "$temporary_dir/reports/coverage-total.txt" 2>/dev/null || true)"

{
    echo "### Tests"
    echo
    printf '**%s**' "${result:-pytest did not report a result}"
    if [[ -n "$coverage_total" ]]; then
        printf ' · coverage **%s%%**' "$coverage_total"
    fi
    printf '\n\n'

    if [[ -s "$temporary_dir/reports/coverage.md" ]]; then
        echo "<details><summary>Coverage by file</summary>"
        echo
        cat "$temporary_dir/reports/coverage.md"
        echo
        echo "</details>"
        echo
    fi
} | report_details

if [[ "$run_status" != 0 ]]; then
    exit "$run_status"
fi

exit "$test_status"