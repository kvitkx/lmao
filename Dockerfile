FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv


FROM python:3.14.9-slim@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8 AS base

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