"""Checks of a connection before a run.

Uses only what every `Provider` has: `get_models` and `generate`. The calls
are the real ones in miniature: the grading prompt with the grade schema, then
the sampling options the judge sends. A failed call is a result, never an
exception. Details come from the provider, which already hides the key.
"""

import time

from .evaluator import JUDGE_NUM_PREDICT
from .prompts import (
    GRADE_SCHEMA,
    GRADER_SYSTEM,
    GradeError,
    build_grading_prompt,
    parse_grade,
)
from .provider import Provider

CHECK_TIMEOUT_SEC = 30
DETAIL_LIMIT = 200

STATE_DONE = "done"
STATE_ERROR = "error"
STATE_SKIPPED = "skipped"

_LABELS = {
    "models": "model list",
    "structured": "structured output",
    "sampling": "seed and temperature",
    "usage": "token usage",
    "rate_limit": "rate limit",
}
# The run cannot work without these; usage only makes the budget checkable.
_REQUIRED = ("models", "structured", "sampling")


def _check(key: str, state: str, detail: str = "", ms: int | None = None) -> dict:
    return {
        "key": key,
        "label": _LABELS[key],
        "state": state,
        "detail": detail[:DETAIL_LIMIT],
        "ms": ms,
    }


def _rate_limit() -> dict:
    # Nothing measures it: the honest state is "unknown".
    return _check("rate_limit", STATE_SKIPPED, "not measured")


def _timed(call):
    started = time.monotonic()
    result = call()
    return result, round((time.monotonic() - started) * 1000)


def _generate(provider: Provider, model: str, prompt: str, **kwargs):
    return _timed(
        lambda: provider.generate(
            model, prompt, think=False, timeout=CHECK_TIMEOUT_SEC, **kwargs
        )
    )


def _grade_reply(result: dict, provider: Provider) -> tuple[str, str]:
    if not result["success"]:
        return STATE_ERROR, result["error"]
    try:
        parse_grade(result["response_text"])
    except GradeError:
        # The reason stays out of the response: it is derived from an exception.
        return STATE_ERROR, "the reply is not a valid grade"
    if getattr(provider, "json_schema", True) is False:
        return STATE_DONE, "plain JSON object: the server rejected the schema"
    return STATE_DONE, "schema accepted"


def _sampling_reply(result: dict) -> tuple[str, str]:
    if not result["success"]:
        return STATE_ERROR, result["error"]
    return STATE_DONE, "accepted"


def _usage(replies: list) -> tuple[str, str]:
    if not replies:
        return STATE_SKIPPED, "no successful call to read"
    reply = replies[-1]
    sent = reply["prompt_eval_count"]
    made = reply["metrics"]["tokens_generated"]
    if sent > 0 and made > 0:
        return STATE_DONE, f"{sent} in · {made} out"
    return STATE_ERROR, "the API reports no token usage: the budget cannot be checked"


def _report(checks: list) -> dict:
    ok = all(c["state"] == STATE_DONE for c in checks if c["key"] in _REQUIRED)
    return {"ok": ok, "checks": checks}


def run_preflight(provider: Provider, model: str) -> dict:
    """Checks that a provider can serve a judge model.

    Order: model list, structured output, seed and temperature, token usage,
    rate limit. If the model list fails, nothing else is called.

    Args:
        provider (Provider): The provider to check.
        model (str): The judge model to check.

    Returns:
        dict: ok (the three required checks passed) and checks, a list of
            key, label, state (done, error or skipped), detail and ms.
    """
    names, ms = _timed(provider.get_models)
    if not names:
        detail = "no models: the API is unreachable or rejects the key"
        first = _check("models", STATE_ERROR, detail, ms)
    elif model not in names:
        detail = f"{len(names)} listed, but not {model!r}"
        first = _check("models", STATE_ERROR, detail, ms)
    else:
        first = _check("models", STATE_DONE, f"{len(names)} listed", ms)

    if first["state"] != STATE_DONE:
        skipped = [
            _check(key, STATE_SKIPPED, "not run: the model list failed")
            for key in ("structured", "sampling", "usage")
        ]
        return _report([first, *skipped, _rate_limit()])

    prompt = build_grading_prompt("What is 2+2?", "Four.", "", "", "4")
    structured, structured_ms = _generate(
        provider,
        model,
        prompt,
        system_prompt=GRADER_SYSTEM,
        format=GRADE_SCHEMA,
        options={"num_predict": JUDGE_NUM_PREDICT},
    )
    state, detail = _grade_reply(structured, provider)
    checks = [first, _check("structured", state, detail, structured_ms)]

    sampling, sampling_ms = _generate(
        provider,
        model,
        "Reply with the single word: ok.",
        options={"temperature": 0, "seed": 1, "num_predict": JUDGE_NUM_PREDICT},
    )
    state, detail = _sampling_reply(sampling)
    checks.append(_check("sampling", state, detail, sampling_ms))

    replies = [reply for reply in (structured, sampling) if reply["success"]]
    state, detail = _usage(replies)
    checks.append(_check("usage", state, detail))
    checks.append(_rate_limit())
    return _report(checks)
