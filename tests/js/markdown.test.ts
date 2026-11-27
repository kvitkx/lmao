import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/markdown.ts";

// Parsed blocks and trees are read field by field below: `any` keeps the
// assertions short, the shapes themselves are checked by markdown.ts.
const md = (text: unknown, options?: { bareFence?: boolean }): any[] =>
    lib.parseMarkdown(text, options);

const tree = (blocks: unknown): any => lib.markdownTree(blocks as lib.MdBlock[]);

test("parseInline splits bold and code", () => {
    const parts = lib.parseInline("a `b` **c** d");

    assert.deepEqual(
        parts.map((p) => [p.text, p.bold, p.code]),
        [
            ["a ", false, false],
            ["b", false, true],
            [" ", false, false],
            ["c", true, false],
            [" d", false, false],
        ],
    );
});

test("parseMarkdown: heading, paragraph, CRLF", () => {
    const blocks = md("# Title\r\n\r\ntext one\r\ntext two");

    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[0].inlines[0].text, "Title");
    assert.equal(blocks[1].type, "paragraph");
    assert.equal(blocks[1].inlines[0].text, "text one text two");
});

test("parseMarkdown: lists", () => {
    const [bullets] = md("- a\n- b");
    const [ordered] = md("3. x\n4. y");

    assert.equal(bullets.type, "list");
    assert.equal(bullets.ordered, false);
    assert.equal(bullets.items.length, 2);
    assert.equal(ordered.ordered, true);
    assert.equal(ordered.start, 3);
    assert.equal(md("- a\n1. b").length, 2);
});

test("parseMarkdown: code fences", () => {
    assert.deepEqual(md("```js\nconst a = 1;\n```"), [
        { type: "code", lang: "js", text: "const a = 1;" },
    ]);
    assert.deepEqual(md("```\ncode"), [{ type: "code", lang: "", text: "code" }]);
});

test("parseMarkdown unwraps a markdown fence, and a bare one only on request", () => {
    assert.equal(md("```markdown\n# T\n```")[0].type, "heading");
    assert.equal(md("```\n# T\n```")[0].type, "code");
    assert.equal(md("```\n# T\n```", { bareFence: true })[0].type, "heading");
});

test("parseMarkdown: tables with and without a header", () => {
    const [withHead] = md("| a | b |\n|---|---|\n| 1 | 2 |");
    const [noHead] = md("| 1 | 2 |\n| 3 | 4 |");

    assert.equal(withHead.type, "table");
    assert.equal(withHead.head.length, 2);
    assert.equal(withHead.head[0][0].text, "a");
    assert.equal(withHead.rows.length, 1);
    assert.deepEqual(noHead.head, []);
    assert.equal(noHead.rows.length, 2);
});

test("parseMarkdown: rule and empty input", () => {
    assert.deepEqual(md("---"), [{ type: "rule" }]);
    assert.deepEqual(md(null), []);
});

test("parseMarkdown keeps HTML as text", () => {
    const [block] = md("<script>alert(1)</script>");

    assert.equal(block.type, "paragraph");
    assert.equal(block.inlines[0].text, "<script>alert(1)</script>");
});

function collectTags(node: lib.TreeNode, tags: string[] = []): string[] {
    if (typeof node === "string") return tags;
    tags.push(node.tag);
    node.children.forEach((child) => collectTags(child, tags));
    return tags;
}

function textOf(node: lib.TreeNode): string {
    return typeof node === "string" ? node : node.children.map(textOf).join("");
}

test("markdownTree: one wrapped block per parsed block, inline styles kept", () => {
    const root = tree(md("# T\n\ntext **b** `c`"));
    const [heading, paragraph] = root.children.map((block: any) => block.children[0]);

    assert.equal(root.tag, "div");
    assert.equal(root.children.length, 2);
    assert.equal(heading.cls, "text-fg break-words text-subheading");
    assert.equal(textOf(heading), "T");
    assert.deepEqual(
        paragraph.children.map((c: any) =>
            typeof c === "string" ? c : [c.tag, c.cls, textOf(c)],
        ),
        [
            "text ",
            ["span", "text-fg", "b"],
            " ",
            ["span", "font-mono text-fg bg-bg px-4", "c"],
        ],
    );
    assert.equal(tree([]).children.length, 0);
    assert.equal(tree(null).children.length, 0);
});

test("markdownTree: lists keep their numbers and bullets", () => {
    const marker = (text: string): string[] =>
        tree(md(text)).children[0].children[0].children.map((li: any) =>
            textOf(li.children[0]),
        );

    assert.deepEqual(marker("3. x\n4. y"), ["3.", "4."]);
    assert.deepEqual(marker("- a\n- b"), ["–", "–"]);
});

test("markdownTree: code keeps its text and an optional language tag", () => {
    const code = (text: string): any => tree(md(text)).children[0].children[0];
    const withLang = code("```js\nconst a = 1;\n```");
    const noLang = code("```\nx\n```");

    assert.deepEqual(
        withLang.children.map((c: any) => c.tag),
        ["div", "pre"],
    );
    assert.equal(textOf(withLang.children[1]), "const a = 1;");
    assert.deepEqual(
        noLang.children.map((c: any) => c.tag),
        ["pre"],
    );
});

test("markdownTree: a table has a header only with a separator row", () => {
    const tags = (text: string): string[] => collectTags(tree(md(text)));

    assert.ok(tags("| a | b |\n|---|---|\n| 1 | 2 |").includes("thead"));
    assert.ok(tags("| a | b |\n|---|---|\n| 1 | 2 |").includes("th"));
    assert.ok(!tags("| 1 | 2 |").includes("thead"));
    assert.ok(tags("| 1 | 2 |").includes("td"));
});

test("markdownTree never turns model text into elements", () => {
    const root = tree(
        md("<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n```html\n<b>x</b>\n```"),
    );

    assert.ok(collectTags(root).every((tag) => ["div", "p", "pre", "span"].includes(tag)));
    assert.ok(textOf(root).includes("<script>alert(1)</script>"));
    assert.ok(textOf(root).includes("<b>x</b>"));
});

test("answerBlocks parses an answer once", () => {
    const result = { answer: "**x**" };

    assert.equal(lib.answerBlocks(result), lib.answerBlocks(result));
});

test("shortenNames replaces the longest name first", () => {
    const blocks = md("m-long and m");

    lib.shortenNames(blocks, { m: "x", "m-long": "y" });

    assert.equal(blocks[0].inlines[0].text, "y and x");
});
