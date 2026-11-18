// The scores matrix of the answers tab: one row per model, one column per
// question, sortable. The mean, median, pass rate and speed of a model live in
// the models table of the overview. Pure: no DOM, no Alpine.

import type { QuestionCard, ReportCell, ReportModel } from "./lib.ts";
import type { Rank, SortDirection, TableRow } from "./overview.ts";

export interface ScoreRow {
    model: string;
    short: string;
    anchor: string; // the model's block in "02 answers"
    rank: Rank;
    cells: ReportCell[];
}

// `models` are the rows of the report (a cell per question), `ranked` the rows
// of the overview table (rank and name). The result is in rank order.
export function buildScoreRows(
    models: { model: string; cells: ReportCell[] }[],
    ranked: TableRow[],
): ScoreRow[] {
    const cells = new Map(models.map((m) => [m.model, m.cells]));
    return ranked
        .filter((row) => cells.has(row.model))
        .map((row) => ({
            model: row.model,
            short: row.short,
            anchor: row.anchor,
            rank: row.rank,
            cells: cells.get(row.model) as ReportCell[],
        }));
}

export interface ScoreSort {
    key: number | null; // a question (0-based), or null for the rank order
    dir: SortDirection;
}

// A missing score (an error, no answer) is always last, ties keep the rank order.
export function sortScoreRows(rows: ScoreRow[], key: number | null, dir: SortDirection): ScoreRow[] {
    const sign = dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
        if (key === null) return sign * (a.rank.rank - b.rank.rank);
        const x = a.cells[key]?.bar ?? null;
        const y = b.cells[key]?.bar ?? null;
        if (x === null && y === null) return a.rank.rank - b.rank.rank;
        if (x === null) return 1;
        if (y === null) return -1;
        return sign * (x - y) || a.rank.rank - b.rank.rank;
    });
}

// A click on a header: the first one puts the best scores (or the best rank)
// on top, a second one reverses.
export function nextScoreSort(current: ScoreSort, key: number | null): ScoreSort {
    if (current.key === key) return { key, dir: current.dir === "desc" ? "asc" : "desc" };
    return { key, dir: key === null ? "asc" : "desc" };
}

// --- folds of the answers tab -----------------------------------------------

export const ANSWERS_SHOWN = 4; // answers of an opened model shown before `show all`
export const QUESTIONS_SHOWN = 7; // question cards shown before `show all`
export const QUESTIONS_OPEN = 2; // of them, opened from the start
export const REFERENCES_SHOWN = 3; // reference rows shown before `show all`

export function visible<T>(items: readonly T[], limit: number, all: boolean): T[] {
    return all ? [...items] : items.slice(0, limit);
}

export function hiddenCount(total: number, limit: number, all: boolean): number {
    return all ? 0 : Math.max(0, total - limit);
}

export interface Folds {
    models: Record<string, boolean>; // model anchor -> opened
    questions: Record<string, boolean>; // question anchor -> opened
    allAnswers: Record<string, boolean>; // model anchor -> every answer shown
    allQuestions: boolean;
    allReferences: boolean;
}

// The best model and the first questions are open; everything else is folded.
export function initialFolds(
    models: Pick<ReportModel, "anchor">[],
    cards: Pick<QuestionCard, "anchor">[],
): Folds {
    return {
        models: models.length ? { [models[0].anchor]: true } : {},
        questions: Object.fromEntries(cards.slice(0, QUESTIONS_OPEN).map((c) => [c.anchor, true])),
        allAnswers: {},
        allQuestions: false,
        allReferences: false,
    };
}

export type AnswersView = "model" | "question";

// Opens whatever holds the block with this id, so that it is rendered before a
// jump. The id of a model, a question or an answer; any other id changes nothing.
// `view`: only the shown view is opened (null: both).
export function withRevealed(
    folds: Folds,
    models: Pick<ReportModel, "anchor" | "entries">[],
    cards: Pick<QuestionCard, "anchor" | "entries">[],
    id: string,
    view: AnswersView | null = null,
): Folds {
    const next: Folds = {
        ...folds,
        models: { ...folds.models },
        questions: { ...folds.questions },
        allAnswers: { ...folds.allAnswers },
    };
    if (view !== "question") {
        for (const model of models) {
            const at = model.entries.findIndex((e) => e.anchor === id);
            if (model.anchor !== id && at < 0) continue;
            next.models[model.anchor] = true;
            if (at >= ANSWERS_SHOWN) next.allAnswers[model.anchor] = true;
        }
    }
    if (view !== "model") {
        cards.forEach((card, i) => {
            const at = card.entries.findIndex((e) => e.anchor === id);
            if (card.anchor !== id && at < 0) return;
            next.questions[card.anchor] = true;
            if (i >= QUESTIONS_SHOWN) next.allQuestions = true;
        });
    }
    return next;
}
