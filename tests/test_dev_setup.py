"""Checks of the dev setup that nothing else would notice breaking."""

from pathlib import Path

ROOT = Path(__file__).parent.parent


def _compose_dev():
    return (ROOT / "compose.dev.yaml").read_text(encoding="utf-8")


def test_css_watcher_keeps_running_without_a_terminal():
    # Tailwind v4 --watch exits when stdin closes, which it does in a container.
    assert "--watch=always" in _compose_dev()


def test_css_watcher_uses_the_light_stage_and_app_waits_for_it():
    compose = _compose_dev()

    assert "target: css-deps" in compose
    assert "condition: service_healthy" in compose
