"""How the judge is called: the sampling options of every judge call.

Pure module: no I/O and no model calls. The run, the request preview, the
estimate and the connection check all read these values from here, so none of
them has to import the evaluation pipeline.
"""

from .provider import KEEP_ALIVE

JUDGE_NUM_CTX = 8192
JUDGE_NUM_PREDICT = 1000
JUDGE_SEED = 42


def judge_options(attempt: int = 0) -> dict:
    """Deterministic judge options. The seed changes per attempt, because an
    identical retry at temperature 0 would return the identical reply."""
    return {
        "temperature": 0,
        "seed": JUDGE_SEED + attempt,
        "num_ctx": JUDGE_NUM_CTX,
        "num_predict": JUDGE_NUM_PREDICT,
    }


def judge_kwargs(system_prompt: str, attempt: int = 0, format=None) -> dict:
    """What every judge call sends besides the prompt.

    One place for the run and for the request preview, so they cannot drift.
    """
    return {
        "system_prompt": system_prompt,
        "format": format,
        "think": False,
        "options": judge_options(attempt),
        "keep_alive": KEEP_ALIVE,
    }
