FROM ghcr.io/astral-sh/uv:0.13.8@sha256:5cc1805e2426484abca4ad46ea783bab281fdb225fd82d8ce6d66a81254bac85 AS uv


FROM python:3.15.2-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS base

# No apt-get upgrade: OS patches arrive via base image bumps (Dependabot),
# which keeps this layer reproducible.
RUN (python3 -m pip uninstall -y pip setuptools wheel 2>/dev/null || true)

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app


FROM base AS deps

COPY --from=uv /uv /uvx /bin/

# UV_NO_BUILD: fail instead of compiling, so no compiler is needed in the image.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_NO_BUILD=1

COPY pyproject.toml uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project \
    --python /usr/local/bin/python --no-python-downloads


FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS css-deps

WORKDIR /build

# Build tools only, never copied into the final image. --ignore-scripts: no
# install script of a dependency runs in the build.
COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

FROM css-deps AS css

COPY scripts/build-assets.sh scripts/build-assets.sh

# What the build reads: the class scan (see the @source lines of input.css)
# and the TypeScript sources.
COPY static/css/input.css static/css/input.css
COPY tsconfig.json tsconfig.json
COPY frontend/ frontend/
COPY types/ types/
COPY templates/ templates/

# /build/out has the layout of /app/static: Alpine, the fonts, the scripts and the stylesheet.
RUN sh scripts/build-assets.sh node_modules /build/out && \
    ./node_modules/.bin/tsc --project tsconfig.json --outDir /build/out/js && \
    ./node_modules/.bin/tailwindcss \
      --input static/css/input.css \
      --output /build/out/css/app.css \
      --minify


FROM css-deps AS typecheck

COPY tsconfig.json tsconfig.check.json playwright.config.ts ./
COPY frontend/ frontend/
COPY types/ types/
COPY tests/js/ tests/js/
COPY tests/dom/ tests/dom/

RUN ./node_modules/.bin/tsc --project tsconfig.check.json


# Browser smoke test (scripts/ci/test-dom.sh). The Playwright image brings the
# browsers, and its version must equal @playwright/test in package.json
# (make check-playwright). Never part of the production image.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS dom-test

WORKDIR /build

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json playwright.config.ts ./
COPY tests/dom/ tests/dom/

CMD ["npx", "playwright", "test"]


# What the page loads from /static: `make css` exports it, the production
# stage copies it. Nothing comes from a CDN.
FROM scratch AS assets-out
COPY --from=css /build/out /


FROM deps AS dev

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project \
    --python /usr/local/bin/python --no-python-downloads

COPY . .

CMD ["flask", "--app", "app", "run", "--host=0.0.0.0", "--port=5000", "--debug"]


FROM base AS production

RUN groupadd -r appuser && useradd -r -m -g appuser appuser

COPY --from=deps /opt/venv /opt/venv

COPY core/ /app/core/
COPY static/ /app/static/
COPY --from=assets-out / /app/static/
COPY templates/ /app/templates/
COPY app.py pyproject.toml /app/

RUN mkdir -p /app/data && \
    chown appuser:appuser /app/data

ENV HOME=/home/appuser

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:5000/health')"]

CMD ["gunicorn", \
     "--workers", "1", \
     "--threads", "4", \
     "--worker-tmp-dir", "/dev/shm", \
     "--bind", "0.0.0.0:5000", \
     "app:app"]