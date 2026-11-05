# lmao

**Local Model Assessment Operator.** Benchmark local LLMs with [Ollama](https://ollama.com): blind grading against a reference, plus speed, ending in a recommendation.

Source code, documentation and issues: https://github.com/ykvit/lmao

## Quick start

You need a running [Ollama](https://ollama.com) with at least two models (one judge and one candidate): `ollama pull MODEL_NAME`.

If Ollama runs on your machine:

```bash
docker run -d --name lmao \
  -p 127.0.0.1:5000:5000 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  --add-host=host.docker.internal:host-gateway \
  -v lmao_history:/app/history \
  kvitkx/lmao:latest
```

Open **http://localhost:5000**. Stop with `docker stop lmao`.

- `--add-host` is needed on Linux. Docker Desktop on macOS and Windows resolves `host.docker.internal` on its own.
- On Linux, Ollama must accept connections from the Docker bridge: start it with `OLLAMA_HOST=0.0.0.0`. Keep that port closed to your network.
- Results of every run are stored in the `lmao_history` volume (`/app/history`).

## Docker Compose

lmao and Ollama together:

```yaml
services:
  lmao:
    image: kvitkx/lmao:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:5000:5000"
    environment:
      - OLLAMA_BASE_URL=http://ollama:11434
    volumes:
      - lmao_history:/app/history
    depends_on:
      ollama:
        condition: service_healthy

  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    environment:
      - OLLAMA_MAX_LOADED_MODELS=1
    volumes:
      - ollama_data:/root/.ollama
    healthcheck:
      test: ["CMD", "ollama", "ps"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 30s
    # NVIDIA GPU (needs NVIDIA Container Toolkit): uncomment
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]

volumes:
  lmao_history:
  ollama_data:
```

```bash
docker compose up -d
docker compose exec ollama ollama pull MODEL_NAME
```

Open **http://localhost:5000**. Stop with `docker compose down` (volumes with models and history are kept).

## Tags

| Tag | Meaning |
|---|---|
| `latest` | The newest stable release |
| `X.Y` | The newest patch release of a minor version, for example `2.2` |
| `X` | The newest release of a major version (from `1.x` on) |
| `X.Y.Z` | An exact release, for example `2.2.2` |

Pre-releases (`X.Y.ZrcN` and similar) get only the exact tag. See the [releases](https://github.com/ykvit/lmao/releases).

The same image (same digest) is also published to GHCR: `ghcr.io/ykvit/lmao`.

## Verify the image

Every release is built once in GitHub Actions, scanned with Trivy and attested:

```bash
gh attestation verify oci://docker.io/kvitkx/lmao:latest --repo ykvit/lmao
```

## Security

lmao is a local tool for one trusted user and has no authentication. Do not expose its port to a network, which is why the examples bind to `127.0.0.1`. Details and how to report a vulnerability: [SECURITY.md](https://github.com/ykvit/lmao/blob/main/SECURITY.md).

## License

[MIT](https://github.com/ykvit/lmao/blob/main/LICENSE)