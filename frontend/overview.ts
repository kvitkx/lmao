// What the overview tab shows besides the verdict (that one is built by
// buildReport in lib.ts): the rank of every model, the sortable models table
// and the speed against quality chart. Pure: no DOM, no Alpine.

import type { ApiResults, ModelStats } from "../types/results.js";
import {
    buildDetails,
    buildHardest,
    buildRunLines,
    type Details,
    type HardRow,
} from "./details.ts";
import {
    buildChart,
    domId,
    numeric,
    pad2,
    shortName,
    shortNames,
    type Chart,
    type ChartPoint,
} from "./lib.ts";

// recommended: filled badge; best: thick border (best score or fastest); plain: thin.
export type BadgeKind = "recommended" | "best" | "plain";

export interface Rank {
    rank: number;
    text: string; // '01': the number stays with the model, whatever the sort order
    kind: BadgeKind;
    tag: string; // the label next to the badge in the chart
}

type RankInput = Pick<ModelStats, "model" | "mean" | "median_cps">;

// Rank by mean score (ties keep the run's order; no score = last), plus who is
// the recommended model, the best score and the fastest (most chars/s).
export function rankModels(
    models: RankInput[],
    recommended: string | null | undefined,
): Map<string, Rank> {
    const order = models
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (b.m.mean ?? -Infinity) - (a.m.mean ?? -Infinity) || a.i - b.i);

    const bestScore = order.length && order[0].m.mean != null ? order[0].m.model : null;
    let fastest: string | null = null;
    let top = -Infinity;
    for (const m of models) {
        if (typeof m.median_cps === "number" && m.median_cps > top) {
            top = m.median_cps;
            fastest = m.model;
        }
    }

    const out = new Map<string, Rank>();
    order.forEach(({ m }, i) => {
        const isRecommended = m.model === recommended;
        const isBest = m.model === bestScore;
        const isFastest = m.model === fastest;
        let tag = "";
        if (isRecommended) tag = "recommended";
        else if (isBest) tag = "best score";
        else if (isFastest) tag = "fastest";
        out.set(m.model, {
            rank: i + 1,
            text: pad2(i),
            kind: isRecommended ? "recommended" : isBest || isFastest ? "best" : "plain",
            tag,
        });
    });
    return out;
}

// --- models table -----------------------------------------------------------

export type SortKey =
    | "mean"
    | "median"
    | "pass"
    | "cps"
    | "time"
    | "length"
    | "scoreGb"
    | "tokPass"
    | "memory";
export type SortDirection = "asc" | "desc";

export interface Column {
    key: SortKey;
    label: string;
    best: "high" | "low" | null; // which end is the best value; null: there is none
}

export const COLUMNS: Column[] = [
    { key: "mean", label: "mean", best: "high" },
    { key: "median", label: "median", best: "high" },
    { key: "pass", label: "pass", best: "high" },
    { key: "cps", label: "c/s", best: "high" },
    { key: "time", label: "time, s", best: "low" },
    { key: "length", label: "length", best: null },
    { key: "scoreGb", label: "score/GB", best: "high" },
    { key: "tokPass", label: "tok/pass", best: "low" },
    { key: "memory", label: "memory GB", best: null },
];

// The first click on a header: best values on top.
export function defaultDirection(key: SortKey): SortDirection {
    return COLUMNS.find((c) => c.key === key)?.best === "low" ? "asc" : "desc";
}

export interface Cell {
    text: string;
    bar: number | null; // % of the column maximum
    fill: number; // memory: % of the bar that is in VRAM, the rest is CPU RAM
    best: boolean;
}

export interface TableRow {
    model: string;
    short: string;
    anchor: string; // the model's block in the answers tab
    rank: Rank;
    values: Record<SortKey, number | null>;
    cells: Record<SortKey, Cell>;
}

const GB = 1e9;

function valuesOf(m: ModelStats): Record<SortKey, number | null> {
    return {
        mean: numeric(m.mean),
        median: numeric(m.median),
        pass: numeric(m.pass_rate),
        cps: numeric(m.median_cps),
        time: numeric(m.median_time_sec),
        length: numeric(m.avg_chars),
        scoreGb: numeric(m.score_per_gb),
        tokPass: numeric(m.tokens_per_pass),
        memory: numeric(m.memory_bytes),
    };
}

// '8.0+3.0': GB in VRAM plus GB in RAM (offload); '5.1': all in VRAM.
function memoryText(m: ModelStats, total: number): string {
    const vram = numeric(m.vram_bytes);
    if (vram === null || vram >= total) return (total / GB).toFixed(1);
    return `${(vram / GB).toFixed(1)}+${((total - vram) / GB).toFixed(1)}`;
}

function textOf(key: SortKey, m: ModelStats, value: number | null): string {
    if (value === null) return "–";
    if (key === "pass") return `${Math.round(value * 100)}%`;
    if (key === "memory") return memoryText(m, value);
    return String(value);
}

// One row per model, in rank order.
export function buildTable(
    models: ModelStats[],
    display: (model: string) => string,
    ranks: Map<string, Rank>,
): TableRow[] {
    const values = models.map(valuesOf);

    const rows = models.map((m, i): TableRow => {
        const own = values[i];
        const cells = {} as Record<SortKey, Cell>;
        for (const column of COLUMNS) {
            const column_values = values
                .map((v) => v[column.key])
                .filter((v): v is number => v !== null);
            const value = own[column.key];
            const max = Math.max(0, ...column_values);
            const best =
                value === null || column.best === null
                    ? false
                    : value === (column.best === "high" ? max : Math.min(...column_values));
            let fill = 100;
            if (column.key === "memory" && value !== null && value > 0) {
                const vram = numeric(m.vram_bytes);
                fill = vram === null ? 100 : Math.min(100, (100 * vram) / value);
            }
            cells[column.key] = {
                text: textOf(column.key, m, value),
                bar: value === null || max <= 0 ? null : (100 * value) / max,
                fill,
                best,
            };
        }
        return {
            model: m.model,
            short: display(m.model),
            anchor: domId("model", m.model),
            rank: ranks.get(m.model) as Rank,
            values: own,
            cells,
        };
    });
    return rows.sort((a, b) => a.rank.rank - b.rank.rank);
}

// Sorted by a column; a missing value is always last, ties keep the rank order.
export function sortRows(rows: TableRow[], key: SortKey, dir: SortDirection): TableRow[] {
    const sign = dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
        const x = a.values[key];
        const y = b.values[key];
        if (x === null && y === null) return a.rank.rank - b.rank.rank;
        if (x === null) return 1;
        if (y === null) return -1;
        return sign * (x - y) || a.rank.rank - b.rank.rank;
    });
}

// --- chart ------------------------------------------------------------------

export type OverviewPoint = ChartPoint & { rank: Rank };
export type OverviewChart = Omit<Chart, "points"> & { points: OverviewPoint[] };

export function buildOverviewChart(
    models: Pick<ModelStats, "model" | "mean" | "median_cps">[],
    display: (model: string) => string,
    recommended: string | null | undefined,
    ranks: Map<string, Rank>,
): OverviewChart {
    const chart = buildChart(models, display, recommended);
    return {
        ...chart,
        points: chart.points.map((p) => ({ ...p, rank: ranks.get(p.model) as Rank })),
    };
}

// --- the tab ----------------------------------------------------------------

export interface Overview {
    models: TableRow[];
    chart: OverviewChart;
    details: Details;
    hardest: HardRow[];
    runLines: string[];
}

export function buildOverview(data: ApiResults): Readonly<Overview> {
    const models = data.summary.models.filter((s) => s && typeof s.model === "string");
    const questions = data.questions_results ?? [];
    const recommended = data.summary.recommendation?.model ?? null;
    const names = shortNames([...models.map((s) => s.model), recommended]);
    const display = (m: string) => names[m] || shortName(m);
    const ranks = rankModels(models, recommended);
    // Frozen like the report: a run never changes after it is built.
    return Object.freeze({
        models: buildTable(models, display, ranks),
        chart: buildOverviewChart(models, display, recommended, ranks),
        details: buildDetails(models, display, ranks, questions),
        hardest: buildHardest(questions, display, ranks),
        runLines: buildRunLines(data),
    });
}
