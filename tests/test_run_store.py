"""
Unit tests for the saved runs on disk. No Flask, no HTTP.
"""

import os

import pytest

from api.errors import ApiError
from api.run_store import RunStore
from core.evaluator import SCHEMA_VERSION
from core.jsonfile import write_json

RUN = "run_x_20260101_000000"


@pytest.fixture
def store(tmp_path):
    return RunStore(str(tmp_path / "history"))


def _save(store, task_id=RUN, **fields):
    folder = os.path.join(store.history_dir, task_id)
    os.makedirs(folder)
    write_json(
        os.path.join(folder, "evaluation_results.json"),
        {"schema_version": SCHEMA_VERSION, **fields},
    )
    return folder


def test_there_are_no_ids_without_a_history_directory(store):
    assert store.ids() == []


@pytest.mark.parametrize(
    "task_id", ["nope", ".hidden", "run_", "run_a/../../x", "run_a\n", None, 5]
)
def test_an_id_that_is_not_a_run_id_is_a_400(store, task_id):
    assert store.path(task_id) is None
    with pytest.raises(ApiError) as error:
        store.folder(task_id)

    assert (error.value.message, error.value.status) == ("Invalid task_id", 400)


def test_read_returns_a_run_in_the_current_schema_only(store):
    _save(store, RUN, judge_model="j")
    _save(store, "run_old_20260101_000000", schema_version=SCHEMA_VERSION - 1)

    assert store.read(RUN)["judge_model"] == "j"
    assert store.read("run_old_20260101_000000") is None
    assert store.read("run_missing_20260101_000000") is None
    assert store.read("nope") is None


def test_load_adds_the_metrics_and_names_what_is_wrong(store):
    folder = _save(store)
    write_json(
        os.path.join(folder, "technical_metrics.json"),
        {"metrics": {"m": {"tokens_per_second": 1.0}}},
    )

    assert store.load(RUN)["metrics"] == {"m": {"tokens_per_second": 1.0}}
    with pytest.raises(ApiError) as missing:
        store.load("run_missing_20260101_000000")
    assert missing.value.status == 404
    with pytest.raises(ApiError) as invalid:
        store.load("nope")
    assert invalid.value.status == 400


def test_a_title_is_stored_and_an_empty_one_restores_the_default(store):
    folder = _save(store)

    store.set_title(RUN, "mine")
    assert store.title(RUN) == "mine"
    store.set_title(RUN, "")

    assert store.title(RUN) is None
    assert not os.path.exists(os.path.join(folder, "meta.json"))
    assert store.title("nope") is None


def test_delete_removes_the_folder_and_a_missing_run_is_a_404(store):
    folder = _save(store)

    store.delete(RUN)

    assert not os.path.exists(folder)
    with pytest.raises(ApiError) as error:
        store.delete(RUN)
    assert error.value.status == 404
