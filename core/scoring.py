"""Aggregation of graded answers and the model recommendation rule.

Pure module: no I/O and no model calls. The numbers and the recommendation are
computed here in Python; the judge only retells them.
"""

import statistics

STATUS_OK = "ok"
STATUS_TRUNCATED = "truncated"
STATUS_GENERATION_ERROR = "generation_error"
STATUS_JUDGE_ERROR = "judge_error"

# Score buckets: pass >= PASS_MIN_SCORE, fail in [CRITICAL_BELOW, PASS_MIN_SCORE),
# critical fail < CRITICAL_BELOW.
PASS_MIN_SCORE = 70
CRITICAL_BELOW = 40

# A model is recommended on speed only if it passes at least this share.
PASS_RATE_THRESHOLD = 0.7
# Fewer graded questions than this means a low-confidence recommendation.
MIN_QUESTIONS = 5

RULE_FASTEST_ABOVE_THRESHOLD = "fastest_above_threshold"
RULE_HIGHEST_MEDIAN = "highest_median"
RULE_NONE_GRADED = "none_graded"

CONFIDENCE_HIGH = "high"
CONFIDENCE_LOW = "low"

# Ollama counts a gigabyte as 10^9 bytes.
BYTES_PER_GB = 1e9


def _median(values: list, digits: int):
    return round(statistics.median(values), digits) if values else None


def _mean(values: list, digits: int):
    return round(statistics.fmean(values), digits) if values else None


def summarize_model(
    model: str, entries: list[dict], footprint: dict | None = None
) -> dict:
    """Aggregates the answers of one model.

    Args:
        model (str): The model name.
        entries (list[dict]): One entry per question with the keys status,
            score (int or None), no_reference (bool), tps (tokens per second or
            None), cps (characters per second or None), time_sec (answer
            time without model loading, or None) and optionally tokens and
            chars (generated tokens and length of the cleaned answer).
        footprint (dict, optional): size_bytes (on disk), memory_bytes and
            vram_bytes (while loaded). Missing values stay None.

    Returns:
        dict: model, n (answers counted in the score), mean, median,
            pass_rate (fraction), fails, critical_fails, errors,
            judge_errors, n_no_reference, median_tps, median_cps,
            median_time_sec, avg_chars, tokens_per_pass (tokens spent per
            passed answer), score_per_gb, size_bytes, memory_bytes and
            vram_bytes.
    """
    scores = []
    errors = judge_errors = n_no_reference = 0

    for entry in entries:
        status = entry["status"]
        if status == STATUS_GENERATION_ERROR:
            errors += 1
            scores.append(0)
        elif status == STATUS_JUDGE_ERROR:
            judge_errors += 1
        elif entry["no_reference"]:
            n_no_reference += 1
        elif status == STATUS_TRUNCATED:
            scores.append(min(entry["score"], PASS_MIN_SCORE - 1))
        else:
            scores.append(entry["score"])

    answered = [e for e in entries if e["status"] != STATUS_GENERATION_ERROR]
    n = len(scores)
    passed = sum(1 for score in scores if score >= PASS_MIN_SCORE)
    mean = _mean(scores, 1)

    footprint = footprint or {}
    size_bytes = footprint.get("size_bytes")
    chars = [e["chars"] for e in answered if e.get("chars") is not None]
    tokens = [e["tokens"] for e in answered if e.get("tokens") is not None]

    return {
        "model": model,
        "n": n,
        "mean": mean,
        "median": _median(scores, 1),
        "pass_rate": round(passed / n, 2) if n else None,
        "fails": sum(1 for s in scores if CRITICAL_BELOW <= s < PASS_MIN_SCORE),
        "critical_fails": sum(1 for s in scores if s < CRITICAL_BELOW),
        "errors": errors,
        "judge_errors": judge_errors,
        "n_no_reference": n_no_reference,
        "median_tps": _median([e["tps"] for e in answered], 2),
        "median_cps": _median([e["cps"] for e in answered if e["cps"] is not None], 2),
        "median_time_sec": _median([e["time_sec"] for e in answered], 2),
        "avg_chars": round(statistics.fmean(chars)) if chars else None,
        "tokens_per_pass": round(sum(tokens) / passed) if passed and tokens else None,
        "score_per_gb": (
            round(mean / (size_bytes / BYTES_PER_GB), 1)
            if mean is not None and size_bytes
            else None
        ),
        "size_bytes": size_bytes,
        "memory_bytes": footprint.get("memory_bytes"),
        "vram_bytes": footprint.get("vram_bytes"),
    }


def recommend(models: list[dict]) -> dict:
    """Picks the model to recommend.

    Args:
        models (list[dict]): Results of `summarize_model` for every model.

    Returns:
        dict: model (or None), rule and confidence.
    """
    graded = [m for m in models if m["n"] > 0]
    if not graded:
        return {
            "model": None,
            "rule": RULE_NONE_GRADED,
            "confidence": CONFIDENCE_LOW,
        }

    qualified = [m for m in graded if m["pass_rate"] >= PASS_RATE_THRESHOLD]
    if qualified:
        rule = RULE_FASTEST_ABOVE_THRESHOLD
        best = min(
            qualified,
            key=lambda m: (
                m["median_time_sec"]
                if m["median_time_sec"] is not None
                else float("inf"),
                -m["median"],
                m["model"],
            ),
        )
    else:
        rule = RULE_HIGHEST_MEDIAN
        best = min(
            graded,
            key=lambda m: (-m["median"], -m["pass_rate"], m["model"]),
        )

    confidence = CONFIDENCE_LOW if best["n"] < MIN_QUESTIONS else CONFIDENCE_HIGH
    return {"model": best["model"], "rule": rule, "confidence": confidence}
