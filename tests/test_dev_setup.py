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


def test_css_watcher_provides_alpine_and_fonts():
    compose = _compose_dev()

    assert "scripts/build-assets.sh" in compose
    # the healthcheck waits for the files the page needs
    assert "static/vendor/alpine.min.js" in compose
    assert "static/fonts/inter-latin-300.woff2" in compose


def test_alpine_is_pinned_to_an_exact_version():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert re.fullmatch(r"\d+\.\d+\.\d+", package["devDependencies"]["alpinejs"])


def _assets_script():
    return (ROOT / "scripts" / "build-assets.sh").read_text(encoding="utf-8")


def test_assets_script_copies_alpine():
    assert "alpinejs/dist/cdn.min.js" in _assets_script()


def test_every_font_file_in_the_css_is_copied_by_the_assets_script():
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")
    script = _assets_script()

    names = re.findall(r'url\("\.\./fonts/([^"]+)"\)', css)

    assert names
    for name in names:
        assert f"fonts/{name}" in script


def test_font_packages_are_pinned_to_exact_versions():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    dev = package["devDependencies"]

    for name in ("@fontsource/inter", "@fontsource/ibm-plex-mono"):
        assert re.fullmatch(r"\d+\.\d+\.\d+", dev[name])


def test_css_service_compiles_and_watches_typescript():
    compose = _compose_dev()

    assert "tsc --project tsconfig.json --watch" in compose
    # the healthcheck waits for the compiled app script
    assert "static/js/lmao.js" in compose


def test_typescript_packages_are_pinned_to_exact_versions():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    dev = package["devDependencies"]

    for name in ("typescript", "@types/node", "@types/alpinejs"):
        assert re.fullmatch(r"\d+\.\d+\.\d+", dev[name])
