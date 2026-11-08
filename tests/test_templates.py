"""
Structural checks for the rendered HTML.

The page is built from Jinja macros and Alpine <template> blocks. A missing or
extra closing tag fails nothing loudly: the browser repairs the tree silently
and a block ends up in the wrong place.
"""

import re
from html.parser import HTMLParser
from pathlib import Path

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "source", "track", "wbr",
}  # fmt: skip


class _Balance(HTMLParser):
    def __init__(self, lines):
        super().__init__()
        self.lines = lines
        self.stack = []  # (tag, line it was opened on)
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        line = self.getpos()[0]
        if not self.stack or self.stack[-1][0] != tag:
            innermost = self.stack[-1] if self.stack else None
            self.errors.append(
                f"unexpected </{tag}> at line {line}: "
                f"{self.lines[line - 1].strip()!r}; innermost open tag: {innermost}"
            )
            return
        self.stack.pop()


def test_index_html_tags_are_balanced(client):
    html = client.get("/").get_data(as_text=True)
    parser = _Balance(html.splitlines())
    parser.feed(html)
    parser.close()

    assert parser.errors == []
    assert parser.stack == []


def test_index_html_has_export_links_and_print_button(client):
    html = client.get("/").get_data(as_text=True)

    for fmt in ("json", "csv", "md"):
        assert f"/export?format={fmt}" in html
    assert "window.print()" in html


def test_css_source_has_print_styles():
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")

    assert "@media print" in css


def test_index_html_renders_answers_only_when_opened(client):
    html = client.get("/").get_data(as_text=True)

    assert "toggleAnswer(" in html
    assert 'x-if="isAnswerOpen(' in html


def test_index_html_builds_markdown_with_the_directive(client):
    html = client.get("/").get_data(as_text=True)

    assert 'x-md="' in html
    assert 'x-for="(b, bi)' not in html
    assert "x-html" not in html


def test_scripts_never_write_html():
    scripts = Path(__file__).parent.parent / "static" / "js"

    for path in scripts.glob("*.js"):
        text = path.read_text(encoding="utf-8")
        for forbidden in ("innerHTML", "outerHTML", "insertAdjacentHTML"):
            assert forbidden not in text, f"{path.name} uses {forbidden}"


def test_offscreen_eval_blocks_are_deferred_but_printed():
    html = (ROOT / "templates" / "_components.html").read_text(encoding="utf-8")
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")

    assert "defer-render" in html
    assert "content-visibility: auto" in css
    # print shows every block
    assert "content-visibility: visible" in css


ROOT = Path(__file__).parent.parent


def test_index_html_uses_the_built_stylesheet(client):
    html = client.get("/").get_data(as_text=True)

    assert "/static/css/app.css" in html
    assert "@tailwindcss/browser" not in html
    assert "text/tailwindcss" not in html


def test_css_build_reads_templates_and_scripts():
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")

    assert '@import "tailwindcss" source(none);' in css
    assert '@source "../../templates";' in css
    assert '@source "../js";' in css


def test_nav_toggle_classes_are_in_the_css_safelist(client):
    html = client.get("/").get_data(as_text=True)
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")

    # nav_toggle builds these from a Jinja variable, so the class scan of the
    # CSS build cannot see them: they must be listed in input.css.
    for composed in ("-left-px w-7", "left-6 w-px", "-right-px w-7", "right-6 w-px"):
        assert composed in html
        for name in composed.split():
            assert name in css


def test_index_html_serves_alpine_from_static(client):
    html = client.get("/").get_data(as_text=True)

    assert "/static/vendor/alpine.min.js" in html
    assert "cdn.jsdelivr.net" not in html
    # the page scripts must register 'alpine:init' before Alpine starts
    assert html.index("js/lmao.js") < html.index("vendor/alpine.min.js")


def test_index_html_loads_nothing_from_another_host(client):
    html = client.get("/").get_data(as_text=True)

    assert re.findall(r'(?:src|href)="https?://', html) == []
    assert "fonts.googleapis.com" not in html
    assert "fonts.gstatic.com" not in html


def test_index_html_preloads_the_body_font(client):
    html = client.get("/").get_data(as_text=True)

    assert "/static/fonts/inter-latin-300.woff2" in html
    assert 'as="font"' in html
    assert "crossorigin" in html
