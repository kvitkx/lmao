"""Evaluation Pipeline module.

Orchestrates a blind evaluation run. The judge writes a reference answer per
question (A), every candidate answers every question (B), the judge grades each
answer on its own against the reference without seeing the model name (C), and
Python aggregates the grades into a summary and a recommendation (D).

Local mode runs the phases strictly one after another and keeps one model in
VRAM at a time. Cloud mode (a judge running remotely) runs the judge calls in a
thread pool while the candidates still generate one by one: references are made
and every answer is graded as soon as it is ready.

Every step is saved as it finishes (`_Checkpoint`). A run can therefore be
stopped between two steps and resumed later, also after an error or after the
server died: a resumed run skips the steps that are already done.
"""

import os
import re
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime

from .jsonfile import read_json, write_json
from .judge import JUDGE_NUM_CTX, judge_kwargs, judge_options
from .prompts import (
    GRADE_SCHEMA,
    GRADER_SYSTEM,
    REFERENCE_SYSTEM,
    SUMMARY_SYSTEM,
    GradeError,
    build_answer_prompt,
    build_grading_prompt,
    build_summary_prompt,
    parse_grade,
)
from .provider import JUDGE_OLLAMA, JUDGE_OPENAI, KEEP_ALIVE, Provider
from .scoring import (
    STATUS_GENERATION_ERROR,
    STATUS_JUDGE_ERROR,
    STATUS_OK,
    STATUS_TRUNCATED,
    recommend,
    summarize_model,
)
from .version import lmao_version

SCHEMA_VERSION = 3
# Everything the server stores lives under one directory: one Docker volume.
DATA_DIR = "data"
HISTORY_DIR = os.path.join(DATA_DIR, "history")
MODE_LOCAL = "local"
MODE_CLOUD = "cloud"

# State of a whole run in evaluation_results.json.
RUN_RUNNING = "running"
RUN_COMPLETED = "completed"
RUN_STOPPED = "stopped"
RUN_ERROR = "error"
# A file that still says "running" belongs to a run whose server died.
RESUMABLE_RUNS = (RUN_STOPPED, RUN_ERROR, RUN_RUNNING)

PHASE_REFERENCE = "reference"
PHASE_ANSWER = "answer"
PHASE_GRADING = "grading"
PHASE_SUMMARY = "summary"

SOURCE_GENERATED = "generated"
SOURCE_PROVIDED = "provided"
SOURCE_NONE = "none"

# Small models can loop forever; the cap keeps one bad answer from stalling a run.
CANDIDATE_OPTIONS = {"num_predict": 1000}
MAX_REFERENCE_ATTEMPTS = 2
MAX_GRADE_ATTEMPTS = 3
# Parallel judge calls in cloud mode; lower it if the cloud rate-limits requests.
CLOUD_WORKERS = 4

_SUMMED_METRICS = (
    "total_time_sec",
    "load_time_sec",
    "eval_time_sec",
    "tokens_generated",
)


class RunCancelled(Exception):
    """Raised between two steps when the run was asked to stop."""


def step_key(phase: str, model: str | None = None, question: str | None = None) -> str:
    """The id of a step. Same shape as the key of the rows in the UI."""
    return f"{phase}:{model or ''}:{question or ''}"


def _empty_metrics() -> dict:
    return {
        "total_time_sec": 0,
        "load_time_sec": 0,
        "eval_time_sec": 0,
        "tokens_generated": 0,
        "tokens_per_second": 0,
    }


def _add_metrics(total: dict, metrics: dict) -> None:
    for key in _SUMMED_METRICS:
        total[key] = round(total[key] + metrics[key], 2)
    if total["eval_time_sec"] > 0:
        total["tokens_per_second"] = round(
            total["tokens_generated"] / total["eval_time_sec"], 2
        )


def _new_question(index: int, test_case: dict) -> dict:
    provided = (test_case.get("reference") or "").strip()
    return {
        "id": f"q{index}",
        "tag": test_case.get("tag", f"Q{index}"),
        "question": test_case.get("question", ""),
        "specific_rationale": test_case.get("specific_rationale", ""),
        "reference": {
            "text": provided or None,
            "source": SOURCE_PROVIDED if provided else SOURCE_NONE,
        },
        "no_reference": not provided,
        "results": [],
    }


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _entry_for(question: dict, model: str) -> dict | None:
    return next((e for e in question["results"] if e["model_name"] == model), None)


def _aggregate(questions: list, candidates: list, footprints: dict) -> list[dict]:
    """Per-model aggregates of the answers saved so far."""
    entries = {model: [] for model in candidates}
    for question in questions:
        for entry in question["results"]:
            entries[entry["model_name"]].append(
                {
                    "status": entry["status"],
                    "score": entry["score"],
                    "no_reference": question["no_reference"],
                    "tps": entry["tps"],
                    "cps": entry["cps"],
                    "time_sec": entry["time_sec"],
                    "tokens": entry["tokens"],
                    "chars": entry["chars"],
                }
            )
    return [
        summarize_model(model, entries[model], footprints[model])
        for model in candidates
    ]


def replay_events(saved: dict) -> list[dict]:
    """Rebuilds the events of the steps a saved run has finished.

    A resumed run gets a fresh event stream. These events put the UI in the
    state the run was left in. A skipped grading (a failed answer) counts as
    finished but has no event, as in a live run.

    Args:
        saved (dict): The content of evaluation_results.json.

    Returns:
        list[dict]: The `*_done` events, with the progress at each of them.
    """
    judge = saved["judge_model"]
    total = saved["progress"]["total"]
    finished = set(saved["finished_steps"])
    questions = saved["questions_results"]
    candidates = saved["candidates"]
    events = []
    done = 0

    def add(event_type, phase, model, question, **extra):
        events.append(
            {
                "type": event_type,
                "phase": phase,
                "model": model,
                "question": question,
                "progress": {"done": done, "total": total},
                **extra,
            }
        )

    for question in questions:
        if step_key(PHASE_REFERENCE, judge, question["id"]) in finished:
            done += 1
            add(
                "reference_done",
                PHASE_REFERENCE,
                judge,
                question["id"],
                success=not question["no_reference"],
                source=question["reference"]["source"],
            )

    for model in candidates:
        for question in questions:
            if step_key(PHASE_ANSWER, model, question["id"]) in finished:
                done += 1
                entry = _entry_for(question, model)
                add(
                    "answer_done",
                    PHASE_ANSWER,
                    model,
                    question["id"],
                    success=entry["status"] != STATUS_GENERATION_ERROR,
                    error=entry["error"],
                )

    for model in candidates:
        for question in questions:
            if step_key(PHASE_GRADING, model, question["id"]) not in finished:
                continue
            done += 1
            entry = _entry_for(question, model)
            if entry["status"] == STATUS_GENERATION_ERROR:
                continue
            failed = entry["status"] == STATUS_JUDGE_ERROR
            add(
                "grading_done",
                PHASE_GRADING,
                model,
                question["id"],
                success=not failed,
                error=entry["error"] if failed else None,
            )

    if step_key(PHASE_SUMMARY, judge) in finished:
        done += 1
        add("summary_done", PHASE_SUMMARY, judge, None, success=True)

    return events


class _Run:
    """Progress, stop flag and event emitter of one evaluation run.

    Cloud mode reports from several threads, so the finished steps and the
    callback sit behind one lock and events stay in the same order as the
    progress. It also carries the provider of the run's judge, which can differ
    from the provider of the candidates.

    Attributes:
        finished (set[str]): Keys of the finished steps. A resumed run starts
            with the keys of the saved run.
    """

    def __init__(
        self,
        task_id: str,
        callback: Callable,
        total: int,
        judge_provider: Provider,
        cancel: threading.Event | None = None,
        finished=(),
        on_step: Callable | None = None,
    ):
        self.task_id = task_id
        self.callback = callback
        self.total = total
        self.judge_provider = judge_provider
        self.cancel = cancel or threading.Event()
        self.finished = set(finished)
        self.on_step = on_step
        self._lock = threading.Lock()

    @property
    def done(self) -> int:
        return len(self.finished)

    def check(self) -> None:
        """Called between steps: stops the run if it was asked to stop."""
        if self.cancel.is_set():
            raise RunCancelled()

    def is_done(self, phase: str, model=None, question=None) -> bool:
        return step_key(phase, model, question) in self.finished

    def advance(self, phase: str, model=None, question=None) -> None:
        """Marks one step as finished without an event (a skipped step)."""
        with self._lock:
            self.finished.add(step_key(phase, model, question))

    def emit(self, event_type, phase, model=None, question=None, **extra) -> None:
        """Pushes an event carrying the phase, model, question and progress."""
        with self._lock:
            self._send(event_type, phase, model, question, extra)

    def complete(self, event_type, phase, model=None, question=None, **extra) -> None:
        """Marks one step as finished, saves the run and reports a single update.

        The run is saved first, so the UI is never ahead of the disk.
        """
        with self._lock:
            self.finished.add(step_key(phase, model, question))
            if self.on_step:
                self.on_step()
            self._send(event_type, phase, model, question, extra)

    def _send(self, event_type, phase, model, question, extra) -> None:
        self.callback(
            self.task_id,
            {
                "type": event_type,
                "phase": phase,
                "model": model,
                "question": question,
                "progress": {"done": self.done, "total": self.total},
                **extra,
            },
        )


class _Checkpoint:
    """Writes the files of a run after every step.

    The results file always holds a valid summary (aggregates of what is graded
    so far, without the judge's text), so every state of a run can be shown.
    """

    def __init__(
        self,
        folder: str,
        header: dict,
        questions: list,
        candidates: list,
        metrics: dict,
        footprints: dict,
    ):
        self.folder = folder
        self.header = header
        self.questions = questions
        self.candidates = candidates
        self.metrics = metrics
        self.footprints = footprints
        self.run: _Run | None = None

    def save(self, status: str, summary: dict | None = None, finished_at=None) -> None:
        models = _aggregate(self.questions, self.candidates, self.footprints)
        if summary is None:
            summary = {
                "models": models,
                "recommendation": recommend(models),
                "text": "",
            }

        write_json(
            os.path.join(self.folder, "technical_metrics.json"),
            {
                "task_id": self.header["task_id"],
                "judge_model": self.header["judge_model"],
                "mode": self.header["mode"],
                "metrics": self.metrics,
                "footprints": self.footprints,
            },
        )
        write_json(
            os.path.join(self.folder, "evaluation_results.json"),
            {
                "schema_version": SCHEMA_VERSION,
                **self.header,
                "status": status,
                "progress": {"done": self.run.done, "total": self.run.total},
                "finished_steps": sorted(self.run.finished),
                "finished_at": finished_at,
                "questions_results": self.questions,
                "summary": summary,
            },
        )


class EvaluationPipeline:
    """Manages the lifecycle of an evaluation task.

    Attributes:
        provider (Provider): The provider that serves every model of a run.
        history_dir (str): Directory where evaluation artifacts are stored.
    """

    def __init__(self, provider: Provider):
        """Initializes the EvaluationPipeline.

        Args:
            provider (Provider): Provider used to call the models.
        """
        self.provider = provider
        self.history_dir = HISTORY_DIR
        os.makedirs(self.history_dir, exist_ok=True)

    @contextmanager
    def _loaded(self, model: str):
        """Unloads the model from VRAM when the block ends, even on errors."""
        try:
            yield
        finally:
            self.provider.unload(model)

    def _remove_think_tags(self, text: str) -> str:
        """Removes <think>...</think> blocks from the model's response.

        Args:
            text (str): The raw output generated by the model.

        Returns:
            str: The cleaned text without reasoning blocks.
        """
        cleaned_text = re.sub(r"<think>.*?</think>\n*", "", text, flags=re.DOTALL)
        return cleaned_text.strip()

    def _read_answer(self, result: dict) -> tuple[str, bool]:
        """Cleans a model reply and tells whether it was cut off.

        A reply is truncated when it hit the token limit or its <think> block
        never closed.
        """
        text = self._remove_think_tags(result["response_text"])
        truncated = result["done_reason"] == "length" or "<think>" in text
        return text, truncated

    def _judge_generate(
        self,
        run: _Run,
        judge: str,
        prompt: str,
        system_prompt: str,
        attempt=0,
        format=None,
    ) -> dict:
        return run.judge_provider.generate(
            judge, prompt, **judge_kwargs(system_prompt, attempt, format)
        )

    def _run_info(self) -> dict:
        """How the run is made: written once, kept when the run is resumed."""
        return {
            "started_at": _now(),
            "lmao_version": lmao_version(),
            "ollama_version": self.provider.get_version(),
            "candidate_params": {"think": False, **CANDIDATE_OPTIONS},
            "judge_params": judge_options(),
        }

    def run_evaluation(
        self,
        task_id: str,
        payload: dict | None,
        update_status_cb: Callable,
        judge_provider: Provider | None = None,
        saved: dict | None = None,
        cancel: threading.Event | None = None,
    ) -> None:
        """Executes the full evaluation process for a given payload.

        Args:
            task_id (str): The unique identifier for the current run.
            payload (dict | None): Configuration data from the UI (candidates,
                judge, judge_provider, base_rationale, test_cases with an
                optional reference each). None when `saved` is given.
            update_status_cb (Callable): Pushes events to the app stream.
            judge_provider (Provider, optional): Serves the judge. Defaults to
                the provider of the candidates (the local Ollama).
            saved (dict, optional): The content of evaluation_results.json of a
                stopped or failed run. The run continues from it and skips the
                steps it has finished.
            cancel (threading.Event, optional): Set to stop the run between two
                steps. A step in progress is not interrupted.
        """
        run_folder = os.path.join(self.history_dir, task_id)
        os.makedirs(run_folder, exist_ok=True)

        if saved is None:
            judge = payload.get("judge")
            judge_kind = payload.get("judge_provider", JUDGE_OLLAMA)
            candidates = list(dict.fromkeys(payload.get("candidates", [])))
            base_rationale = payload.get("base_rationale", "")
            questions = [
                _new_question(index, test_case)
                for index, test_case in enumerate(payload.get("test_cases", []), 1)
            ]
            finished = set()
            technical = {}
            run_info = self._run_info()
        else:
            judge = saved["judge_model"]
            judge_kind = saved["judge_provider"]
            candidates = saved["candidates"]
            base_rationale = saved["base_rationale"]
            questions = saved["questions_results"]
            finished = set(saved["finished_steps"])
            # An answer saved without its step was cut off by a crash: redo it.
            for question in questions:
                question["results"] = [
                    entry
                    for entry in question["results"]
                    if step_key(PHASE_ANSWER, entry["model_name"], question["id"])
                    in finished
                ]
            technical = (
                read_json(os.path.join(run_folder, "technical_metrics.json")) or {}
            )
            run_info = saved.get("run") or self._run_info()

        cloud = judge_kind != JUDGE_OLLAMA
        mode = MODE_CLOUD if cloud else MODE_LOCAL

        known_metrics = technical.get("metrics", {})
        known_footprints = technical.get("footprints", {})
        metrics = {
            model: known_metrics.get(model) or _empty_metrics() for model in candidates
        }
        sizes = self.provider.get_model_sizes()
        footprints = {}
        for model in candidates:
            footprint = {
                "size_bytes": sizes.get(model) or None,
                "memory_bytes": None,
                "vram_bytes": None,
            }
            footprint.update(
                {
                    k: v
                    for k, v in known_footprints.get(model, {}).items()
                    if v is not None
                }
            )
            footprints[model] = footprint

        checkpoint = _Checkpoint(
            run_folder,
            {
                "task_id": task_id,
                "judge_model": judge,
                "judge_provider": judge_kind,
                "mode": mode,
                # An OpenAI judge lives at the API: it cannot be a local candidate.
                "judge_is_candidate": judge_kind != JUDGE_OPENAI
                and judge in candidates,
                "candidates": candidates,
                "base_rationale": base_rationale,
                "run": run_info,
            },
            questions,
            candidates,
            metrics,
            footprints,
        )
        total = len(questions) * (1 + 2 * len(candidates)) + 1
        run = _Run(
            task_id,
            update_status_cb,
            total=total,
            judge_provider=(
                judge_provider if judge_provider is not None else self.provider
            ),
            cancel=cancel,
            finished=finished,
            on_step=lambda: checkpoint.save(RUN_RUNNING),
        )
        checkpoint.run = run
        checkpoint.save(RUN_RUNNING)

        runner = self._run_cloud if cloud else self._run_local
        try:
            summary = runner(
                run, judge, candidates, questions, metrics, footprints, base_rationale
            )
        except RunCancelled:
            checkpoint.save(RUN_STOPPED, finished_at=_now())
            update_status_cb(
                task_id,
                {
                    "type": "cancelled",
                    "message": "Run stopped.",
                    "progress": {"done": run.done, "total": total},
                },
            )
            return
        except Exception:
            checkpoint.save(RUN_ERROR, finished_at=_now())
            raise

        checkpoint.save(RUN_COMPLETED, summary=summary, finished_at=_now())
        update_status_cb(
            task_id,
            {"type": "completed", "message": "All tasks completed successfully."},
        )

    # --- orchestration ------------------------------------------------------

    def _run_local(
        self, run, judge, candidates, questions, metrics, footprints, base_rationale
    ) -> dict:
        """A, B, C and D strictly one after another, one model in VRAM at a time."""
        pending = [
            question
            for question in questions
            if not run.is_done(PHASE_REFERENCE, judge, question["id"])
        ]
        if pending:
            with self._loaded(judge):
                for question in pending:
                    self._make_reference(run, judge, question)

        for model in candidates:
            self._answer_all(run, model, questions, metrics[model], footprints[model])

        # Grading and the summary share one load of the judge. Grading goes
        # model by model, the same order as in cloud mode.
        with self._loaded(judge):
            for model in candidates:
                for question, entry in self._entries_of(model, questions):
                    self._grade_entry(run, judge, question, base_rationale, entry)
            return self._summarize(run, judge, questions, candidates, footprints)

    def _run_cloud(
        self, run, judge, candidates, questions, metrics, footprints, base_rationale
    ) -> dict:
        """Judge calls run in a pool while the candidates generate one by one."""
        pool = ThreadPoolExecutor(max_workers=CLOUD_WORKERS)
        try:
            references = {
                question["id"]: pool.submit(self._make_reference, run, judge, question)
                for question in questions
            }
            gradings = []

            def grade_when_answered(question, entry):
                gradings.append(
                    pool.submit(
                        self._grade_after,
                        references[question["id"]],
                        run,
                        judge,
                        question,
                        base_rationale,
                        entry,
                    )
                )

            # Answers saved before a stop: grade what is still ungraded.
            for question in questions:
                for entry in question["results"]:
                    grade_when_answered(question, entry)

            for model in candidates:
                self._answer_all(
                    run,
                    model,
                    questions,
                    metrics[model],
                    footprints[model],
                    grade_when_answered,
                )

            # Surface any exception raised in a worker thread.
            for future in [*references.values(), *gradings]:
                future.result()
        except BaseException:
            pool.shutdown(wait=True, cancel_futures=True)
            raise
        pool.shutdown(wait=True)

        return self._summarize(run, judge, questions, candidates, footprints)

    @staticmethod
    def _entries_of(model: str, questions: list):
        """Yields (question, entry) for the answers of one model, in question order."""
        for question in questions:
            for entry in question["results"]:
                if entry["model_name"] == model:
                    yield question, entry

    # --- A: references ------------------------------------------------------

    def _make_reference(self, run: _Run, judge: str, question: dict) -> None:
        if run.is_done(PHASE_REFERENCE, judge, question["id"]):
            return
        run.check()
        run.emit("reference_start", PHASE_REFERENCE, judge, question["id"])

        if question["reference"]["source"] != SOURCE_PROVIDED:
            text = self._generate_reference(run, judge, question["question"])
            if text:
                question["reference"] = {"text": text, "source": SOURCE_GENERATED}
                question["no_reference"] = False

        run.complete(
            "reference_done",
            PHASE_REFERENCE,
            judge,
            question["id"],
            success=not question["no_reference"],
            source=question["reference"]["source"],
        )

    def _generate_reference(self, run: _Run, judge: str, question: str) -> str | None:
        """Returns a complete reference answer, or None after the last attempt."""
        for attempt in range(MAX_REFERENCE_ATTEMPTS):
            result = self._judge_generate(
                run, judge, build_answer_prompt(question), REFERENCE_SYSTEM, attempt
            )
            if result["success"]:
                text, truncated = self._read_answer(result)
                if text and not truncated:
                    return text
        return None

    # --- B: candidate answers -----------------------------------------------

    def _answer_all(
        self,
        run: _Run,
        model: str,
        questions: list,
        metrics: dict,
        footprint: dict,
        on_answer: Callable | None = None,
    ) -> None:
        """One candidate answers the questions it has not answered yet.

        The model is loaded once, and only if something is left to answer.
        After the first answer that was generated, the memory the loaded model
        takes is read once (unless a resumed run already has it).

        Args:
            footprint (dict): Updated in place with memory_bytes and vram_bytes.
            on_answer (Callable, optional): Called with the question and the
                saved entry right after each answer.
        """
        pending = [
            question
            for question in questions
            if not run.is_done(PHASE_ANSWER, model, question["id"])
        ]
        if not pending:
            return

        run.emit("candidate_start", PHASE_ANSWER, model)

        measured = footprint["memory_bytes"] is not None
        with self._loaded(model):
            for question in pending:
                run.check()
                entry = self._answer(run, model, question, metrics)
                if not measured and entry["status"] != STATUS_GENERATION_ERROR:
                    measured = True
                    loaded = self.provider.get_loaded(model)
                    if loaded:
                        footprint["memory_bytes"] = loaded["size"]
                        footprint["vram_bytes"] = loaded["size_vram"]
                if on_answer:
                    on_answer(question, entry)

    def _answer(self, run: _Run, model: str, question: dict, metrics: dict) -> dict:
        run.emit("answer_start", PHASE_ANSWER, model, question["id"])

        result = self.provider.generate(
            model,
            build_answer_prompt(question["question"]),
            think=False,
            options=CANDIDATE_OPTIONS,
            keep_alive=KEEP_ALIVE,
        )
        entry = self._answer_entry(model, result)
        question["results"].append(entry)
        if result["success"]:
            _add_metrics(metrics, result["metrics"])

        run.complete(
            "answer_done",
            PHASE_ANSWER,
            model,
            question["id"],
            success=result["success"],
            error=entry["error"],
        )
        return entry

    def _answer_entry(self, model: str, result: dict) -> dict:
        entry = {
            "model_name": model,
            "answer": "",
            "status": STATUS_GENERATION_ERROR,
            "category": None,
            "score": None,
            "comment": "",
            "truncated": False,
            "done_reason": "",
            "error": result.get("error"),
            "tps": None,
            "cps": None,
            "time_sec": None,
            "tokens": None,
            "chars": None,
        }
        if result["success"]:
            text, truncated = self._read_answer(result)
            metrics = result["metrics"]
            eval_time = metrics["eval_time_sec"]
            entry.update(
                answer=text,
                status=STATUS_TRUNCATED if truncated else STATUS_OK,
                truncated=truncated,
                done_reason=result["done_reason"],
                tps=metrics["tokens_per_second"],
                tokens=metrics["tokens_generated"],
                chars=len(text),
                # Characters of the cleaned answer, not tokens: tokenizers differ
                # between models, so t/s does not compare across them.
                cps=round(len(text) / eval_time, 2) if eval_time > 0 else None,
                # Answer time without the model load.
                time_sec=round(
                    max(metrics["total_time_sec"] - metrics["load_time_sec"], 0), 2
                ),
            )
        return entry

    # --- C: grading ---------------------------------------------------------

    def _grade_after(self, reference: Future, *args) -> None:
        """Waits for the question's reference, then grades (cloud mode)."""
        reference.result()
        self._grade_entry(*args)

    def _grade_entry(
        self, run: _Run, judge: str, question: dict, base_rationale: str, entry: dict
    ) -> None:
        model = entry["model_name"]
        if run.is_done(PHASE_GRADING, model, question["id"]):
            return
        run.check()

        if entry["status"] == STATUS_GENERATION_ERROR:
            run.advance(PHASE_GRADING, model, question["id"])
            return

        run.emit("grading_start", PHASE_GRADING, model, question["id"])
        grade, error = self._grade(run, judge, question, base_rationale, entry)
        if grade:
            entry.update(grade)
        else:
            entry.update(status=STATUS_JUDGE_ERROR, error=error)

        run.complete(
            "grading_done",
            PHASE_GRADING,
            model,
            question["id"],
            success=grade is not None,
            error=error,
        )

    def _grade(
        self, run: _Run, judge: str, question: dict, base_rationale: str, entry: dict
    ) -> tuple[dict | None, str | None]:
        """Grades one answer. Returns (grade, None) or (None, error)."""
        prompt = build_grading_prompt(
            question["question"],
            question["reference"]["text"],
            base_rationale,
            question["specific_rationale"],
            entry["answer"],
            entry["truncated"],
        )

        error = "Unknown error."
        for attempt in range(MAX_GRADE_ATTEMPTS):
            system_prompt = GRADER_SYSTEM
            if attempt > 0:
                system_prompt += f" Your previous reply was rejected: {error}"

            result = self._judge_generate(
                run, judge, prompt, system_prompt, attempt, format=GRADE_SCHEMA
            )
            if not result["success"]:
                error = result["error"]
                continue

            # Ollama silently cuts a prompt that does not fit the context window.
            if (
                run.judge_provider.truncates_prompts
                and result["prompt_eval_count"] >= JUDGE_NUM_CTX
            ):
                return None, "Judge prompt does not fit the context window."

            try:
                return parse_grade(result["response_text"]), None
            except GradeError as e:
                error = str(e)

        return None, error

    # --- D: summary ---------------------------------------------------------

    def _summarize(
        self, run: _Run, judge: str, questions: list, candidates: list, footprints: dict
    ) -> dict:
        run.check()
        run.emit("summary_start", PHASE_SUMMARY, judge)

        models = _aggregate(questions, candidates, footprints)
        recommendation = recommend(models)

        result = self._judge_generate(
            run,
            judge,
            build_summary_prompt(models, recommendation),
            SUMMARY_SYSTEM,
        )
        if result["success"]:
            text = self._remove_think_tags(result["response_text"])
        else:
            text = f"Failed to generate summary: {result['error']}"

        run.complete("summary_done", PHASE_SUMMARY, judge, success=result["success"])

        return {"models": models, "recommendation": recommendation, "text": text}
