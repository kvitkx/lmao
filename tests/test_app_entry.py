"""
Checks of the entry point and of the direction of the imports.
"""

import importlib
from pathlib import Path

from flask import Flask

ROOT = Path(__file__).parent.parent


def test_the_entry_point_exposes_the_app():
    module = importlib.import_module("app")

    assert isinstance(module.app, Flask)


def test_core_never_imports_the_api():
    for path in (ROOT / "core").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from api" not in text, path.name
        assert "import api" not in text, path.name
