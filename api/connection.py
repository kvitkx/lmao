"""The saved connection to an OpenAI-compatible API and its checks."""

from flask import Blueprint, jsonify, request

from core.connection import ERROR_TEXTS, InvalidConnection, public_view
from core.preflight import run_preflight

from .errors import ApiError
from .providers import openai_client
from .services import get_services
from .validation import json_object

bp = Blueprint("connection", __name__)


@bp.get("/api/connection")
def get_connection():
    """Returns the saved connection to an OpenAI-compatible API.

    The key is never part of the response: only the base URL, the model and the
    last four characters of the key.

    Returns:
        Response: {"connection": {base_url, model, key_last4}} or
            {"connection": null}.
    """
    store = get_services().connection_store
    return jsonify({"connection": public_view(store.load())}), 200


@bp.put("/api/connection")
def put_connection():
    """Saves the connection.

    Expects base_url and api_key, and optionally model, price_in and price_out
    (prices per million tokens, both or neither). An empty api_key keeps the
    saved key, but only while the base URL stays the same. A missing optional
    field is cleared.

    Returns:
        Response: The saved connection as in GET, or a 400 response with the
            reason.
    """
    data = json_object()
    try:
        saved = get_services().connection_store.save(
            data.get("base_url"),
            data.get("api_key"),
            data.get("model"),
            data.get("price_in"),
            data.get("price_out"),
        )
    except InvalidConnection as e:
        raise ApiError(ERROR_TEXTS[e.code]) from e
    return jsonify({"connection": public_view(saved)}), 200


@bp.delete("/api/connection")
def delete_connection():
    """Removes the saved connection (and with it the key)."""
    get_services().connection_store.delete()
    return jsonify({"connection": None}), 200


@bp.post("/api/connection/test")
def check_connection():
    """Runs the preflight checks against the saved connection.

    The key never comes from the request: the checks use the saved connection,
    so the form saves first and then tests. The body is optional; `model`
    overrides the saved default model.

    Returns:
        Response: {"ok": bool, "checks": [...]} (see core/preflight.py), or a
            400 response when there is no connection or no model.
    """
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise ApiError("Invalid JSON payload")

    connection = get_services().connection_store.load()
    if connection is None:
        raise ApiError("There is no saved connection to test.")

    model = data.get("model") or connection["model"]
    if not isinstance(model, str) or not model.strip():
        raise ApiError("Choose a model to test.")

    report = run_preflight(openai_client(connection), model.strip())
    return jsonify(report), 200
