"""
Unit tests for reading and writing the JSON files of the server.
"""

import pytest

from core.jsonfile import read_json, write_json


def test_a_written_object_is_read_back(tmp_path):
    path = str(tmp_path / "a.json")

    write_json(path, {"title": "я"})

    assert read_json(path) == {"title": "я"}
    assert "я" in open(path, encoding="utf-8").read()


def test_write_leaves_no_temporary_file(tmp_path):
    write_json(str(tmp_path / "a.json"), {})

    assert [p.name for p in tmp_path.iterdir()] == ["a.json"]


def test_a_missing_file_reads_as_none(tmp_path):
    assert read_json(str(tmp_path / "missing.json")) is None


@pytest.mark.parametrize("content", ["", "{not json", "[]", "5", "null"])
def test_a_damaged_file_or_a_non_object_reads_as_none(tmp_path, content):
    path = tmp_path / "a.json"
    path.write_text(content, encoding="utf-8")

    assert read_json(str(path)) is None
