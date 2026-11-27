// The running screen: rows, phases, the clock and the models x questions matrix. Pure; tested in tests/js/run.test.ts.

import { shortName } from "./names.ts";

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
    preview: string; // the answer written so far, in full
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
        preview: "",
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
    side: string; // the counter, '3 / 8'; empty for a single call
    span: string; // the phase duration, '41.2 s', once the phase is done
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
            side: count,
            span,
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
    layout: MatrixLayout,
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
    | "judge_error"
    | "stopped";

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
    loaded: boolean; // the model is in memory now: it answers, or it judges
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
    stopped: "stopped",
};

// The legend under the matrix: every state once, in the order of the design.
export const CELL_LEGEND = (Object.keys(CELL_TEXT) as CellState[]).map((state) => ({
    state,
    label: CELL_TEXT[state],
}));

const CELL_ORDER: CellState[] = [
    "graded",
    "ready",
    "grading",
    "answering",
    "planned",
    "generation_error",
    "judge_error",
    "stopped",
];

function isErrorCell(state: CellState): boolean {
    return state === "generation_error" || state === "judge_error";
}

function stepSeconds(step: Step | undefined): number | null {
    if (!step || step.startTs === null || step.endTs === null) return null;
    const sec = (step.endTs - step.startTs) / 1000;
    return sec >= 0 ? sec : null;
}

// A step still to come: planned, or stopped once the run was stopped.
function pending(stopped: boolean): CellState {
    return stopped ? "stopped" : "planned";
}

function referenceCell(step: Step | undefined, stopped: boolean): CellState {
    if (!step) return pending(stopped);
    if (step.state === "running") return "answering";
    if (step.state === "done") return "graded";
    if (step.state === "error") return "generation_error";
    return pending(stopped);
}

function candidateCell(
    answer: Step | undefined,
    grading: Step | undefined,
    stopped: boolean,
): CellState {
    if (!answer || answer.state === "queued") return pending(stopped);
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
    const idle = (s: CellState) => s === "planned" || s === "stopped";
    if (cells.every((c) => idle(c.state))) return "queued";
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

// A group of steps is in progress while one of them runs, or some are finished
// and some are still to come (a skipped step is neither).
function inProgress(steps: (Step | undefined)[]): boolean {
    const list = steps.filter((s): s is Step => s !== undefined);
    const finished = (s: Step) => s.state === "done" || s.state === "error";
    const open = (s: Step) => s.state === "queued" || s.state === "running";
    return list.some((s) => s.state === "running") || (list.some(finished) && list.some(open));
}

// The reference row and one row per candidate, a cell per question. The state
// of a cell comes from the answer and grading steps, so no new events. `cloud`:
// the judge runs remotely, beside the candidates. `stopped`: the run was
// stopped, so the steps still to come are `stopped` and nothing is in memory.
export function buildMatrix(
    steps: Step[],
    questionCount: number,
    display: (model: string) => string,
    cloud = false,
    stopped = false,
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
        return cellInfo(`reference · ${display(judge)}`, id, referenceCell(step, stopped), step);
    });
    // The judge is in memory while it works: for the references, then again for
    // grading and the summary (a local judge is loaded twice). A cloud judge
    // works beside the candidates, from its first call to the summary.
    const judgeSteps = steps.filter((s) => s.phase === "grading" || s.phase === "summary");
    const judgeLoaded =
        !stopped &&
        (cloud
            ? inProgress([...referenceSteps, ...judgeSteps])
            : inProgress(referenceSteps) || inProgress(judgeSteps));

    const rows: MatrixRow[] = judge
        ? [
              {
                  model: judge,
                  label: "reference",
                  sub: display(judge),
                  reference: true,
                  state: rowState(referenceCells),
                  loaded: judgeLoaded,
                  time: totalTime(referenceSteps),
                  cells: referenceCells,
              },
          ]
        : [];

    for (const model of candidates) {
        const answers = ids.map((id) => byKey.get(stepKey("answer", model, id)));
        const cells = ids.map((id, i) => {
            const grading = byKey.get(stepKey("grading", model, id));
            const state = candidateCell(answers[i], grading, stopped);
            const graded = state === "grading" || state === "graded" || state === "judge_error";
            return cellInfo(display(model), id, state, graded ? grading : answers[i]);
        });
        rows.push({
            model,
            label: display(model),
            sub: "",
            reference: false,
            state: rowState(cells),
            loaded: !stopped && inProgress(answers),
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
