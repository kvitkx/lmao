// What the results screen shows: scores, charts, figures, the archive list and the report. Pure; tested in tests/js/report.test.ts.

import type {
    ApiResults,
    Entry,
    ModelMetrics,
    ModelStats,
    Question,
    Recommendation,
    Reference,
} from "../types/results.js";
import { answerBlocks, type MdBlock, parseMarkdown, shortenNames } from "./markdown.ts";
import { domId, shortName, shortNames } from "./names.ts";

// UI labels for the stable ids stored in the results.
const RULE_LABELS: Record<string, string> = {
    fastest_above_threshold: "the fastest model among those with a high pass rate",
    highest_median: "the highest median score (no model reached the pass-rate threshold)",
    none_graded: "no answers could be graded",
};
export const CATEGORY_LABELS: Record<string, string> = {
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

function evalEntry(question: Question, result: Entry): EvalEntry {
    const generationFailed = result.status === "generation_error";
    const failed = isFailed(result);
    const notes: string[] = [];
    if (result.truncated) notes.push("truncated answer: it cannot count as a pass");
    if (question.no_reference) notes.push(`no reference answer: ${NO_REFERENCE}`);

    return {
        qid: question.id,
        anchor: domId("answer", result.model_name, question.id),
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
        ...evalEntry(question, result),
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

export interface HistoryRun {
    task_id: string;
    tag_name: string;
    timestamp: string;
    models_tested: number;
    questions_count: number;
    judge_model: string;
    status?: string; // completed, stopped or error
    progress?: { done: number; total: number } | null;
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

export const CATEGORY_ORDER: string[] = [
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

export function median(values: number[]): number | null {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Linear interpolation between the two closest ranks (the default of numpy).
// p is a fraction, 0..1.
export function quantile(values: number[], p: number): number | null {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    const at = (n - 1) * Math.min(1, Math.max(0, p));
    const lower = Math.floor(at);
    const upper = Math.ceil(at);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
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
    title?: string; // the exact range behind a rounded value
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

export type ReportCell = MatrixCell & { anchor: string | null };

export interface ReportModel {
    model: string;
    anchor: string;
    short: string;
    cells: ReportCell[];
    entries: EvalEntry[];
    distribution: Distribution;
    summaryLine: string; // the folded row: mean, median, pass, errors
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
    verdict: {
        model: string | null;
        short: string;
        label: string;
        rule: string;
        figures: Figure[];
    };
    notes: string[];
    summaryBlocks: MdBlock[];
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

    const unfinished = data.status !== "completed";
    const notes: string[] = [];
    if (unfinished) {
        notes.push(
            `the run did not finish: ${data.progress.done} of ${data.progress.total} steps are done. resume continues from here.`,
        );
    }
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
        questions.forEach((question) => {
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
            entries.push(evalEntry(question, result));
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
            cells,
            entries,
            distribution: buildDistribution(results),
            summaryLine: [
                `mean ${fmtNum(stats.mean)}`,
                `median ${fmtNum(stats.median)}`,
                `pass ${pass}`,
                `errors ${fmtNum(stats.errors)}`,
            ].join(" · "),
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

    // Frozen on purpose: Alpine does not wrap a frozen object in a reactive
    // proxy, and a report never changes after it is built.
    return Object.freeze({
        verdict: {
            model: rec.model || null,
            short: rec.model ? display(rec.model) : "",
            label: rec.model
                ? unfinished
                    ? "recommended so far"
                    : "recommended"
                : "no recommendation",
            rule: (rec.rule && RULE_LABELS[rec.rule]) || rec.rule || "",
            figures: rec.model ? verdictFigures(summaryModels, rec.model) : [],
        },
        notes,
        summaryBlocks: shortenNames(parseMarkdown(summary.text, { bareFence: true }), names),
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

// A finite number, or null.
export function numeric(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
