# Contributing

## Setup

Requires Docker with Compose v2, GNU Make and Bash. Everything runs through
Docker; nothing else is installed on the host. See the README for `make dev`
and `make help`.

## Before every commit

```bash
make format
GH_TOKEN="$(gh auth token)" make ci
```

`make format` changes files, so run it first and review `git diff`. `make ci`
runs exactly what GitHub CI runs and must pass for each commit, not only for the
last one. It ends with a table of every check; the same report, with test,
coverage, audit and Trivy details, is written to `reports/summary.md`.

## CI and make

Workflows contain no check logic: they only call `make report-TARGET`, and
the targets each workflow runs are listed in `ci.mk`:

| Workflow | Runs | Locally |
|---|---|---|
| `ci.yml` (pull requests) | `CI_JOBS` | `GH_TOKEN="$(gh auth token)" make ci` |
| `security.yml` (daily) | `SECURITY_JOBS` | `GH_TOKEN="$(gh auth token)" make security` |
| `release.yml` (push to `main`) | `RELEASE_JOBS` | `make test-image` (after `make build-prod`) |

`make check-parity` (part of `make ci`) fails when a workflow and `ci.mk`
disagree. To add a check, add a make target and list it in `ci.mk`; do not
add commands to a workflow.

- `make report-TARGET` runs one target the way CI does, for example
  `make report-check-code`. Checks run with `make -k`, so one run reports
  every failure, not only the first.
- `make check` is `make ci` without the online zizmor audit (no token).
- The Security workflow does not run on pull requests: its result depends on
  the published image and today's advisories, not on the change. When you
  change `security.yml` or its scripts, run `make security`, then
  `gh workflow run security.yml --ref <branch>`.
- A failing `scan-published` means the published image needs a new release
  (usually a base image fix that is already on `main`): run `make bump`.

GitHub disables the daily Security workflow after 60 days without repository
activity (Dependabot merges do not count). Re-enable it in the Actions tab.

## Branches

Format: `<type>/<short-kebab-description>`, for example
`feat/cloud-judge` or `fix/results-without-metrics`.

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
`chore`. A version bump uses `chore/bump-X.Y.Z`.

## Commits

Format: `<type>(<scope>): <summary>`, using [Conventional Commits](https://www.conventionalcommits.org).

- Same types as for branches. The scope is optional, for example `core`, `api`,
  `ui`, `deps`, `ci`, `docker`.
- Imperative mood, lowercase, no trailing period, at most 72 characters:
  `fix(api): return 404 for unknown runs`.
- Mark breaking changes with `!`: `refactor(core)!: change the results schema`.
- One logical change per commit. Write its tests in the same commit.

## Pull requests

- The title follows the commit format.
- Describe what changed and why, and how you verified it.
- Open the PR when every commit passes `make ci`.

## Versions and releases

Only change the version with `make bump PART=patch|minor|major`. The script
commits `pyproject.toml` and `uv.lock` on a `chore/bump-X.Y.Z` branch and
opens the release PR (label `release`, template
`.github/PULL_REQUEST_TEMPLATE/release.md`). Merging that PR releases the
version, so never mix it with other changes. Dependabot merges do not create
releases; bump PRs are excluded from changelogs by the `release` label.
Run it from a clean `main` that matches `origin/main`: the script refuses
otherwise.

Prereleases: `make bump PART="patch rc"` (`1.2.3rc1` is released as
`v1.2.3-rc.1`); `make bump PART=stable` makes the final version.
`make release-plan` shows the tag the current version would release.

## Rules of the repository

- Tests: coverage must stay at or above `fail_under` in `pyproject.toml`.
- JS tests: `static/js/lib.js` holds the pure helpers; cover new ones in
  `tests/js/` (`make test-js`). Keep the DOM and Alpine out of `lib.js`.
- Python version: the `Dockerfile` `FROM python:` line and `requires-python`
  change together (`make check-python` verifies it).
- Workflows call make only as a single-line `run: make report-TARGET`
  (`make check-parity` verifies it).
- Makefile recipes start with exactly one tab.
- New scripts are executable: `chmod +x` and `git add --chmod=+x`.
- Scripts source `scripts/lib.sh` and use its helpers (`log`, `die`,
  `require_env`, `on_exit` for cleanup) instead of their own traps.
- Do not edit `uv.lock` by hand.
- Security issues: see [SECURITY.md](SECURITY.md), not a public issue.