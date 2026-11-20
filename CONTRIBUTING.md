# Contributing

## Setup

Requires Docker with Compose v2, GNU Make and Bash. Everything runs through Docker; Node is not needed on the host. `make help` lists the commands and the variables they accept (`ENV`, `GPU`, `MODEL`, `ARGS`, `PART`); keep that list in `Makefile` up to date when you add one.

- `make dev`: the app with hot reload on http://localhost:5000. It rebuilds `static/css/app.css` and `static/js/` whenever a template, a script or `static/css/input.css` changes.
- `make run`: the app on the host with [uv](https://docs.astral.sh/uv/) (it installs Python 3.15). It builds the front-end files in Docker when they are missing or outdated; `make css` does only that, `make -B css` forces it. Without Docker the page has no styles. If Ollama is not on `http://localhost:11434`, set `OLLAMA_BASE_URL` (see `.env.example`).

## Workflow

While you work, `make test` runs the Python and JS tests without coverage (`make test ARGS="-k export"` passes `ARGS` to pytest). Run it after every change.

Before every commit:

```bash
make format    # changes files: review git diff
make ci        # exactly what GitHub CI runs; must pass for each commit
```

`make ci` takes the GitHub token from `gh auth token` (or `GH_TOKEN`) and passes it only to the zizmor container. It ends with a table of every check; the full report (tests, coverage, audit, Trivy) is in `reports/summary.md`.

## CI and make

Workflows contain no check logic: they only call `make report-TARGET`, and the targets each workflow runs are listed in `ci.mk`.

| Workflow | Runs | Locally |
|---|---|---|
| `ci.yml` (pull requests) | `CI_JOBS` | `make ci` |
| `security.yml` (daily) | `SECURITY_JOBS` | `make security` |
| `release.yml` (push to `main`) | `RELEASE_JOBS` | `make test-image` (after `make build-prod`) |

- To add a check, add a make target and list it in `ci.mk`; never add commands to a workflow. `make check-parity` (part of `make ci`) fails when a workflow and `ci.mk` disagree.
- `make check` is `make ci` without the online zizmor audit (no token). `make report-TARGET` runs one target the way CI does. Checks run with `make -k`, so one run reports every failure.
- `make help` lists only everyday commands. Describe a new CI target with a plain `#` comment in `ci.mk`, not `##>`.
- The Security workflow does not run on pull requests. After changing it or its scripts, run `make security`, then `gh workflow run security.yml --ref <branch>`. GitHub disables it after 60 days without repository activity (Dependabot merges do not count): re-enable it in the Actions tab.
- A failing `audit-npm` means a vulnerable npm package has a fix: merge the Dependabot security PR, or bump the package in `package.json` and regenerate the lockfile (see below).
- A failing `scan-published` means the published image needs a new release, usually for a base image fix already on `main`: run `make bump`.
- `scan-image` sorts findings into *to fix* (the newest base image does not have them: rebuild or bump) and *waiting* (the newest base image has them too). *Waiting* only warns until the base image is older than `BASE_MAX_AGE_DAYS` (14, set in `ci.mk`).

## Branches, commits, pull requests

- Branch: `<type>/<short-kebab-description>`, for example `feat/cloud-judge`. A version bump uses `chore/bump-X.Y.Z`.
- Commit: `<type>(<scope>): <summary>` ([Conventional Commits](https://www.conventionalcommits.org)), imperative, lowercase, no trailing period, at most 72 characters. Mark breaking changes with `!`: `refactor(core)!: change the results schema`. One logical change per commit, with its tests.
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`. The scope is optional (`core`, `api`, `ui`, `deps`, `ci`, `docker`).
- The PR title follows the commit format. Describe what changed, why and how you verified it. Open the PR when every commit passes `make ci`.

## Versions and releases

Only change the version with `make bump PART=patch|minor|major`. Run it from a clean `main` that matches `origin/main`. It commits `pyproject.toml` and `uv.lock` on a `chore/bump-X.Y.Z` branch and opens the release PR (label `release`); merging that PR releases the version, so never mix it with other changes. Dependabot merges do not create releases.

Prereleases: `make bump PART="patch rc"` (`1.2.3rc1` is released as `v1.2.3-rc.1`); `make bump PART=stable` makes the final version. `make release-plan` shows the tag the current version would release.

## Rules of the repository

- Coverage must stay at or above `fail_under` in `pyproject.toml` (measured by `make ci`).
- Python version: the `Dockerfile` `FROM python:` line and `requires-python` change together (`make check-python`).
- Workflows call make only as a single-line `run: make report-TARGET` (`make check-parity`).
- Makefile recipes start with exactly one tab. New scripts are executable (`chmod +x`, `git add --chmod=+x`) and source `scripts/lib.sh` (`log`, `die`, `require_env`, `on_exit` instead of their own traps).
- Do not edit `uv.lock` or `package-lock.json` by hand. Front-end packages are pinned to exact versions in `package.json`; after changing it, regenerate the lockfile in Docker:

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
    --volume "$PWD:/app" --workdir /app \
    "$(make -s print-NODE_IMAGE)" \
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  ```

- Front end: TypeScript in `frontend/`, compiled to `static/js/`. `frontend/lib.ts` holds the pure helpers (no DOM, no Alpine); cover new ones in `tests/js/*.test.ts`. No `enum` or `namespace`: Node runs the tests by stripping types. `make typecheck-js` runs `tsc`.
- Styles live in `static/css/input.css`. `static/css/app.css`, `static/vendor/`, `static/fonts/` and `static/js/` are generated and never committed.
- The CSS build finds class names by scanning `templates/` and `frontend/`. A class composed from a variable (as `nav_toggle` does) is invisible to the scan: list it in the `@source inline(...)` line of `input.css`.
- The page loads nothing from another host (a test checks `index.html`). A new front-end file comes from an npm package through `scripts/build-assets.sh`.
- Nothing from a model is written as HTML: no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `x-html` (tests check this).
- Security issues: see [SECURITY.md](SECURITY.md), not a public issue.