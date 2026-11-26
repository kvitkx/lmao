"""The page itself and the health check."""

from flask import Blueprint, render_template

bp = Blueprint("system", __name__)


@bp.get("/")
def index():
    """Renders the main Single Page Application (SPA) dashboard.

    Returns:
        str: The rendered HTML template.
    """
    return render_template("index.html")


@bp.get("/health")
def health_check():
    """Checks the health status of the service.

    Returns:
        A tuple containing a dictionary with the status and an HTTP 200 code.
    """
    return {"status": "ok"}, 200
