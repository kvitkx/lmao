// The archive and the results screen: tabs, scores, folds and jumps.

import type { ApiResults } from "../../types/results.js";
import {
    ANSWERS_SHOWN,
    buildScoreRows,
    type Folds,
    hiddenCount,
    initialFolds,
    nextScoreSort,
    QUESTIONS_SHOWN,
    REFERENCES_SHOWN,
    type ScoreRow,
    type ScoreSort,
    sortScoreRows,
    visible,
    withRevealed,
} from "../answers.ts";
import {
    buildOverview,
    COLUMNS,
    defaultDirection,
    type Overview,
    type SortDirection,
    type SortKey,
    sortRows,
    type TableRow,
} from "../overview.ts";
import {
    buildReport,
    type EvalEntry,
    type HistoryRun,
    type QuestionCard,
    type Report,
    ReportFormatError,
    type ReportModel,
    type ReportReference,
    sortHistory,
} from "../report.ts";
import { freshRun } from "./run.ts";
import { errorText, magic, slice } from "./shared.ts";

let openToken = 0; // ignores a late response of a superseded results request

const SCORES_NAME = 254;
const SCORES_CELL = 48;

export function resultsSlice() {
    return slice({
        resultsView: "model", // model | question
        resultsTab: "overview", // overview | answers
        sections: { overview: "summary", answers: "scores" } as Record<string, string>, // the section nav, per tab

        history: [] as HistoryRun[],
        historyLoaded: false,
        historyError: "",
        activeRunId: null as string | null,
        resultsError: "",
        openAnswers: {} as Record<string, boolean>, // eval block anchor -> true: its answer text is rendered
        folds: initialFolds([], []) as Folds, // which model rows and question cards are opened
        results: null as ApiResults | null,
        report: null as Report | null,
        overview: null as Overview | null,
        modelSort: { key: "mean", dir: "desc" } as { key: SortKey; dir: SortDirection },
        modelColumns: COLUMNS,
        scores: [] as ScoreRow[],
        scoreSort: { key: null, dir: "asc" } as ScoreSort,

        // The opened run can be continued: it was stopped or failed.
        get resumable(): boolean {
            const status = this.results?.status;
            return Boolean(status) && status !== "completed" && !this.busy;
        },

        get runTitle(): string | null {
            const run = this.history.find((r) => r.task_id === this.activeRunId);
            return run ? run.tag_name : this.activeRunId;
        },

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

        async renameRun(id: string, title: string): Promise<boolean> {
            try {
                const response = await fetch(`/api/results/${encodeURIComponent(id)}/title`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                await this.loadHistory();
                return true;
            } catch (e) {
                this.historyError = errorText(e);
                return false;
            }
        },

        async deleteRun(id: string): Promise<boolean> {
            try {
                const response = await fetch(`/api/results/${encodeURIComponent(id)}`, {
                    method: "DELETE",
                });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                if (this.activeRunId === id) this.goHome();
                if (this.run.id === id) this.run = freshRun();
                await this.loadHistory();
                return true;
            } catch (e) {
                this.historyError = errorText(e);
                return false;
            }
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
                this.resultsView as "model" | "question",
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

        isAnswerOpen(id: string): boolean {
            return Boolean(this.openAnswers[id]);
        },

        toggleAnswer(id: string): void {
            this.openAnswers[id] = !this.openAnswers[id];
        },

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
    });
}

export type ResultsSlice = ReturnType<typeof resultsSlice>;
