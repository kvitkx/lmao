"""The one error the API reports: a message and a status code."""

from flask import Flask, jsonify


class ApiError(Exception):
    """An error that is sent to the client as {"error": message}.

    Attributes:
        message (str): The text the client sees.
        status (int): The HTTP status code.
    """

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _api_error(error: ApiError):
        return jsonify({"error": error.message}), error.status
