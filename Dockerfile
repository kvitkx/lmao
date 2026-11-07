FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv


FROM python:3.15.2-slim@sha256:e97b88e416c3c01eb427b21fd8cd3ebf006e6ee38afcfcc3cae1c54ee2ab0a75 AS base

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


FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS css-deps

WORKDIR /build

# Build tools only, never copied into the final image. --ignore-scripts: no
# install script of a dependency runs in the build.
COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

FROM css-deps AS css

# Only what the class scan reads (see the @source lines of input.css).
COPY static/css/input.css static/css/input.css
COPY static/js/ static/js/
COPY templates/ templates/

RUN ./node_modules/.bin/tailwindcss \
    --input static/css/input.css \
    --output /build/app.css \
    --minify


# Just the stylesheet: `make css` exports it, the production stage copies it.
FROM scratch AS css-out
COPY --from=css /build/app.css /app.css


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
COPY --from=css-out /app.css /app/static/css/app.css
COPY templates/ /app/templates/
COPY app.py /app/

RUN mkdir -p /app/history && \
    chown appuser:appuser /app/history

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