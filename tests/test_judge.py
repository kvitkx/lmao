"""
Unit tests for the options of a judge call.
"""

from pathlib import Path

from core.judge import (
    JUDGE_NUM_CTX,
    JUDGE_NUM_PREDICT,
    JUDGE_SEED,
    judge_kwargs,
    judge_options,
)
from core.provider import KEEP_ALIVE

ROOT = Path(__file__).parent.parent


def test_options_are_deterministic_and_the_seed_follows_the_attempt():
    assert judge_options() == {
        "temperature": 0,
        "seed": JUDGE_SEED,
        "num_ctx": JUDGE_NUM_CTX,
        "num_predict": JUDGE_NUM_PREDICT,
    }
    assert judge_options(2)["seed"] == JUDGE_SEED + 2


def test_kwargs_are_what_every_judge_call_sends():
    assert judge_kwargs("sys", 1, {"type": "object"}) == {
        "system_prompt": "sys",
        "format": {"type": "object"},
        "think": False,
        "options": judge_options(1),
        "keep_alive": KEEP_ALIVE,
    }


def test_budget_and_preflight_do_not_import_the_evaluator():
    for name in ("budget", "preflight"):
        source = (ROOT / "core" / f"{name}.py").read_text(encoding="utf-8")
        assert ".evaluator" not in source, name
