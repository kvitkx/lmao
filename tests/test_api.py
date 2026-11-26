"""
Unit tests for the Flask API endpoints.

The Ollama client and the worker thread are replaced, and every test runs on a
fresh app in an empty temporary working directory (see ``conftest.py``), so
nothing here touches a real Ollama or the real ``data/`` folder.
"""

import json
import os
import re
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from api import evaluation
from api.validation import sanitize_tag
from core.evaluator import SCHEMA_VERSION
from core.openai_client import OpenAIClient
from core.prompts import GRADE_SCHEMA


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _parse_sse(response):
    body = response.get_data(as_text=True)
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


def _run(judge="judge-model", models=("m1", "m2"), questions=2):
    """The parts of a current-schema evaluation_results.json the API reads."""
    return {
        "schema_version": SCHEMA_VERSION,
        "judge_model": judge,
        "questions_results": [
            {"id": f"q{number}", "results": []} for number in range(1, questions + 1)
        ],
        "summary": {
            "models": [{"model": model} for model in models],
            "recommendation": {},
            "text": "",
        },
    }


def _payload(**overrides):
    payload = {
        "judge": "j",
        "candidates": ["m"],
        "test_cases": [{"tag": "My Tag!", "question": "Q"}],
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def installed_models(services):
    with patch.object(services.ollama, "get_models", return_value=["j", "m"]):
        yield


@pytest.fixture
def spawn(services):
    """Records the worker the API would start instead of starting it."""
    services.spawn = MagicMock()
    return services.spawn


# --- health and index -------------------------------------------------------


def test_health_check_returns_200(client):
    """
    Test that the /health endpoint returns a 200 OK status
    and the correct JSON response.
    """
    response = client.get("/health")

    assert response.status_code == 200
    assert response.is_json
    assert response.get_json() == {"status": "ok"}


def test_index_page_loads(client):
    """
    Test that the root URL (/) serves the index.html page.
    """
    response = client.get("/")

    assert response.status_code == 200
    # The response should contain some standard HTML tags
    assert b"<!DOCTYPE html>" in response.data or b"<html" in response.data


# --- helpers ----------------------------------------------------------------


@pytest.mark.parametrize(
    "tag, expected",
    [
        ("", "run"),
        ("   ", "run"),
        (None, "run"),
        (42, "run"),
        ("python_test", "python_test"),
        ("My Tag!", "My_Tag_"),
        ("../etc/passwd", "___etc_passwd"),
        ("x" * 60, "x" * 40),
    ],
)
def test_sanitize_tag(tag, expected):
    assert sanitize_tag(tag) == expected


def test_publish_appends_event_with_timestamp(registry):
    registry.add("t")

    registry.publish("t", {"type": "info", "message": "hi"})

    [event] = registry.get("t").events
    assert event["message"] == "hi"
    assert "timestamp" in event
    assert registry.get("t").status == "started"


@pytest.mark.parametrize("final_type", ["completed", "error"])
def test_publish_marks_task_finished(registry, final_type):
    registry.add("t")

    registry.publish("t", {"type": final_type, "message": "x"})

    assert registry.get("t").status == final_type


def test_publish_ignores_unknown_task(registry):
    registry.publish("missing", {"type": "info"})

    assert registry.ids() == []


def test_run_task_runs_the_pipeline(services):
    with patch.object(services.pipeline, "run_evaluation") as run_evaluation:
        evaluation.run_task(services, "t", {"judge": "j"}, "provider")

    run_evaluation.assert_called_once_with(
        "t",
        {"judge": "j"},
        services.registry.publish,
        "provider",
        saved=None,
        cancel=None,
    )


def test_run_task_reports_a_crash_to_the_stream(services, registry):
    registry.add("t")

    with patch.object(
        services.pipeline, "run_evaluation", side_effect=RuntimeError("boom")
    ):
        evaluation.run_task(services, "t", {})

    [event] = registry.get("t").events
    assert event["type"] == "error"
    assert "boom" in event["message"]
    assert registry.get("t").status == "error"


# --- /api/models ------------------------------------------------------------


def test_models_endpoint_returns_installed_models(client, services):
    with patch.object(services.ollama, "get_models", return_value=["a:1b", "b:2b"]):
        response = client.get("/api/models")

    assert response.status_code == 200
    assert response.get_json() == {"models": ["a:1b", "b:2b"]}


def test_models_endpoint_returns_empty_list_when_ollama_is_down(client, services):
    with patch.object(services.ollama, "get_models", return_value=[]):
        response = client.get("/api/models")

    assert response.status_code == 200
    assert response.get_json() == {"models": []}


# --- /api/evaluate ----------------------------------------------------------


def test_evaluate_rejects_empty_payload(client):
    response = client.post("/api/evaluate", json={})

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid JSON payload"}


def test_evaluate_rejects_non_object_payload(client):
    response = client.post("/api/evaluate", json=[1, 2])

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid JSON payload"}


def test_evaluate_rejects_non_json_request(client):
    response = client.post("/api/evaluate", data="not json")

    assert response.status_code == 415


@pytest.mark.parametrize(
    "overrides",
    [
        {"judge": None},
        {"judge": ""},
        {"judge": 5},
        {"candidates": []},
        {"candidates": "m"},
        {"candidates": [1]},
        {"test_cases": []},
        {"test_cases": ["Q"]},
        {"test_cases": [{"question": "  "}]},
        {"test_cases": [{"question": 5}]},
        {"test_cases": [{"question": "Q", "tag": 5}]},
        {"test_cases": [{"question": "Q", "reference": None}]},
        {"base_rationale": 5},
        {"judge_provider": "yes"},
        {"judge_provider": 5},
    ],
)
def test_evaluate_rejects_invalid_payload(client, registry, overrides):
    response = client.post("/api/evaluate", json=_payload(**overrides))

    assert response.status_code == 400
    assert response.get_json()["error"]
    assert registry.ids() == []


def test_evaluate_rejects_models_that_are_not_installed(client, services, registry):
    with patch.object(services.ollama, "get_models", return_value=["j"]):
        response = client.post("/api/evaluate", json=_payload())

    assert response.status_code == 400
    assert response.get_json() == {"error": "Models are not installed: m."}
    assert registry.ids() == []


def test_evaluate_starts_background_task(
    client, services, registry, installed_models, spawn
):
    payload = _payload()

    response = client.post("/api/evaluate", json=payload)

    assert response.status_code == 202
    body = response.get_json()
    assert body["status"] == "started"
    task_id = body["task_id"]
    assert re.fullmatch(r"run_My_Tag__\d{8}_\d{6}", task_id)
    task = registry.get(task_id)
    assert task.status == "started"
    assert task.events[0]["type"] == "info"
    spawn.assert_called_once_with(evaluation.run_task, services, task_id, payload, None)


def test_evaluate_accepts_the_ollama_cloud_judge(client, installed_models, spawn):
    response = client.post(
        "/api/evaluate", json=_payload(judge_provider="ollama_cloud")
    )

    assert response.status_code == 202
    assert spawn.call_args.args[4] is None


def _save_connection(services, **overrides):
    fields = {
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-secret-1234",
        "model": "gpt-4.1-mini",
    }
    fields.update(overrides)
    return services.connection_store.save(**fields)


def test_evaluate_gives_an_openai_judge_its_saved_connection(client, services, spawn):
    _save_connection(services)
    payload = _payload(judge="gpt-4.1-mini", judge_provider="openai")

    with patch.object(services.ollama, "get_models", return_value=["m"]):
        response = client.post("/api/evaluate", json=payload)

    assert response.status_code == 202
    task_id, sent, judge_provider = spawn.call_args.args[2:]
    assert (task_id, sent) == (response.get_json()["task_id"], payload)
    assert isinstance(judge_provider, OpenAIClient)
    assert judge_provider.base_url == "https://api.example.com/v1"
    assert judge_provider.api_key == "sk-secret-1234"


def test_evaluate_rejects_an_openai_judge_without_a_connection(
    client, registry, installed_models
):
    response = client.post("/api/evaluate", json=_payload(judge_provider="openai"))

    assert response.status_code == 400
    assert response.get_json() == {
        "error": "The OpenAI judge needs a saved connection."
    }
    assert registry.ids() == []


def test_evaluate_still_checks_the_candidates_of_an_openai_judge(client, services):
    _save_connection(services)

    with patch.object(services.ollama, "get_models", return_value=[]):
        response = client.post("/api/evaluate", json=_payload(judge_provider="openai"))

    assert response.status_code == 400
    assert response.get_json() == {"error": "Models are not installed: m."}


@pytest.mark.parametrize(
    "test_cases",
    [[{"question": "Q"}], [{"question": "Q", "tag": "  "}]],
)
def test_evaluate_uses_default_tag_when_none_is_usable(
    client, installed_models, spawn, test_cases
):
    response = client.post("/api/evaluate", json=_payload(test_cases=test_cases))

    assert response.status_code == 202
    assert re.fullmatch(r"run_run_\d{8}_\d{6}", response.get_json()["task_id"])


# --- /api/connection --------------------------------------------------------


def test_connection_is_empty_by_default(client):
    response = client.get("/api/connection")

    assert response.status_code == 200
    assert response.get_json() == {"connection": None}


def test_put_connection_saves_it_and_never_returns_the_key(client, services):
    body = {
        "base_url": "https://api.example.com/v1/",
        "api_key": "sk-secret-1234",
        "model": "gpt-4.1-mini",
    }

    put = client.put("/api/connection", json=body)
    get = client.get("/api/connection")

    expected = {
        "connection": {
            "base_url": "https://api.example.com/v1",
            "model": "gpt-4.1-mini",
            "price_in": None,
            "price_out": None,
            "key_last4": "1234",
        }
    }
    assert put.status_code == 200
    assert put.get_json() == expected
    assert get.get_json() == expected
    assert b"sk-secret" not in put.data
    assert b"sk-secret" not in get.data
    assert services.connection_store.load()["api_key"] == "sk-secret-1234"


def test_put_connection_without_a_key_keeps_the_saved_one(client, services):
    _save_connection(services)

    response = client.put(
        "/api/connection",
        json={"base_url": "https://api.example.com/v1", "model": "other"},
    )

    assert response.status_code == 200
    saved = services.connection_store.load()
    assert (saved["api_key"], saved["model"]) == ("sk-secret-1234", "other")


def test_put_connection_with_a_new_url_needs_the_key_again(client, services):
    _save_connection(services)

    response = client.put(
        "/api/connection", json={"base_url": "https://evil.example.com/v1"}
    )

    assert response.status_code == 400
    assert "again" in response.get_json()["error"]
    saved = services.connection_store.load()
    assert saved["base_url"] == "https://api.example.com/v1"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"base_url": "ftp://api.example.com", "api_key": "sk-secret-1234"},
        {"base_url": "https://api.example.com/v1"},
        {"base_url": "https://api.example.com/v1", "api_key": 5},
    ],
)
def test_put_connection_rejects_invalid_fields(client, services, body):
    response = client.put("/api/connection", json=body)

    assert response.status_code == 400
    assert response.get_json()["error"]
    assert services.connection_store.load() is None


def test_put_connection_rejects_a_non_object_and_non_json(client):
    array = client.put("/api/connection", json=[1])
    text = client.put("/api/connection", data="not json")

    assert array.status_code == 400
    assert array.get_json() == {"error": "Invalid JSON payload"}
    assert text.status_code == 415


def test_delete_connection_removes_it(client, services):
    _save_connection(services)

    first = client.delete("/api/connection")
    second = client.delete("/api/connection")

    assert first.status_code == second.status_code == 200
    assert first.get_json() == {"connection": None}
    assert services.connection_store.load() is None


def test_the_connection_and_the_history_share_one_directory(services):
    connection_dir = Path(services.connection_store.path).parent

    assert connection_dir == Path(services.pipeline.history_dir).parent


def test_put_connection_returns_the_text_of_the_error(client):
    response = client.put(
        "/api/connection",
        json={"base_url": "ftp://api.example.com", "api_key": "sk-secret-1234"},
    )

    assert response.status_code == 400
    assert response.get_json() == {
        "error": "Field 'base_url' must start with http:// or https://."
    }


def test_put_connection_saves_the_prices(client):
    body = {
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-secret-1234",
        "price_in": 0.4,
        "price_out": 1.6,
    }

    response = client.put("/api/connection", json=body)

    assert response.status_code == 200
    connection = response.get_json()["connection"]
    assert (connection["price_in"], connection["price_out"]) == (0.4, 1.6)
    assert client.get("/api/connection").get_json()["connection"] == connection


@pytest.mark.parametrize(
    "prices",
    [
        {"price_in": 1},
        {"price_in": -1, "price_out": 1},
        {"price_in": "1", "price_out": 1},
    ],
)
def test_put_connection_rejects_bad_prices(client, services, prices):
    body = {
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-secret-1234",
        **prices,
    }

    response = client.put("/api/connection", json=body)

    assert response.status_code == 400
    assert response.get_json()["error"]
    assert services.connection_store.load() is None


# --- /api/connection/test ---------------------------------------------------

PREFLIGHT_REPORT = {"ok": True, "checks": []}


def test_connection_test_needs_a_saved_connection(client):
    response = client.post("/api/connection/test")

    assert response.status_code == 400
    assert response.get_json() == {"error": "There is no saved connection to test."}


def test_connection_test_needs_a_model(client, services):
    _save_connection(services, model="")

    response = client.post("/api/connection/test")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Choose a model to test."}


def test_connection_test_runs_the_preflight_on_the_saved_connection(client, services):
    _save_connection(services)

    with patch(
        "api.connection.run_preflight", return_value=PREFLIGHT_REPORT
    ) as preflight:
        response = client.post("/api/connection/test")

    assert response.status_code == 200
    assert response.get_json() == PREFLIGHT_REPORT
    provider, model = preflight.call_args.args
    assert isinstance(provider, OpenAIClient)
    assert provider.base_url == "https://api.example.com/v1"
    assert provider.api_key == "sk-secret-1234"
    assert model == "gpt-4.1-mini"


def test_connection_test_takes_the_model_from_the_request(client, services):
    _save_connection(services)

    with patch(
        "api.connection.run_preflight", return_value=PREFLIGHT_REPORT
    ) as preflight:
        client.post("/api/connection/test", json={"model": " other "})

    assert preflight.call_args.args[1] == "other"


@pytest.mark.parametrize("body", [[1], {"model": 5}])
def test_connection_test_rejects_a_bad_body(client, services, body):
    _save_connection(services)

    response = client.post("/api/connection/test", json=body)

    assert response.status_code == 400


# --- /api/budget ------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"judge": None},
        {"candidates": []},
        {"test_cases": []},
        {"judge_provider": "yes"},
    ],
)
def test_budget_rejects_an_invalid_payload(client, overrides):
    response = client.post("/api/budget", json=_payload(**overrides))

    assert response.status_code == 400
    assert response.get_json()["error"]


def test_budget_rejects_an_empty_payload(client):
    response = client.post("/api/budget", json={})

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid JSON payload"}


def test_budget_counts_calls_and_tokens_for_a_local_judge(client):
    response = client.post("/api/budget", json=_payload())

    assert response.status_code == 200
    body = response.get_json()
    assert body["judge_calls"] == {
        "references": 1,
        "grades": 1,
        "summary": 1,
        "total": 3,
    }
    assert body["tokens"]["total"]["low"] > 0
    assert body["leaves_machine"] is False
    assert body["cost"] is None


def test_budget_prices_an_openai_judge_from_the_saved_connection(client, services):
    _save_connection(services, price_in=2.0, price_out=8.0)

    body = client.post("/api/budget", json=_payload(judge_provider="openai")).get_json()

    assert body["leaves_machine"] is True
    assert 0 < body["cost"]["low"] <= body["cost"]["high"]


def test_budget_has_no_cost_without_saved_prices(client, services):
    _save_connection(services)

    body = client.post("/api/budget", json=_payload(judge_provider="openai")).get_json()

    assert body["leaves_machine"] is True
    assert body["cost"] is None


def test_budget_has_no_cost_for_the_ollama_cloud_judge(client):
    body = client.post(
        "/api/budget", json=_payload(judge_provider="ollama_cloud")
    ).get_json()

    assert body["leaves_machine"] is True
    assert body["cost"] is None


# --- /api/stream ------------------------------------------------------------


def test_stream_reports_unknown_task(client):
    response = client.get("/api/stream/nope")

    assert response.mimetype == "text/event-stream"
    assert _parse_sse(response) == [{"type": "error", "message": "Task not found"}]


def test_stream_replays_events_until_completion(client, registry):
    registry.add(
        "t1",
        status="completed",
        events=[
            {"type": "info", "message": "start"},
            {"type": "completed", "message": "done"},
            {"type": "info", "message": "never sent"},
        ],
    )

    response = client.get("/api/stream/t1")

    assert response.mimetype == "text/event-stream"
    assert [event["type"] for event in _parse_sse(response)] == ["info", "completed"]


def test_stream_stops_on_error_event(client, registry):
    registry.add("t2", status="error", events=[{"type": "error", "message": "boom"}])

    response = client.get("/api/stream/t2")

    assert _parse_sse(response) == [{"type": "error", "message": "boom"}]


def test_stream_sends_heartbeats_while_waiting(client, app, registry):
    app.config["HEARTBEAT_SEC"] = 0
    registry.add("t")

    def finish():
        time.sleep(0.2)
        registry.publish("t", {"type": "completed", "message": "done"})

    worker = threading.Thread(target=finish)
    worker.start()
    body = client.get("/api/stream/t").get_data(as_text=True)
    worker.join()

    assert ": ping" in body
    assert '"type": "completed"' in body


# --- /api/history -----------------------------------------------------------


def test_history_is_empty_without_history_directory(client):
    response = client.get("/api/history")

    assert response.status_code == 200
    assert response.get_json() == []


def test_history_lists_run_metadata(client):
    _write_json(
        Path("data/history/run_python_test_20260101_120000/evaluation_results.json"),
        _run(),
    )

    response = client.get("/api/history")

    assert response.get_json() == [
        {
            "task_id": "run_python_test_20260101_120000",
            "tag_name": "Python Test",
            "timestamp": "2026-01-01 12:00",
            "models_tested": 2,
            "questions_count": 2,
            "judge_model": "judge-model",
            "status": "completed",
            "progress": None,
        }
    ]


def test_history_is_sorted_newest_first(client):
    for task_id in ("run_a_20260101_000000", "run_a_20260102_000000"):
        _write_json(Path("data/history") / task_id / "evaluation_results.json", _run())

    response = client.get("/api/history")

    assert [run["task_id"] for run in response.get_json()] == [
        "run_a_20260102_000000",
        "run_a_20260101_000000",
    ]


def test_history_copes_with_oddly_named_runs(client):
    _write_json(Path("data/history/weird/evaluation_results.json"), _run())
    _write_json(
        Path("data/history/run_x_notadate_nottime/evaluation_results.json"), _run()
    )

    runs = {run["task_id"]: run for run in client.get("/api/history").get_json()}

    assert "weird" not in runs
    assert runs["run_x_notadate_nottime"]["tag_name"] == "X"
    assert runs["run_x_notadate_nottime"]["timestamp"] == "notadate nottime"


def test_history_skips_legacy_corrupted_and_incomplete_entries(client):
    _write_json(
        Path("data/history/run_old_20260101_000000/evaluation_results.json"),
        {"questions_results": []},
    )
    _write_json(
        Path("data/history/run_v1_20260101_000000/evaluation_results.json"),
        {**_run(), "schema_version": 2},
    )
    broken = Path("data/history/run_broken_20260101_000000/evaluation_results.json")
    broken.parent.mkdir(parents=True)
    broken.write_text("{not json", encoding="utf-8")
    Path("data/history/run_empty_20260101_000000").mkdir()
    Path("data/history/readme.txt").write_text("not a run", encoding="utf-8")

    response = client.get("/api/history")

    assert response.status_code == 200
    assert response.get_json() == []


# --- /api/results -----------------------------------------------------------


def test_results_rejects_unsafe_task_id(client):
    response = client.get("/api/results/.hidden")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid task_id"}


def test_results_returns_404_when_run_is_missing(client):
    response = client.get("/api/results/run_x_20260101_000000")

    assert response.status_code == 404
    assert response.get_json() == {"error": "Results not found or not ready"}


def test_results_returns_the_run_with_metrics(client):
    task_id = "run_x_20260101_000000"
    run_dir = Path("data/history") / task_id
    data = _run()
    _write_json(run_dir / "evaluation_results.json", data)
    _write_json(
        run_dir / "technical_metrics.json",
        {"task_id": task_id, "metrics": {"m1": {"tokens_per_second": 10.0}}},
    )

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 200
    assert response.get_json() == {
        **data,
        "metrics": {"m1": {"tokens_per_second": 10.0}},
    }


def test_results_work_without_technical_metrics(client):
    task_id = "run_x_20260101_000000"
    _write_json(Path("data/history") / task_id / "evaluation_results.json", _run())

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 200
    assert response.get_json()["metrics"] == {}


def test_results_hide_legacy_runs(client):
    task_id = "run_x_20260101_000000"
    _write_json(
        Path("data/history") / task_id / "evaluation_results.json",
        {"questions_results": []},
    )

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 404


# --- /api/results/<id>/export -----------------------------------------------


def _save_run(task_id="run_x_20260101_000000"):
    run = _run()
    # The pipeline always writes these two next to the fields _run() has.
    run["task_id"] = task_id
    run["mode"] = "local"
    run["questions_results"][0]["tag"] = "=SUM(1+1)"
    run["questions_results"][0]["results"] = [
        {
            "model_name": "m1",
            "answer": "4",
            "status": "ok",
            "category": "perfect",
            "score": 95,
            "tps": 10.0,
            "cps": 50.0,
            "time_sec": 1.0,
        }
    ]
    run_dir = Path("data/history") / task_id
    _write_json(run_dir / "evaluation_results.json", run)
    _write_json(
        run_dir / "technical_metrics.json",
        {"task_id": task_id, "metrics": {"m1": {"tokens_per_second": 10.0}}},
    )
    return task_id


@pytest.mark.parametrize(
    "fmt, mimetype",
    [
        ("json", "application/json"),
        ("csv", "text/csv"),
        ("md", "text/markdown"),
    ],
)
def test_export_sends_an_attachment(client, fmt, mimetype):
    task_id = _save_run()

    response = client.get(f"/api/results/{task_id}/export?format={fmt}")

    assert response.status_code == 200
    assert response.mimetype == mimetype
    assert response.headers["Content-Disposition"] == (
        f'attachment; filename="{task_id}.{fmt}"'
    )
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_export_json_matches_the_results_endpoint(client):
    task_id = _save_run()

    exported = client.get(f"/api/results/{task_id}/export?format=json")
    results = client.get(f"/api/results/{task_id}")

    assert exported.get_json() == results.get_json()


def test_export_csv_has_one_row_per_answer_and_defuses_formulas(client):
    task_id = _save_run()

    body = client.get(f"/api/results/{task_id}/export?format=csv").get_data(
        as_text=True
    )

    lines = body.splitlines()
    assert lines[0] == (
        "question,tag,model,score,category,status,tps,cps,time_sec,tokens,chars"
    )
    assert lines[1] == "q1,'=SUM(1+1),m1,95,perfect,ok,10.0,50.0,1.0,,"
    assert len(lines) == 2


def test_export_markdown_contains_the_report(client):
    task_id = _save_run()

    body = client.get(f"/api/results/{task_id}/export?format=md").get_data(as_text=True)

    assert body.startswith(f"# {task_id}\n")
    assert "#### m1" in body


@pytest.mark.parametrize("query", ["", "?format=", "?format=xml", "?format=CSV"])
def test_export_rejects_a_missing_or_unknown_format(client, query):
    task_id = _save_run()

    response = client.get(f"/api/results/{task_id}/export{query}")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Unknown format. Use json, csv or md."}


def test_export_rejects_unsafe_task_id(client):
    response = client.get("/api/results/.hidden/export?format=csv")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid task_id"}


def test_export_returns_404_for_missing_and_legacy_runs(client):
    task_id = "run_old_20260101_000000"
    _write_json(
        Path("data/history") / task_id / "evaluation_results.json",
        {"questions_results": []},
    )

    missing = client.get("/api/results/run_x_20260101_000000/export?format=csv")
    legacy = client.get(f"/api/results/{task_id}/export?format=csv")

    assert missing.status_code == 404
    assert legacy.status_code == 404
    assert legacy.get_json() == {"error": "Results not found or not ready"}


# --- stop and resume --------------------------------------------------------

RESUME_ID = "run_x_20260101_000000"


def _partial_run(status="stopped"):
    return {
        "schema_version": SCHEMA_VERSION,
        "task_id": RESUME_ID,
        "judge_model": "j",
        "judge_provider": "ollama",
        "mode": "local",
        "judge_is_candidate": False,
        "status": status,
        "progress": {"done": 1, "total": 4},
        "finished_steps": ["reference:j:q1"],
        "candidates": ["m"],
        "base_rationale": "",
        "finished_at": None,
        "questions_results": [
            {
                "id": "q1",
                "tag": "t",
                "question": "Q",
                "specific_rationale": "",
                "reference": {"text": "R", "source": "generated"},
                "no_reference": False,
                "results": [],
            }
        ],
        "summary": {"models": [{"model": "m"}], "recommendation": {}, "text": ""},
    }


def _save_partial(status="stopped"):
    data = _partial_run(status)
    _write_json(Path("data/history") / RESUME_ID / "evaluation_results.json", data)
    return data


def test_cancel_sets_the_flag_and_announces_it(client, registry):
    task = registry.add("t")

    response = client.post("/api/evaluate/t/cancel")

    assert response.status_code == 202
    assert response.get_json() == {"task_id": "t", "status": "stopping"}
    assert task.cancel.is_set()
    assert [event["type"] for event in task.events] == ["cancelling"]
    assert task.status == "started"


def test_cancel_unknown_task_is_404(client):
    assert client.post("/api/evaluate/nope/cancel").status_code == 404


@pytest.mark.parametrize("status", ["completed", "error", "cancelled"])
def test_cancel_a_finished_task_is_409(client, registry, status):
    registry.add("t", status=status)

    response = client.post("/api/evaluate/t/cancel")

    assert response.status_code == 409
    assert response.get_json() == {"error": "The run is not in progress."}


def test_the_cancelled_event_finishes_the_task(registry):
    registry.add("t")

    registry.publish("t", {"type": "cancelled"})

    assert registry.get("t").status == "cancelled"


def test_stream_stops_on_the_cancelled_event(client, registry):
    registry.add(
        "t",
        status="cancelled",
        events=[
            {"type": "info", "message": "start"},
            {"type": "cancelled", "message": "Run stopped."},
            {"type": "info", "message": "never sent"},
        ],
    )

    events = _parse_sse(client.get("/api/stream/t"))

    assert [event["type"] for event in events] == ["info", "cancelled"]


def test_evaluate_is_refused_while_another_run_is_in_progress(
    client, registry, installed_models
):
    registry.add("live")

    response = client.post("/api/evaluate", json=_payload())

    assert response.status_code == 409
    assert response.get_json() == {"error": "A run is already in progress."}
    assert registry.ids() == ["live"]


def test_resume_starts_a_thread_with_the_saved_run(
    client, services, registry, installed_models, spawn
):
    saved = _save_partial()

    response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 202
    assert response.get_json() == {"task_id": RESUME_ID, "status": "started"}
    task = registry.get(RESUME_ID)
    assert task.status == "started"
    assert [event["type"] for event in task.events] == ["info", "reference_done"]
    assert not task.cancel.is_set()
    spawn.assert_called_once_with(
        evaluation.run_task, services, RESUME_ID, None, None, saved
    )


@pytest.mark.parametrize("status", ["stopped", "error", "running"])
def test_resume_accepts_every_unfinished_status(
    client, installed_models, spawn, status
):
    _save_partial(status)

    response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 202


def test_resume_a_complete_run_is_409(client, installed_models):
    _save_partial("completed")

    response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 409
    assert response.get_json() == {"error": "The run is already complete."}


def test_resume_is_refused_while_another_run_is_in_progress(
    client, registry, installed_models
):
    _save_partial()
    registry.add("live")

    response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 409


def test_resume_rejects_unknown_and_unsafe_ids(client):
    missing = client.post("/api/evaluate/run_y_20260101_000000/resume")
    not_a_run = client.post("/api/evaluate/nope/resume")
    unsafe = client.post("/api/evaluate/.hidden/resume")

    assert missing.status_code == 404
    assert missing.get_json() == {"error": "Results not found or not ready"}
    assert not_a_run.status_code == 400
    assert unsafe.status_code == 400
    assert unsafe.get_json() == {"error": "Invalid task_id"}


def test_resume_checks_that_the_models_are_still_installed(client, services, registry):
    _save_partial()

    with patch.object(services.ollama, "get_models", return_value=["j"]):
        response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Models are not installed: m."}
    assert registry.get(RESUME_ID) is None


def test_resume_of_an_openai_judge_needs_the_saved_connection(client):
    data = _partial_run()
    data["judge_provider"] = "openai"
    _write_json(Path("data/history") / RESUME_ID / "evaluation_results.json", data)

    response = client.post(f"/api/evaluate/{RESUME_ID}/resume")

    assert response.status_code == 400
    assert response.get_json() == {
        "error": "The OpenAI judge needs a saved connection."
    }


def test_history_marks_a_dead_run_as_stopped_and_hides_a_live_one(client, registry):
    dead = {**_run(), "status": "running", "progress": {"done": 2, "total": 9}}
    live = {**_run(), "status": "running"}
    _write_json(
        Path("data/history/run_a_20260101_000000/evaluation_results.json"), dead
    )
    _write_json(
        Path("data/history/run_b_20260102_000000/evaluation_results.json"), live
    )
    registry.add("run_b_20260102_000000")

    runs = client.get("/api/history").get_json()

    assert [(r["task_id"], r["status"], r["progress"]) for r in runs] == [
        ("run_a_20260101_000000", "stopped", {"done": 2, "total": 9})
    ]


# --- /api/preview -----------------------------------------------------------


def test_preview_shows_a_local_grading_call_with_placeholders(client):
    response = client.post("/api/preview", json=_payload(base_rationale="Be strict."))

    assert response.status_code == 200
    body = response.get_json()
    assert body["method"] == "POST"
    assert body["url"].endswith("/api/generate")
    assert body["body"]["model"] == "j"
    assert body["body"]["format"] == GRADE_SCHEMA
    assert "<question>" in body["body"]["prompt"]
    assert "<candidate answer>" in body["body"]["prompt"]
    assert "Be strict." in body["body"]["prompt"]
    assert "Authorization" not in body["headers"]
    assert body["leaves_machine"] is False
    assert body["curl"].startswith("curl -X POST ")


def test_preview_of_an_openai_judge_hides_the_key(client, services):
    _save_connection(services)
    payload = _payload(judge="gpt-4.1-mini", judge_provider="openai")

    response = client.post("/api/preview", json=payload)

    body = response.get_json()
    assert body["url"] == "https://api.example.com/v1/chat/completions"
    assert body["headers"]["Authorization"] == "Bearer ***"
    assert body["body"]["model"] == "gpt-4.1-mini"
    assert body["body"]["response_format"]["type"] == "json_schema"
    assert '"Authorization: Bearer $API_KEY"' in body["curl"]
    assert b"sk-secret" not in response.data
    assert body["leaves_machine"] is True


def test_preview_of_an_openai_judge_needs_the_saved_connection(client):
    response = client.post("/api/preview", json=_payload(judge_provider="openai"))

    assert response.status_code == 400


@pytest.mark.parametrize("body", [{}, _payload(judge=None), _payload(test_cases=[])])
def test_preview_rejects_an_invalid_payload(client, body):
    response = client.post("/api/preview", json=body)

    assert response.status_code == 400
    assert response.get_json()["error"]


# --- run ids and paths ------------------------------------------------------


@pytest.mark.parametrize(
    "task_id", ["weird", "run_", "run_a/../../x", "run_a\n", "../run_a_1_2"]
)
def test_run_path_rejects_ids_that_are_not_run_ids(services, task_id):
    assert services.runs.path(task_id) is None


def test_run_path_stays_inside_the_history_directory(services):
    folder = services.runs.path("run_a_20260101_000000")

    assert folder.startswith(os.path.realpath(services.pipeline.history_dir) + os.sep)


# --- delete and rename ------------------------------------------------------


def test_delete_removes_the_run_folder(client):
    task_id = _save_run()

    response = client.delete(f"/api/results/{task_id}")

    assert response.status_code == 200
    assert response.get_json() == {"task_id": task_id}
    assert not Path("data/history", task_id).exists()
    assert client.get("/api/history").get_json() == []


def test_delete_refuses_a_run_in_progress(client, registry):
    task_id = _save_run()
    registry.add(task_id)

    response = client.delete(f"/api/results/{task_id}")

    assert response.status_code == 409
    assert Path("data/history", task_id).exists()


def test_delete_rejects_unknown_and_unsafe_ids(client):
    assert client.delete("/api/results/run_x_20260101_000000").status_code == 404
    unsafe = client.delete("/api/results/.hidden")
    assert unsafe.status_code == 400
    assert unsafe.get_json() == {"error": "Invalid task_id"}


def test_delete_works_for_a_stopped_run(client):
    _save_partial()

    response = client.delete(f"/api/results/{RESUME_ID}")

    assert response.status_code == 200
    assert not Path("data/history", RESUME_ID).exists()


def test_rename_sets_the_title_shown_in_the_archive(client):
    task_id = _save_run()

    response = client.put(f"/api/results/{task_id}/title", json={"title": "  my  run "})

    assert response.status_code == 200
    assert response.get_json() == {"task_id": task_id, "title": "my run"}
    [run] = client.get("/api/history").get_json()
    assert run["tag_name"] == "my run"


def test_an_empty_title_restores_the_default_name(client):
    task_id = _save_run()
    client.put(f"/api/results/{task_id}/title", json={"title": "mine"})

    response = client.put(f"/api/results/{task_id}/title", json={"title": " "})

    assert response.get_json()["title"] is None
    assert not Path("data/history", task_id, "meta.json").exists()
    assert client.get("/api/history").get_json()[0]["tag_name"] == "X"


@pytest.mark.parametrize("body", [{}, {"title": 5}, {"title": "x" * 81}, [1]])
def test_rename_rejects_a_bad_title(client, body):
    task_id = _save_run()

    response = client.put(f"/api/results/{task_id}/title", json=body)

    assert response.status_code == 400
    assert response.get_json()["error"]


def test_rename_unknown_and_unsafe_ids(client):
    missing = client.put(
        "/api/results/run_x_20260101_000000/title", json={"title": "a"}
    )
    unsafe = client.put("/api/results/.hidden/title", json={"title": "a"})

    assert missing.status_code == 404
    assert unsafe.status_code == 400


# --- task memory and stream wake-ups ----------------------------------------


def _finished_task(registry, task_id, finished_at, status="completed"):
    registry.add(
        task_id, status=status, events=[{"type": status}], finished_at=finished_at
    )


def test_only_the_newest_finished_tasks_are_kept(registry, monkeypatch):
    monkeypatch.setattr(registry, "max_finished", 2)
    for number in range(3):
        _finished_task(registry, f"old{number}", number)
    registry.add("t")

    registry.publish("t", {"type": "completed", "message": "done"})

    assert sorted(registry.ids()) == ["old2", "t"]


def test_a_task_in_progress_is_never_evicted(client, registry, monkeypatch):
    monkeypatch.setattr(registry, "max_finished", 0)
    registry.add("live")
    registry.add("t")

    registry.publish("t", {"type": "error", "message": "boom"})

    assert registry.ids() == ["live"]
    assert _parse_sse(client.get("/api/stream/t")) == [
        {"type": "error", "message": "Task not found"}
    ]


def test_stream_waits_on_the_condition_and_does_not_poll(
    client, app, registry, monkeypatch
):
    app.config["HEARTBEAT_SEC"] = 30
    registry.add("t")

    def no_polling(_seconds):
        raise AssertionError("the stream must not sleep")

    monkeypatch.setattr(time, "sleep", no_polling)

    def finish():
        threading.Event().wait(0.2)
        registry.publish("t", {"type": "completed", "message": "done"})

    worker = threading.Thread(target=finish)
    worker.start()
    body = client.get("/api/stream/t").get_data(as_text=True)
    worker.join()

    assert '"type": "completed"' in body
    assert ": ping" not in body


# --- stream ids, Last-Event-ID and dropped tokens ---------------------------


def _answer_event(kind, text=None, model="m", question="q1"):
    event = {"type": kind, "phase": "answer", "model": model, "question": question}
    if text is not None:
        event["text"] = text
    return event


def _ids(body):
    return [line for line in body.splitlines() if line.startswith("id: ")]


def _finished_events():
    return [
        {"type": "info", "message": "a"},
        {"type": "info", "message": "b"},
        {"type": "completed", "message": "c"},
    ]


def test_stream_events_have_ids_and_a_reconnect_continues_after_the_last_one(
    client, registry
):
    registry.add("t", status="completed", events=_finished_events())

    body = client.get("/api/stream/t").get_data(as_text=True)
    resumed = client.get("/api/stream/t", headers={"Last-Event-ID": "0"})

    assert _ids(body) == ["id: 0", "id: 1", "id: 2"]
    assert [event["message"] for event in _parse_sse(resumed)] == ["b", "c"]


@pytest.mark.parametrize("last", ["", "x", "-1", "99"])
def test_stream_replays_everything_for_an_unusable_last_event_id(
    client, registry, last
):
    registry.add("t", status="completed", events=_finished_events())

    response = client.get("/api/stream/t", headers={"Last-Event-ID": last})

    assert [event["message"] for event in _parse_sse(response)] == ["a", "b", "c"]


def test_stream_skips_dropped_events_and_keeps_the_ids(client, registry):
    events = _finished_events()
    events[1] = None
    registry.add("t", status="completed", events=events)

    body = client.get("/api/stream/t").get_data(as_text=True)

    assert _ids(body) == ["id: 0", "id: 2"]


def test_the_tokens_of_a_finished_answer_are_dropped_but_the_slots_stay(registry):
    registry.add("t")

    for event in (
        _answer_event("answer_start"),
        _answer_event("answer_token", "a"),
        _answer_event("answer_token", "b"),
        _answer_event("answer_start", model="n"),
        _answer_event("answer_token", "c", model="n"),
        _answer_event("answer_done"),
    ):
        registry.publish("t", event)

    events = registry.get("t").events
    assert [e and e["type"] for e in events] == [
        "answer_start",
        None,
        None,
        "answer_start",
        "answer_token",
        "answer_done",
    ]
