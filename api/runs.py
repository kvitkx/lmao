"""The saved runs: the archive, the results, export, rename and delete."""

import json
from datetime import datetime

from flask import Blueprint, Response, jsonify, request

from core.evaluator import RUN_COMPLETED, RUN_RUNNING, RUN_STOPPED
from core.export import to_csv, to_markdown

from .errors import ApiError
from .run_store import NOT_FOUND
from .services import get_services

bp = Blueprint("runs", __name__)

MAX_TITLE_LENGTH = 80


def _to_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


# format -> (renderer, mimetype) for /api/results/<task_id>/export
_EXPORTS = {
    "json": (_to_json, "application/json"),
    "csv": (to_csv, "text/csv"),
    "md": (to_markdown, "text/markdown"),
}


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


def _run_status(data: dict) -> str:
    """The status of a saved run. A file that says "running" with no live task
    belongs to a run whose server died: it counts as stopped."""
    status = data.get("status", RUN_COMPLETED)
    return RUN_STOPPED if status == RUN_RUNNING else status


@bp.get("/api/history")
def get_history():
    """Retrieves a list of all past evaluations stored on disk.

    Runs in another schema version (old format, corrupted files) are skipped.

    Returns:
        Response: A JSON list of historical run metadata, sorted by newest first.
    """
    svc = get_services()
    runs = []
    for task_id in svc.runs.ids():
        # The run in progress is shown on the running screen, not in the archive.
        if svc.registry.is_running(task_id):
            continue
        data = svc.runs.read(task_id)
        if data is None:
            continue

        tag_name, timestamp = _parse_task_id(task_id)
        runs.append(
            {
                "task_id": task_id,
                "tag_name": svc.runs.title(task_id) or tag_name,
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


@bp.get("/api/results/<task_id>")
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
    return jsonify(get_services().runs.load(task_id)), 200


@bp.get("/api/results/<task_id>/export")
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
        raise ApiError("Unknown format. Use json, csv or md.")

    data = get_services().runs.load(task_id)

    render, mimetype = _EXPORTS[fmt]
    response = Response(render(data), mimetype=mimetype)
    # task_id is a valid run id, so it is safe in a header.
    response.headers["Content-Disposition"] = f'attachment; filename="{task_id}.{fmt}"'
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@bp.delete("/api/results/<task_id>")
def delete_run(task_id: str):
    """Deletes a saved run. A run in progress cannot be deleted.

    Returns:
        Response: 200 with the task id; 400 for an invalid id, 404 for a
            missing run and 409 while the run is in progress.
    """
    svc = get_services()
    svc.runs.folder(task_id)
    if svc.registry.is_running(task_id):
        raise ApiError("The run is in progress.", 409)

    svc.runs.delete(task_id)
    svc.registry.remove(task_id)
    return jsonify({"task_id": task_id}), 200


@bp.put("/api/results/<task_id>/title")
def rename_run(task_id: str):
    """Gives a saved run a name. An empty title restores the default one.

    Returns:
        Response: {"task_id", "title"} (title is null for the default one); 400
            for an invalid id or title, 404 for a missing run.
    """
    svc = get_services()
    svc.runs.folder(task_id)

    data = request.get_json(silent=True)
    title = data.get("title") if isinstance(data, dict) else None
    if not isinstance(title, str):
        raise ApiError("Field 'title' must be a string.")
    title = " ".join(title.split())
    if len(title) > MAX_TITLE_LENGTH:
        raise ApiError(f"Field 'title' is too long (max {MAX_TITLE_LENGTH}).")
    if svc.runs.read(task_id) is None:
        raise ApiError(NOT_FOUND, 404)

    svc.runs.set_title(task_id, title)
    return jsonify({"task_id": task_id, "title": title or None}), 200
