SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory
.NOTPARALLEL:
.DEFAULT_GOAL := help

export UID := $(shell id -u)
export GID := $(shell id -g)

COMPOSE_GPU := $(if $(filter 1,$(GPU)),-f compose.gpu.yaml)
CMD_DEV     := docker compose -f compose.yaml -f compose.dev.yaml $(COMPOSE_GPU)
CMD_PROD    := docker compose -f compose.yaml -f compose.prod.yaml $(COMPOSE_GPU)
CMD_ACTIVE  := $(if $(filter prod,$(ENV)),$(CMD_PROD),$(CMD_DEV))

.PHONY: help models-volume dev prod run pull logs shell down format test css clean reset bump release-plan


##@ General

help: ##> Show this help message.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-20s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)
	@printf '\n\033[1;33mVariables\033[0m\n'
	@printf '  \033[36m%-20s\033[0m %s\n' \
		'ENV=prod|all' 'Environment for logs, shell and down (default: dev; all is for down only).' \
		'GPU=1' 'Add the NVIDIA GPU to dev and prod (needs NVIDIA Container Toolkit).' \
		'MODEL=name' 'Model to download with pull.' \
		'ARGS=...' 'Arguments for pytest in test, for example ARGS="-k export -x".' \
		'PART=...' 'Version part for bump: patch, minor or major (plus alpha, beta, rc or stable).'


##@ Environment

# Internal: the models volume is external, so Compose does not create it.
models-volume:
	@docker volume inspect ollama >/dev/null 2>&1 || docker volume create ollama >/dev/null

dev: models-volume ##> Start DEV with hot reload and css rebuild on port 5000.
	@test -z "$$($(CMD_PROD) ps -q)" || { echo "prod is running: run 'make down ENV=prod' first (dev and prod share the models volume and the GPU)." >&2; exit 1; }
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:5000"

prod: models-volume ##> Start PROD locally on port 5001.
	@test -z "$$($(CMD_DEV) ps -q)" || { echo "dev is running: run 'make down' first (dev and prod share the models volume and the GPU)." >&2; exit 1; }
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:5001"

run: static/css/app.css ##> Run on the host with uv (builds the css in Docker if needed).
	uv run --locked flask --app app run

# dev and prod never run together (see the guards above), so whichever Ollama
# is up is the one to talk to. The models volume is shared, so the model is
# available in both environments afterwards.
pull: ##> Pull a model into the running Ollama (make pull MODEL=name).
	@test -n "$(MODEL)" || { echo "Usage: make pull MODEL=name" >&2; exit 1; }
	@if test -n "$$($(CMD_DEV) ps -q ollama)"; then \
		$(CMD_DEV) exec ollama ollama pull "$(MODEL)"; \
	elif test -n "$$($(CMD_PROD) ps -q ollama)"; then \
		$(CMD_PROD) exec ollama ollama pull "$(MODEL)"; \
	else \
		echo "Ollama is not running: start it with 'make dev' or 'make prod'." >&2; \
		exit 1; \
	fi

logs: ##> Follow logs.
	$(CMD_ACTIVE) logs -f

shell: ##> Open bash in app.
	$(CMD_ACTIVE) exec app /bin/bash

down: ##> Stop the environment.
ifeq ($(ENV),all)
	$(CMD_DEV) down --remove-orphans
	$(CMD_PROD) down --remove-orphans
else
	$(CMD_ACTIVE) down --remove-orphans
endif


##@ Code

format: ##> Fix and format Python files (changes source!).
	scripts/dev/format.sh

test: ##> Run Python and JS tests, no coverage.
	scripts/dev/test.sh $(ARGS)

# What the css stage of the Dockerfile reads (see its COPY lines).
CSS_SOURCES := Dockerfile package.json package-lock.json tsconfig.json scripts/build-assets.sh \
    static/css/input.css $(shell find frontend types templates -type f)

# Rebuilt only when a source is newer. `touch`: a BuildKit cache hit exports the
# files with their old time, and this rule would then run on every call.
static/css/app.css: $(CSS_SOURCES)
	docker buildx build --target assets-out --output type=local,dest=static .
	@touch $@

# Hidden from help: `make dev` and `make run` build the css themselves.
# `make -B css` forces a rebuild (for example after deleting static/fonts).
css: static/css/app.css


##@ Cleanup

clean: ##> Remove reports and caches.
	scripts/dev/clean.sh

reset: ##> Clean + remove containers, prod history and the saved connection (models are kept).
	scripts/dev/clean.sh --volumes

##@ Release

bump: ##> Bump the version and open the release PR.
	scripts/dev/bump.sh $(PART)

release-plan: ##> Show the tag the current version would release.
	scripts/release/plan.sh

include ci.mk