"""
Unit tests for the estimate of the judge's work.
"""

import math

from core.budget import (
    CHARS_PER_TOKEN,
    GRADE_OUTPUT_TOKENS,
    REFERENCE_OUTPUT_TOKENS,
    SUMMARY_OUTPUT_TOKENS,
    cost_of,
    estimate,
)


def _payload(**overrides):
    payload = {
        "judge": "j",
        "candidates": ["a", "b"],
        "test_cases": [{"question": "Q1"}, {"question": "Q2"}],
    }
    payload.update(overrides)
    return payload


def test_counts_the_judge_calls():
    assert estimate(_payload())["judge_calls"] == {
        "references": 2,
        "grades": 4,
        "summary": 1,
        "total": 7,
    }


def test_a_provided_reference_is_not_generated():
    cases = [
        {"question": "Q1", "reference": "Four."},
        {"question": "Q2", "reference": "  "},
    ]

    calls = estimate(_payload(test_cases=cases))["judge_calls"]

    assert (calls["references"], calls["grades"]) == (1, 4)


def test_duplicate_candidates_count_once():
    calls = estimate(_payload(candidates=["a", "a", "b"]))["judge_calls"]

    assert calls["grades"] == 4


def test_output_tokens_are_the_sum_of_the_call_budgets():
    payload = _payload(candidates=["a"], test_cases=[{"question": "Q"}])
    budgets = (REFERENCE_OUTPUT_TOKENS, GRADE_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)

    output = estimate(payload)["tokens"]["output"]

    assert output == {
        "low": sum(budget[0] for budget in budgets),
        "high": sum(budget[1] for budget in budgets),
    }


def test_input_tokens_follow_the_characters_sent():
    result = estimate(_payload())

    for side in ("low", "high"):
        expected = math.ceil(result["sent_chars"][side] / CHARS_PER_TOKEN)
        assert result["tokens"]["input"][side] == expected


def test_ranges_are_ordered_and_the_total_is_the_sum():
    tokens = estimate(_payload())["tokens"]

    for part in tokens.values():
        assert 0 < part["low"] < part["high"]
    for side in ("low", "high"):
        assert tokens["total"][side] == tokens["input"][side] + tokens["output"][side]


def test_longer_criteria_and_more_candidates_cost_more():
    base = estimate(_payload())["tokens"]["total"]["low"]
    criteria = estimate(_payload(base_rationale="x" * 400))["tokens"]["total"]["low"]
    more = estimate(_payload(candidates=["a", "b", "c"]))["tokens"]["total"]["low"]

    assert criteria > base
    assert more > base


def test_cost_prices_both_ends_of_the_range():
    tokens = {
        "input": {"low": 1_000_000, "high": 2_000_000},
        "output": {"low": 500_000, "high": 1_000_000},
    }

    assert cost_of(tokens, 2.0, 8.0) == {"low": 6.0, "high": 12.0}


def test_cost_is_none_without_both_prices():
    tokens = {"input": {"low": 1, "high": 2}, "output": {"low": 1, "high": 2}}

    assert cost_of(tokens, None, None) is None
    assert cost_of(tokens, 1.0, None) is None
    assert cost_of(tokens, None, 1.0) is None
