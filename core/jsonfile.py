"""Reading and writing the JSON files the server keeps on disk.

Pure module: no app state and no model calls. The pipeline (run files) and the
API (run files, titles) share these two functions.
"""

import json
import os


def read_json(path: str) -> dict | None:
    """Reads a JSON object from disk.

    Args:
        path (str): The file to read.

    Returns:
        dict | None: The object, or None if the file is missing, unreadable,
            not valid JSON or not a JSON object.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError, ValueError:
        return None
    return data if isinstance(data, dict) else None


def write_json(path: str, data: dict) -> None:
    """Writes through a temporary file: a crash never leaves half a file."""
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(temporary, path)
