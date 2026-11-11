"""
Unit tests for the connection preflight. The provider is a scripted fake.
"""

from core.evaluator import JUDGE_NUM_PREDICT
from core.preflight import CHECK_TIMEOUT_SEC, DETAIL_LIMIT, run_preflight
from core.prompts import GRADE_SCHEMA
from core.provider import Provider

GRADE = '{"comment": "ok", "category": "perfect", "score": 95}'


def ok(text, prompt_tokens=20, tokens=5):
    return {
        "success": True,
        "response_text": text,
        "done_reason": "stop",
        "prompt_eval_count": prompt_tokens,
        "metrics": {
            "total_time_sec": 0.1,
            "load_time_sec": 0,
            "eval_time_sec": 0.1,
            "tokens_generated": tokens,
            "tokens_per_second": 50,
        },
    }


def fail(error):
    return {"success": False, "error": error}


class FakeProvider(Provider):
    """Answers the structured call and the sampling call from a script."""

    def __init__(self, models=("m",), structured=None, sampling=None):
        self.models = list(models)
        self.structured = structured or ok(GRADE)
        self.sampling = sampling or ok("ok")
        self.calls = []

    def get_models(self):
        return self.models

    def generate(
        self,
        model,
        prompt,
        system_prompt="",
        format=None,
        think=None,
        options=None,
        keep_alive=0,
        timeout=None,
    ):
        self.calls.append(
            {
                "model": model,
                "prompt": prompt,
                "format": format,
                "think": think,
                "options": options,
                "timeout": timeout,
            }
        )
        return self.structured if format is not None else self.sampling


def _states(report):
    return {check["key"]: check["state"] for check in report["checks"]}


def _check(report, key):
    return next(check for check in report["checks"] if check["key"] == key)


def test_a_working_connection_passes_every_check():
    report = run_preflight(FakeProvider(), "m")

    assert report["ok"] is True
    assert [check["key"] for check in report["checks"]] == [
        "models",
        "structured",
        "sampling",
        "usage",
        "rate_limit",
    ]
    assert _states(report) == {
        "models": "done",
        "structured": "done",
        "sampling": "done",
        "usage": "done",
        "rate_limit": "skipped",
    }
    assert _check(report, "models")["detail"] == "1 listed"
    assert _check(report, "usage")["detail"] == "20 in · 5 out"
    assert _check(report, "rate_limit")["detail"] == "not measured"
    assert isinstance(_check(report, "models")["ms"], int)
    assert _check(report, "usage")["ms"] is None


def test_an_empty_model_list_skips_every_call():
    provider = FakeProvider(models=[])

    report = run_preflight(provider, "m")

    assert report["ok"] is False
    assert _states(report) == {
        "models": "error",
        "structured": "skipped",
        "sampling": "skipped",
        "usage": "skipped",
        "rate_limit": "skipped",
    }
    assert provider.calls == []


def test_a_model_that_is_not_listed_is_an_error():
    provider = FakeProvider(models=["other"])

    report = run_preflight(provider, "m")

    assert report["ok"] is False
    assert _check(report, "models")["state"] == "error"
    assert "'m'" in _check(report, "models")["detail"]
    assert provider.calls == []


def test_the_structured_call_uses_the_grade_schema_without_sampling_options():
    provider = FakeProvider()

    run_preflight(provider, "m")

    structured = provider.calls[0]
    assert structured["model"] == "m"
    assert structured["format"] == GRADE_SCHEMA
    assert structured["think"] is False
    assert structured["timeout"] == CHECK_TIMEOUT_SEC
    assert structured["options"] == {"num_predict": JUDGE_NUM_PREDICT}


def test_the_sampling_call_sends_temperature_and_seed():
    provider = FakeProvider()

    run_preflight(provider, "m")

    sampling = provider.calls[1]
    assert sampling["format"] is None
    assert sampling["timeout"] == CHECK_TIMEOUT_SEC
    assert sampling["options"] == {
        "temperature": 0,
        "seed": 1,
        "num_predict": JUDGE_NUM_PREDICT,
    }


def test_an_invalid_grade_fails_the_structured_check_only():
    provider = FakeProvider(structured=ok("not json"))

    report = run_preflight(provider, "m")

    assert report["ok"] is False
    assert _states(report)["structured"] == "error"
    assert "not a valid grade" in _check(report, "structured")["detail"]
    assert _states(report)["sampling"] == "done"


def test_a_failed_structured_call_reports_the_error():
    provider = FakeProvider(structured=fail("400: bad schema"))

    report = run_preflight(provider, "m")

    assert _check(report, "structured")["detail"] == "400: bad schema"
    assert report["ok"] is False


def test_rejected_sampling_options_fail_the_sampling_check():
    text = "400: Unsupported value: 'temperature' does not support 0"
    provider = FakeProvider(sampling=fail(text))

    report = run_preflight(provider, "m")

    assert report["ok"] is False
    assert _check(report, "sampling")["state"] == "error"
    assert "temperature" in _check(report, "sampling")["detail"]


def test_a_schema_that_fell_back_to_a_json_object_is_reported():
    provider = FakeProvider()
    provider.json_schema = False

    report = run_preflight(provider, "m")

    assert report["ok"] is True
    assert "plain JSON" in _check(report, "structured")["detail"]


def test_missing_token_usage_is_flagged_but_does_not_fail_the_run():
    provider = FakeProvider(sampling=ok("ok", tokens=0))

    report = run_preflight(provider, "m")

    assert _states(report)["usage"] == "error"
    assert report["ok"] is True


def test_usage_is_skipped_when_both_calls_fail():
    provider = FakeProvider(structured=fail("x"), sampling=fail("y"))

    report = run_preflight(provider, "m")

    assert _states(report)["usage"] == "skipped"
    assert report["ok"] is False


def test_a_long_error_is_cut():
    provider = FakeProvider(structured=fail("x" * 1000))

    report = run_preflight(provider, "m")

    assert len(_check(report, "structured")["detail"]) == DETAIL_LIMIT
