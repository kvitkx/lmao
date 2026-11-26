"""The life of a run: start, stop, resume and the event stream."""

import json
from datetime import datetime

from flask import Blueprint, Response, current_app, jsonify, request

from core.evaluator import RESUMABLE_RUNS, RUN_COMPLETED, replay_events
from core.provider import JUDGE_OLLAMA, Provider

from .errors import ApiError
from .providers import resolve_judge
from .run_store import NOT_FOUND
from .services import Services, get_services
from .tasks import FINAL_EVENTS, STARTED
from .validation import evaluation_payload, sanitize_tag

bp = Blueprint("evaluation", __name__)


def run_task(
    svc: Services,
    task_id: str,
    payload: dict | None,
    judge_provider: Provider | None = None,
    saved: dict | None = None,
) -> None:
    """Runs the pipeline in a worker thread and reports a crash to the stream.

    Without this, an exception would end the thread silently and the SSE stream
    would wait forever for a final event. `saved` is a stopped run to resume,
    and then `payload` is None.
    """
    task = svc.registry.get(task_id)
    cancel = task.cancel if task is not None else None
    try:
        svc.pipeline.run_evaluation(
            task_id,
            payload,
            svc.registry.publish,
            judge_provider,
            saved=saved,
            cancel=cancel,
        )
    except Exception as e:
        svc.registry.publish(
            task_id, {"type": "error", "message": f"Evaluation failed: {e}"}
        )


@bp.post("/api/evaluate")
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
    svc = get_services()
    data = evaluation_payload()

    if svc.registry.active_id():
        raise ApiError("A run is already in progress.", 409)

    judge_provider = resolve_judge(
        svc,
        data.get("judge_provider", JUDGE_OLLAMA),
        data["judge"],
        data["candidates"],
    )

    first_tag = sanitize_tag(data["test_cases"][0].get("tag", "run"))
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    task_id = f"run_{first_tag}_{timestamp}"

    svc.registry.add(
        task_id, events=[{"type": "info", "message": "Task queued for execution."}]
    )
    svc.spawn(run_task, svc, task_id, data, judge_provider)

    return jsonify({"task_id": task_id, "status": "started"}), 202


@bp.post("/api/evaluate/<task_id>/cancel")
def cancel_evaluation(task_id: str):
    """Asks a run to stop. A candidate answer in progress is cut off at once
    (it is redone on resume); a judge call in progress finishes first.

    Returns:
        Response: 202 once the flag is set, 404 for an unknown task and 409 if
            the run is not in progress. The stream ends with a `cancelled` event.
    """
    registry = get_services().registry
    task = registry.get(task_id)
    if task is None:
        raise ApiError("Task not found", 404)
    if task.status != STARTED:
        raise ApiError("The run is not in progress.", 409)

    task.cancel.set()
    registry.publish(task_id, {"type": "cancelling"})
    return jsonify({"task_id": task_id, "status": "stopping"}), 202


@bp.post("/api/evaluate/<task_id>/resume")
def resume_evaluation(task_id: str):
    """Continues a stopped or failed run from its saved steps.

    Works from the archive too, so it also resumes a run that a server restart
    cut off. The stream of the task starts over with the events of the steps
    that are already done.

    Returns:
        Response: 202 with the task id; 400, 404 or 409 with the reason.
    """
    svc = get_services()
    svc.runs.folder(task_id)  # 400 for anything that is not a run id
    if svc.registry.active_id():
        raise ApiError("A run is already in progress.", 409)

    saved = svc.runs.read(task_id)
    if saved is None:
        raise ApiError(NOT_FOUND, 404)
    if saved.get("status", RUN_COMPLETED) not in RESUMABLE_RUNS:
        raise ApiError("The run is already complete.", 409)

    judge_provider = resolve_judge(
        svc, saved["judge_provider"], saved["judge_model"], saved["candidates"]
    )

    events = [{"type": "info", "message": "Run resumed."}, *replay_events(saved)]
    svc.registry.add(task_id, events=events)
    svc.spawn(run_task, svc, task_id, None, judge_provider, saved)

    return jsonify({"task_id": task_id, "status": "started"}), 202


@bp.get("/api/stream/<task_id>")
def stream_status(task_id: str):
    """Server-Sent Events (SSE) endpoint to push real-time updates to the client.

    Args:
        task_id (str): The unique identifier of the task to monitor.

    Returns:
        Response: A continuous text/event-stream response.
    """
    registry = get_services().registry
    heartbeat = current_app.config["HEARTBEAT_SEC"]

    # A reconnecting EventSource sends the id of the last event it got:
    # continue right after it.
    last = request.headers.get("Last-Event-ID", "")
    start = int(last) + 1 if last.isdecimal() else 0

    def generate():
        task = registry.get(task_id)
        if not task:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Task not found'})}\n\n"
            return

        # An id the task never had belongs to another run of the same id.
        idx = start if start <= len(task.events) else 0
        while True:
            # Sleeps until an event is published. No event within the heartbeat:
            # a comment line, which EventSource ignores, but whose write fails
            # when the client is gone and ends this generator.
            ready, event = registry.wait_for(task, idx, heartbeat)

            if not ready:
                yield ": ping\n\n"
                continue
            if event is None:
                # The tokens of a finished answer were dropped.
                idx += 1
                continue

            yield f"id: {idx}\ndata: {json.dumps(event)}\n\n"

            # Stop streaming if the task has finished or failed.
            if event.get("type") in FINAL_EVENTS:
                break
            idx += 1

    return Response(generate(), mimetype="text/event-stream")
