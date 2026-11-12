// Pure helpers. No DOM, no Alpine: tested with `node --test` (tests/js/).

import type {
    ApiResults,
    Entry,
    ModelMetrics,
    ModelStats,
    Question,
    Recommendation,
    Reference,
} from "../types/results.js";

// --- names ----------------------------------------------------------------

// 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M' -> 'openbmb/MiniCPM5-2B'
// The full name stays in `title` attributes and in the archive meta.
export function shortName(name: unknown): string {
    if (typeof name !== "string") return "";
    return name.replace(/^hf\.co\//, "").replace(/-GGUF:[^:\s]+$/i, "");
}

// 'x-GGUF:Q4_K_M' -> 'Q4_K_M', 'llama3:8b' -> '8b', 'llama3' -> 'latest'
export function variantOf(name: string): string {
    const quant = /-GGUF:([^:\s]+)$/i.exec(name);
    if (quant) return quant[1];
    const tag = /:([^:/\s]+)$/.exec(name);
    return tag ? tag[1] : "latest";
}

// Display names for a set of models: { fullName: displayName }.
// Names whose short form collides get the quantisation as a suffix
// ('foo · Q4_K_M' / 'foo · Q8_0'); if that is still ambiguous, the full name.
export function shortNames(names: unknown): Record<string, string> {
    const list: unknown[] = Array.isArray(names) ? names : [];
    const unique = [
        ...new Set(list.filter((n): n is string => typeof n === "string" && n !== "")),
    ];
    const groups = new Map<string, string[]>();
    unique.forEach((name) => {
        const short = shortName(name);
        const group = groups.get(short);
        if (group) group.push(name);
        else groups.set(short, [name]);
    });

    const out: Record<string, string> = {};
    groups.forEach((group, short) => {
        if (group.length === 1) {
            out[group[0]] = short;
            return;
        }
        const variants = group.map(variantOf);
        const distinct = new Set(variants).size === group.length;
        group.forEach((name, i) => {
            out[name] = distinct ? `${short} · ${variants[i]}` : name;
        });
    });
    return out;
}

// 0 -> '01', 11 -> '12'
export function pad2(index: number): string {
    return String(index + 1).padStart(2, "0");
}

// --- running screen -------------------------------------------------------

export type StepState = "queued" | "running" | "done" | "error" | "skipped";

export interface Step {
    key: string;
    phase: string;
    model: string;
    question: string | null;
    label: string;
    state: StepState;
    meta: string;
    startedAt: number | null; // client clock, for the live timer
    startTs: number | null; // server timestamp, for the final duration
    endTs: number | null; // server timestamp, for the phase duration
    loading: boolean; // first call of a model load group: the load notice may apply
    announced: boolean; // the load notice was already announced to screen readers
}

// Same key on both sides: built from the SSE event fields (phase, model, question).
// reference: model = judge; summary: question = null.
export function stepKey(
    phase: string,
    model: string | null | undefined,
    question: string | null | undefined,
): string {
    return `${phase}:${model ?? ""}:${question ?? ""}`;
}

// Total steps as the backend counts them: Q * (1 + 2M) + 1 (M = unique candidates).
export function totalSteps(questionCount: number, candidateCount: number): number {
    return questionCount * (1 + 2 * candidateCount) + 1;
}

// All rows of a run in the `queued` state, built from the request payload.
// `names` is the map from shortNames(); missing names fall back to shortName().
export function buildSteps(
    judge: string,
    candidates: string[],
    questionCount: number,
    names: Record<string, string> = {},
): Step[] {
    const display = (m: string) => names[m] || shortName(m);
    const ids = Array.from({ length: questionCount }, (_, i) => `q${i + 1}`);
    const unique = [...new Set(candidates)];
    const row = (
        phase: string,
        model: string,
        question: string | null,
        label: string,
    ): Step => ({
        key: stepKey(phase, model, question),
        phase,
        model,
        question,
        label,
        state: "queued",
        meta: "",
        startedAt: null,
        startTs: null,
        endTs: null,
        loading: false,
        announced: false,
    });

    const steps: Step[] = [];
    ids.forEach((q) =>
        steps.push(row("reference", judge, q, `reference · ${q} · ${display(judge)}`)),
    );
    unique.forEach((m) =>
        ids.forEach((q) => steps.push(row("answer", m, q, `${display(m)} · ${q}`))),
    );
    // Grading rows go model by model in both modes, like the backend grades.
    // Display only: SSE events find their row by key.
    unique.forEach((m) =>
        ids.forEach((q) => steps.push(row("grading", m, q, `judge · ${display(m)} · ${q}`))),
    );
    steps.push(row("summary", judge, null, "final summary"));
    return steps;
}

// The model that has to be loaded for a step, or null when it is not local.
// Judge: loaded once for the references, once for grading + summary.
export function loadGroup(phase: string, model: string, cloud: boolean): string | null {
    if (phase === "answer") return `cand:${model}`;
    if (cloud) return null;
    return phase === "reference" ? "judge-1" : "judge-2";
}

export type GroupState = "queued" | "running" | "done";


export interface PhaseGroup {
    phase: string;
    title: string;
    short?: string;
}

export type PhaseFigures = PhaseGroup & {
    total: number;
    finished: number;
    errors: number;
    state: GroupState;
    side: string;
    pct: number;
};

// The figures of every phase from one pass over the rows. `groups` is the list
// of phases ({ phase, ...labels }); the result is keyed by phase.
// Duration = wall clock from the first start to the last end (server
// timestamps), so parallel calls are not added up. Error and skipped rows are
// finished too; errors are counted separately.
export function phaseStats(steps: Step[], groups: PhaseGroup[]): Record<string, PhaseFigures> {
    interface Acc {
        total: number;
        open: number;
        running: number;
        errors: number;
        first: number;
        last: number;
    }
    const acc = new Map<string, Acc>(
        groups.map((g) => [
            g.phase,
            { total: 0, open: 0, running: 0, errors: 0, first: Infinity, last: -Infinity },
        ]),
    );
    for (const s of steps) {
        const a = acc.get(s.phase);
        if (!a) continue;
        a.total += 1;
        if (s.state === "queued" || s.state === "running") a.open += 1;
        if (s.state === "running") a.running += 1;
        if (s.state === "error") a.errors += 1;
        if (s.startTs !== null) a.first = Math.min(a.first, s.startTs);
        if (s.endTs !== null) a.last = Math.max(a.last, s.endTs);
    }

    const out: Record<string, PhaseFigures> = {};
    for (const g of groups) {
        const { total, open, running, errors, first, last } = acc.get(g.phase)!;
        const finished = total - open;
        let state: GroupState = "queued";
        if (running) state = "running";
        else if (total && !open) state = "done";

        const span =
            state === "done" && Number.isFinite(first) && Number.isFinite(last)
                ? fmtSpan((last - first) / 1000)
                : "";
        // A single-call phase (summary) needs no counter.
        const count = total > 1 ? `${finished} / ${total}` : "";
        out[g.phase] = {
            ...g,
            total,
            finished,
            errors,
            state,
            side: [count, span].filter(Boolean).join(" · "),
            pct: total ? Math.round((100 * finished) / total) : 0,
        };
    }
    return out;
}

// Empty for missing, broken or negative durations (clock skew, lost start event).
export function fmtSeconds(sec: unknown): string {
    return typeof sec === "number" && isFinite(sec) && sec >= 0 ? `${sec.toFixed(1)} s` : "";
}

// 151 -> '02:31'
export function fmtClock(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

// Phase duration: '41.2 s' under a minute, '05:12' above.
export function fmtSpan(sec: unknown): string {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
    return sec < 60 ? `${sec.toFixed(1)} s` : fmtClock(sec);
}

// --- matrix -----------------------------------------------------------------

export interface MatrixLayout {
    name: number; // px of the model column
    tail: number; // px of the columns after the questions (time)
    cell: number; // px of one question column
    counter: number; // px of one `‹ N` / `N ›` counter column
    counters: 1 | 2; // counter columns that take room when not everything fits
}

// The scores matrix of the results screens: a counter on the right only.
export const RESULTS_MATRIX: MatrixLayout = {
    name: 254,
    tail: 0,
    cell: 48,
    counter: 48,
    counters: 1,
};

// The matrix of the running screen: both counters are always there, so the
// columns do not jump while the window follows the run.
export const RUNNING_MATRIX: MatrixLayout = {
    name: 270,
    tail: 80,
    cell: 52,
    counter: 44,
    counters: 2,
};

// How many question columns fit into a matrix `width` px wide. Everything fits:
// all `total`. Otherwise the counter columns take their room first.
export function columnsThatFit(
    width: number,
    total: number,
    layout: MatrixLayout = RESULTS_MATRIX,
): number {
    const room = width - layout.name - layout.tail;
    if (!(room >= layout.cell) || !(total > 0)) return 0;
    if (Math.floor(room / layout.cell) >= total) return total;
    return Math.max(1, Math.floor((room - layout.counters * layout.counter) / layout.cell));
}

export interface ColumnWindow {
    start: number; // first visible question (0-based)
    end: number; // one past the last visible question
    before: number; // hidden on the left: the `‹ N` counter
    after: number; // hidden on the right: the `N ›` counter
}

// The visible window of question columns. `fit` comes from columnsThatFit().
// The window is centred on `anchor` (the question in progress) unless `start`
// is given (manual paging); it never leaves 0..total.
export function columnWindow(
    total: number,
    fit: number,
    anchor: number,
    start: number | null = null,
): ColumnWindow {
    if (!(total > 0)) return { start: 0, end: 0, before: 0, after: 0 };
    if (fit >= total) return { start: 0, end: total, before: 0, after: 0 };
    if (!(fit > 0)) return { start: 0, end: 0, before: 0, after: total };

    const wanted = start ?? anchor - Math.floor((fit - 1) / 2);
    const first = Math.max(0, Math.min(total - fit, wanted));
    const end = first + fit;
    return { start: first, end, before: first, after: total - end };
}

// --- running matrix ---------------------------------------------------------

export type CellState =
    | "planned"
    | "answering"
    | "ready"
    | "grading"
    | "graded"
    | "generation_error"
    | "judge_error";

export interface MatrixCellInfo {
    state: CellState;
    title: string; // tooltip and accessible name
}

export interface MatrixRow {
    model: string;
    label: string;
    sub: string; // the judge's name on the reference row
    reference: boolean;
    state: GroupState;
    time: string; // total answering time of the model
    cells: MatrixCellInfo[];
}

const CELL_TEXT: Record<CellState, string> = {
    planned: "planned",
    answering: "answering",
    ready: "answer ready",
    grading: "grading",
    graded: "graded",
    generation_error: "generation error",
    judge_error: "judge error",
};

const CELL_ORDER: CellState[] = [
    "graded",
    "ready",
    "grading",
    "answering",
    "planned",
    "generation_error",
    "judge_error",
];

function isErrorCell(state: CellState): boolean {
    return state === "generation_error" || state === "judge_error";
}

function stepSeconds(step: Step | undefined): number | null {
    if (!step || step.startTs === null || step.endTs === null) return null;
    const sec = (step.endTs - step.startTs) / 1000;
    return sec >= 0 ? sec : null;
}

function referenceCell(step: Step | undefined): CellState {
    if (!step) return "planned";
    if (step.state === "running") return "answering";
    if (step.state === "done") return "graded";
    if (step.state === "error") return "generation_error";
    return "planned";
}

function candidateCell(answer: Step | undefined, grading: Step | undefined): CellState {
    if (!answer || answer.state === "queued") return "planned";
    if (answer.state === "running") return "answering";
    if (answer.state === "error") return "generation_error";
    if (!grading || grading.state === "queued") return "ready";
    if (grading.state === "running") return "grading";
    if (grading.state === "error") return "judge_error";
    return "graded";
}

function cellInfo(
    name: string,
    id: string,
    state: CellState,
    step: Step | undefined,
): MatrixCellInfo {
    const sec = stepSeconds(step);
    const time = sec === null ? "" : ` · ${sec.toFixed(1)} s`;
    return { state, title: `${name} · ${id}: ${CELL_TEXT[state]}${time}` };
}

function rowState(cells: MatrixCellInfo[]): GroupState {
    if (cells.every((c) => c.state === "planned")) return "queued";
    const final = (s: CellState) => s === "graded" || isErrorCell(s);
    return cells.every((c) => final(c.state)) ? "done" : "running";
}

// Sum in ms, so 4.1 s + 1.9 s is exactly 6 s.
function totalTime(steps: (Step | undefined)[]): string {
    let ms = 0;
    let any = false;
    for (const s of steps) {
        if (s && s.startTs !== null && s.endTs !== null && s.endTs >= s.startTs) {
            ms += s.endTs - s.startTs;
            any = true;
        }
    }
    return any ? fmtClock(ms / 1000) : "–";
}

// The reference row and one row per candidate, a cell per question. The state
// of a cell comes from the answer and grading steps, so no new events.
export function buildMatrix(
    steps: Step[],
    questionCount: number,
    display: (model: string) => string,
): MatrixRow[] {
    const byKey = new Map(steps.map((s) => [s.key, s]));
    const candidates: string[] = [];
    let judge = "";
    for (const s of steps) {
        if (s.phase === "reference" && !judge) judge = s.model;
        if (s.phase === "answer" && !candidates.includes(s.model)) candidates.push(s.model);
    }
    const ids = Array.from({ length: questionCount }, (_, i) => `q${i + 1}`);

    const referenceSteps = ids.map((id) => byKey.get(stepKey("reference", judge, id)));
    const referenceCells = ids.map((id, i) => {
        const step = referenceSteps[i];
        return cellInfo(`reference · ${display(judge)}`, id, referenceCell(step), step);
    });
    const rows: MatrixRow[] = judge
        ? [
              {
                  model: judge,
                  label: "reference",
                  sub: display(judge),
                  reference: true,
                  state: rowState(referenceCells),
                  time: totalTime(referenceSteps),
                  cells: referenceCells,
              },
          ]
        : [];

    for (const model of candidates) {
        const answers = ids.map((id) => byKey.get(stepKey("answer", model, id)));
        const cells = ids.map((id, i) => {
            const grading = byKey.get(stepKey("grading", model, id));
            const state = candidateCell(answers[i], grading);
            const graded = state === "grading" || state === "graded" || state === "judge_error";
            return cellInfo(display(model), id, state, graded ? grading : answers[i]);
        });
        rows.push({
            model,
            label: display(model),
            sub: "",
            reference: false,
            state: rowState(cells),
            time: totalTime(answers),
            cells,
        });
    }
    return rows;
}

// The first question that is in progress (0-based), or null between two steps.
export function activeQuestion(steps: Step[]): number | null {
    let first = Infinity;
    for (const s of steps) {
        if (s.state !== "running" || !s.question) continue;
        const n = Number(s.question.slice(1)) - 1;
        if (Number.isFinite(n)) first = Math.min(first, n);
    }
    return Number.isFinite(first) ? first : null;
}

export interface Hidden {
    count: number;
    warn: boolean; // an error among the hidden cells
    title: string;
}

// The counter of the hidden cells cells[from, to): how many, and what they hold.
export function hiddenSummary(cells: MatrixCellInfo[], from: number, to: number): Hidden {
    const part = cells.slice(from, to);
    if (!part.length) return { count: 0, warn: false, title: "" };

    const parts = CELL_ORDER.flatMap((state) => {
        const hits = part
            .map((cell, i) => ({ cell, id: from + i + 1 }))
            .filter((hit) => hit.cell.state === state);
        if (!hits.length) return [];
        const where = isErrorCell(state)
            ? ` (${hits
                  .slice(0, 3)
                  .map((hit) => `q${hit.id}`)
                  .join(", ")}${hits.length > 3 ? ", …" : ""})`
            : "";
        return [`${hits.length} ${CELL_TEXT[state]}${where}`];
    });
    const first = from + 1;
    const last = from + part.length;
    const range = part.length === 1 ? `q${first}` : `q${first}–q${last}`;
    return {
        count: part.length,
        warn: part.some((c) => isErrorCell(c.state)),
        title: `${range}: ${parts.join(" · ")}`,
    };
}

// The calls in flight, for the `now` list.
export interface NowRow {
    key: string;
    step: Step;
    verb: string;
}

const VERBS: Record<string, string> = {
    reference: "reference",
    answer: "answering",
    grading: "grading",
    summary: "summary",
};

export function nowRows(steps: Step[]): NowRow[] {
    return steps
        .filter((s) => s.state === "running")
        .map((s) => ({ key: s.key, step: s, verb: VERBS[s.phase] ?? s.phase }));
}

// --- dom anchors ----------------------------------------------------------

// Model names contain ':', '/' and '.', so they cannot be used as ids as is.
// The id is a readable slug plus a FNV-1a hash of the raw parts, so names
// with the same slug ('a:b' and 'a/b') still get different ids.
// domId('answer', 'hf.co/o/m-GGUF:Q4_K_M', 'q1')
//   -> 'answer-hf-co-o-m-gguf-q4_k_m-q1-<hash>'
export function domId(prefix: string, ...parts: unknown[]): string {
    const raw = parts.map((p) => String(p ?? "")).join("\n");
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return [prefix, slug, (hash >>> 0).toString(36)].filter(Boolean).join("-");
}

// --- results --------------------------------------------------------------

// UI labels for the stable ids stored in the results.
const RULE_LABELS: Record<string, string> = {
    fastest_above_threshold: "the fastest model among those with a high pass rate",
    highest_median: "the highest median score (no model reached the pass-rate threshold)",
    none_graded: "no answers could be graded",
};
const CATEGORY_LABELS: Record<string, string> = {
    perfect: "perfect solution",
    acceptable: "generally acceptable",
    instruction_violation: "violation of instructions",
    broken_logic: "broken logic",
    garbage: "garbage",
};
// One wording for questions without a reference, everywhere in the UI.
const NO_REFERENCE = "excluded from the scores";

// A run file the UI cannot read: the message is shown to the user as is.
export class ReportFormatError extends Error {}

export function fmtNum(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : String(value);
}

// Score as a 0..100 number for bars and scales, or null.
export function clampScore(value: unknown): number | null {
    return typeof value === "number" && isFinite(value)
        ? Math.max(0, Math.min(100, value))
        : null;
}

// --- markdown -------------------------------------------------------------

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

export function isFailed(result: { status?: string }): boolean {
    return result.status === "generation_error" || result.status === "judge_error";
}

export function questionLabel(question: { id: string; tag?: string }): string {
    const tag =
        question.tag && String(question.tag).toLowerCase() !== question.id
            ? ` · ${question.tag}`
            : "";
    return `${question.id}${tag}`;
}

export interface MatrixCell {
    text: string;
    warn: boolean;
    muted: boolean;
    title: string;
    bar: number | null;
}

export function matrixCell(
    question: Pick<Question, "no_reference">,
    result: Partial<Entry>,
): MatrixCell {
    if (result.status === "generation_error") {
        return { text: "err", warn: true, muted: false, title: result.error || "", bar: null };
    }
    if (result.status === "judge_error") {
        return { text: "?", warn: true, muted: false, title: result.error || "", bar: null };
    }
    let title = "";
    if (result.truncated) title = "truncated answer";
    else if (question.no_reference) title = `no reference: ${NO_REFERENCE}`;
    return {
        text: `${fmtNum(result.score)}${result.truncated ? "*" : ""}`,
        warn: false,
        muted: Boolean(question.no_reference),
        title,
        bar: clampScore(result.score),
    };
}

export interface EvalEntry {
    qid: string;
    anchor: string;
    index: number;
    label: string;
    question: string;
    error: boolean;
    score: number | null;
    scoreText: string;
    caption: string;
    category: string;
    comment: string;
    answer: string;
    // A function: the Markdown is parsed when the answer is opened, not for every answer of the run.
    answerBlocks: () => MdBlock[];
    notes: string[];
}

function evalEntry(question: Question, result: Entry, index: number): EvalEntry {
    const generationFailed = result.status === "generation_error";
    const failed = isFailed(result);
    const notes: string[] = [];
    if (result.truncated) notes.push("truncated answer: it cannot count as a pass");
    if (question.no_reference) notes.push(`no reference answer: ${NO_REFERENCE}`);

    return {
        qid: question.id,
        anchor: domId("answer", result.model_name, question.id),
        index,
        label: questionLabel(question),
        question: question.question || "",
        error: failed,
        score: failed ? null : clampScore(result.score),
        scoreText: failed ? "err" : fmtNum(result.score),
        caption: failed ? (generationFailed ? "generation failed" : "grading failed") : "/ 100",
        category: failed
            ? ""
            : (result.category && CATEGORY_LABELS[result.category]) || result.category || "",
        comment: failed ? result.error || "" : result.comment || "",
        answer: result.answer || "",
        answerBlocks: () => answerBlocks(result),
        notes,
    };
}

// Competition ranking (1, 1, 3): equal scores share a rank, null (failed) is not ranked.
export function competitionRanks(scores: (number | null)[]): (number | null)[] {
    return scores.map((score) =>
        score === null ? null : 1 + scores.filter((other) => other !== null && other > score).length,
    );
}

function pad2digits(number: number): string {
    return String(number).padStart(2, "0");
}

export type QuestionEntry = EvalEntry & {
    model: string;
    short: string;
    rank: number | null;
    rankText: string;
    order: number;
};

export interface QuestionCard {
    id: string;
    anchor: string;
    label: string;
    question: string;
    metricsLine: string;
    entries: QuestionEntry[];
    marks: { score: number; many: boolean; title: string }[];
    spread: string;
}

// One card per question: the answers of all models, best first, failed ones last.
function buildQuestionCard(
    question: Question,
    summaryModels: ModelStats[],
    display: (model: string) => string,
): QuestionCard {
    const rows: { stats: ModelStats; result: Entry; order: number }[] = [];
    summaryModels.forEach((stats, order) => {
        const result = (question.results || []).find((r) => r.model_name === stats.model);
        if (result) rows.push({ stats, result, order });
    });

    const ranks = competitionRanks(
        rows.map(({ result }) => (isFailed(result) ? null : (result.score ?? null))),
    );

    const entries: QuestionEntry[] = rows.map(({ stats, result, order }, i) => ({
        ...evalEntry(question, result, order),
        model: stats.model,
        short: display(stats.model),
        rank: ranks[i],
        rankText:
            ranks[i] === null
                ? "not ranked"
                : `rank ${pad2digits(ranks[i] as number)} / ${pad2digits(rows.length)}`,
        order,
    }));
    entries.sort(
        (a, b) =>
            Number(a.rank === null) - Number(b.rank === null) ||
            (a.rank ?? 0) - (b.rank ?? 0) ||
            a.order - b.order,
    );

    // Score scale: one mark per distinct score; several models on one score = a tall tick.
    const graded = entries.filter((e) => e.score !== null);
    const byScore = new Map<number, string[]>();
    graded.forEach((e) => {
        const score = e.score as number;
        const names = byScore.get(score);
        if (names) names.push(e.short);
        else byScore.set(score, [e.short]);
    });
    const marks = [...byScore].map(([score, names]) => ({
        score,
        many: names.length > 1,
        title: `${score}: ${names.join(", ")}`,
    }));
    const scores = graded.map((e) => e.score as number);
    let spread = "";
    if (scores.length === 1) spread = `one graded answer · ${scores[0]}`;
    else if (scores.length > 1) spread = `range ${Math.min(...scores)}–${Math.max(...scores)}`;

    const source = (question.reference || {}).source || "none";
    return {
        id: question.id,
        anchor: domId("question", question.id),
        label: questionLabel(question),
        question: question.question || "",
        metricsLine: `${rows.length} models · ${source === "none" ? "no reference" : `${source} reference`}`,
        entries,
        marks,
        spread,
    };
}

// --- archive --------------------------------------------------------------

export interface HistoryRun {
    task_id: string;
    tag_name: string;
    timestamp: string;
    models_tested: number;
    questions_count: number;
    judge_model: string;
}

// Run time in ms: the id ends with YYYYMMDD_HHMMSS; the timestamp field is the fallback.
export function runTime(run: Partial<HistoryRun> | null | undefined): number {
    const match = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(run?.task_id || "");
    if (match) {
        const [, y, mo, d, h, mi, s] = match.map(Number);
        return new Date(y, mo - 1, d, h, mi, s).getTime();
    }
    const parsed = Date.parse(run?.timestamp ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
}

// Newest first. Stable: runs with the same time keep the API order.
export function sortHistory(runs: unknown): HistoryRun[] {
    const list = (Array.isArray(runs) ? runs : []) as HistoryRun[];
    return [...list].sort((a, b) => runTime(b) - runTime(a));
}

// --- answers by category -------------------------------------------------

const CATEGORY_ORDER: string[] = [
    "perfect",
    "acceptable",
    "instruction_violation",
    "broken_logic",
    "garbage",
];

export interface Distribution {
    n: number;
    rows: { label: string; count: number; warn: boolean; pct: number; text: string }[];
}

// One row per judge category (always, also with 0, so cards compare),
// then uncategorised and errors only when they occur.
export function buildDistribution(
    results: { status?: string; category?: string | null }[],
): Distribution {
    const n = results.length;
    const counts: Record<string, number> = {};
    let other = 0;
    let generation = 0;
    let judge = 0;
    results.forEach((r) => {
        const category = r.category;
        if (r.status === "generation_error") generation += 1;
        else if (r.status === "judge_error") judge += 1;
        else if (category && CATEGORY_ORDER.includes(category)) {
            counts[category] = (counts[category] || 0) + 1;
        } else other += 1;
    });

    const row = (label: string, count: number, warn = false) => {
        const pct = n ? Math.round((100 * count) / n) : 0;
        return { label, count, warn, pct, text: `${count} · ${pct}%` };
    };
    const rows = CATEGORY_ORDER.map((c) => row(CATEGORY_LABELS[c], counts[c] || 0));
    if (other) rows.push(row("uncategorised", other));
    if (generation) rows.push(row("generation error", generation, true));
    if (judge) rows.push(row("judge error", judge, true));
    return { n, rows };
}

// --- chart: mean score against median chars/s ----------------------------

export function median(values: number[]): number | null {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

// 1 / 2 / 5 x 10^n, so ticks read as round numbers.
export function niceStep(range: number, count: number): number {
    const raw = range / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export interface ChartPoint {
    model: string;
    short: string;
    score: number;
    cps: number;
    best: boolean;
    left: number;
    top: number;
    flip: boolean;
    leading: boolean;
    title: string;
}

export interface Chart {
    points: ChartPoint[];
    missing: string[];
    xTicks: { text: string; pos: number }[];
    yTicks: { text: string; pos: number }[];
    pareto: string;
    mid: {
        left: number;
        bottom: number;
        flipX: boolean;
        flipY: boolean;
        cpsText: string;
        scoreText: string;
    } | null;
    label: string;
}

// Positions are percentages of the plot box: left = x, top = 100 - y.
// The quadrant is bounded by the medians of the plotted models: "faster and
// better than half of this run". Pareto front: no other model is both faster
// and better.
export function buildChart(
    summaryModels: Pick<ModelStats, "model" | "mean" | "median_cps">[],
    display: (model: string) => string,
    recommended: string | null | undefined,
): Chart {
    const base: { model: string; short: string; score: number; cps: number; best: boolean }[] = [];
    const missing: string[] = [];
    summaryModels.forEach((stats) => {
        const score = clampScore(stats.mean);
        const cps =
            typeof stats.median_cps === "number" && isFinite(stats.median_cps) && stats.median_cps >= 0
                ? stats.median_cps
                : null;
        const short = display(stats.model);
        if (score === null || cps === null) missing.push(short);
        else base.push({ model: stats.model, short, score, cps, best: stats.model === recommended });
    });
    if (!base.length) {
        return { points: [], missing, xTicks: [], yTicks: [], pareto: "", mid: null, label: "" };
    }

    const maxCps = Math.max(...base.map((p) => p.cps));
    const span = maxCps > 0 ? maxCps * 1.05 : 1;
    const step = niceStep(span, 4);
    const tickCount = Math.max(1, Math.ceil(span / step));
    const xMax = step * tickCount;
    const digits = step < 1 ? 1 : 0;
    const xPos = (v: number) => (100 * v) / xMax;
    const xTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
        text: (i * step).toFixed(digits),
        pos: xPos(i * step),
    }));
    // Fixed 0..100: charts of different runs stay comparable.
    const yTicks = [0, 25, 50, 75, 100].map((v) => ({ text: String(v), pos: 100 - v }));

    const midCps = median(base.map((p) => p.cps)) as number;
    const midScore = median(base.map((p) => p.score)) as number;
    const points: ChartPoint[] = base.map((p) => {
        const left = xPos(p.cps);
        return {
            ...p,
            left,
            top: 100 - p.score,
            flip: left > 70, // label on the left near the right edge
            leading: p.cps >= midCps && p.score >= midScore,
            title: `${p.short}: mean score ${p.score} · ${round1(p.cps)} c/s`,
        };
    });

    // Walk from the fastest; a point is on the front when it beats every faster one.
    const byCps = [...points].sort((a, b) => b.cps - a.cps || b.score - a.score);
    const front: ChartPoint[] = [];
    let best = -Infinity;
    byCps.forEach((p) => {
        if (p.score > best) {
            front.push(p);
            best = p.score;
        }
    });
    front.reverse();

    const leading = points.filter((p) => p.leading).map((p) => p.short);
    return {
        points,
        missing,
        xTicks,
        yTicks,
        pareto: front.length > 1 ? front.map((p) => `${p.left},${p.top}`).join(" ") : "",
        mid: {
            left: xPos(midCps),
            bottom: midScore,
            flipX: xPos(midCps) > 70, // c/s label left of its line near the right edge
            flipY: midScore > 90, // score label below its line near the top
            cpsText: `median ${round1(midCps)} c/s`,
            scoreText: `median ${round1(midScore)}`,
        },
        label: `mean score against median chars/s, ${points.length} models. faster and better than the median: ${
            leading.length ? leading.join(", ") : "none"
        }.`,
    };
}

// --- summary --------------------------------------------------------------

export interface RankInfo {
    rank: number;
    n: number;
    best: number;
}

// Rank of one model among all for a stats key; null when it has no value.
export function rankOf(
    summaryModels: Partial<ModelStats>[],
    model: string,
    key: string,
    higherIsBetter: boolean,
): RankInfo | null {
    const read = (m: Partial<ModelStats>) => (m as Record<string, unknown>)[key];
    const values = summaryModels
        .map(read)
        .filter((v): v is number => typeof v === "number" && isFinite(v));
    const found = summaryModels.find((m) => m.model === model);
    const own = found ? read(found) : undefined;
    if (typeof own !== "number" || !isFinite(own) || !values.length) return null;
    const better = values.filter((v) => (higherIsBetter ? v > own : v < own)).length;
    return {
        rank: better + 1,
        n: values.length,
        best: higherIsBetter ? Math.max(...values) : Math.min(...values),
    };
}

export interface Figure {
    label: string;
    value: string;
    unit: string;
    caption: string;
}

// Four key figures of the recommended model, each with its place in the run.
export function verdictFigures(summaryModels: Partial<ModelStats>[], model: string): Figure[] {
    const s = summaryModels.find((m) => m.model === model);
    if (!s) return [];
    const num = (v: unknown) =>
        typeof v === "number" && isFinite(v) ? String(round1(v)) : "–";
    const caption = (r: RankInfo | null, fmt: (v: number) => string) => {
        if (!r) return "";
        if (r.rank === 1) return r.n > 1 ? `best of ${r.n}` : "only model";
        return `#${r.rank} of ${r.n} · best ${fmt(r.best)}`;
    };
    return [
        {
            label: "mean score",
            value: num(s.mean),
            unit: "/ 100",
            caption: caption(rankOf(summaryModels, model, "mean", true), num),
        },
        {
            label: "pass rate",
            value: s.pass_rate == null ? "–" : String(Math.round(s.pass_rate * 100)),
            unit: "%",
            caption: caption(
                rankOf(summaryModels, model, "pass_rate", true),
                (v) => `${Math.round(v * 100)}%`,
            ),
        },
        {
            label: "speed",
            value: num(s.median_cps),
            unit: "c/s",
            caption: caption(rankOf(summaryModels, model, "median_cps", true), num),
        },
        {
            label: "median time",
            value: num(s.median_time_sec),
            unit: "s",
            caption: caption(
                rankOf(summaryModels, model, "median_time_sec", false),
                (v) => `${num(v)} s`,
            ),
        },
    ];
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

export type ReportCell = MatrixCell & { anchor: string | null };

export interface ReportModel {
    model: string;
    anchor: string;
    short: string;
    mean: string;
    median: string;
    passRate: string;
    cps: string;
    tps: string;
    time: string;
    cells: ReportCell[];
    entries: EvalEntry[];
    distribution: Distribution;
    metricsLine: string;
}

export interface ReportReference {
    id: string;
    title: string;
    question: string;
    text: string;
    // Parsed when the reference is opened.
    blocks: () => MdBlock[];
}

export interface Report {
    meta: string;
    verdict: {
        model: string | null;
        short: string;
        label: string;
        rule: string;
        figures: Figure[];
    };
    notes: string[];
    summaryBlocks: MdBlock[];
    chart: Chart;
    grid: string;
    questionHeads: { id: string; title: string; anchor: string }[];
    models: ReportModel[];
    questionCards: QuestionCard[];
    references: ReportReference[];
}

// Everything the results screen shows, computed once per opened run.
// Throws ReportFormatError for files the UI cannot read (older schema).
export function buildReport(raw: unknown): Readonly<Report> {
    const probe = raw as Partial<ApiResults> | null;
    if (
        !probe ||
        !Array.isArray(probe.questions_results) ||
        !probe.summary ||
        !Array.isArray(probe.summary.models)
    ) {
        throw new ReportFormatError("this run was saved in an older format and cannot be shown.");
    }
    const data = probe as ApiResults;

    const questions = data.questions_results;
    const summary = data.summary;
    const rec: Partial<Recommendation> = summary.recommendation || {};
    const metrics: Record<string, Partial<ModelMetrics>> = data.metrics || {};
    const summaryModels = summary.models.filter((s) => s && typeof s.model === "string");

    const names = shortNames([...summaryModels.map((s) => s.model), rec.model]);
    const display = (m: string) => names[m] || shortName(m);

    const notes: string[] = [];
    if (data.judge_is_candidate) {
        notes.push("the judge is also a candidate: its own score may be biased.");
    }
    const withoutReference = questions.filter((q) => q.no_reference).length;
    if (withoutReference) {
        notes.push(`${withoutReference} question(s) have no reference answer: ${NO_REFERENCE}.`);
    }
    if (rec.model && rec.confidence === "low") {
        notes.push("low confidence: too few graded questions.");
    }

    const models: ReportModel[] = summaryModels.map((stats) => {
        const cells: ReportCell[] = [];
        const entries: EvalEntry[] = [];
        const results: Entry[] = [];
        questions.forEach((question, index) => {
            const result = (question.results || []).find((r) => r.model_name === stats.model);
            if (!result) {
                cells.push({ text: "–", warn: false, muted: true, title: "", bar: null, anchor: null });
                return;
            }
            results.push(result);
            cells.push({
                ...matrixCell(question, result),
                anchor: domId("answer", stats.model, question.id),
            });
            entries.push(evalEntry(question, result, index));
        });

        const total = metrics[stats.model] || {};
        const pass = stats.pass_rate == null ? "–" : `${Math.round(stats.pass_rate * 100)}%`;
        const totalTime =
            typeof total.total_time_sec === "number" && total.total_time_sec > 0
                ? `${total.total_time_sec.toFixed(1)} s total`
                : null;
        return {
            model: stats.model,
            anchor: domId("model", stats.model),
            short: display(stats.model),
            mean: fmtNum(stats.mean),
            median: fmtNum(stats.median),
            passRate: pass,
            cps: fmtNum(stats.median_cps),
            tps: fmtNum(stats.median_tps),
            time: fmtNum(stats.median_time_sec),
            cells,
            entries,
            distribution: buildDistribution(results),
            metricsLine: [
                `mean ${fmtNum(stats.mean)}`,
                `median ${fmtNum(stats.median)}`,
                `pass ${pass}`,
                `fails ${fmtNum(stats.fails)}`,
                `critical ${fmtNum(stats.critical_fails)}`,
                `errors ${fmtNum(stats.errors)}`,
                `judge errors ${fmtNum(stats.judge_errors)}`,
                `${fmtNum(stats.median_cps)} c/s`,
                `${fmtNum(stats.median_tps)} t/s`,
                totalTime,
            ]
                .filter(Boolean)
                .join(" · "),
        };
    });

    const finished =
        typeof data.finished_at === "string" ? data.finished_at.replace("T", " ").slice(0, 16) : "";
    // Frozen on purpose: Alpine does not wrap a frozen object in a reactive
    // proxy, and a report never changes after it is built.
    return Object.freeze({
        meta: [
            finished && `finished ${finished}`,
            data.judge_model && `judge: ${data.judge_model}`,
            data.mode === "cloud" ? "cloud judge" : "local judge",
        ]
            .filter(Boolean)
            .join(" · "),
        verdict: {
            model: rec.model || null,
            short: rec.model ? display(rec.model) : "",
            label: rec.model ? "recommended" : "no recommendation",
            rule: (rec.rule && RULE_LABELS[rec.rule]) || rec.rule || "",
            figures: rec.model ? verdictFigures(summaryModels, rec.model) : [],
        },
        notes,
        summaryBlocks: shortenNames(parseMarkdown(summary.text, { bareFence: true }), names),
        chart: buildChart(summaryModels, display, rec.model),
        // model | mean | median | pass | one column per question | c/s | t/s | time
        grid: `grid-template-columns:minmax(160px,1fr) 64px 64px 64px repeat(${questions.length},48px) 64px 64px 64px`,
        questionHeads: questions.map((q) => ({
            id: q.id,
            title: q.tag || "",
            anchor: domId("question", q.id),
        })),
        models,
        questionCards: questions.map((q) => buildQuestionCard(q, summaryModels, display)),
        references: questions.map((q) => {
            const ref: Partial<Reference> = q.reference || {};
            let blocks: MdBlock[] | null = null;
            return {
                id: q.id,
                title: `${q.id} · ${q.tag || "–"} · ${ref.source || "none"}`,
                question: q.question || "",
                text: ref.text || "",
                blocks: () => (blocks ??= parseMarkdown(ref.text || "")),
            };
        }),
    });
}

// --- test cases file ------------------------------------------------------

// The file holds the setup form the way /api/evaluate takes it:
// {"version": 1, "base_rationale": "...",
//  "test_cases": [{tag, question, specific_rationale, reference}]}
export const CASES_FILE_VERSION = 1;
export const CASES_MAX_BYTES = 256 * 1024;
export const CASES_MAX_COUNT = 200;
export const CASES_TOO_LARGE = "the file is too large (max 256 KB).";
const CASE_OPTIONAL_FIELDS = ["tag", "specific_rationale", "reference"] as const;

// A file the UI cannot import: the message is shown to the user as is.
export class CasesFileError extends Error {}

// A case of the setup form.
export interface FormCase {
    id?: number;
    tag?: string;
    question?: string;
    rationale?: string;
    reference?: string;
    open?: boolean;
}

// A case as the file and the /api/evaluate payload have it.
export interface PayloadCase {
    tag?: string;
    question: string;
    specific_rationale?: string;
    reference?: string;
}

// A case read from a file: every optional field is there, maybe empty.
export interface RawCase {
    question: string;
    tag: string;
    specific_rationale: string;
    reference: string;
}

// Form case -> the case of the payload and of the file. Empty optional fields
// are left out: the backend would keep an empty tag as the tag instead of
// using its default.
export function payloadCase(c: FormCase): PayloadCase {
    const text = (value: unknown) => String(value ?? "").trim();
    const optional = (key: string, value: unknown) =>
        text(value) ? { [key]: text(value) } : {};
    return {
        ...optional("tag", c.tag),
        question: text(c.question),
        ...optional("specific_rationale", c.rationale),
        ...optional("reference", c.reference),
    };
}

// File case -> form fields. lmao.ts adds `id` and `open` (caseCounter lives there).
export function caseFields(raw: RawCase): Required<Omit<FormCase, "id" | "open">> {
    return {
        tag: raw.tag,
        question: raw.question,
        rationale: raw.specific_rationale,
        reference: raw.reference,
    };
}

// A case with nothing typed in it (the initial empty case).
export function isBlankCase(c: FormCase): boolean {
    return !(["tag", "question", "rationale", "reference"] as const).some((key) =>
        String(c[key] ?? "").trim(),
    );
}

function isBlankQuestion(c: FormCase): boolean {
    return !String(c.question ?? "").trim();
}

// Cases without a question are skipped: the importer would reject them.
export function buildCasesFile({
    baseRationale,
    cases,
}: {
    baseRationale: string;
    cases: FormCase[];
}): string {
    const file = {
        version: CASES_FILE_VERSION,
        base_rationale: String(baseRationale ?? "").trim(),
        test_cases: cases.filter((c) => !isBlankQuestion(c)).map(payloadCase),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
}

// Text of a file -> { baseRationale, cases }. The cases are raw: they keep the
// file's field names (specific_rationale), see caseFields(). Unknown fields are
// ignored, null counts as a missing optional field. Throws CasesFileError.
export function parseCasesFile(text: unknown): { baseRationale: string; cases: RawCase[] } {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (new TextEncoder().encode(source).length > CASES_MAX_BYTES) {
        throw new CasesFileError(CASES_TOO_LARGE);
    }

    let data: unknown;
    try {
        data = JSON.parse(source);
    } catch {
        throw new CasesFileError("the file is not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new CasesFileError("the file must contain a JSON object.");
    }
    const file = data as Record<string, unknown>;
    if (file.version !== CASES_FILE_VERSION) {
        throw new CasesFileError(`unsupported file version: expected ${CASES_FILE_VERSION}.`);
    }

    const baseRationale = file.base_rationale ?? "";
    if (typeof baseRationale !== "string") {
        throw new CasesFileError('"base_rationale" must be a string.');
    }

    const list = file.test_cases;
    if (!Array.isArray(list) || list.length === 0) {
        throw new CasesFileError("the file has no test cases.");
    }
    if (list.length > CASES_MAX_COUNT) {
        throw new CasesFileError(`too many test cases (max ${CASES_MAX_COUNT}).`);
    }

    const cases = list.map((item: unknown, index: number): RawCase => {
        const label = `case ${pad2(index)}`;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new CasesFileError(`${label}: must be an object.`);
        }
        const fields = item as Record<string, unknown>;
        if (typeof fields.question !== "string") {
            throw new CasesFileError(`${label}: "question" must be a string.`);
        }
        if (!fields.question.trim()) {
            throw new CasesFileError(`${label}: the question is empty.`);
        }
        const out: Record<string, string> = { question: fields.question };
        for (const key of CASE_OPTIONAL_FIELDS) {
            const value = fields[key] ?? "";
            if (typeof value !== "string") {
                throw new CasesFileError(`${label}: "${key}" must be a string.`);
            }
            out[key] = value;
        }
        return out as unknown as RawCase;
    });

    return { baseRationale, cases };
}