// Markdown of model output: parser, element tree and short names in a text. Pure; tested in tests/js/markdown.test.ts.

export interface Inline {
    text: string;
    bold: boolean;
    code: boolean;
}

export type MdBlock =
    | { type: "heading"; level: number; inlines: Inline[] }
    | { type: "paragraph"; inlines: Inline[] }
    | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
    | { type: "code"; lang: string; text: string }
    | { type: "table"; head: Inline[][]; rows: Inline[][][] }
    | { type: "rule" };

// Markdown -> blocks. Nothing here touches the DOM: the template renders the
// blocks with x-text, so no HTML from a model is ever injected or executed.
// Blocks: heading, paragraph, list (- * + and 1.), code (``` fences), table, rule.
// Inline: **bold**, `code`. Everything else (links, italics, HTML) stays text.
export function parseInline(text: string): Inline[] {
    const parts: Inline[] = [];
    const re = /`([^`]+)`|\*\*(.+?)\*\*/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
        if (match.index > last) {
            parts.push({ text: text.slice(last, match.index), bold: false, code: false });
        }
        if (match[1] !== undefined) parts.push({ text: match[1], bold: false, code: true });
        else parts.push({ text: match[2], bold: true, code: false });
        last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold: false, code: false });
    return parts;
}

// Models often wrap the whole text in ```markdown ... ```. Unwrap it;
// with `bareToo` also a fence without a language (the judge summary).
function unwrapFence(text: string, bareToo?: boolean): string {
    const match = /^\s*```([\w-]*)[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
    if (!match) return text;
    const lang = match[1].toLowerCase();
    return lang === "markdown" || lang === "md" || (bareToo && !lang) ? match[2] : text;
}

// '| a | b |' -> ['a', 'b']
function tableCells(line: string): Inline[][] {
    return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => parseInline(cell.trim()));
}

interface ListState {
    ordered: boolean;
    start: number;
    items: Inline[][];
}

interface CodeState {
    lang: string;
    lines: string[];
}

export function parseMarkdown(
    text: unknown,
    options: { bareFence?: boolean } = {},
): MdBlock[] {
    const source = unwrapFence(String(text || "").replace(/\r\n?/g, "\n"), options.bareFence);
    const blocks: MdBlock[] = [];
    let paragraph: string[] = [];
    // `as`: the flush helpers below assign these, which the flow analysis cannot see.
    let list = null as ListState | null;
    let table = null as string[] | null;
    let code = null as CodeState | null;

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list) {
            blocks.push({ type: "list", ...list });
            list = null;
        }
    };
    const flushTable = () => {
        if (table) {
            // a header row needs the |---| separator; otherwise every row is data
            const hasHead =
                table.length > 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(table[1]) && table[1].includes("-");
            const rows = table.filter((_, i) => !(hasHead && i === 1)).map(tableCells);
            blocks.push({
                type: "table",
                head: hasHead ? rows[0] : [],
                rows: hasHead ? rows.slice(1) : rows,
            });
            table = null;
        }
    };
    const flushAll = () => {
        flushParagraph();
        flushList();
        flushTable();
    };

    for (const raw of source.split("\n")) {
        if (code) {
            if (/^\s*```\s*$/.test(raw)) {
                blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
                code = null;
            } else {
                code.lines.push(raw);
            }
            continue;
        }

        const fence = /^\s*```\s*([\w+#.-]*)/.exec(raw);
        if (fence) {
            flushAll();
            code = { lang: fence[1].toLowerCase(), lines: [] };
            continue;
        }

        const line = raw.trim();
        if (!line) {
            flushAll();
            continue;
        }

        if (line.startsWith("|")) {
            flushParagraph();
            flushList();
            (table ??= []).push(line);
            continue;
        }
        flushTable();

        let match: RegExpExecArray | null;
        if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
            flushParagraph();
            flushList();
            blocks.push({ type: "heading", level: match[1].length, inlines: parseInline(match[2]) });
        } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
            flushParagraph();
            flushList();
            blocks.push({ type: "rule" });
        } else if ((match = /^[-*+]\s+(.*)$/.exec(line))) {
            flushParagraph();
            if (list && list.ordered) flushList();
            (list ??= { ordered: false, start: 1, items: [] }).items.push(parseInline(match[1]));
        } else if ((match = /^(\d+)[.)]\s+(.*)$/.exec(line))) {
            flushParagraph();
            if (list && !list.ordered) flushList();
            (list ??= { ordered: true, start: Number(match[1]), items: [] }).items.push(
                parseInline(match[2]),
            );
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    // an unclosed fence: the rest is code
    if (code) blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
    flushAll();
    return blocks;
}

// --- markdown view --------------------------------------------------------

// Blocks of parseMarkdown() -> a plain element tree: a string is a text node,
// an object is { tag, cls, attrs, children }. lmao.ts builds the DOM from it
// with createElement and text nodes only, so nothing from a model is parsed
// as HTML.
export interface TreeElement {
    tag: string;
    cls: string;
    attrs: Record<string, string>;
    children: TreeNode[];
}

export type TreeNode = string | TreeElement;

function treeNode(
    tag: string,
    cls = "",
    children: TreeNode[] = [],
    attrs: Record<string, string> = {},
): TreeElement {
    return { tag, cls, attrs, children };
}

function mdInline(parts: Inline[]): TreeNode[] {
    return parts.map((p) => {
        if (p.code) return treeNode("span", "font-mono text-fg bg-bg px-4", [p.text]);
        if (p.bold) return treeNode("span", "text-fg", [p.text]);
        return p.text;
    });
}

function mdBlock(b: MdBlock): TreeElement {
    switch (b.type) {
        case "heading":
            return treeNode(
                "div",
                `text-fg break-words${b.level <= 2 ? " text-subheading" : ""}`,
                mdInline(b.inlines),
            );
        case "paragraph":
            return treeNode("p", "text-fg-muted break-words", mdInline(b.inlines));
        case "list":
            return treeNode(
                "ul",
                "flex flex-col gap-6",
                b.items.map((item, i) =>
                    treeNode("li", "flex gap-8 text-fg-muted", [
                        treeNode(
                            "span",
                            `shrink-0${b.ordered ? " text-fg" : ""}`,
                            [b.ordered ? `${b.start + i}.` : "–"],
                            { "aria-hidden": "true" },
                        ),
                        treeNode("span", "min-w-0 break-words", mdInline(item)),
                    ]),
                ),
            );
        case "code": {
            const parts: TreeNode[] = [];
            if (b.lang) {
                parts.push(
                    treeNode(
                        "div",
                        "self-start px-12 py-4 border border-b-0 border-line font-mono text-fg-muted",
                        [b.lang],
                    ),
                );
            }
            parts.push(
                treeNode(
                    "pre",
                    "bg-bg border border-line p-12 font-mono text-caption font-light text-fg whitespace-pre overflow-x-auto",
                    [b.text],
                ),
            );
            return treeNode("div", "flex flex-col", parts);
        }
        case "table": {
            const th = (cell: Inline[]) =>
                treeNode(
                    "th",
                    "px-12 py-6 border border-line font-light text-fg align-top",
                    mdInline(cell),
                );
            const td = (cell: Inline[]) =>
                treeNode(
                    "td",
                    "px-12 py-6 border border-line text-fg-muted align-top",
                    mdInline(cell),
                );
            const parts: TreeNode[] = [];
            if (b.head.length) {
                parts.push(treeNode("thead", "", [treeNode("tr", "", b.head.map(th))]));
            }
            parts.push(
                treeNode(
                    "tbody",
                    "",
                    b.rows.map((row) => treeNode("tr", "", row.map(td))),
                ),
            );
            return treeNode("div", "overflow-x-auto", [
                treeNode("table", "border-collapse text-left", parts),
            ]);
        }
        case "rule":
            return treeNode("div", "border-t border-line");
    }
}

export function markdownTree(blocks: MdBlock[] | null | undefined): TreeElement {
    return treeNode(
        "div",
        "min-w-0 flex flex-col gap-12",
        (blocks || []).map((b) => treeNode("div", "min-w-0", [mdBlock(b)])),
    );
}

// An answer appears in both views: parse it once.
const blockCache = new WeakMap<object, MdBlock[]>();
export function answerBlocks(result: { answer?: string }): MdBlock[] {
    let blocks = blockCache.get(result);
    if (!blocks) {
        blocks = parseMarkdown(result.answer || "");
        blockCache.set(result, blocks);
    }
    return blocks;
}

// The judge writes full model names; show the same short names as the rest of the UI.
// Longest first, so a name that contains another one is replaced as a whole.
export function shortenNames(blocks: MdBlock[], names: Record<string, string>): MdBlock[] {
    const pairs = Object.entries(names)
        .filter(([full, short]) => full !== short)
        .sort((a, b) => b[0].length - a[0].length);
    if (!pairs.length) return blocks;
    const fix = (parts: Inline[]) =>
        parts.forEach((p) => {
            pairs.forEach(([full, short]) => {
                if (p.text.includes(full)) p.text = p.text.split(full).join(short);
            });
        });
    blocks.forEach((b) => {
        if (b.type === "heading" || b.type === "paragraph") fix(b.inlines);
        else if (b.type === "list") b.items.forEach(fix);
        else if (b.type === "table") {
            b.head.forEach(fix);
            b.rows.forEach((row) => row.forEach(fix));
        }
    });
    return blocks;
}
