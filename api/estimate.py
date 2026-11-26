"""What a run will do, before it starts: the budget and the request preview."""

import json
import shlex

from flask import Blueprint, jsonify

from core.budget import estimate as estimate_budget
from core.judge import judge_kwargs
from core.prompts import GRADE_SCHEMA, GRADER_SYSTEM, build_grading_prompt
from core.provider import JUDGE_OLLAMA

from .providers import judge_kind
from .services import get_services
from .validation import evaluation_payload

bp = Blueprint("estimate", __name__)


@bp.post("/api/budget")
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
    svc = get_services()
    data = evaluation_payload()

    result = estimate_budget(data)
    kind = judge_kind(data.get("judge_provider", JUDGE_OLLAMA))

    return jsonify(
        {
            **result,
            "leaves_machine": kind.leaves_machine,
            "cost": kind.cost(svc, result["tokens"]),
        }
    ), 200


@bp.post("/api/preview")
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
    svc = get_services()
    data = evaluation_payload()

    kind = judge_kind(data.get("judge_provider", JUDGE_OLLAMA))
    target = kind.preview(svc)

    prompt = build_grading_prompt(
        "<question>",
        "<reference answer>",
        data.get("base_rationale", ""),
        data["test_cases"][0].get("specific_rationale", ""),
        "<candidate answer>",
    )
    url, body = target.provider.build_request(
        data["judge"], prompt, **judge_kwargs(GRADER_SYSTEM, format=GRADE_SCHEMA)
    )
    curl = (
        f"curl -X POST {shlex.quote(url)} \\\n"
        "  -H 'Content-Type: application/json'"
        f"{target.curl_auth} \\\n"
        f"  -d {shlex.quote(json.dumps(body, ensure_ascii=False))}"
    )
    return jsonify(
        {
            "method": "POST",
            "url": url,
            "headers": {"Content-Type": "application/json", **target.headers},
            "body": body,
            "curl": curl,
            "leaves_machine": kind.leaves_machine,
        }
    ), 200
