"""Checks of what a request carries, shared by several endpoints."""

import re

from flask import request

from core.provider import JUDGE_OLLAMA, JUDGE_PROVIDERS

from .errors import ApiError

_SAFE_TAG_RE = re.compile(r"[^a-zA-Z0-9_-]")
_OPTIONAL_TEXT_FIELDS = ("tag", "specific_rationale", "reference")


def sanitize_tag(tag, fallback="run", max_length=40):
    """Strip anything unsafe for a filesystem path segment."""
    if not isinstance(tag, str) or not tag.strip():
        return fallback
    cleaned = _SAFE_TAG_RE.sub("_", tag.strip())[:max_length]
    return cleaned or fallback


def validate_payload(data: dict) -> str | None:
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


def json_object() -> dict:
    """The JSON body of the request, which must be an object.

    Raises:
        ApiError: If the body is JSON but not an object.
    """
    data = request.json
    if not isinstance(data, dict):
        raise ApiError("Invalid JSON payload")
    return data


def evaluation_payload() -> dict:
    """The validated body of /api/evaluate, /api/budget and /api/preview.

    Raises:
        ApiError: If the body is empty, not an object or not a valid request.
    """
    data = json_object()
    if not data:
        raise ApiError("Invalid JSON payload")
    error = validate_payload(data)
    if error:
        raise ApiError(error)
    return data
