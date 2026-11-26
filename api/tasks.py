"""Live state of the runs.

The worker thread of a run publishes events here and the SSE streams wait for
them. One lock and one condition guard every change, and every new event wakes
the streams that wait on it (no polling). There is no Flask in this module: the
registry is plain Python and is tested without HTTP.
"""

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime

STARTED = "started"

# The last event of a stream: the run finished, failed or was stopped.
FINAL_EVENTS = ("completed", "error", "cancelled")

# Finished tasks kept in memory, so a stream that broke right at the end can
# still replay its events. Older ones are dropped: the run is saved on disk and
# is opened from there.
MAX_FINISHED_TASKS = 3


@dataclass
class Task:
    """One run as the streams see it.

    Attributes:
        status (str): "started" while in progress, else the type of the final
            event.
        events (list): The event log. The position of an event is its stream
            id, so a dropped one is None and keeps its slot.
        cancel (threading.Event): Set to ask the run to stop.
        finished_at (float): time.monotonic() of the final event.
    """

    status: str = STARTED
    events: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    finished_at: float = 0.0


def drop_tokens(events: list, done: dict) -> None:
    """Replaces the token events of a finished answer with None.

    The ids of a stream are positions in the list, so the slots stay; a
    reconnecting client skips them and a long run does not keep every token.
    """
    for i in range(len(events) - 1, -1, -1):
        event = events[i]
        if event is None:
            continue
        same = event.get("model") == done.get("model") and event.get(
            "question"
        ) == done.get("question")
        if event.get("type") == "answer_token" and same:
            events[i] = None
        elif event.get("type") == "answer_start" and same:
            break


class TaskRegistry:
    """The tasks of this server and the condition their streams wait on.

    Attributes:
        max_finished (int): How many finished tasks are kept.
    """

    def __init__(self, max_finished: int = MAX_FINISHED_TASKS):
        self.max_finished = max_finished
        self._tasks: dict[str, Task] = {}
        self._cv = threading.Condition()

    def add(
        self,
        task_id: str,
        events: list | None = None,
        status: str = STARTED,
        finished_at: float = 0.0,
    ) -> Task:
        """Registers a task, replacing one with the same id."""
        task = Task(
            status=status,
            events=events if events is not None else [],
            finished_at=finished_at,
        )
        with self._cv:
            self._tasks[task_id] = task
        return task

    def get(self, task_id: str) -> Task | None:
        with self._cv:
            return self._tasks.get(task_id)

    def remove(self, task_id: str) -> None:
        with self._cv:
            self._tasks.pop(task_id, None)

    def ids(self) -> list[str]:
        with self._cv:
            return list(self._tasks)

    def active_id(self) -> str | None:
        """The id of the run that is in progress, if any (one at a time)."""
        with self._cv:
            for task_id, task in self._tasks.items():
                if task.status == STARTED:
                    return task_id
        return None

    def is_running(self, task_id: str) -> bool:
        task = self.get(task_id)
        return task is not None and task.status == STARTED

    def publish(self, task_id: str, payload: dict) -> None:
        """Appends an event to the task's log and wakes the streams.

        Args:
            task_id (str): The task. An unknown one is ignored.
            payload (dict): The event, for example {"type": "info", ...}. A
                final event (see FINAL_EVENTS) finishes the task.
        """
        with self._cv:
            task = self._tasks.get(task_id)
            if task is None:
                return

            payload["timestamp"] = datetime.now().isoformat()
            if payload.get("type") == "answer_done":
                drop_tokens(task.events, payload)
            task.events.append(payload)

            if payload.get("type") in FINAL_EVENTS:
                task.status = payload["type"]
                task.finished_at = time.monotonic()
                self._evict_finished()

            self._cv.notify_all()

    def wait_for(self, task: Task, index: int, timeout: float):
        """Sleeps until the task has an event at `index`.

        Returns:
            tuple: (ready, event). Not ready after `timeout` seconds: (False,
                None). A dropped event is (True, None).
        """
        with self._cv:
            ready = self._cv.wait_for(lambda: index < len(task.events), timeout=timeout)
            return ready, (task.events[index] if ready else None)

    def _evict_finished(self) -> None:
        """Drops the oldest finished tasks beyond `max_finished`.

        A task that is in progress is never dropped. Call it with the lock held.
        """
        finished = [tid for tid, task in self._tasks.items() if task.status != STARTED]
        finished.sort(key=lambda tid: self._tasks[tid].finished_at)
        for tid in finished[: max(0, len(finished) - self.max_finished)]:
            del self._tasks[tid]
