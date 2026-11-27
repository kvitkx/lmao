# Maintenance

Runbook for the automated maintenance loop: what updates automatically, what
each alert means, and which settings live outside git.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens two grouped pull requests:

| Group | Schedule | Covers |
|---|---|---|
| `runtime` | weekly, Monday 09:00 UTC | uv, `Dockerfile`, Compose, npm |
| `ci-tooling` | monthly | GitHub Actions, `docker/tools.Dockerfile` |

Version updates wait out a 7-day cooldown. Security updates and the `python`
base image do not: upstream rebuilds of the base tag deliver OS security fixes.

`dependabot-automerge.yml` arms a squash auto-merge for:

- patch and minor updates, including digest-only Docker bumps;
- any pull request labelled `security`, at any semver level.

Majors without the label get one comment and are merged by hand. Auto-merge
never bypasses CI: the `Protect main` ruleset requires all checks. 0.x minors
count as minor; CI is the safeguard.

## Alerts

A failed run of `security.yml` (daily, 04:00 UTC), `release.yml` or
`auto-bump.yml` opens or updates one issue labelled `maintenance`. The next
green run closes it.
Runs on branches other than `main` never touch these issues.

| Failed job | Action |
|---|---|
| `audit`, `audit-npm` | Let the Dependabot security PR merge, then release. |
| `scan-published` (*to fix*) | Let the `runtime` PR that bumps the base digest merge, then release. |
| `scan-published` (*waiting*) | None: the fix awaits an upstream rebuild. Fails only when the base image is older than `BASE_MAX_AGE_DAYS` (30); then investigate upstream. |
| `zizmor` | Fix the workflow. Details are in Code scanning. |
| `ci` (release) | The code on `main` is broken. |
| `publish` (release) | The image failed to build, verify or push. |
| `github-release` (release) | Tagging failed after a successful publish. |
| `bump` (auto-bump) | Usually an expired `MAINTENANCE_TOKEN`: renew it as an Actions secret and as a Dependabot secret. Run the workflow with `dry-run` to check. |

## Releases

Every push to `main` builds and verifies the image, but publishes only when
`pyproject.toml` has an untagged version. Dependabot merges therefore do not
publish.

`auto-bump.yml` runs Mondays 12:00 UTC and opens the patch release PR
(`make bump PART=patch`) when every commit since the newest tag is `fix`,
`ci` or `docs` (any scope), `chore(deps)` or `chore(ci)` (the Dependabot
prefixes) — nothing else. `feat`, a `!` suffix, `refactor`, `test`, `perf`
and any other `chore` keep the release a human call. It skips with a logged
reason (green run, no PR) when the last release run is not green, a bump PR
is already open, or nothing is unreleased. An open `Security workflow
failed` issue does not block it: a published image with a fixable CVE is
what the release fixes. Merging the bump PR releases the version; the next
daily scan closes the alert. Without `MAINTENANCE_TOKEN` the run goes red: a
PR created with `GITHUB_TOKEN` would hang on its required checks. To see
what it would do without opening a PR, run it from the Actions tab with
`dry-run`.

## Settings outside git

| Setting | Value |
|---|---|
| Ruleset `Protect main` | squash only, linear history, dismiss stale reviews, resolve threads, 0 approvals; required checks: Check workflows, Check code, Check image |
| Ruleset `Protect v* tags` | no deletion, update or force push |
| Repository | `allow_auto_merge`, `delete_branch_on_merge` (`gh api -X PATCH repos/kvitkx/lmao -F allow_auto_merge=true -F delete_branch_on_merge=true`) |
| Secret `MAINTENANCE_TOKEN` | fine-grained PAT, this repository: Contents, Issues and Pull requests read/write, Actions read |
| Secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | Docker Hub push account |
| Variable `DOCKERHUB_REPOSITORY` | `namespace/name` of the Docker Hub image |
| Label `maintenance` | created by the alert script if missing |

- `MAINTENANCE_TOKEN` lets an auto-merge trigger `release.yml` and lets
  `auto-bump.yml` open release PRs. Merges and pull requests made with
  `GITHUB_TOKEN` start no workflows; without the secret, release by hand and
  expect a red Auto bump run.
- Store `MAINTENANCE_TOKEN` twice: as an Actions secret (`auto-bump.yml`) and
  as a Dependabot secret (`gh secret set MAINTENANCE_TOKEN --app dependabot`).
  Runs that Dependabot starts read only Dependabot secrets and otherwise fall
  back to `GITHUB_TOKEN` without a word.
- GitHub disables scheduled workflows after 60 days without repository
  activity (Dependabot merges do not count). Re-enable them in the Actions tab.
- Forks: `make PUBLISHED_IMAGE=<image> scan-published`.