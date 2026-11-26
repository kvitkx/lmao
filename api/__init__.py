"""The HTTP API of lmao.

`create_app()` is the application factory: it builds the shared `Services` (one
set per app, so a test gets a fresh state) and registers one blueprint per
feature. `app.py` only calls it.
"""

import os

from flask import Flask

from . import connection, estimate, evaluation, providers, runs, system
from .errors import register_error_handlers
from .services import Services, build_services

# The templates and the static files live next to `api/`, not inside it.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# An SSE stream that writes nothing never notices a closed connection, and
# gunicorn has only a few threads. A comment line every few seconds fixes that.
HEARTBEAT_SEC = 15


def create_app(services: Services | None = None) -> Flask:
    """Builds the Flask app.

    Args:
        services (Services, optional): The shared objects. Defaults to the real
            ones (local Ollama, the data directory).

    Returns:
        Flask: The app. The services are in `app.extensions["lmao"]`.
    """
    app = Flask(__name__, root_path=ROOT)
    app.config["HEARTBEAT_SEC"] = HEARTBEAT_SEC
    app.extensions["lmao"] = services or build_services()
    register_error_handlers(app)
    for module in (system, providers, evaluation, runs, connection, estimate):
        app.register_blueprint(module.bp)
    return app
