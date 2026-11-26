"""The objects the endpoints share.

They are created once per app by `create_app` and read from
`app.extensions["lmao"]`, so nothing is a module global: a test builds an app
and gets its own state.
"""

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass

from flask import current_app

from core.connection import ConnectionStore
from core.evaluator import DATA_DIR, EvaluationPipeline
from core.ollama_client import OllamaClient

from .run_store import RunStore
from .tasks import TaskRegistry


def spawn_thread(target: Callable, *args) -> None:
    """Runs target(*args) in a daemon thread."""
    thread = threading.Thread(target=target, args=args)
    thread.daemon = True
    thread.start()


@dataclass
class Services:
    """Attributes:
    ollama: The local Ollama (candidates, and the judge unless it is remote).
    pipeline: Runs an evaluation.
    connection_store: The saved connection to an OpenAI-compatible API (the key).
    registry: The live state of the runs.
    runs: The saved runs on disk.
    spawn: Starts a worker, spawn(target, *args). Tests replace it.
    """

    ollama: OllamaClient
    pipeline: EvaluationPipeline
    connection_store: ConnectionStore
    registry: TaskRegistry
    runs: RunStore
    spawn: Callable[..., None] = spawn_thread


def build_services() -> Services:
    """The real objects: everything the server stores lives under DATA_DIR."""
    ollama = OllamaClient()
    pipeline = EvaluationPipeline(ollama)
    return Services(
        ollama=ollama,
        pipeline=pipeline,
        connection_store=ConnectionStore(os.path.join(DATA_DIR, "connection.json")),
        registry=TaskRegistry(),
        runs=RunStore(pipeline.history_dir),
    )


def get_services() -> Services:
    """The services of the app that is handling the request."""
    return current_app.extensions["lmao"]
