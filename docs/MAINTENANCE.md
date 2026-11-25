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

A failed run of `security.yml` (daily, 04:00 UTC) or `release.yml` opens or
updates one issue labelled `maintenance`. The next green run closes it.
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

## Releases

Every push to `main` builds and verifies the image, but publishes only when
`pyproject.toml` has an untagged version. Dependabot merges therefore do not
publish. To ship a fix, run `make bump PART=patch` from a clean `main` and
merge the bump pull request. The next daily scan closes the alert.

## Settings outside git

| Setting | Value |
|---|---|
| Ruleset `Protect main` | squash only, linear history, dismiss stale reviews, resolve threads, 0 approvals; required checks: Check workflows, Check code, Check image |
| Ruleset `Protect v* tags` | no deletion, update or force push |
| Repository | `allow_auto_merge`, `delete_branch_on_merge` (`gh api -X PATCH repos/kvitkx/lmao -F allow_auto_merge=true -F delete_branch_on_merge=true`) |
| Secret `MAINTENANCE_TOKEN` | fine-grained PAT, this repository: Contents and Pull requests read/write |
| Secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | Docker Hub push account |
| Variable `DOCKERHUB_REPOSITORY` | `namespace/name` of the Docker Hub image |
| Label `maintenance` | created by the alert script if missing |

- `MAINTENANCE_TOKEN` lets an auto-merge trigger `release.yml`. Merges made
  with `GITHUB_TOKEN` start no workflows; without the secret, run the release
  by hand after maintenance merges.
- GitHub disables scheduled workflows after 60 days without repository
  activity (Dependabot merges do not count). Re-enable them in the Actions tab.
- Forks: `make PUBLISHED_IMAGE=<image> scan-published`.