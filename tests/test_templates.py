"""
Structural checks for the rendered HTML.

The page is built from Jinja macros and Alpine <template> blocks. A missing or
extra closing tag fails nothing loudly: the browser repairs the tree silently
and a block ends up in the wrong place.
"""

import re
from functools import reduce
from html.parser import HTMLParser
from math import gcd
from pathlib import Path

ROOT = Path(__file__).parent.parent

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
    scripts = ROOT / "frontend"

    assert list(scripts.glob("*.ts"))
    for path in scripts.glob("*.ts"):
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


def test_index_html_uses_the_built_stylesheet(client):
    html = client.get("/").get_data(as_text=True)

    assert "/static/css/app.css" in html
    assert "@tailwindcss/browser" not in html
    assert "text/tailwindcss" not in html


def test_css_build_reads_templates_and_scripts():
    css = (ROOT / "static" / "css" / "input.css").read_text(encoding="utf-8")

    assert '@import "tailwindcss" source(none);' in css
    assert '@source "../../templates";' in css
    assert '@source "../../frontend";' in css


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


def test_index_html_loads_the_app_as_one_module(client):
    html = client.get("/").get_data(as_text=True)

    assert '<script type="module" src="/static/js/lmao.js"></script>' in html
    assert "js/lib.js" not in html


# --- progress and the blue squares -------------------------------------------


def _ratio(numbers):
    divisor = reduce(gcd, numbers)
    return [number // divisor for number in numbers]


def test_progress_segments_follow_the_bars_of_the_favicon():
    html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    favicon = (ROOT / "frontend" / "favicon.ts").read_text(encoding="utf-8")

    grid = re.search(r"grid-cols-\[(\d+)fr_(\d+)fr_(\d+)fr_(\d+)fr\] gap-33", html)
    widths = [int(width) for width in re.findall(r"\bw: (\d+)", favicon)]

    assert grid
    assert _ratio([int(part) for part in grid.groups()]) == [1, 4, 3, 3]
    assert _ratio(widths) == [1, 4, 3, 3]


def test_progress_segments_have_no_activity_dot():
    html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")

    segment = html.split('x-for="p in phaseProgress"')[1].split("</template>")[0]

    assert "activity_dot" not in segment
    assert "bg-link" not in segment


def test_status_rows_have_no_activity_dot():
    components = (ROOT / "templates" / "_components.html").read_text(encoding="utf-8")

    macro = components.split("{% macro status_row(")[1].split("{%- endmacro %}")[0]

    assert "activity_dot" not in macro


def test_topbar_is_icon_only_with_a_progress_hairline(client):
    html = client.get("/").get_data(as_text=True)

    header = html.split("<header")[1].split("</header>")[0]

    assert 'aria-label="setup"' in header
    assert 'aria-label="archive"' in header
    assert "<span>setup</span>" not in header
    assert "<span>archive</span>" not in header
    assert "local model assessment operator" not in header
    assert "'width:' + pct + '%'" in header
    assert "local model assessment operator" in html


def test_topbar_status_has_no_step_count_but_the_tab_title_keeps_it():
    source = (ROOT / "frontend" / "lmao.ts").read_text(encoding="utf-8")

    status = source.split("get topStatus()")[1].split("get phaseProgress()")[0]
    title = source.split("get pageTitle()")[1].split("get faviconBars()")[0]

    assert "run.total" not in status
    assert "run.done" not in status
    assert "this.run.done} / ${this.run.total}" in title


def test_dataset_buttons_are_two_equal_secondary_buttons(client):
    html = client.get("/").get_data(as_text=True)

    buttons = re.findall(
        r'<button[^>]*class="([^"]*)"[^>]*>(import|export) dataset</button>', html
    )

    assert [label for _, label in buttons] == ["import", "export"]
    for classes, _ in buttons:
        assert "flex-1" in classes
        assert "border border-fg-muted" in classes
        assert "px-12 py-4" in classes
    assert ">import</button>" not in html
    assert ">export</button>" not in html
