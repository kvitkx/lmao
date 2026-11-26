"""
Unit tests for the live state of the runs. No Flask, no HTTP.
"""

import threading

from api.tasks import STARTED, TaskRegistry


def test_a_new_task_is_started_with_a_cancel_flag():
    task = TaskRegistry().add("t")

    assert task.status == STARTED
    assert task.events == []
    assert not task.cancel.is_set()


def test_active_id_is_the_task_in_progress():
    registry = TaskRegistry()
    registry.add("done", status="completed")

    assert registry.active_id() is None
    registry.add("live")
    assert registry.active_id() == "live"
    assert registry.is_running("live") is True
    assert registry.is_running("done") is False
    assert registry.is_running("nope") is False


def test_remove_forgets_a_task_and_is_safe_twice():
    registry = TaskRegistry()
    registry.add("t")

    registry.remove("t")
    registry.remove("t")

    assert registry.get("t") is None
    assert registry.ids() == []


def test_publish_to_an_unknown_task_is_ignored():
    registry = TaskRegistry()

    registry.publish("missing", {"type": "info"})

    assert registry.ids() == []


def test_wait_for_times_out_without_an_event():
    registry = TaskRegistry()
    task = registry.add("t")

    assert registry.wait_for(task, 0, timeout=0) == (False, None)


def test_wait_for_wakes_when_an_event_is_published():
    registry = TaskRegistry()
    task = registry.add("t")
    timer = threading.Timer(0.05, registry.publish, ("t", {"type": "info"}))
    timer.start()

    ready, event = registry.wait_for(task, 0, timeout=5)
    timer.join()

    assert ready is True
    assert event["type"] == "info"


def test_wait_for_reports_a_dropped_event_as_ready_and_empty():
    registry = TaskRegistry()
    task = registry.add("t", events=[None])

    assert registry.wait_for(task, 0, timeout=0) == (True, None)
