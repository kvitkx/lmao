// The scores matrix of the answers tab: one row per model, one column per
// question, sortable. The mean, median, pass rate and speed of a model live in
// the models table of the overview. Pure: no DOM, no Alpine.

import type { ReportCell } from "./lib.ts";
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
