"""
Unit tests for the version of lmao.
"""

import tomllib
from pathlib import Path

from core.version import lmao_version

ROOT = Path(__file__).parent.parent


def test_the_version_is_the_one_in_pyproject():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert lmao_version() == project["project"]["version"]


def test_a_missing_pyproject_gives_no_version(monkeypatch, tmp_path):
    monkeypatch.setattr("core.version.PYPROJECT", tmp_path / "missing.toml")

    assert lmao_version() is None
