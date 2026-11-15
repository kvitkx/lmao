"""The version of lmao, read from pyproject.toml."""

import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def lmao_version() -> str | None:
    """Reads the project version.

    Returns:
        str | None: The version, or None if pyproject.toml is missing or
            has no version.
    """
    try:
        with open(PYPROJECT, "rb") as f:
            return tomllib.load(f)["project"]["version"]
    except OSError, ValueError, KeyError:
        return None
