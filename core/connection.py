"""Saved connection to an OpenAI-compatible API.

The connection (base URL, API key and default model) lives in one JSON file on
the server. The key is stored as plain text with owner-only permissions: the app
has no secret to encrypt it with. It never leaves the server: `public_view()` is
the only form of the connection that an API response may contain.
"""

import json
import os
from urllib.parse import urlsplit

MAX_URL_LENGTH = 200
MAX_KEY_LENGTH = 500
MAX_MODEL_LENGTH = 200


class InvalidConnection(ValueError):
    """Raised when the connection fields cannot be saved."""


def normalize_url(value) -> str:
    """Checks a base URL and returns it without a trailing slash.

    Raises:
        InvalidConnection: If it is not an http(s) URL with a host, or it
            carries credentials, a query or a fragment.
    """
    if not isinstance(value, str) or not value.strip():
        raise InvalidConnection("Field 'base_url' must be a URL.")

    url = value.strip().rstrip("/")
    if len(url) > MAX_URL_LENGTH:
        raise InvalidConnection("Field 'base_url' is too long.")

    try:
        parts = urlsplit(url)
        _ = parts.port  # a bad port number raises ValueError here
    except ValueError:
        raise InvalidConnection("Field 'base_url' is not a valid URL.") from None

    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise InvalidConnection("Field 'base_url' must start with http:// or https://.")
    if "@" in parts.netloc or parts.query or parts.fragment:
        raise InvalidConnection(
            "Field 'base_url' must not contain credentials, a query or a fragment."
        )
    return url


def _clean_key(value) -> str:
    """Returns the key, or an empty string if none was given."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InvalidConnection("Field 'api_key' must be a string.")

    key = value.strip()
    if len(key) > MAX_KEY_LENGTH:
        raise InvalidConnection("Field 'api_key' is too long.")
    if key and not (key.isascii() and key.isprintable() and " " not in key):
        raise InvalidConnection(
            "Field 'api_key' contains characters that are not allowed."
        )
    return key


def _clean_model(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value.strip()) > MAX_MODEL_LENGTH:
        raise InvalidConnection("Field 'model' must be a model name.")
    return value.strip()


def public_view(connection: dict | None) -> dict | None:
    """The only form of the connection an API response may contain.

    Args:
        connection (dict | None): The result of `ConnectionStore.load()`.

    Returns:
        dict | None: base_url, model and key_last4 (the last four characters
            of the key, empty for a short key), or None without a connection.
    """
    if connection is None:
        return None

    key = connection["api_key"]
    return {
        "base_url": connection["base_url"],
        "model": connection["model"],
        "key_last4": key[-4:] if len(key) >= 8 else "",
    }


class ConnectionStore:
    """Reads and writes the saved connection.

    Attributes:
        path (str): The JSON file. Its directory is created on the first save.
    """

    def __init__(self, path: str):
        self.path = path

    def load(self) -> dict | None:
        """Reads the connection.

        Returns:
            dict | None: base_url, api_key and model, or None if the file is
                missing or damaged.
        """
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except OSError, ValueError:
            return None

        if not isinstance(data, dict):
            return None
        base_url, api_key, model = (
            data.get("base_url"),
            data.get("api_key"),
            data.get("model"),
        )
        if not (isinstance(base_url, str) and base_url):
            return None
        if not (isinstance(api_key, str) and api_key):
            return None
        return {
            "base_url": base_url,
            "api_key": api_key,
            "model": model if isinstance(model, str) else "",
        }

    def save(self, base_url, api_key=None, model=None) -> dict:
        """Validates and saves the connection.

        An empty `api_key` keeps the saved key, but only for the same base URL:
        a key must never follow a changed URL to another host.

        Raises:
            InvalidConnection: If a field is not acceptable or the key is
                missing.

        Returns:
            dict: The saved base_url, api_key and model.
        """
        url = normalize_url(base_url)
        key = _clean_key(api_key)
        model_name = _clean_model(model)

        if not key:
            current = self.load()
            if current is None:
                raise InvalidConnection("Field 'api_key' is required.")
            if current["base_url"] != url:
                raise InvalidConnection(
                    "Enter the API key again: the base URL changed."
                )
            key = current["api_key"]

        connection = {"base_url": url, "api_key": key, "model": model_name}
        self._write(connection)
        return connection

    def delete(self) -> None:
        """Removes the saved connection. Does nothing if there is none."""
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass

    def _write(self, connection: dict) -> None:
        """Writes the file through a temporary one, readable by the owner only."""
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, mode=0o700, exist_ok=True)

        temporary = f"{self.path}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(connection, f)
        os.replace(temporary, self.path)
