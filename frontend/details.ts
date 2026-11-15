// The rest of the overview tab: the small charts of "04 details", the answers
// by category, the hardest questions and how the run was made. Pure: no DOM,
// no Alpine.

import type { ApiResults, Entry, ModelStats, Question } from "../types/results.js";
import {
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    domId,
    median,
    niceStep,
    numeric,
    questionLabel,
    round1,
    totalSteps,
} from "./lib.ts";
import type { Rank } from "./overview.ts";

const GB = 1e9;

// Mirrors of the constants in core/scoring.py.
const PASS_MIN_SCORE = 70;
const PASS_THRESHOLD_PCT = 70;

export interface Who {
    model: string;
    short: string;
    rank: Rank;
}

interface Item extends Who {
    stats: ModelStats;
}

// The models in rank order: every panel lists them the same way.
function itemsOf(
    models: ModelStats[],
    display: (model: string) => string,
    ranks: Map<string, Rank>,
): Item[] {
    return models
        .map((stats) => ({
            model: stats.model,
            short: display(stats.model),
            rank: ranks.get(stats.model) as Rank,
            stats,
        }))
        .sort((a, b) => a.rank.rank - b.rank.rank);
}

const who = (item: Item): Who => ({ model: item.model, short: item.short, rank: item.rank });

// --- bars: score per GB, tokens per correct answer ----------------------------

export interface Bar extends Who {
    width: number; // % of the track
    text: string;
    best: boolean;
}

export interface BarChart {
    bars: Bar[];
    medianLeft: number | null; // where the dashed median line stands, % of the track
    medianText: string;
}

interface BarSpec {
    pick: (stats: ModelStats) => number | null;
    lowerIsBetter: boolean;
    format: (value: number) => string;
    axisCut: boolean; // a lone outlier is cut so that it does not flatten the others
}

function buildBars(items: Item[], spec: BarSpec): BarChart {
    const values = items.map((item) => numeric(spec.pick(item.stats)));
    const present = values.filter((v): v is number => v !== null);
    const empty = (item: Item): Bar => ({ ...who(item), width: 0, text: "–", best: false });
    if (!present.length) return { bars: items.map(empty), medianLeft: null, medianText: "" };

    const sorted = [...present].sort((a, b) => b - a);
    const cut = spec.axisCut && sorted.length > 1 && sorted[0] > 2 * sorted[1];
    const cap = cut ? sorted[1] * 1.05 : sorted[0];
    const best = spec.lowerIsBetter ? Math.min(...present) : Math.max(...present);
    const mid = median(present) as number;
    const share = (v: number) => (cap > 0 ? (100 * Math.min(v, cap)) / cap : 0);

    const bars = items.map((item, i): Bar => {
        const value = values[i];
        if (value === null) return empty(item);
        const parts = [spec.format(value)];
        if (value === best) parts.push("best");
        if (cut && value > cap) parts.push("axis cut");
        return { ...who(item), width: share(value), text: parts.join(" · "), best: value === best };
    });
    return { bars, medianLeft: share(mid), medianText: spec.format(mid) };
}

// --- memory -------------------------------------------------------------------

export interface MemoryBar extends Who {
    width: number; // % of the longest bar
    gpu: number; // % of the bar that is in VRAM, the rest is CPU RAM
    text: string;
}

function buildMemory(items: Item[]): MemoryBar[] {
    const totals = items.map((item) => numeric(item.stats.memory_bytes));
    const max = Math.max(0, ...totals.map((t) => t ?? 0));

    return items.map((item, i): MemoryBar => {
        const total = totals[i];
        if (total === null || total <= 0 || max <= 0) {
            return { ...who(item), width: 0, gpu: 100, text: "–" };
        }
        const vram = numeric(item.stats.vram_bytes);
        const spills = vram !== null && vram < total;
        const gpu = spills ? (100 * vram) / total : 100;
        return {
            ...who(item),
            width: (100 * total) / max,
            gpu,
            text: `${(total / GB).toFixed(1)} GB${spills ? ` · ${Math.round(gpu)}% GPU` : ""}`,
        };
    });
}

// --- tokens against characters ------------------------------------------------

export interface Tick {
    text: string;
    pos: number; // % along the axis
}

export interface ScatterPoint extends Who {
    left: number;
    bottom: number;
    title: string;
}

// A line of constant chars per token, from the origin to the edge of the plot.
export interface Ray {
    label: string;
    title: string; // the model on it
    x2: number; // % of the width where it ends
    y2: number; // % of the height where it ends
    edge: "right" | "top"; // the edge of the plot it ends on
}

export interface Scatter {
    points: ScatterPoint[];
    xTicks: Tick[];
    yTicks: Tick[];
    rays: Ray[]; // the fewest and the most characters per token
    missing: string[];
}

// Round ticks (1 / 2 / 5 x 10^n) up to a maximum a little above the data.
function axis(max: number): { max: number; ticks: Tick[] } {
    const span = max > 0 ? max * 1.05 : 1;
    const step = niceStep(span, 4);
    const count = Math.max(1, Math.ceil(span / step));
    const top = step * count;
    const digits = step < 1 ? 1 : 0;
    return {
        max: top,
        ticks: Array.from({ length: count + 1 }, (_, i) => ({
            text: (i * step).toFixed(digits),
            pos: (100 * i * step) / top,
        })),
    };
}

// Where the ray of k chars per token meets the edge of the plot.
function rayTo(k: number, label: string, title: string, xMax: number, yMax: number): Ray {
    if (k * xMax <= yMax) {
        return { label, title, x2: 100, y2: (100 * k * xMax) / yMax, edge: "right" };
    }
    return { label, title, x2: (100 * yMax) / k / xMax, y2: 100, edge: "top" };
}

function buildScatter(items: Item[]): Scatter {
    const plotted = items.filter(
        (item) => numeric(item.stats.median_tps) !== null && numeric(item.stats.median_cps) !== null,
    );
    const missing = items.filter((item) => !plotted.includes(item)).map((item) => item.short);
    if (!plotted.length) return { points: [], xTicks: [], yTicks: [], rays: [], missing };

    const tps = (item: Item) => item.stats.median_tps as number;
    const cps = (item: Item) => item.stats.median_cps as number;
    const x = axis(Math.max(...plotted.map(tps)));
    const y = axis(Math.max(...plotted.map(cps)));

    // The tokenizers that need the fewest and the most characters per token.
    const ratios = plotted
        .filter((item) => tps(item) > 0)
        .map((item) => ({ item, k: cps(item) / tps(item) }))
        .sort((a, b) => a.k - b.k);
    const rays: Ray[] = [];
    if (ratios.length) {
        const lowest = ratios[0];
        const highest = ratios[ratios.length - 1];
        const text = (r: { k: number }) => r.k.toFixed(1);
        if (text(lowest) === text(highest)) {
            const label = `${text(lowest)} chars/token`;
            rays.push(rayTo(lowest.k, label, lowest.item.short, x.max, y.max));
        } else {
            const low = `min ${text(lowest)} chars/token`;
            const high = `max ${text(highest)} chars/token`;
            rays.push(rayTo(lowest.k, low, lowest.item.short, x.max, y.max));
            rays.push(rayTo(highest.k, high, highest.item.short, x.max, y.max));
        }
    }

    return {
        points: plotted.map((item) => ({
            ...who(item),
            left: (100 * tps(item)) / x.max,
            bottom: (100 * cps(item)) / y.max,
            title: `${item.short}: ${round1(tps(item))} t/s · ${round1(cps(item))} c/s`,
        })),
        xTicks: x.ticks,
        yTicks: y.ticks,
        rays,
        missing,
    };
}

// --- answers by category ------------------------------------------------------

export interface Segment {
    label: string;
    count: number;
    pct: number;
    cls: string;
}

export interface CategoryBar extends Who {
    segments: Segment[];
    passText: string;
}

export interface Categories {
    bars: CategoryBar[];
    legend: { label: string; cls: string }[];
    threshold: number; // the pass-rate threshold of the recommendation, in %
}

// perfect .. garbage, light to dark; what is not a category comes after them.
const SHADES = ["bg-fg", "bg-fg/65", "bg-fg/40", "bg-fg/20", "bg-fg/8"];
const BASE_LABELS = CATEGORY_ORDER.map((id) => CATEGORY_LABELS[id]);
const ALL_LABELS = [...BASE_LABELS, "uncategorised", "truncated", "generation error"];

function segmentClass(label: string): string {
    const index = BASE_LABELS.indexOf(label);
    if (index >= 0) return SHADES[index];
    if (label === "truncated") return "border border-fg-muted";
    if (label === "generation error") return "bg-warn";
    return "bg-line";
}

// What an answer counts as, the way core/scoring.py counts it: a generation
// error is a 0, a judge error and an answer to a question without a reference
// are left out (null), a truncated answer cannot pass.
function bucketOf(question: Question, entry: Entry): string | null {
    if (entry.status === "generation_error") return "generation error";
    if (entry.status === "judge_error" || question.no_reference) return null;
    if (entry.status === "truncated") return "truncated";
    return (entry.category && CATEGORY_LABELS[entry.category]) || "uncategorised";
}

// The bar and the pass number come from the same answers, so they agree.
function buildCategories(items: Item[], questions: Question[]): Categories {
    const used = new Set<string>();
    const bars = items.map((item): CategoryBar => {
        const counts = new Map<string, number>();
        let n = 0;
        let passed = 0;
        for (const question of questions) {
            for (const entry of question.results || []) {
                if (entry.model_name !== item.model) continue;
                const label = bucketOf(question, entry);
                if (label === null) continue;
                n += 1;
                counts.set(label, (counts.get(label) ?? 0) + 1);
                if (label === CATEGORY_LABELS.perfect || label === CATEGORY_LABELS.acceptable) {
                    passed += 1;
                }
            }
        }
        const segments = ALL_LABELS.filter((label) => counts.has(label)).map((label) => {
            used.add(label);
            const count = counts.get(label) as number;
            return { label, count, pct: (100 * count) / n, cls: segmentClass(label) };
        });
        return {
            ...who(item),
            segments,
            passText: n ? `${Math.round((100 * passed) / n)}% pass` : "–",
        };
    });
    return {
        bars,
        legend: ALL_LABELS.filter((label) => BASE_LABELS.includes(label) || used.has(label)).map(
            (label) => ({ label, cls: segmentClass(label) }),
        ),
        threshold: PASS_THRESHOLD_PCT,
    };
}

// --- all the panels -----------------------------------------------------------

export interface Details {
    scoreGb: BarChart;
    tokPass: BarChart;
    memory: MemoryBar[];
    scatter: Scatter;
    categories: Categories;
}

export function buildDetails(
    models: ModelStats[],
    display: (model: string) => string,
    ranks: Map<string, Rank>,
    questions: Question[],
): Details {
    const items = itemsOf(models, display, ranks);
    return {
        scoreGb: buildBars(items, {
            pick: (s) => s.score_per_gb,
            lowerIsBetter: false,
            format: (v) => v.toFixed(1),
            axisCut: false,
        }),
        tokPass: buildBars(items, {
            pick: (s) => s.tokens_per_pass,
            lowerIsBetter: true,
            format: (v) => String(Math.round(v)),
            axisCut: true,
        }),
        memory: buildMemory(items),
        scatter: buildScatter(items),
        categories: buildCategories(items, questions),
    };
}

// --- hardest questions --------------------------------------------------------

export interface HardRow {
    id: string;
    anchor: string; // the question's card in the answers tab
    label: string;
    mean: number;
    min: number;
    max: number;
    passed: string; // '2/10'
    best: Who | null;
}

// The score of an answer as core/scoring.py counts it: a generation error is 0,
// a judge error and a question without a reference are left out, a truncated
// answer cannot pass.
function scoreOf(question: Question, entry: Entry): number | null {
    if (entry.status === "generation_error") return 0;
    if (entry.status === "judge_error" || question.no_reference) return null;
    if (typeof entry.score !== "number") return null;
    return entry.status === "truncated" ? Math.min(entry.score, PASS_MIN_SCORE - 1) : entry.score;
}

// The questions with the lowest mean score across models (rounded).
export function buildHardest(
    questions: Question[],
    display: (model: string) => string,
    ranks: Map<string, Rank>,
    limit = 5,
): HardRow[] {
    const rankOf = (model: string) => ranks.get(model)?.rank ?? Infinity;
    const rows: { row: HardRow; mean: number; order: number }[] = [];

    questions.forEach((question, order) => {
        const scored = (question.results || [])
            .map((entry) => ({ entry, score: scoreOf(question, entry) }))
            .filter((s): s is { entry: Entry; score: number } => s.score !== null);
        if (!scored.length) return;

        const scores = scored.map((s) => s.score);
        const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
        const top = [...scored].sort(
            (a, b) => b.score - a.score || rankOf(a.entry.model_name) - rankOf(b.entry.model_name),
        )[0];
        const topRank = ranks.get(top.entry.model_name);

        rows.push({
            mean,
            order,
            row: {
                id: question.id,
                anchor: domId("question", question.id),
                label: questionLabel(question),
                mean: Math.round(mean),
                min: Math.min(...scores),
                max: Math.max(...scores),
                passed: `${scores.filter((s) => s >= PASS_MIN_SCORE).length}/${scores.length}`,
                best: topRank
                    ? { model: top.entry.model_name, short: display(top.entry.model_name), rank: topRank }
                    : null,
            },
        });
    });

    return rows
        .sort((a, b) => a.mean - b.mean || a.order - b.order)
        .slice(0, limit)
        .map((r) => r.row);
}

// --- how the run was made -----------------------------------------------------

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 16);

function duration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const JUDGE_WHERE: Record<string, string> = {
    ollama: "local",
    ollama_cloud: "ollama cloud",
    openai: "openai api",
};

function candidateParams(params: Record<string, number | boolean>): string {
    const parts: string[] = [];
    if (!("temperature" in params) && !("seed" in params)) {
        parts.push("temperature and seed are model defaults");
    }
    for (const key of ["temperature", "seed", "num_ctx", "num_predict"]) {
        if (key in params) parts.push(`${key} ${params[key]}`);
    }
    if (params.think === false) parts.push("thinking off");
    return parts.join(" · ");
}

function judgeParams(params: Record<string, number | boolean>): string {
    return ["temperature", "seed", "num_ctx", "num_predict"]
        .filter((key) => key in params)
        .map((key) => `${key} ${params[key]}`)
        .join(" · ");
}

// Up to two lines: the facts of the run, and the generation parameters. A run
// saved before the `run` block existed has only what the results themselves say.
export function buildRunLines(data: ApiResults): string[] {
    const info = data.run;
    const candidates = data.summary?.models?.length ?? 0;
    const questions = data.questions_results?.length ?? 0;
    const parts: string[] = [];

    if (info?.started_at) parts.push(`started ${stamp(info.started_at)}`);
    if (data.finished_at) {
        const sameDay = info?.started_at?.slice(0, 10) === data.finished_at.slice(0, 10);
        parts.push(`finished ${sameDay ? data.finished_at.slice(11, 16) : stamp(data.finished_at)}`);
    }
    if (info?.started_at && data.finished_at) {
        const took = (Date.parse(data.finished_at) - Date.parse(info.started_at)) / 1000;
        if (Number.isFinite(took) && took >= 0) parts.push(`took ${duration(took)}`);
    }
    if (info?.ollama_version) parts.push(`ollama ${info.ollama_version}`);
    if (info?.lmao_version) parts.push(`lmao v${info.lmao_version}`);
    if (data.judge_model) {
        const where = JUDGE_WHERE[data.judge_provider] ?? (data.mode === "cloud" ? "cloud" : "local");
        parts.push(`judge ${data.judge_model} (${where})`);
    }
    parts.push(plural(candidates, "candidate"));
    parts.push(plural(questions, "question"));
    parts.push(plural(totalSteps(questions, candidates), "step"));

    const lines = [parts.join(" · ")];
    if (info) {
        lines.push(
            `candidates: ${candidateParams(info.candidate_params)} | judge: ${judgeParams(info.judge_params)}`,
        );
    }
    return lines;
}
