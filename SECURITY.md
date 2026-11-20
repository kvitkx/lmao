# Security Policy

## Supported versions

Only the latest release (`ghcr.io/kvitkx/lmao:latest`) receives fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: **Security** tab, then **Report a vulnerability**. Include the version, steps to reproduce and the impact. Reports are handled on a best-effort basis.

## Security model

lmao is a local tool for one trusted user. It has no authentication: anyone who can reach its port can run evaluations, read the history, use your Ollama models and use the saved API key (the key itself is never returned).

- Compose binds the app to `127.0.0.1` only (`make ci` enforces it). Do not expose the app or Ollama (`11434`) to a network without a reverse proxy or VPN that adds authentication.
- The production image runs as a non-root user.

## Data handling

- **Local judge (default):** prompts and answers go only to your own Ollama.
- **Ollama cloud judge (off by default):** questions, criteria, reference answers and all candidate answers are sent to Ollama's cloud service. Do not use it with confidential data.
- **OpenAI-compatible judge (off by default):** the same data goes to the API you configure. The key is saved on the server in `data/connection.json` (mode `0600`) as plain text, because the app has no secret to encrypt it with. It is never returned to the browser and never written to logs or run results. Changing the base URL requires entering the key again, so a request cannot send a saved key to another host.
- **Page assets:** the page loads no scripts, styles or fonts from other hosts. The browser talks only to the app.
- **History:** every run is saved as JSON in `data/history/` (the `app_data` Docker volume in prod) with your questions and the model answers. `make reset` removes the prod volume.

## Untrusted model output

Candidate answers are wrapped in delimiters and given to the judge as data, and the grade must match a fixed JSON schema. This reduces but does not eliminate prompt injection, so scores are not a security boundary.

- The UI renders model output as text, never as HTML: Markdown becomes elements through `createElement` and text nodes, and a test fails if a script uses an HTML-writing API.
- CSV exports prefix cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return with an apostrophe, so a spreadsheet does not run them as formulas.
- Markdown exports fence model answers with a fence longer than any backtick run inside them and quote the judge text.

## Supply chain

- Images and Actions are pinned by digest or SHA. Dependencies are locked with hashes (`uv.lock`, `package-lock.json`). Nothing is loaded from a CDN at runtime.
- CI runs Trivy on the image, `pip-audit` and `npm audit` on dependencies and zizmor on workflows; daily scheduled scans cover the published image and both lockfiles, with results in code scanning. `npm audit` fails only on HIGH or CRITICAL findings that have a fix; findings without a fix are a warning. CodeQL runs on pushes and pull requests.
- Dependabot alerts, security updates and grouped version updates are enabled (security updates skip the cooldown). Secret scanning and push protection are enabled.
- Release images are attested with build provenance, stored in the GitHub Attestations API only. Verify one with
  `gh attestation verify oci://ghcr.io/kvitkx/lmao:latest --repo kvitkx/lmao`.
- Releases are immutable. `main` and `v*` tags are protected by rulesets: pull requests with required CI checks, squash-only merges with linear history, no direct or force pushes, no tag deletion.