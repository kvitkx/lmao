"""Estimate of the judge's work in one run, before it starts.

Pure module: no I/O and no model calls. The judge calls are counted exactly
(retries not included); the tokens are a range, because the candidates' answers
do not exist yet. The prompts are built with the real templates of `prompts`,
so the estimate follows them when they change.
"""

import math

from .evaluator import JUDGE_NUM_PREDICT
from .prompts import (
    GRADER_SYSTEM,
    MAX_ANSWER_WORDS,
    REFERENCE_SYSTEM,
    SUMMARY_SYSTEM,
    build_answer_prompt,
    build_grading_prompt,
    build_summary_prompt,
)

# A rough rule of thumb; real tokenizers differ.
CHARS_PER_TOKEN = 4
# Length of an answer or a generated reference: (short, at the word limit).
TEXT_CHARS = (200, MAX_ANSWER_WORDS * 6)
# Tokens the judge writes per call: (low, high).
REFERENCE_OUTPUT_TOKENS = (100, JUDGE_NUM_PREDICT)
GRADE_OUTPUT_TOKENS = (60, 300)
SUMMARY_OUTPUT_TOKENS = (150, 600)

_SIDES = (0, 1)


def _range(low, high) -> dict:
    return {"low": low, "high": high}


def _reference_of(case: dict) -> str:
    return (case.get("reference") or "").strip()


def _summary_chars(candidates: list) -> int:
    """Size of the summary call, built with the real template and stand-in numbers."""
    stats = [
        {
            "model": name,
            "n": 99,
            "mean": 100.0,
            "median": 100.0,
            "pass_rate": 1.0,
            "fails": 99,
            "critical_fails": 99,
            "errors": 99,
            "judge_errors": 99,
            "median_cps": 9999.99,
            "median_time_sec": 9999.99,
        }
        for name in candidates
    ]
    recommendation = {
        "model": candidates[0],
        "rule": "fastest_above_threshold",
        "confidence": "high",
    }
    return len(SUMMARY_SYSTEM) + len(build_summary_prompt(stats, recommendation))


def estimate(payload: dict) -> dict:
    """Estimates what the judge will do in a run.

    Args:
        payload (dict): The same payload as /api/evaluate, already validated:
            candidates, test_cases and an optional base_rationale.

    Returns:
        dict: judge_calls (references, grades, summary, total), tokens (input,
            output and total, each a low/high range) and sent_chars (the
            characters of all judge prompts, a low/high range).
    """
    cases = payload["test_cases"]
    candidates = list(dict.fromkeys(payload["candidates"]))
    base_rationale = payload.get("base_rationale", "")

    generated = [case for case in cases if not _reference_of(case)]
    grades = len(cases) * len(candidates)

    chars = [0, 0]
    output = [0, 0]

    for case in generated:
        size = len(REFERENCE_SYSTEM) + len(build_answer_prompt(case["question"]))
        for side in _SIDES:
            chars[side] += size
            output[side] += REFERENCE_OUTPUT_TOKENS[side]

    for case in cases:
        provided = _reference_of(case)
        for side in _SIDES:
            text = "x" * TEXT_CHARS[side]
            prompt = build_grading_prompt(
                case["question"],
                provided or text,
                base_rationale,
                case.get("specific_rationale", ""),
                text,
            )
            chars[side] += (len(GRADER_SYSTEM) + len(prompt)) * len(candidates)
            output[side] += GRADE_OUTPUT_TOKENS[side] * len(candidates)

    summary = _summary_chars(candidates)
    for side in _SIDES:
        chars[side] += summary
        output[side] += SUMMARY_OUTPUT_TOKENS[side]

    tokens_in = [math.ceil(size / CHARS_PER_TOKEN) for size in chars]
    return {
        "judge_calls": {
            "references": len(generated),
            "grades": grades,
            "summary": 1,
            "total": len(generated) + grades + 1,
        },
        "tokens": {
            "input": _range(*tokens_in),
            "output": _range(*output),
            "total": _range(*(tokens_in[side] + output[side] for side in _SIDES)),
        },
        "sent_chars": _range(*chars),
    }


def cost_of(tokens: dict, price_in, price_out) -> dict | None:
    """Prices the tokens of `estimate` at the prices per million tokens.

    Args:
        tokens (dict): The `tokens` value of `estimate`.
        price_in (float | None): Price of a million input tokens.
        price_out (float | None): Price of a million output tokens.

    Returns:
        dict | None: low and high cost in the currency of the prices, or None
            when a price is missing.
    """
    if price_in is None or price_out is None:
        return None

    def at(side: str) -> float:
        spent = tokens["input"][side] * price_in + tokens["output"][side] * price_out
        return round(spent / 1_000_000, 4)

    return _range(at("low"), at("high"))
