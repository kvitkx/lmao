// The running screen: the event stream, the rows, the matrix, stop and resume.

import type { ApiResults } from "../../types/results.js";
import { type BarState, barStates } from "../favicon.ts";
import { pad2 } from "../names.ts";
import { hostOf, judgeLatency } from "../remote.ts";
import {
    activeQuestion,
    buildMatrix,
    buildSteps,
    CELL_LEGEND,
    type CellState,
    columnsThatFit,
    columnWindow,
    type ColumnWindow,
    fmtClock,
    fmtSeconds,
    type Hidden,
    hiddenSummary,
    loadGroup,
    type MatrixCellInfo,
    type MatrixRow,
    type NowRow,
    nowRows,
    type PhaseFigures,
    type PhaseGroup,
    phaseStats,
    RUNNING_MATRIX,
    type Step,
    stepKey,
    totalSteps,
} from "../run.ts";
import { errorText, slice } from "./shared.ts";

// One event of /api/stream/<task_id>, see docs/DESIGN.md (data contract).
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
    text?: string;
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
    reconnectable: boolean; // the stream broke: the run may still go on, the stream can be reopened
    reconnecting: boolean; // the stream broke and the browser is reconnecting by itself
    attention: boolean; // finished while another screen was open
    config: RunConfig | null;
    phases: Record<string, PhaseFigures>; // phase -> figures, see updateRun()
    questions: number;
    active: number; // the question in progress (0-based), the anchor of the matrix window
    matrix: MatrixRow[];
    current: NowRow[]; // the calls in flight
}

interface TopStatus {
    tone: string;
    dot: boolean;
    go: boolean;
    open: boolean;
    text: string;
}

// Not reactive on purpose: one run at a time.
let source: EventSource | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let loadWatch: Step[] = []; // rows that may still show the load notice

const SLOW_LOAD_MS = 8000;

// The browser reconnects by itself and sends Last-Event-ID, so the server
// continues after the last event it got. After this long without a
// connection the run is shown as failed, with `reconnect`.
const RECONNECT_GIVE_UP_MS = 30_000;
const LOST_TEXT =
    "connection to the server was lost. the run may still be going: reconnect to see it.";
let reconnectSince = 0; // 0: connected

// `short` is the label of the progress segment (a quarter of the width).
const PHASE_GROUPS: (PhaseGroup & { short: string })[] = [
    { phase: "reference", title: "01 reference answers", short: "01 ref" },
    { phase: "answer", title: "02 candidate answers", short: "02 answers" },
    { phase: "grading", title: "03 grading", short: "03 grading" },
    { phase: "summary", title: "04 summary", short: "04 summary" },
];

export const freshRun = (): RunState => ({
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
    reconnectable: false,
    reconnecting: false,
    attention: false,
    config: null,
    phases: phaseStats([], PHASE_GROUPS),
    questions: 0,
    active: 0,
    matrix: [],
    current: [],
});

export function runSlice() {
    return slice({
        phaseGroups: PHASE_GROUPS,
        cellLegend: CELL_LEGEND,
        controlError: "", // stop and resume
        run: freshRun(),
        matrixWidth: 0, // px, from a ResizeObserver
        followCurrent: true,
        matrixStart: 0, // first visible question while the user pages by hand

        // A run is in progress (or stopping): the form is locked, on every screen
        // (the wordmark can lead away from the running screen). The archive is not.
        get busy(): boolean {
            return this.run.status === "running" || this.run.status === "stopping";
        },

        get pageTitle(): string {
            if (this.busy) {
                const lead = this.run.status === "stopping" ? "stopping" : fmtClock(this.elapsed);
                return `${lead} ${this.run.done} / ${this.run.total}`;
            }
            if (this.run.status === "stopped" && this.view === "running") {
                return `stopped ${this.run.done} / ${this.run.total}`;
            }
            if (this.view === "results" && this.runTitle) return this.runTitle;
            return "lmao";
        },

        // The four bars of the icon are the four phases of a run.
        get faviconBars(): BarState[] {
            return barStates(this.run.phases, this.run.status);
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
        // `go`: a run is in progress but another screen is shown. `open`: a run
        // finished while another screen was open.
        get topStatus(): TopStatus {
            const run = this.run;
            const figures = fmtClock(this.elapsed);
            const base = { dot: false, go: false, open: false };
            if (this.busy) {
                const stopping = run.status === "stopping";
                return {
                    tone: "text-fg",
                    dot: true,
                    go: this.view !== "running",
                    open: false,
                    text: `${stopping ? "stopping" : "running"} · ${fmtClock(this.elapsed)}${run.reconnecting ? " · reconnecting…" : ""}`,
                };
            }
            if (this.view === "running" && run.status === "stopped") {
                return { ...base, tone: "text-fg-muted", text: `stopped · ${figures}` };
            }
            if (this.view === "running" && run.status === "error") {
                return { ...base, tone: "text-warn", text: `failed · ${figures}` };
            }
            if (
                (run.status === "stopped" || run.status === "error") &&
                this.view !== "running"
            ) {
                const failed = run.status === "error";
                return {
                    ...base,
                    tone: failed ? "text-warn" : "text-fg-muted",
                    go: true,
                    text: `${failed ? "failed" : "stopped"} · ${figures}`,
                };
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

            reconnectSince = 0;
            source = new EventSource(`/api/stream/${encodeURIComponent(taskId)}`);
            source.onopen = () => {
                reconnectSince = 0;
                this.run.reconnecting = false;
            };
            source.onmessage = (event) => this.onMessage(event);
            // The browser reconnects by itself with the id of the last event, so
            // no row is duplicated. A closed source will not try again.
            source.onerror = () => {
                if (!this.busy) return;
                if (source && source.readyState === EventSource.CLOSED) {
                    this.failRun(LOST_TEXT, false, true);
                    return;
                }
                if (!reconnectSince) reconnectSince = Date.now();
                this.run.reconnecting = true;
            };
        },

        // One clock for the elapsed time, the row timers and the load notice.
        tick(): void {
            this.run.now = Date.now();
            if (reconnectSince && this.busy && this.run.now - reconnectSince > RECONNECT_GIVE_UP_MS) {
                this.failRun(LOST_TEXT, false, true);
                return;
            }
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
            reconnectSince = 0;
            this.run.reconnecting = false;
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

            if (event.type === "answer_token") {
                const row = this.step(event);
                if (row && row.state === "running") {
                    row.preview += event.text ?? "";
                }
                return;
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
            step.preview = "";

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

        failRun(message: string, resumable = false, reconnectable = false): void {
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
            this.run.reconnectable = reconnectable;
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

        // A candidate answer in progress is cut off at once (redone on resume);
        // a judge call in progress finishes first, then the run stops.
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

        // The stream broke but the run may still be going: open it again. The
        // server replays the events from the start, so the rows are rebuilt.
        reconnectRun(): void {
            const { id, config, startedAt } = this.run;
            if (!id || !config) return;
            this.startRun(id, config);
            if (startedAt) this.run.startedAt = startedAt; // the clock keeps running
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
                // Still going on the server: connect to it instead of resuming.
                if (response.status === 409 && this.run.id === id) return this.reconnectRun();
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
            this.run = freshRun();
            this.view = "idle";
            this.setupOpen = true;
        },

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
                step.preview === "" &&
                step.loading &&
                step.startedAt !== null &&
                this.run.now - step.startedAt > SLOW_LOAD_MS
            );
        },
    });
}

export type RunSlice = ReturnType<typeof runSlice>;
