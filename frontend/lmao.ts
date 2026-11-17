// Alpine state of the whole page. Registered on 'alpine:init'; this module is
// loaded before Alpine itself (see templates/base.html).

import type { ApiResults } from "../types/results.js";
import {
    budgetFigures as figuresOf,
    connectionBody,
    formOf,
    hostOf,
    judgeChoices as judgeModelsOf,
    judgeLatency,
    maskedKey as maskKey,
    preflightMeta as metaOf,
    previewText,
    routeOf,
    type Budget,
    type Connection,
    type ConnectionBody,
    type ConnectionForm,
    type Figure,
    type JudgeProvider,
    type PreflightCheck,
    type PreflightReport,
    type Preview,
    type Route,
} from "./lib.ts";
import {
    CASES_MAX_BYTES,
    CASES_MAX_COUNT,
    CASES_TOO_LARGE,
    CasesFileError,
    ReportFormatError,
    buildCasesFile,
    buildReport,
    buildSteps,
    caseFields,
    fmtClock,
    fmtSeconds,
    isBlankCase,
    loadGroup,
    markdownTree,
    pad2,
    parseCasesFile,
    payloadCase,
    phaseStats,
    shortName,
    shortNames,
    sortHistory,
    stepKey,
    totalSteps,
    type FormCase,
    type HistoryRun,
    type MdBlock,
    type PayloadCase,
    type PhaseFigures,
    type PhaseGroup,
    type EvalEntry,
    type QuestionCard,
    type Report,
    type ReportModel,
    type ReportReference,
    type Step,
    type TreeNode,
    RUNNING_MATRIX,
    CELL_LEGEND,
    activeQuestion,
    buildMatrix,
    columnWindow,
    columnsThatFit,
    hiddenSummary,
    nowRows,
    type CellState,
    type ColumnWindow,
    type Hidden,
    type MatrixCellInfo,
    type MatrixRow,
    type NowRow,
} from "./lib.ts";
import {
    COLUMNS,
    buildOverview,
    defaultDirection,
    sortRows,
    type Overview,
    type SortDirection,
    type SortKey,
    type TableRow,
} from "./overview.ts";
import {
    ANSWERS_SHOWN,
    QUESTIONS_SHOWN,
    REFERENCES_SHOWN,
    buildScoreRows,
    hiddenCount,
    initialFolds,
    nextScoreSort,
    sortScoreRows,
    visible,
    withRevealed,
    type Folds,
    type ScoreRow,
    type ScoreSort,
} from "./answers.ts";
import { barStates, faviconHref, type BarState } from "./favicon.ts";

// One event of /api/stream/<task_id>, see DESIGN.md (data contract).
interface SseEvent {
    type?: string;
    phase?: string;
    model?: string | null;
    question?: string | null;
    progress?: { done: number; total: number };
    timestamp?: string;
    success?: boolean;
    error?: string | null;
    source?: string;
    message?: string;
}

// What a run is made of: enough to build its rows again when it is resumed.
interface RunConfig {
    judge: string;
    cloud: boolean;
    candidates: string[];
    questions: number;
}

interface RunState {
    id: string | null;
    status: "idle" | "running" | "stopping" | "stopped" | "done" | "error";
    steps: Step[];
    pos: Record<string, number>; // step key -> index in `steps` (a lookup through the proxy stays reactive)
    seen: Record<string, boolean>; // load groups and phases that already had a first call
    cloud: boolean;
    done: number;
    total: number;
    startedAt: number | null;
    endedAt: number | null;
    now: number;
    error: string;
    resumable: boolean; // the server failed the run: it can be resumed
    attention: boolean; // finished while another screen was open
    config: RunConfig | null;
    phases: Record<string, PhaseFigures>; // phase -> figures, see updateRun()
    questions: number;
    active: number; // the question in progress (0-based), the anchor of the matrix window
    matrix: MatrixRow[];
    current: NowRow[]; // the calls in flight
}

// A case of the setup form: every field is there.
interface TestCase extends FormCase {
    id: number;
    tag: string;
    question: string;
    rationale: string;
    reference: string;
    open: boolean;
}

interface EvaluatePayload {
    judge: string;
    judge_provider: string;
    candidates: string[];
    base_rationale: string;
    test_cases: PayloadCase[];
}

interface TopStatus {
    tone: string;
    dot: boolean;
    go: boolean;
    stop: boolean;
    open: boolean;
    text: string;
}

interface ChecklistRow {
    key: string;
    label: string;
    state: string;
    meta: string;
}

interface Magics {
    $nextTick(callback?: () => void): Promise<void>;
    $refs: Record<string, HTMLElement>;
}
const magic = (self: unknown): Magics => self as Magics;

interface DirectiveUtils {
    effect(callback: () => void): unknown;
    evaluateLater(expression: string): (callback: (value: unknown) => void) => void;
}

document.addEventListener("alpine:init", () => {
    // Builds DOM from the tree of markdownTree(): createElement and text nodes
    // only, so a model answer is never parsed as HTML.
    const buildNode = (node: TreeNode): Node => {
        if (typeof node === "string") return document.createTextNode(node);
        const element = document.createElement(node.tag);
        if (node.cls) element.className = node.cls;
        for (const [key, value] of Object.entries(node.attrs)) {
            element.setAttribute(key, value);
        }
        for (const child of node.children) element.append(buildNode(child));
        return element;
    };

    // x-md="blocks": renders the blocks of parseMarkdown() into the element.
    Alpine.directive(
        "md",
        (
            root: HTMLElement,
            { expression }: { expression: string },
            { effect, evaluateLater }: DirectiveUtils,
        ) => {
            const read = evaluateLater(expression);
            effect(() =>
                read((blocks) =>
                    root.replaceChildren(buildNode(markdownTree(blocks as MdBlock[]))),
                ),
            );
        },
    );

    let caseCounter = 0;
    let openToken = 0; // ignores a late response of a superseded results request
    // Not reactive on purpose: one run at a time.
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let loadWatch: Step[] = []; // rows that may still show the load notice
    // The estimate of the budget follows the form; the request waits until the typing stops.
    let estimateTimer: ReturnType<typeof setTimeout> | null = null;
    let estimateToken = 0; // ignores a late reply of a superseded request
    let estimateKeyLast = "";

    const SLOW_LOAD_MS = 8000;

    const SCORES_NAME = 254;
    const SCORES_CELL = 48;

    // `short` is the label of the progress segment (a quarter of the width).
    const PHASE_GROUPS: (PhaseGroup & { short: string })[] = [
        { phase: "reference", title: "01 reference answers", short: "01 reference" },
        { phase: "answer", title: "02 candidate answers", short: "02 answers" },
        { phase: "grading", title: "03 grading", short: "03 grading" },
        { phase: "summary", title: "04 summary", short: "04 summary" },
    ];

    // `fields`: values of an imported case (see caseFields in lib.ts).
    const newCase = (fields: Partial<TestCase> = {}): TestCase => ({
        id: ++caseCounter,
        tag: "",
        question: "",
        rationale: "",
        reference: "",
        open: true,
        ...fields,
    });

    const freshRun = (): RunState => ({
        id: null,
        status: "idle",
        steps: [],
        pos: {},
        seen: {},
        cloud: false,
        done: 0,
        total: 0,
        startedAt: null,
        endedAt: null,
        now: 0,
        error: "",
        resumable: false,
        attention: false,
        config: null,
        phases: phaseStats([], PHASE_GROUPS),
        questions: 0,
        active: 0,
        matrix: [],
        current: [],
    });

    const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    Alpine.data("lmao", () => ({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results
        resultsView: "model", // model | question
        resultsTab: "overview", // overview | answers
        sections: { overview: "summary", answers: "scores" } as Record<string, string>, // the section nav, per tab

        phaseGroups: PHASE_GROUPS,
        cellLegend: CELL_LEGEND,

        models: [] as string[],
        names: {} as Record<string, string>, // full model name -> display name (see shortNames)
        modelsLoaded: false,
        judge: "",
        judgeProvider: "ollama" as JudgeProvider,
        apiModel: "", // the model an openai judge names
        connection: null as Connection | null, // the saved connection: there is no key in it
        connectionLoaded: false,
        connectionEditing: false,
        connectionBusy: false,
        connectionError: "",
        connectionRev: 0, // changes with the saved connection: the estimate depends on its prices
        connectionForm: formOf(null, "") as ConnectionForm,
        preflight: null as PreflightReport | null,
        preflightBusy: false,
        budget: null as Budget | null,
        preview: null as Preview | null,
        estimating: false,
        estimateError: "",
        selected: [] as string[],
        baseRationale: "",
        cases: [newCase()] as TestCase[],
        formError: "",
        casesError: "", // import / export of test cases
        submitting: false,

        history: [] as HistoryRun[],
        historyLoaded: false,
        historyError: "",
        activeRunId: null as string | null,
        resultsError: "",
        controlError: "", // stop and resume
        openAnswers: {} as Record<string, boolean>, // eval block anchor -> true: its answer text is rendered
        folds: initialFolds([], []) as Folds, // which model rows and question cards are opened
        run: freshRun(),
        matrixWidth: 0, // px, from a ResizeObserver
        followCurrent: true,
        matrixStart: 0, // first visible question while the user pages by hand
        results: null as ApiResults | null,
        report: null as Report | null,
        overview: null as Overview | null,
        modelSort: { key: "mean", dir: "desc" } as { key: SortKey; dir: SortDirection },
        modelColumns: COLUMNS,
        scores: [] as ScoreRow[],
        scoreSort: { key: null, dir: "asc" } as ScoreSort,

        announcement: "", // text of the page live region
        // Clipboard API exists only in a secure context (localhost / https).
        canCopy: Boolean(window.isSecureContext && navigator.clipboard),

        init(): void {
            void this.loadModels();
            void this.loadHistory();
            void this.loadConnection();
            // A judge that is not among the models of its provider becomes the first one.
            Alpine.effect(() => this.ensureJudge());
            Alpine.effect(() => {
                const key = this.estimateKey;
                if (key === estimateKeyLast) return;
                estimateKeyLast = key;
                if (estimateTimer) clearTimeout(estimateTimer);
                if (!key) {
                    estimateToken += 1;
                    this.budget = null;
                    this.preview = null;
                    this.estimateError = "";
                    this.estimating = false;
                    return;
                }
                estimateTimer = setTimeout(() => void this.refreshEstimate(key), 400);
            });
            // The tab shows the state of the run: its title and its icon.
            let icon = "";
            Alpine.effect(() => {
                document.title = this.pageTitle;
                const href = faviconHref(this.faviconBars);
                if (href !== icon) {
                    icon = href;
                    document.getElementById("favicon")?.setAttribute("href", href);
                }
            });
        },

        // Templates read it as `pad2(i)`: modules have no globals.
        pad2(index: number): string {
            return pad2(index);
        },

        // A run is in progress (or stopping): the form is locked, on every screen
        // (the wordmark can lead away from the running screen). The archive is not.
        get busy(): boolean {
            return this.run.status === "running" || this.run.status === "stopping";
        },

        get pageTitle(): string {
            if (this.busy) {
                const lead = this.run.status === "stopping" ? "stopping" : fmtClock(this.elapsed);
                return `lmao | ${lead} ${this.run.done} / ${this.run.total}`;
            }
            if (this.run.status === "stopped" && this.view === "running") {
                return `lmao | stopped ${this.run.done} / ${this.run.total}`;
            }
            if (this.view === "results" && this.runTitle) return `lmao | ${this.runTitle}`;
            return "lmao";
        },

        // The four bars of the icon are the four phases of a run.
        get faviconBars(): BarState[] {
            return barStates(this.run.phases, this.run.status);
        },

        // The opened run can be continued: it was stopped or failed.
        get resumable(): boolean {
            const status = this.results?.status;
            return Boolean(status) && status !== "completed" && !this.busy;
        },

        get runTitle(): string | null {
            const run = this.history.find((r) => r.task_id === this.activeRunId);
            return run ? run.tag_name : this.activeRunId;
        },

        get pct(): number {
            return this.run.total ? Math.round((100 * this.run.done) / this.run.total) : 0;
        },

        get elapsed(): number {
            const started = this.run.startedAt;
            if (!started) return 0;
            return Math.max(0, ((this.run.endedAt ?? this.run.now) - started) / 1000);
        },

        // Centre of the topbar. Built from the existing state only.
        // `go`: a run is in progress but another screen is shown. `stop`: the run
        // can be stopped. `open`: a run finished while another screen was open.
        get topStatus(): TopStatus {
            const run = this.run;
            const figures = `${fmtClock(this.elapsed)} · ${run.done} / ${run.total}`;
            const base = { dot: false, go: false, stop: false, open: false };
            if (this.busy) {
                const stopping = run.status === "stopping";
                return {
                    tone: "text-fg",
                    dot: true,
                    go: this.view !== "running",
                    stop: !stopping,
                    open: false,
                    text: `${stopping ? "stopping" : "running"} · ${figures}`,
                };
            }
            if (this.view === "running" && run.status === "stopped") {
                return { ...base, tone: "text-fg-muted", text: `stopped · ${figures}` };
            }
            if (this.view === "running" && run.status === "error") {
                return { ...base, tone: "text-warn", text: `failed · ${figures}` };
            }
            if (run.attention) {
                return { ...base, tone: "text-fg", open: true, text: `finished · ${figures}` };
            }
            if (this.view === "results") {
                return { ...base, tone: "text-fg", text: this.runTitle || "" };
            }
            if (!this.modelsLoaded) {
                return { ...base, tone: "text-fg-muted", text: "connecting…" };
            }
            if (this.models.length === 0) {
                return { ...base, tone: "text-warn", text: "no models found" };
            }
            const n = this.models.length;
            const latency = this.judgeProvider === "openai" ? judgeLatency(this.preflight) : null;
            const judgeNote =
                latency === null ? "" : ` · judge ${hostOf(this.connection?.base_url)} ${latency} ms`;
            return {
                ...base,
                tone: "text-fg-muted",
                text: `ollama · ${n} model${n === 1 ? "" : "s"}${judgeNote}`,
            };
        },

        // One segment per phase, filled from the rows themselves: phases fill
        // independently (a cloud judge grades while local candidates still answer).
        get phaseProgress(): PhaseFigures[] {
            return this.phaseGroups.map((g) => this.run.phases[g.phase]);
        },

        // Recomputed once per event, not on every read: the template reads
        // these figures many times per row.
        updateRun(): void {
            const run = this.run;
            run.phases = phaseStats(run.steps, this.phaseGroups);
            run.matrix = buildMatrix(
                run.steps,
                run.questions,
                (m) => this.label(m),
                run.cloud,
                run.status === "stopped",
            );
            run.current = nowRows(run.steps);
            const active = activeQuestion(run.steps);
            // Between two steps nothing runs: keep the last question.
            if (active !== null) run.active = active;
        },

        // --- matrix ---------------------------------------------------------

        observeMatrix(el: HTMLElement): void {
            const read = () => {
                this.matrixWidth = el.clientWidth;
            };
            read();
            new ResizeObserver(read).observe(el);
        },

        // As many question columns as fit the width, centred on the question in progress.
        get matrixWindow(): ColumnWindow {
            const total = this.run.questions;
            const fit = columnsThatFit(this.matrixWidth, total, RUNNING_MATRIX);
            return columnWindow(
                total,
                fit,
                this.run.active,
                this.followCurrent ? null : this.matrixStart,
            );
        },

        get matrixOverflow(): boolean {
            const w = this.matrixWindow;
            return w.before + w.after > 0;
        },

        get matrixRange(): string {
            const w = this.matrixWindow;
            return `q${pad2(w.start)}–q${pad2(w.end - 1)}`;
        },

        get matrixLabels(): string[] {
            const w = this.matrixWindow;
            return Array.from({ length: w.end - w.start }, (_, i) => `q${w.start + i + 1}`);
        },

        // model | counter | one column per visible question | counter | time.
        // The counter columns exist only while something is hidden.
        get matrixGrid(): string {
            const w = this.matrixWindow;
            const counter = this.matrixOverflow ? RUNNING_MATRIX.counter : 0;
            const count = w.end - w.start;
            const cell = RUNNING_MATRIX.cell;
            // Not everything fits: the columns share the leftover width, so there
            // is no gap before the time. Everything fits: they keep their size.
            const track = this.matrixOverflow ? `minmax(${cell}px,1fr)` : `minmax(${cell}px,64px)`;
            const cells = count ? `repeat(${count},${track})` : "";
            const tail = this.matrixOverflow
                ? `${RUNNING_MATRIX.tail}px`
                : `minmax(${RUNNING_MATRIX.tail}px,1fr)`;
            return `grid-template-columns:${RUNNING_MATRIX.name}px ${counter}px ${cells} ${counter}px ${tail}`;
        },

        visibleCells(row: MatrixRow): MatrixCellInfo[] {
            const w = this.matrixWindow;
            return row.cells.slice(w.start, w.end);
        },

        hiddenLeft(row: MatrixRow): Hidden {
            return hiddenSummary(row.cells, 0, this.matrixWindow.start);
        },

        hiddenRight(row: MatrixRow): Hidden {
            return hiddenSummary(row.cells, this.matrixWindow.end, row.cells.length);
        },

        toggleFollow(): void {
            // Turning it off keeps the window where it is.
            if (this.followCurrent) this.matrixStart = this.matrixWindow.start;
            this.followCurrent = !this.followCurrent;
        },

        pageMatrix(direction: -1 | 1): void {
            const w = this.matrixWindow;
            const size = Math.max(1, w.end - w.start);
            this.matrixStart = w.start + direction * size; // columnWindow clamps it
            this.followCurrent = false;
        },

        // The mark of a cell, 18px (12px in the legend): outline = waiting for the
        // next step, filled = progress, warn = error. The only animation is the
        // breathing of the live marks. Every state is a class and never an x-show:
        // Alpine shows an x-show element one frame later but hides it at once, so a
        // step that finished within a frame (0.0 s) left its old mark on the cell.
        cellClass(state: CellState): string {
            const classes: Record<CellState, string> = {
                planned: "border border-line",
                answering: "bg-link animate-breathe motion-reduce:animate-none",
                ready: "border border-fg",
                grading: "border border-fg",
                graded: "bg-fg",
                generation_error: "bg-warn",
                judge_error: "border border-fg",
                stopped: "border border-fg-muted",
            };
            return classes[state];
        },

        // The small square (or dash) inside the mark; hidden when a state has none.
        cellMark(state: CellState, small = false): string {
            const inset = small ? "inset-2" : "inset-3";
            const marks: Partial<Record<CellState, string>> = {
                grading: `${inset} bg-link animate-breathe motion-reduce:animate-none`,
                judge_error: `${inset} bg-warn`,
                stopped: `${small ? "inset-x-2" : "inset-x-3"} top-1/2 h-2 -translate-y-1/2 bg-fg-muted`,
            };
            return marks[state] ?? "hidden";
        },

        // Blue only while the model is in memory, white once it is done.
        rowNameClass(row: MatrixRow): string {
            if (row.loaded) return "text-link";
            return row.state === "queued" ? "text-fg-muted" : "text-fg";
        },

        // First screen: the state of the form as status rows.
        get checklist(): ChecklistRow[] {
            let judge: { state: string; meta: string };
            if (!this.modelsLoaded) judge = { state: "queued", meta: "loading models…" };
            else if (this.models.length === 0) {
                judge = { state: "error", meta: "no models. is ollama running?" };
            } else if (this.judge) {
                judge = {
                    state: "done",
                    meta: this.label(this.judge) + (this.judgeCloud ? " · cloud" : ""),
                };
            } else judge = { state: "queued", meta: "not selected" };

            const picked = this.selected.length;
            const candidates = picked
                ? { state: "done", meta: `${picked} selected` }
                : { state: "queued", meta: "none selected" };

            const ready = this.cases.filter((c) => c.question.trim()).length;
            const cases =
                ready === this.cases.length
                    ? { state: "done", meta: `${ready} ready` }
                    : { state: "queued", meta: `${ready} of ${this.cases.length} ready` };

            const all = [judge, candidates, cases].every((r) => r.state === "done");
            let runRow = { state: all ? "ready" : "", meta: all ? "press run evaluation" : "" };
            if (this.busy) {
                runRow = { state: "running", meta: `${this.run.done} / ${this.run.total} steps` };
            }
            return [
                { key: "judge", label: "01 judge", ...judge },
                { key: "candidates", label: "02 candidates", ...candidates },
                { key: "cases", label: "03 test cases", ...cases },
                { key: "run", label: "04 run evaluation", ...runRow },
            ];
        },

        label(model: string): string {
            return this.names[model] || shortName(model);
        },

        // Clears first, so the same text can be announced twice.
        announce(text: string): void {
            this.announcement = "";
            setTimeout(() => {
                this.announcement = text;
            }, 50);
        },

        // --- models ---------------------------------------------------------

        async loadModels(): Promise<void> {
            this.modelsLoaded = false;
            try {
                const response = await fetch("/api/models");
                const data: { models?: unknown } = await response.json();
                this.models = Array.isArray(data.models) ? (data.models as string[]) : [];
            } catch (e) {
                console.error("Failed to load models:", e);
                this.models = [];
            }
            this.names = shortNames(this.models);
            this.modelsLoaded = true;
            // Let x-for render the <option>s before the value is set.
            await magic(this).$nextTick();
            this.ensureJudge();
            this.selected = this.selected.filter((m) => this.models.includes(m));
        },

        // --- judge ----------------------------------------------------------

        get remoteJudge(): boolean {
            return this.judgeProvider !== "ollama";
        },

        // The model the judge calls name.
        get judgeName(): string {
            return this.judgeProvider === "openai" ? this.apiModel.trim() : this.judge;
        },

        get judgeChoices(): string[] {
            return judgeModelsOf(this.models, this.judgeProvider);
        },

        ensureJudge(): void {
            if (this.judgeProvider === "openai") return;
            const list = this.judgeChoices;
            if (!list.includes(this.judge)) this.judge = list[0] ?? "";
        },

        get route(): Route | null {
            return routeOf(this.judgeProvider, this.selected.length, this.connection?.base_url ?? null);
        },

        // --- openai connection ----------------------------------------------

        get connectionHost(): string {
            return hostOf(this.connection?.base_url) || (this.connection?.base_url ?? "");
        },

        get maskedKey(): string {
            return maskKey(this.connection?.key_last4 ?? "");
        },

        preflightMeta(check: PreflightCheck): string {
            return metaOf(check);
        },

        async loadConnection(): Promise<void> {
            try {
                const response = await fetch("/api/connection");
                const data: { connection?: Connection | null } = await response.json();
                this.connection = data.connection ?? null;
            } catch (e) {
                console.error("Failed to load the connection:", e);
                this.connection = null;
            }
            if (this.connection && !this.apiModel) this.apiModel = this.connection.model;
            this.connectionLoaded = true;
        },

        editConnection(): void {
            this.connectionForm = formOf(this.connection, this.apiModel);
            this.connectionError = "";
            this.connectionEditing = true;
        },

        cancelConnection(): void {
            this.connectionForm = formOf(null, "");
            this.connectionEditing = false;
            this.connectionError = "";
        },

        // True when the connection is saved. An empty key keeps the saved one.
        async saveConnection(): Promise<boolean> {
            this.connectionError = "";
            let body: ConnectionBody;
            try {
                body = connectionBody({ ...this.connectionForm, model: this.apiModel });
            } catch (e) {
                this.connectionError = errorText(e);
                return false;
            }
            this.connectionBusy = true;
            try {
                const response = await fetch("/api/connection", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.connection = data.connection;
                this.connectionForm = formOf(null, ""); // the typed key is not kept
                this.connectionEditing = false;
                this.connectionRev += 1;
                this.preflight = null;
                return true;
            } catch (e) {
                this.connectionError = errorText(e);
                return false;
            } finally {
                this.connectionBusy = false;
            }
        },

        // The key never comes from the request: the form saves first, then the
        // saved connection is tested.
        async testConnection(): Promise<void> {
            if (this.connectionEditing && !(await this.saveConnection())) return;
            if (!this.connection) return;
            const model = this.apiModel.trim();
            if (!model) {
                this.connectionError = "enter the judge model to test.";
                return;
            }
            this.connectionError = "";
            this.preflightBusy = true;
            try {
                const response = await fetch("/api/connection/test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.preflight = data as PreflightReport;
                this.announce(this.preflight.ok ? "connection test passed." : "connection test failed.");
            } catch (e) {
                this.connectionError = errorText(e);
            } finally {
                this.preflightBusy = false;
            }
        },

        async removeConnection(): Promise<void> {
            this.connectionError = "";
            try {
                const response = await fetch("/api/connection", { method: "DELETE" });
                if (!response.ok) throw new Error(`request failed (${response.status})`);
                this.connection = null;
                this.connectionEditing = false;
                this.connectionRev += 1;
                this.preflight = null;
            } catch (e) {
                this.connectionError = errorText(e);
            }
        },

        // --- budget and request preview -------------------------------------

        // Empty while there is nothing to estimate: a local judge sends nothing out.
        get estimateKey(): string {
            if (this.judgeProvider === "ollama") return "";
            if (this.judgeProvider === "openai" && (!this.connection || this.connectionEditing)) return "";
            const payload = this.buildPayload(true);
            if (!payload.judge || !payload.candidates.length || !payload.test_cases.length) return "";
            return JSON.stringify({ payload, rev: this.connectionRev });
        },

        async refreshEstimate(key: string): Promise<void> {
            const token = ++estimateToken;
            this.estimating = true;
            const { payload } = JSON.parse(key) as { payload: EvaluatePayload };
            const post = async (url: string) => {
                try {
                    const response = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const data = await response.json().catch(() => ({}));
                    return { ok: response.ok, data };
                } catch (e) {
                    return { ok: false, data: { error: errorText(e) } };
                }
            };
            const [budget, preview] = await Promise.all([post("/api/budget"), post("/api/preview")]);
            if (token !== estimateToken) return;
            this.estimating = false;
            this.budget = budget.ok ? (budget.data as Budget) : null;
            this.preview = preview.ok ? (preview.data as Preview) : null;
            const failed = !budget.ok ? budget : !preview.ok ? preview : null;
            this.estimateError = failed ? failed.data.error || "the estimate failed." : "";
        },

        get budgetFigures(): Figure[] {
            if (!this.budget) return [];
            return figuresOf(this.budget, this.judgeProvider === "openai" ? this.judgeName : null);
        },

        get previewBody(): string {
            return this.preview ? previewText(this.preview) : "";
        },

        // --- archive --------------------------------------------------------

        async loadHistory(): Promise<void> {
            try {
                const response = await fetch("/api/history");
                if (!response.ok) throw new Error(`request failed (${response.status})`);
                this.history = sortHistory(await response.json());
                this.historyError = "";
            } catch (e) {
                console.error("Failed to load history:", e);
                this.historyError = "failed to load the archive.";
            }
            this.historyLoaded = true;
        },

        // Opens a saved run. Allowed while a run is in progress: that run keeps its
        // own state in `this.run`, and the topbar leads back to it.
        async openRun(id: string): Promise<void> {
            if (id === this.run.id) this.run.attention = false;
            const token = ++openToken;
            this.activeRunId = id;
            this.view = "results";
            if (magic(this).$refs?.main) magic(this).$refs.main.scrollTop = 0;
            this.results = null;
            this.report = null;
            this.overview = null;
            this.scores = [];
            this.scoreSort = { key: null, dir: "asc" };
            this.resultsTab = "overview";
            this.sections = { overview: "summary", answers: "scores" };
            this.openAnswers = {};
            this.folds = initialFolds([], []);
            this.resultsError = "";
            try {
                const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
                const data = await response.json().catch(() => ({}));
                if (token !== openToken) return;
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                let report: Report;
                try {
                    report = buildReport(data);
                } catch (e) {
                    console.error("Cannot build the report:", e);
                    // TypeError: a field is missing or has another type -> the file.
                    // Anything else (ReferenceError...) is a bug in the UI, not the file.
                    let message =
                        "the report could not be built: a bug in the UI, see the browser console.";
                    if (e instanceof ReportFormatError) message = e.message;
                    else if (e instanceof TypeError) {
                        message = "this run cannot be shown: the file has an unexpected format.";
                    }
                    throw new Error(message);
                }
                this.overview = buildOverview(data as ApiResults);
                this.scores = buildScoreRows(report.models, this.overview.models);
                this.report = report;
                this.folds = initialFolds(report.models, report.questionCards);
                this.results = data as ApiResults;
            } catch (e) {
                console.error("Failed to open run:", e);
                if (token === openToken) this.resultsError = errorText(e);
            }
        },

        // --- test cases -----------------------------------------------------

        addCase(): void {
            // Collapse the finished ones, never one that is still empty.
            this.cases.forEach((c) => {
                if (c.question.trim()) c.open = false;
            });
            this.cases.push(newCase());
        },

        removeCase(id: number): void {
            if (this.cases.length > 1) {
                this.cases = this.cases.filter((c) => c.id !== id);
            }
        },

        get canExport(): boolean {
            return this.cases.some((c) => c.question.trim());
        },

        exportCases(): void {
            this.casesError = "";
            const text = buildCasesFile({
                baseRationale: this.baseRationale,
                cases: this.cases,
            });
            const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "lmao-test-cases.json";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        // Empty form: the file replaces it. Otherwise the cases are added after
        // the existing ones; empty cases are dropped either way. The general
        // criteria of the file are used only while the field is empty.
        async importCases(event: Event): Promise<void> {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;
            this.casesError = "";
            try {
                // Checked before the file is read.
                if (file.size > CASES_MAX_BYTES) throw new CasesFileError(CASES_TOO_LARGE);
                const parsed = parseCasesFile(await file.text());

                const kept = this.cases.filter((c) => !isBlankCase(c));
                if (kept.length + parsed.cases.length > CASES_MAX_COUNT) {
                    throw new CasesFileError(`too many test cases (max ${CASES_MAX_COUNT}).`);
                }
                if (!this.baseRationale.trim()) this.baseRationale = parsed.baseRationale;
                this.cases = [
                    ...kept,
                    ...parsed.cases.map((raw) => newCase({ ...caseFields(raw), open: false })),
                ];
                this.announce(`imported ${parsed.cases.length} test cases`);
            } catch (e) {
                const known = e instanceof CasesFileError;
                if (!known) console.error("Failed to import test cases:", e);
                this.casesError = known ? e.message : "could not read the file.";
            } finally {
                input.value = ""; // the same file can be chosen again
            }
        },

        // --- start ----------------------------------------------------------

        validate(): string {
            if (this.judgeProvider === "openai") {
                if (!this.connection) return "connect the openai api first.";
                if (this.connectionEditing) return "save the connection first.";
                if (!this.judgeName) return "enter the judge model.";
            } else if (!this.judgeName) {
                return "choose a judge model.";
            }
            if (this.selected.length === 0) {
                return "select at least one candidate.";
            }
            const index = this.cases.findIndex((c) => !c.question.trim());
            if (index !== -1) {
                this.cases[index].open = true;
                return `case ${pad2(index)}: the question is empty.`;
            }
            return "";
        },

        // `estimate`: only the cases that have a question, the way the budget and
        // the preview take them while the form is still being filled.
        buildPayload(estimate = false): EvaluatePayload {
            return {
                judge: this.judgeName,
                judge_provider: this.judgeProvider,
                candidates: [...this.selected],
                base_rationale: this.baseRationale.trim(),
                test_cases: this.cases
                    .filter((c) => !estimate || c.question.trim())
                    .map((c) => payloadCase(c)),
            };
        },

        async submit(): Promise<void> {
            this.formError = this.validate();
            if (this.formError || this.busy) return;

            const payload = this.buildPayload();
            this.submitting = true;
            try {
                const response = await fetch("/api/evaluate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.startRun(data.task_id, {
                    judge: payload.judge,
                    cloud: payload.judge_provider !== "ollama",
                    candidates: payload.candidates,
                    questions: payload.test_cases.length,
                });
            } catch (e) {
                this.formError = errorText(e);
            } finally {
                this.submitting = false;
            }
        },

        // --- running --------------------------------------------------------

        startRun(taskId: string, config: RunConfig): void {
            this.stopStream();
            const steps = buildSteps(
                config.judge,
                config.candidates,
                config.questions,
                this.names,
            );
            const pos: Record<string, number> = {};
            steps.forEach((step, index) => (pos[step.key] = index));
            const now = Date.now();

            this.run = {
                ...freshRun(),
                id: taskId,
                status: "running",
                steps,
                pos,
                cloud: config.cloud,
                config,
                // Corrected by the first event that carries `progress`.
                total: totalSteps(config.questions, new Set(config.candidates).size),
                questions: config.questions,
                startedAt: now,
                now,
            };
            this.followCurrent = true;
            this.matrixStart = 0;
            this.updateRun();
            loadWatch = [];
            this.activeRunId = null; // the running screen is not an archive item
            this.controlError = "";
            this.setupOpen = false;
            this.view = "running";

            timer = setInterval(() => this.tick(), 1000);

            source = new EventSource(`/api/stream/${encodeURIComponent(taskId)}`);
            source.onmessage = (event) => this.onMessage(event);
            // EventSource would reconnect and the backend replays the stream
            // from the start, which would duplicate the rows: stop at the first error.
            source.onerror = () => {
                if (this.run.status !== "running") return;
                this.failRun(
                    "connection to the server was lost. the run may still finish: check the archive.",
                );
            };
        },

        // One clock for the elapsed time, the row timers and the load notice.
        tick(): void {
            this.run.now = Date.now();
            if (!loadWatch.length) return;
            loadWatch = loadWatch.filter((step) => {
                if (step.state !== "running") return false;
                if (!this.showLoadNotice(step)) return true;
                step.announced = true;
                this.announce("the model may still be loading. this is normal.");
                return false;
            });
        },

        stopStream(): void {
            if (source) source.close();
            source = null;
            if (timer) clearInterval(timer);
            timer = null;
        },

        step(event: SseEvent): Step | null {
            const key = stepKey(event.phase ?? "", event.model, event.question);
            const index = this.run.pos[key];
            return index === undefined ? null : this.run.steps[index];
        },

        onMessage(message: MessageEvent<string>): void {
            let event: SseEvent;
            try {
                event = JSON.parse(message.data);
            } catch (e) {
                console.error("Bad SSE payload:", e);
                return;
            }

            if (event.progress) {
                this.run.total = event.progress.total;
                this.run.done = Math.max(this.run.done, event.progress.done);
            }

            if (event.type === "completed") return this.finishRun();
            if (event.type === "cancelling") {
                this.run.status = "stopping";
                return;
            }
            if (event.type === "cancelled") return this.stoppedRun();
            if (event.type === "error") {
                return this.failRun(event.message || "the evaluation failed.", true);
            }

            const match = /^([a-z]+)_(start|done)$/.exec(event.type || "");
            // `info` is not shown; `candidate_start` has no question and is only a group marker.
            if (!match || match[1] === "candidate") return;

            const step = this.step(event);
            if (!step) return;
            if (match[2] === "start") this.stepStarted(step, event);
            else this.stepDone(step, event);
            this.updateRun();
        },

        stepStarted(step: Step, event: SseEvent): void {
            // A duplicate start must not reset the timer of a row in flight.
            if (step.state !== "queued") return;
            step.state = "running";
            step.startedAt = Date.now();
            const ts = Date.parse(event.timestamp ?? "");
            step.startTs = Number.isFinite(ts) ? ts : null;

            const phaseKey = `phase:${step.phase}`;
            if (!this.run.seen[phaseKey]) {
                this.run.seen[phaseKey] = true;
                const group = this.phaseGroups.find((g) => g.phase === step.phase);
                if (group) this.announce(`${group.title.replace(/^\d+\s+/, "")} started`);
            }

            const loadKey = loadGroup(step.phase, step.model, this.run.cloud);
            if (loadKey && !this.run.seen[loadKey]) {
                this.run.seen[loadKey] = true;
                step.loading = true;
                loadWatch.push(step);
            }
        },

        stepDone(step: Step, event: SseEvent): void {
            // Finished rows stay as they are (duplicates, events after `skipped`).
            if (step.state !== "running" && step.state !== "queued") return;

            // Both timestamps come from the server, so its time zone cancels out.
            // No start event (or a broken timestamp): no duration instead of nonsense.
            const end = Date.parse(event.timestamp ?? "");
            const sec =
                step.startTs !== null && Number.isFinite(end) ? (end - step.startTs) / 1000 : NaN;
            const duration = fmtSeconds(sec);
            step.endTs = Number.isFinite(end) ? end : null;

            if (event.success) {
                step.state = "done";
                if (step.phase === "reference") {
                    step.meta =
                        event.source === "generated" && duration
                            ? `generated · ${duration}`
                            : event.source || "";
                } else {
                    step.meta = duration;
                }
            } else {
                step.state = "error";
                step.meta =
                    step.phase === "reference"
                        ? "no reference: graded without one"
                        : event.error || "failed";
            }

            // The backend sends no grading events for a failed answer.
            if (step.phase === "answer" && !event.success) {
                const index = this.run.pos[stepKey("grading", step.model, step.question)];
                if (index !== undefined) {
                    this.run.steps[index].state = "skipped";
                    this.run.steps[index].meta = "not graded";
                }
            }
        },

        finishRun(): void {
            this.run.done = this.run.total; // `completed` may come without `progress`
            this.run.status = "done";
            this.run.endedAt = Date.now();
            this.stopStream();
            // Someone browsing the archive is not pulled away from it.
            const watching = this.view === "running";
            this.announce(
                watching ? "evaluation finished. opening the results." : "evaluation finished.",
            );
            void this.loadHistory();
            if (!this.run.id) return;
            if (watching) void this.openRun(this.run.id);
            else this.run.attention = true;
        },

        failRun(message: string, resumable = false): void {
            // Rows that were in flight will never finish: stop their animation.
            this.run.steps.forEach((step) => {
                if (step.state === "running") {
                    step.state = "error";
                    step.meta = "interrupted";
                }
            });
            this.updateRun();
            this.run.status = "error";
            this.run.error = message; // announced by the role="alert" notice
            this.run.resumable = resumable;
            this.run.endedAt = Date.now();
            this.stopStream();
            void this.loadHistory(); // a failed run is in the archive and can be resumed
        },

        // The server confirmed the stop: the last call has finished.
        stoppedRun(): void {
            this.run.status = "stopped";
            this.run.endedAt = Date.now();
            this.stopStream();
            this.updateRun();
            void this.loadHistory();
            this.announce(`run stopped. ${this.run.done} of ${this.run.total} steps are done.`);
        },

        // The step in progress is not interrupted: the run stops after it.
        async stopRun(): Promise<void> {
            const id = this.run.id;
            if (this.run.status !== "running" || !id) return;
            this.controlError = "";
            this.run.status = "stopping"; // at once: the server may take a moment
            try {
                const response = await fetch(`/api/evaluate/${encodeURIComponent(id)}/cancel`, {
                    method: "POST",
                });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `request failed (${response.status})`);
                }
            } catch (e) {
                // Nothing was stopped: the run goes on.
                if (this.run.status === "stopping") this.run.status = "running";
                this.controlError = errorText(e);
            }
        },

        // From the stopped screen or from the archive. The server replays the
        // finished steps, so the rows are built the same way as for a live run.
        async resumeRun(id: string): Promise<void> {
            if (this.busy) return;
            this.controlError = "";
            try {
                const config =
                    this.run.id === id && this.run.config ? this.run.config : await this.configOf(id);
                const response = await fetch(`/api/evaluate/${encodeURIComponent(id)}/resume`, {
                    method: "POST",
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.startRun(data.task_id, config);
            } catch (e) {
                this.controlError = errorText(e);
            }
        },

        // The rows of a saved run, read from its results file.
        async configOf(id: string): Promise<RunConfig> {
            const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
            const data: Partial<ApiResults> & { error?: string } = await response
                .json()
                .catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
            if (
                !data.judge_model ||
                !Array.isArray(data.candidates) ||
                !Array.isArray(data.questions_results)
            ) {
                throw new Error("this run cannot be resumed: its file has an unexpected format.");
            }
            return {
                judge: data.judge_model,
                cloud: data.judge_provider !== "ollama",
                candidates: data.candidates,
                questions: data.questions_results.length,
            };
        },

        // Back to the form: after an error the setup panel may still be closed.
        dismissRun(): void {
            this.view = "idle";
            this.setupOpen = true;
        },

        // Wordmark: back to the first screen. A run in progress keeps going;
        // the topbar status and the first screen lead back to it.
        goHome(): void {
            this.view = "idle";
            this.activeRunId = null;
            if (magic(this).$refs?.main) magic(this).$refs.main.scrollTop = 0;
        },

        showRun(): void {
            this.view = "running";
            this.activeRunId = null;
        },

        // Comparison table -> a card or an eval block in 03 view. Both 03 views
        // are x-if templates, so switch first and scroll once the view exists.
        // Without `view` the active view stays: each holds every answer block.
        async jumpTo(id: string | null, view: string | null = null): Promise<void> {
            if (!id) return;
            if (view && this.resultsView !== view) {
                this.resultsView = view;
                await magic(this).$nextTick();
            }
            // A folded row or a hidden answer is not in the DOM: open it first.
            this.folds = withRevealed(
                this.folds,
                this.report?.models ?? [],
                this.report?.questionCards ?? [],
                id,
            );
            await magic(this).$nextTick();
            // The answer text exists only when opened: open it first, so the
            // scroll lands on the final layout.
            if (id.startsWith("answer-")) {
                this.openAnswers[id] = true;
                await magic(this).$nextTick();
            }
            const target = document.getElementById(id);
            if (!target) return;
            // Instant on purpose: the blocks above the target are skipped
            // (content-visibility) and their heights are estimates, so a long
            // smooth scroll would end off target while they render.
            target.scrollIntoView({ block: "start", behavior: "auto" });
            // Keyboard users continue from the target.
            target.focus({ preventScroll: true });
        },

        // --- results tabs ---------------------------------------------------

        // --- scores matrix of the answers tab ------------------------------

        get scoreRows(): ScoreRow[] {
            return sortScoreRows(this.scores, this.scoreSort.key, this.scoreSort.dir);
        },

        // model | one fixed column per question: the matrix scrolls sideways.
        get scoresGrid(): string {
            const count = this.report?.questionHeads.length ?? 0;
            const cells = count ? ` repeat(${count},${SCORES_CELL}px)` : "";
            return `grid-template-columns:${SCORES_NAME}px${cells}`;
        },

        sortScores(key: number | null): void {
            this.scoreSort = nextScoreSort(this.scoreSort, key);
        },

        get modelRows(): TableRow[] {
            if (!this.overview) return [];
            return sortRows(this.overview.models, this.modelSort.key, this.modelSort.dir);
        },

        sortModels(key: SortKey): void {
            if (this.modelSort.key === key) {
                this.modelSort.dir = this.modelSort.dir === "desc" ? "asc" : "desc";
            } else {
                this.modelSort = { key, dir: defaultDirection(key) };
            }
        },

        get activeSection(): string {
            return this.sections[this.resultsTab] ?? "";
        },

        // Section nav -> the section `sec-<id>` of the open tab.
        goSection(id: string): void {
            this.sections[this.resultsTab] = id;
            const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            document
                .getElementById(`sec-${id}`)
                ?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
        },

        // From one tab to a block of another one: switch first, then jump.
        async showIn(tab: string, id: string | null, view: string | null = null): Promise<void> {
            this.resultsTab = tab;
            await magic(this).$nextTick();
            await this.jumpTo(id, view);
        },

        async copyText(text: unknown): Promise<boolean> {
            try {
                await navigator.clipboard.writeText(String(text ?? ""));
                return true;
            } catch (e) {
                console.error("Copy failed:", e);
                return false;
            }
        },

        isAnswerOpen(id: string): boolean {
            return Boolean(this.openAnswers[id]);
        },

        toggleAnswer(id: string): void {
            this.openAnswers[id] = !this.openAnswers[id];
        },

        // --- folds of the answers tab ---------------------------------------

        isFoldOpen(kind: "models" | "questions", anchor: string): boolean {
            return Boolean(this.folds[kind][anchor]);
        },

        toggleFold(kind: "models" | "questions", anchor: string): void {
            this.folds = {
                ...this.folds,
                [kind]: { ...this.folds[kind], [anchor]: !this.folds[kind][anchor] },
            };
        },

        shownEntries(model: ReportModel): EvalEntry[] {
            return visible(model.entries, ANSWERS_SHOWN, Boolean(this.folds.allAnswers[model.anchor]));
        },

        hiddenAnswers(model: ReportModel): number {
            return hiddenCount(
                model.entries.length,
                ANSWERS_SHOWN,
                Boolean(this.folds.allAnswers[model.anchor]),
            );
        },

        showAllAnswers(anchor: string): void {
            this.folds = { ...this.folds, allAnswers: { ...this.folds.allAnswers, [anchor]: true } };
        },

        get visibleCards(): QuestionCard[] {
            const cards = this.report?.questionCards ?? [];
            return visible(cards, QUESTIONS_SHOWN, this.folds.allQuestions);
        },

        get hiddenCards(): number {
            const total = this.report?.questionCards.length ?? 0;
            return hiddenCount(total, QUESTIONS_SHOWN, this.folds.allQuestions);
        },

        get visibleReferences(): ReportReference[] {
            const list = this.report?.references ?? [];
            return visible(list, REFERENCES_SHOWN, this.folds.allReferences);
        },

        get hiddenReferences(): number {
            const total = this.report?.references.length ?? 0;
            return hiddenCount(total, REFERENCES_SHOWN, this.folds.allReferences);
        },

        // [ and ] toggle the panels, Esc goes to the first screen.
        // event.code: the same physical keys on any layout (х / ї in Ukrainian).
        // Ignored while typing and with modifiers.
        hotkey(event: KeyboardEvent): void {
            if (
                event.defaultPrevented ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
            ) {
                return;
            }
            const target = event.target as Element | null;
            if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

            if (event.code === "BracketLeft") this.setupOpen = !this.setupOpen;
            else if (event.code === "BracketRight") this.archiveOpen = !this.archiveOpen;
            else if (event.code === "Escape" && this.view !== "idle") this.goHome();
            else return;
            event.preventDefault();
        },

        // Tabs (ui.tabs): `key` is the state property, ids are tab-<key>-<value>.
        setTab(key: string, value: string): void {
            (this as unknown as Record<string, unknown>)[key] = value;
            void magic(this).$nextTick(() => document.getElementById(`tab-${key}-${value}`)?.focus());
        },

        // `list`: comma-separated values in tab order; `step`: +1 / -1, wraps around.
        cycleTab(key: string, list: string, step: number): void {
            const values = list.split(",");
            const current = (this as unknown as Record<string, unknown>)[key] as string;
            const index = values.indexOf(current);
            this.setTab(key, values[(index + step + values.length) % values.length]);
        },

        // --- row helpers ----------------------------------------------------

        stateClass(state: string): string {
            const classes: Record<string, string> = {
                done: "text-fg",
                ready: "text-fg",
                running: "text-link",
                queued: "text-fg-muted",
                skipped: "text-fg-muted",
                error: "text-warn",
            };
            return classes[state] || "text-fg-muted";
        },

        isMuted(state: string): boolean {
            return state === "queued" || state === "skipped" || !state;
        },

        rowMeta(step: Step): string {
            if (step.state === "running" && step.startedAt) {
                // run.now ticks once a second and can be behind startedAt.
                return fmtSeconds(Math.max(0, this.run.now - step.startedAt) / 1000);
            }
            return step.meta;
        },

        showLoadNotice(step: Step): boolean {
            return (
                step.state === "running" &&
                step.loading &&
                step.startedAt !== null &&
                this.run.now - step.startedAt > SLOW_LOAD_MS
            );
        },
    }));
});