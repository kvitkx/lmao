"""The saved runs on disk.

The one place that knows the layout of a run folder and the one rule for what
a run id is. Plain Python apart from `ApiError`, so it is tested without HTTP.
"""

import os
import re
import shutil

from core.evaluator import SCHEMA_VERSION
from core.jsonfile import read_json, write_json

from .errors import ApiError

_RUN_ID_RE = re.compile(r"run_[A-Za-z0-9_-]+")

NOT_FOUND = "Results not found or not ready"


class RunStore:
    """Reads, names and deletes the runs in the history directory.

    Attributes:
        history_dir (str): Where the run folders are. It is resolved on every
            call, so a relative path follows the working directory.
    """

    def __init__(self, history_dir: str):
        self.history_dir = history_dir

    def path(self, task_id) -> str | None:
        """The folder of a run, or None if the id is not a run id.

        The id must look like run_<tag>_<date>_<time>, and the resolved path
        must stay inside the history directory.
        """
        if not isinstance(task_id, str) or not _RUN_ID_RE.fullmatch(task_id):
            return None
        base = os.path.realpath(self.history_dir)
        path = os.path.realpath(os.path.join(base, task_id))
        if not path.startswith(base + os.sep):
            return None
        return path

    def folder(self, task_id) -> str:
        """Like `path`, but an id that is not a run id is an error.

        Raises:
            ApiError: 400, Invalid task_id.
        """
        path = self.path(task_id)
        if path is None:
            raise ApiError("Invalid task_id", 400)
        return path

    def ids(self) -> list[str]:
        """The names in the history directory (not all of them are runs)."""
        if not os.path.isdir(self.history_dir):
            return []
        return os.listdir(self.history_dir)

    def read(self, task_id) -> dict | None:
        """The results of a run, or None if it is missing, not a run id or not
        in the current schema."""
        folder = self.path(task_id)
        if folder is None:
            return None
        data = read_json(os.path.join(folder, "evaluation_results.json"))
        if data is None or data.get("schema_version") != SCHEMA_VERSION:
            return None
        return data

    def load(self, task_id) -> dict:
        """The results of a run together with its technical metrics.

        Raises:
            ApiError: 400 for an invalid id, 404 for a missing run.
        """
        folder = self.folder(task_id)
        data = self.read(task_id)
        if data is None:
            raise ApiError(NOT_FOUND, 404)
        metrics_path = os.path.join(folder, "technical_metrics.json")
        metrics = (read_json(metrics_path) or {}).get("metrics", {})
        return {**data, "metrics": metrics}

    def title(self, task_id) -> str | None:
        """The name a run was given, or None for the default one."""
        folder = self.path(task_id)
        if folder is None:
            return None
        title = (read_json(os.path.join(folder, "meta.json")) or {}).get("title")
        return title.strip() if isinstance(title, str) and title.strip() else None

    def set_title(self, task_id, title: str) -> None:
        """Names a run. An empty title restores the default name."""
        path = os.path.join(self.folder(task_id), "meta.json")
        if title:
            write_json(path, {"title": title})
        elif os.path.exists(path):
            os.remove(path)

    def delete(self, task_id) -> None:
        """Removes the folder of a run.

        Raises:
            ApiError: 400 for an invalid id, 404 for a missing run.
        """
        folder = self.folder(task_id)
        if not os.path.isdir(folder):
            raise ApiError(NOT_FOUND, 404)
        shutil.rmtree(folder)
