"""Checks of the dev setup that nothing else would notice breaking."""

import json
import re
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


def test_css_watcher_provides_alpine():
    compose = _compose_dev()

    assert "node_modules/alpinejs/dist/cdn.min.js" in compose
    assert "static/vendor/alpine.min.js" in compose


def test_alpine_is_pinned_to_an_exact_version():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert re.fullmatch(r"\d+\.\d+\.\d+", package["devDependencies"]["alpinejs"])
