"""Flask application for the Local Model Assessment Operator.

This module provides REST API endpoints to trigger and monitor the asynchronous
evaluation of local Large Language Models (LLMs) using Ollama. It serves the SPA,
handles Server-Sent Events (SSE) for real-time UI updates, and manages task history.
"""

import json
import os
import re
import shlex
import shutil
import threading
import time
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request
from werkzeug.utils import secure_filename

from core.budget import cost_of, estimate
from core.connection import (
    ERROR_TEXTS,
    ConnectionStore,
    InvalidConnection,
    public_view,
)
from core.evaluator import (
    DATA_DIR,
    RESUMABLE_RUNS,
    RUN_COMPLETED,
    RUN_RUNNING,
    RUN_STOPPED,
    SCHEMA_VERSION,
    EvaluationPipeline,
    judge_kwargs,
    replay_events,
)
from core.export import to_csv, to_markdown
from core.ollama_client import OllamaClient
from core.openai_client import OpenAIClient
from core.preflight import run_preflight
from core.prompts import GRADE_SCHEMA, GRADER_SYSTEM, build_grading_prompt
from core.provider import JUDGE_OLLAMA, JUDGE_OPENAI, JUDGE_PROVIDERS

load_dotenv()

app = Flask(__name__)

# Global dictionary to store task states and their event logs in memory.
# Format: { "task_id": { "status": str, "events": list[dict] } }
TASKS = {}

ollama_client = OllamaClient()
pipeline = EvaluationPipeline(ollama_client)

# The saved connection holds an API key: nothing but this store reads the file.
connection_store = ConnectionStore(os.path.join(DATA_DIR, "connection.json"))

_SAFE_TAG_RE = re.compile(r"[^a-zA-Z0-9_-]")
_RUN_ID_RE = re.compile(r"run_[A-Za-z0-9_-]+")
MAX_TITLE_LENGTH = 80
_OPTIONAL_TEXT_FIELDS = ("tag", "specific_rationale", "reference")

# An SSE stream that writes nothing never notices a closed connection, and
# gunicorn has only a few threads. A comment line every few seconds fixes that.
HEARTBEAT_SEC = 15

# The last event of a stream: the run finished, failed or was stopped.
FINAL_EVENTS = ("completed", "error", "cancelled")


def _to_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


# format -> (renderer, mimetype) for /api/results/<task_id>/export
_EXPORTS = {
    "json": (_to_json, "application/json"),
    "csv": (to_csv, "text/csv"),
    "md": (to_markdown, "text/markdown"),
}


def _sanitize_tag(tag, fallback="run", max_length=40):
    """Strip anything unsafe for a filesystem path segment."""
    if not isinstance(tag, str) or not tag.strip():
        return fallback
    cleaned = _SAFE_TAG_RE.sub("_", tag.strip())[:max_length]
    return cleaned or fallback


def _validate_payload(data: dict) -> str | None:
    """Checks the shape of an evaluation request.

    Args:
        data (dict): The parsed JSON payload.

    Returns:
        str | None: A description of the first problem, or None if valid.
    """
    judge = data.get("judge")
    candidates = data.get("candidates")
    test_cases = data.get("test_cases")

    if not isinstance(judge, str) or not judge:
        return "Field 'judge' must be a model name."
    if (
        not isinstance(candidates, list)
        or not candidates
        or not all(isinstance(model, str) and model for model in candidates)
    ):
        return "Field 'candidates' must be a non-empty list of model names."
    if (
        not isinstance(test_cases, list)
        or not test_cases
        or not all(
            isinstance(case, dict)
            and isinstance(case.get("question"), str)
            and case["question"].strip()
            for case in test_cases
        )
    ):
        return "Field 'test_cases' must be a non-empty list of objects with a question."
    if not isinstance(data.get("base_rationale", ""), str) or not all(
        isinstance(case.get(field, ""), str)
        for case in test_cases
        for field in _OPTIONAL_TEXT_FIELDS
    ):
        return "Text fields must be strings."
    if data.get("judge_provider", JUDGE_OLLAMA) not in JUDGE_PROVIDERS:
        return f"Field 'judge_provider' must be one of: {', '.join(JUDGE_PROVIDERS)}."
    return None


def update_task_status(task_id: str, payload: dict) -> None:
    """Appends a new structured event payload to the task's event stream.

    Args:
        task_id (str): The unique identifier of the task.
        payload (dict): The event data to append (e.g., {"type": "info", "message": "..."}).
    """
    if task_id in TASKS:
        payload["timestamp"] = datetime.now().isoformat()
        TASKS[task_id]["events"].append(payload)

        if payload.get("type") in FINAL_EVENTS:
            TASKS[task_id]["status"] = payload.get("type")


def _run_task(
    task_id: str, payload: dict | None, judge_provider=None, saved: dict | None = None
) -> None:
    """Runs the pipeline in a worker thread and reports a crash to the stream.

    Without this, an exception would end the thread silently and the SSE stream
    would wait forever for a final event. `saved` is a stopped run to resume,
    and then `payload` is None.
    """
    cancel = TASKS.get(task_id, {}).get("cancel")
    try:
        pipeline.run_evaluation(
            task_id,
            payload,
            update_task_status,
            judge_provider,
            saved=saved,
            cancel=cancel,
        )
    except Exception as e:
        update_task_status(
            task_id, {"type": "error", "message": f"Evaluation failed: {e}"}
        )


def _read_json(path: str) -> dict | None:
    """Reads a JSON object from disk, or None if it is missing or unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError:
        return None
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _run_dir(task_id: str) -> str | None:
    """The folder of a run, or None if the id is not a run id.

    The id must look like run_<tag>_<date>_<time>, and the resolved path must
    stay inside the history directory.
    """
    if not isinstance(task_id, str) or not _RUN_ID_RE.fullmatch(task_id):
        return None
    base = os.path.realpath(pipeline.history_dir)
    path = os.path.realpath(os.path.join(base, task_id))
    if not path.startswith(base + os.sep):
        return None
    return path


def _read_run(task_id: str) -> dict | None:
    """Reads the results of a run, or None if it is missing or not in the current schema."""
    folder = _run_dir(task_id)
    if folder is None:
        return None
    data = _read_json(os.path.join(folder, "evaluation_results.json"))
    if data is None or data.get("schema_version") != SCHEMA_VERSION:
        return None
    return data


def _parse_task_id(task_id: str) -> tuple[str, str]:
    """Splits run_{tag}_{YYYYMMDD}_{HHMMSS} into a readable tag and timestamp."""
    parts = task_id.split("_")
    if len(parts) < 4:
        return task_id, "Unknown"

    tag_name = "_".join(parts[1:-2]).replace("_", " ").title()
    date_str, time_str = parts[-2], parts[-1]
    try:
        moment = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
    except ValueError:
        return tag_name, f"{date_str} {time_str}"
    return tag_name, moment.strftime("%Y-%m-%d %H:%M")


def _load_run(task_id: str) -> tuple[dict | None, tuple | None]:
    """Reads a saved run together with its technical metrics.

    Args:
        task_id (str): The task id from the URL.

    Returns:
        tuple: (data, None) on success, or (None, error) where error is a
            (response, status) pair ready to be returned from a view.
    """
    safe_task_id = secure_filename(task_id)
    if not safe_task_id or safe_task_id != task_id:
        return None, (jsonify({"error": "Invalid task_id"}), 400)

    results = _read_run(safe_task_id)
    if results is None:
        return None, (jsonify({"error": "Results not found or not ready"}), 404)

    metrics_path = os.path.join(_run_dir(safe_task_id) or "", "technical_metrics.json")
    metrics = (_read_json(metrics_path) or {}).get("metrics", {})
    return {**results, "metrics": metrics}, None


def _active_task() -> str | None:
    """The id of the run that is in progress, if any (one at a time)."""
    for task_id, task in TASKS.items():
        if task["status"] == "started":
            return task_id
    return None


def _run_status(data: dict) -> str:
    """The status of a saved run. A file that says "running" with no live task
    belongs to a run whose server died: it counts as stopped."""
    status = data.get("status", RUN_COMPLETED)
    return RUN_STOPPED if status == RUN_RUNNING else status


def _title_of(folder: str) -> str | None:
    """The name a run was given, or None for the default one."""
    title = (_read_json(os.path.join(folder, "meta.json")) or {}).get("title")
    return title.strip() if isinstance(title, str) and title.strip() else None


def _resolve_providers(judge: str, candidates: list, kind: str):
    """Finds the provider of the judge and checks the local models.

    Returns:
        tuple: (judge_provider, None) on success, where judge_provider is None
            unless the judge lives at an OpenAI-compatible API, or
            (None, (response, status)) ready to be returned from a view.
    """
    judge_provider = None
    local_models = [judge, *candidates]
    if kind == JUDGE_OPENAI:
        connection = connection_store.load()
        if connection is None:
            error = "The OpenAI judge needs a saved connection."
            return None, (jsonify({"error": error}), 400)
        judge_provider = OpenAIClient(connection["base_url"], connection["api_key"])
        # The judge lives at the API, so only the candidates must be installed.
        local_models = candidates

    installed = ollama_client.get_models()
    missing = [model for model in dict.fromkeys(local_models) if model not in installed]
    if missing:
        error = f"Models are not installed: {', '.join(missing)}."
        return None, (jsonify({"error": error}), 400)
    return judge_provider, None


@app.route("/", methods=["GET"])
def index():
    """Renders the main Single Page Application (SPA) dashboard.

    Returns:
        str: The rendered HTML template.
    """
    return render_template("index.html")


@app.route("/api/models", methods=["GET"])
def get_models():
    """Retrieves a list of available models from the local Ollama instance.

    Returns:
        Response: A JSON response containing the list of model names.
    """
    models = ollama_client.get_models()
    return jsonify({"models": models}), 200


@app.route("/api/evaluate", methods=["POST"])
def start_evaluation():
    """Starts a new asynchronous evaluation task.

    Expects a JSON payload with judge, candidates, an optional base_rationale,
    an optional judge_provider (ollama, ollama_cloud or openai; the last two
    grade in parallel) and a list of test_cases (question, optional tag,
    specific_rationale and reference). Every model must be installed in Ollama,
    except an OpenAI judge, which needs a saved connection instead.

    Returns:
        Response: A JSON response containing the generated task_id and status,
            or a 400 response describing what is wrong with the payload.
    """
    data = request.json
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    error = _validate_payload(data)
    if error:
        return jsonify({"error": error}), 400

    if _active_task():
        return jsonify({"error": "A run is already in progress."}), 409

    judge_provider, error = _resolve_providers(
        data["judge"], data["candidates"], data.get("judge_provider", JUDGE_OLLAMA)
    )
    if error:
        return error

    first_tag = _sanitize_tag(data["test_cases"][0].get("tag", "run"))
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    task_id = f"run_{first_tag}_{timestamp}"

    # Initialize the task with an empty event list.
    TASKS[task_id] = {
        "status": "started",
        "events": [{"type": "info", "message": "Task queued for execution."}],
        "cancel": threading.Event(),
    }

    # Start the evaluation pipeline in a background thread.
    thread = threading.Thread(target=_run_task, args=(task_id, data, judge_provider))
    thread.daemon = True
    thread.start()

    return jsonify({"task_id": task_id, "status": "started"}), 202


@app.route("/api/evaluate/<task_id>/cancel", methods=["POST"])
def cancel_evaluation(task_id: str):
    """Asks a run to stop. It stops between two steps, not in the middle of one.

    Returns:
        Response: 202 once the flag is set, 404 for an unknown task and 409 if
            the run is not in progress. The stream ends with a `cancelled` event.
    """
    task = TASKS.get(task_id)
    if task is None:
        return jsonify({"error": "Task not found"}), 404
    if task["status"] != "started":
        return jsonify({"error": "The run is not in progress."}), 409

    task["cancel"].set()
    update_task_status(task_id, {"type": "cancelling"})
    return jsonify({"task_id": task_id, "status": "stopping"}), 202


@app.route("/api/evaluate/<task_id>/resume", methods=["POST"])
def resume_evaluation(task_id: str):
    """Continues a stopped or failed run from its saved steps.

    Works from the archive too, so it also resumes a run that a server restart
    cut off. The stream of the task starts over with the events of the steps
    that are already done.

    Returns:
        Response: 202 with the task id; 400, 404 or 409 with the reason.
    """
    safe_task_id = secure_filename(task_id)
    if not safe_task_id or safe_task_id != task_id:
        return jsonify({"error": "Invalid task_id"}), 400
    if _active_task():
        return jsonify({"error": "A run is already in progress."}), 409

    saved = _read_run(task_id)
    if saved is None:
        return jsonify({"error": "Results not found or not ready"}), 404
    if saved.get("status", RUN_COMPLETED) not in RESUMABLE_RUNS:
        return jsonify({"error": "The run is already complete."}), 409

    judge_provider, error = _resolve_providers(
        saved["judge_model"], saved["candidates"], saved["judge_provider"]
    )
    if error:
        return error

    TASKS[task_id] = {
        "status": "started",
        "events": [
            {"type": "info", "message": "Run resumed."},
            *replay_events(saved),
        ],
        "cancel": threading.Event(),
    }
    thread = threading.Thread(
        target=_run_task, args=(task_id, None, judge_provider, saved)
    )
    thread.daemon = True
    thread.start()

    return jsonify({"task_id": task_id, "status": "started"}), 202


@app.route("/api/stream/<task_id>", methods=["GET"])
def stream_status(task_id: str):
    """Server-Sent Events (SSE) endpoint to push real-time updates to the client.

    Args:
        task_id (str): The unique identifier of the task to monitor.

    Returns:
        Response: A continuous text/event-stream response.
    """

    def generate():
        task = TASKS.get(task_id)
        if not task:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Task not found'})}\n\n"
            return

        idx = 0
        last_sent = time.monotonic()
        while True:
            # Yield new events as they become available in the memory buffer.
            if idx < len(task["events"]):
                event = task["events"][idx]
                yield f"data: {json.dumps(event)}\n\n"
                last_sent = time.monotonic()

                # Stop streaming if the task has finished or failed.
                if event.get("type") in FINAL_EVENTS:
                    break
                idx += 1
            else:
                # A comment line: EventSource ignores it, but the write fails
                # when the client is gone, which ends this generator.
                if time.monotonic() - last_sent >= HEARTBEAT_SEC:
                    yield ": ping\n\n"
                    last_sent = time.monotonic()
                # Sleep briefly to avoid CPU spinning while waiting for events.
                time.sleep(0.5)

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/history", methods=["GET"])
def get_history():
    """Retrieves a list of all past evaluations stored on disk.

    Runs in another schema version (old format, corrupted files) are skipped.

    Returns:
        Response: A JSON list of historical run metadata, sorted by newest first.
    """
    if not os.path.isdir(pipeline.history_dir):
        return jsonify([])

    runs = []
    for task_id in os.listdir(pipeline.history_dir):
        # The run in progress is shown on the running screen, not in the archive.
        if TASKS.get(task_id, {}).get("status") == "started":
            continue
        data = _read_run(task_id)
        if data is None:
            continue

        tag_name, timestamp = _parse_task_id(task_id)
        title = _title_of(_run_dir(task_id))
        runs.append(
            {
                "task_id": task_id,
                "tag_name": title or tag_name,
                "timestamp": timestamp,
                "models_tested": len(data["summary"]["models"]),
                "questions_count": len(data["questions_results"]),
                "judge_model": data["judge_model"],
                "status": _run_status(data),
                "progress": data.get("progress"),
            }
        )

    # Sort by task_id descending (newest first).
    runs.sort(key=lambda x: x["task_id"], reverse=True)
    return jsonify(runs), 200


@app.route("/api/results/<task_id>", methods=["GET"])
def get_results(task_id: str):
    """Returns the saved results of a run together with its technical metrics.

    The body is the content of evaluation_results.json (questions_results with
    per-model answers and grades, plus the summary) and a `metrics` object keyed
    by model name. The client groups it per model or per question.

    Args:
        task_id (str): The unique identifier of the completed task.

    Returns:
        Response: A JSON object with the results and metrics.
    """
    data, error = _load_run(task_id)
    if error:
        return error
    return jsonify(data), 200


@app.route("/api/results/<task_id>/export", methods=["GET"])
def export_results(task_id: str):
    """Downloads a saved run as json, csv or Markdown.

    The format comes from the `format` query parameter (json, csv or md). The
    json export has the same body as /api/results/<task_id>. The aggregates are
    the ones saved in the run; nothing is recomputed.

    Args:
        task_id (str): The unique identifier of the completed task.

    Returns:
        Response: The file as an attachment, or a JSON error (400 for an
            invalid task_id or an unknown format, 404 for a missing run).
    """
    fmt = request.args.get("format", "")
    if fmt not in _EXPORTS:
        return jsonify({"error": "Unknown format. Use json, csv or md."}), 400

    data, error = _load_run(task_id)
    if error:
        return error

    render, mimetype = _EXPORTS[fmt]
    response = Response(render(data), mimetype=mimetype)
    # task_id passed the secure_filename check, so it is safe in a header.
    response.headers["Content-Disposition"] = f'attachment; filename="{task_id}.{fmt}"'
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/api/results/<task_id>", methods=["DELETE"])
def delete_run(task_id: str):
    """Deletes a saved run. A run in progress cannot be deleted.

    Returns:
        Response: 200 with the task id; 400 for an invalid id, 404 for a
            missing run and 409 while the run is in progress.
    """
    folder = _run_dir(task_id)
    if folder is None:
        return jsonify({"error": "Invalid task_id"}), 400
    if TASKS.get(task_id, {}).get("status") == "started":
        return jsonify({"error": "The run is in progress."}), 409
    if not os.path.isdir(folder):
        return jsonify({"error": "Results not found or not ready"}), 404

    shutil.rmtree(folder)
    TASKS.pop(task_id, None)
    return jsonify({"task_id": task_id}), 200


@app.route("/api/results/<task_id>/title", methods=["PUT"])
def rename_run(task_id: str):
    """Gives a saved run a name. An empty title restores the default one.

    Returns:
        Response: {"task_id", "title"} (title is null for the default one); 400
            for an invalid id or title, 404 for a missing run.
    """
    folder = _run_dir(task_id)
    if folder is None:
        return jsonify({"error": "Invalid task_id"}), 400

    data = request.get_json(silent=True)
    title = data.get("title") if isinstance(data, dict) else None
    if not isinstance(title, str):
        return jsonify({"error": "Field 'title' must be a string."}), 400
    title = " ".join(title.split())
    if len(title) > MAX_TITLE_LENGTH:
        error = f"Field 'title' is too long (max {MAX_TITLE_LENGTH})."
        return jsonify({"error": error}), 400
    if _read_run(task_id) is None:
        return jsonify({"error": "Results not found or not ready"}), 404

    path = os.path.join(folder, "meta.json")
    if title:
        temporary = f"{path}.tmp"
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump({"title": title}, f, ensure_ascii=False)
        os.replace(temporary, path)
    elif os.path.exists(path):
        os.remove(path)
    return jsonify({"task_id": task_id, "title": title or None}), 200


@app.route("/api/connection", methods=["GET"])
def get_connection():
    """Returns the saved connection to an OpenAI-compatible API.

    The key is never part of the response: only the base URL, the model and the
    last four characters of the key.

    Returns:
        Response: {"connection": {base_url, model, key_last4}} or
            {"connection": null}.
    """
    return jsonify({"connection": public_view(connection_store.load())}), 200


@app.route("/api/connection", methods=["PUT"])
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
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON payload"}), 400

    try:
        saved = connection_store.save(
            data.get("base_url"),
            data.get("api_key"),
            data.get("model"),
            data.get("price_in"),
            data.get("price_out"),
        )
    except InvalidConnection as e:
        return jsonify({"error": ERROR_TEXTS[e.code]}), 400
    return jsonify({"connection": public_view(saved)}), 200


@app.route("/api/connection", methods=["DELETE"])
def delete_connection():
    """Removes the saved connection (and with it the key)."""
    connection_store.delete()
    return jsonify({"connection": None}), 200


@app.route("/api/connection/test", methods=["POST"])
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
        return jsonify({"error": "Invalid JSON payload"}), 400

    connection = connection_store.load()
    if connection is None:
        return jsonify({"error": "There is no saved connection to test."}), 400

    model = data.get("model") or connection["model"]
    if not isinstance(model, str) or not model.strip():
        return jsonify({"error": "Choose a model to test."}), 400

    provider = OpenAIClient(connection["base_url"], connection["api_key"])
    return jsonify(run_preflight(provider, model.strip())), 200


@app.route("/api/budget", methods=["POST"])
def get_budget():
    """Estimates the judge's work for a run, before it starts.

    Takes the same payload as /api/evaluate. Judge calls are counted; tokens
    are a low/high range. The cost is set only for an OpenAI judge whose saved
    connection has prices.

    Returns:
        Response: judge_calls, tokens, sent_chars, leaves_machine (prompts go
            to a remote judge) and cost (low/high, or null); or a 400 response
            describing what is wrong with the payload.
    """
    data = request.json
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    error = _validate_payload(data)
    if error:
        return jsonify({"error": error}), 400

    result = estimate(data)
    kind = data.get("judge_provider", JUDGE_OLLAMA)

    cost = None
    if kind == JUDGE_OPENAI:
        connection = connection_store.load()
        if connection is not None:
            cost = cost_of(
                result["tokens"], connection["price_in"], connection["price_out"]
            )

    return jsonify(
        {**result, "leaves_machine": kind != JUDGE_OLLAMA, "cost": cost}
    ), 200


@app.route("/api/preview", methods=["POST"])
def get_preview():
    """Shows the real shape of one grading call, before the run starts.

    Takes the payload of /api/evaluate. The request is built by the provider
    that will send it, with placeholders for the question, the reference and
    the answer. No model names of the candidates and no key: the key is shown
    as `***` and the curl line reads it from $API_KEY.

    Returns:
        Response: method, url, headers, body, curl and leaves_machine; or a 400
            response describing what is wrong with the payload.
    """
    data = request.json
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    error = _validate_payload(data)
    if error:
        return jsonify({"error": error}), 400

    kind = data.get("judge_provider", JUDGE_OLLAMA)
    headers = {"Content-Type": "application/json"}
    curl_auth = ""
    if kind == JUDGE_OPENAI:
        connection = connection_store.load()
        if connection is None:
            error = "The OpenAI judge needs a saved connection."
            return jsonify({"error": error}), 400
        provider = OpenAIClient(connection["base_url"], connection["api_key"])
        headers["Authorization"] = "Bearer ***"
        curl_auth = ' \\\n  -H "Authorization: Bearer $API_KEY"'
    else:
        provider = ollama_client

    prompt = build_grading_prompt(
        "<question>",
        "<reference answer>",
        data.get("base_rationale", ""),
        data["test_cases"][0].get("specific_rationale", ""),
        "<candidate answer>",
    )
    url, body = provider.build_request(
        data["judge"], prompt, **judge_kwargs(GRADER_SYSTEM, format=GRADE_SCHEMA)
    )
    curl = (
        f"curl -X POST {shlex.quote(url)} \\\n"
        "  -H 'Content-Type: application/json'"
        f"{curl_auth} \\\n"
        f"  -d {shlex.quote(json.dumps(body, ensure_ascii=False))}"
    )
    return jsonify(
        {
            "method": "POST",
            "url": url,
            "headers": headers,
            "body": body,
            "curl": curl,
            "leaves_machine": kind != JUDGE_OLLAMA,
        }
    ), 200


@app.route("/health")
def health_check():
    """Checks the health status of the service.

    Returns:
        A tuple containing a dictionary with the status and an HTTP 200 code.
    """
    return {"status": "ok"}, 200


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "False").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
