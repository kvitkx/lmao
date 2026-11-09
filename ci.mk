# Checks. Everything the workflows run is defined here:
# each workflow calls `make report-TARGET` for the targets listed in
# CI_JOBS, SECURITY_JOBS and RELEASE_JOBS (enforced by check-parity).
#
# `make help` lists only targets marked with `##>` (here: `ci`). The rest is
# internal: describe a new target with a plain `#` comment, not `##>`.

export CI_DEV_IMAGE    ?= lmao:dev-ci
export CI_IMAGE        ?= lmao:ci-local
# In GitHub Actions: $RUNNER_TEMP/trivy-cache, the path that
# .github/actions/setup-trivy-cache restores and saves.
export TRIVY_CACHE_DIR ?= $(if $(RUNNER_TEMP),$(RUNNER_TEMP)/trivy-cache,$(HOME)/.cache/lmao/trivy)
# A finding that only a base image rebuild fixes does not fail scan-image until
# the newest base image is older than this many days (see scripts/ci/scan-image.sh).
export BASE_MAX_AGE_DAYS ?= 14
export GH_TOKEN

# Online zizmor audits: always on in GitHub Actions (CI=true),
# locally only through `make ci` and `make security`.
export ZIZMOR_ONLINE ?= $(if $(CI),1,0)

# Tool images live in docker/tools.Dockerfile (single source of truth,
# tracked by Dependabot). `$(call tool_image,NAME)` reads `FROM <image> AS NAME`.
TOOLS_FILE := docker/tools.Dockerfile
tool_image = $(or $(shell sed -nE 's/^FROM[[:space:]]+([^[:space:]]+)[[:space:]]+AS[[:space:]]+$(1)[[:space:]]*$$/\1/p' $(TOOLS_FILE)),$(error No image named '$(1)' in $(TOOLS_FILE)))

export ACTIONLINT_IMAGE  := $(call tool_image,actionlint)
export ZIZMOR_IMAGE      := $(call tool_image,zizmor)
export HADOLINT_IMAGE    := $(call tool_image,hadolint)
export SHELLCHECK_IMAGE  := $(call tool_image,shellcheck)
export NODE_IMAGE        := $(call tool_image,node)
export TRIVY_IMAGE       := $(call tool_image,trivy)
export REGISTRY_IMAGE    := $(call tool_image,registry)

# Published image scanned by `make scan-published`. Override for forks.
export PUBLISHED_IMAGE   ?= ghcr.io/ykvit/lmao

# What each workflow runs, as `make report-TARGET`:
#   ci.yml       -> CI_JOBS        (make ci)
#   security.yml -> SECURITY_JOBS  (make security)
#   release.yml  -> RELEASE_JOBS   (the image itself is built by build-push-action)
export CI_JOBS       := check-workflows check-code check-image
export SECURITY_JOBS := audit audit-npm scan-published zizmor-sarif
export RELEASE_JOBS  := test-image

# Run TARGETS with make -k (every failing check is reported, not only the
# first), then always render the report: terminal, reports/summary.md and,
# in GitHub Actions, the job summary. Exits with the status of the checks.
# Usage in a recipe: @$(call run_report,TITLE,TARGETS)
run_report = scripts/ci/report.sh begin '$(1)'; \
	status=0; $(MAKE) -k $(2) || status=$$?; \
	scripts/ci/report.sh render; \
	exit $$status

.PHONY: check ci security \
        check-workflows check-parity check-code check-image test-image \
        check-python lint-python lint-shell lint-docker audit audit-npm test-py test-js \
        build-dev build-prod smoke-test scan-image \
        scan-published zizmor-sarif


##@ Checks

check: # What CI runs, offline (no token needed).
	@$(call run_report,All checks,$(CI_JOBS))

ci: export ZIZMOR_ONLINE := 1
ci: check ##> Exactly what the CI workflow runs (uses your gh login).

security: export ZIZMOR_ONLINE := 1
security: # Exactly what the daily Security workflow runs (uses your gh login).
	@$(call run_report,Security,$(SECURITY_JOBS))


# CI jobs

check-workflows: check-parity # Lint GitHub workflows (parity, actionlint, zizmor).
	scripts/ci/lint-workflows.sh

check-code: check-python lint-shell lint-python audit audit-npm test-py test-js # Check Python version, lint, audit, run Python and JS tests.

check-python: # Dockerfile and requires-python agree on Python version.
	scripts/ci/check-python.sh

check-image: lint-docker build-prod test-image # Lint Docker config, build and test prod image.

test-image: smoke-test scan-image # Smoke-test and scan existing CI_IMAGE (no build).


# Building blocks

check-parity: # Workflows run exactly the targets in CI_JOBS, SECURITY_JOBS, RELEASE_JOBS.
	scripts/ci/check-parity.sh

lint-python audit test-py: build-dev

lint-python: # Ruff lint and format check.
	scripts/ci/lint-python.sh

lint-shell: # ShellCheck all scripts.
	scripts/ci/lint-shell.sh

lint-docker: # Hadolint and Compose validation.
	scripts/ci/lint-docker.sh

audit: # Audit production dependencies.
	scripts/ci/audit.sh

audit-npm: # Audit the npm lockfile (fails only on findings that have a fix).
	scripts/ci/audit-npm.sh

test-py: # Tests with coverage (coverage.xml, htmlcov/).
	scripts/ci/test-py.sh

test-js: # JavaScript unit tests (node --test).
	scripts/ci/test-js.sh

build-dev: # Build dev image.
	scripts/ci/build-image.sh dev "$(CI_DEV_IMAGE)"

build-prod: # Build production image.
	scripts/ci/build-image.sh production "$(CI_IMAGE)"

smoke-test: # Smoke-test CI_IMAGE.
	scripts/ci/smoke-test.sh

scan-image: # Scan CI_IMAGE for vulnerabilities.
	scripts/ci/scan-image.sh

# Scheduled security

# Default SARIF paths for local runs; security.yml sets the same paths.
scan-published: export SARIF_FILE ?= reports/trivy-latest.sarif
zizmor-sarif:   export SARIF_FILE ?= reports/zizmor.sarif

scan-published: # Scan the published image (latest + current X.Y) with Trivy.
	scripts/ci/scan-published.sh

zizmor-sarif: # Online zizmor audit as SARIF (uses your gh login).
	scripts/ci/zizmor-sarif.sh

# Reports

# make report-TARGET: run TARGET with a summary report (what CI runs),
# for example `make report-check-code`.
report-%:
	@$(call run_report,$*,$*)

print-%:
	@printf '%s\n' '$($*)'