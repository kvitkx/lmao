import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/report.ts";
import { domId } from "../../frontend/names.ts";

test("clampScore keeps scores in 0..100 and rejects non-numbers", () => {
    assert.equal(lib.clampScore(150), 100);
    assert.equal(lib.clampScore(-5), 0);
    assert.equal(lib.clampScore(50), 50);
    assert.equal(lib.clampScore("x"), null);
    assert.equal(lib.clampScore(NaN), null);
});

test("fmtNum shows a dash for missing values", () => {
    assert.equal(lib.fmtNum(null), "–");
    assert.equal(lib.fmtNum(undefined), "–");
    assert.equal(lib.fmtNum(0), "0");
});

test("median and round1", () => {
    assert.equal(lib.median([3, 1, 2]), 2);
    assert.equal(lib.median([1, 2, 3, 4]), 2.5);
    assert.equal(lib.median([]), null);
    assert.equal(lib.round1(1.26), 1.3);
    assert.equal(lib.round1(1.24), 1.2);
});

test("niceStep gives 1 / 2 / 5 times a power of ten", () => {
    assert.equal(lib.niceStep(100, 4), 50);
    assert.equal(lib.niceStep(8, 4), 2);
    assert.equal(lib.niceStep(1000, 4), 500);
});

test("competitionRanks shares ranks and skips failed answers", () => {
    assert.deepEqual(lib.competitionRanks([90, 90, 70, null]), [1, 1, 3, null]);
});

test("questionLabel adds the tag unless it repeats the id", () => {
    assert.equal(lib.questionLabel({ id: "q1" }), "q1");
    assert.equal(lib.questionLabel({ id: "q1", tag: "Python" }), "q1 · Python");
    assert.equal(lib.questionLabel({ id: "q2", tag: "Q2" }), "q2");
});

test("isFailed covers generation and judge errors", () => {
    assert.equal(lib.isFailed({ status: "generation_error" }), true);
    assert.equal(lib.isFailed({ status: "judge_error" }), true);
    assert.equal(lib.isFailed({ status: "truncated" }), false);
});

test("matrixCell for errors, truncated answers and questions without a reference", () => {
    const question = { no_reference: false };

    assert.equal(lib.matrixCell(question, { status: "generation_error", error: "oom" }).text, "err");
    assert.equal(lib.matrixCell(question, { status: "judge_error" }).text, "?");
    assert.deepEqual(lib.matrixCell(question, { status: "ok", score: 95, truncated: false }), {
        text: "95",
        warn: false,
        muted: false,
        title: "",
        bar: 95,
    });
    assert.equal(lib.matrixCell(question, { status: "truncated", score: 95, truncated: true }).text, "95*");

    const muted = lib.matrixCell({ no_reference: true }, { status: "ok", score: 80, truncated: false });
    assert.equal(muted.muted, true);
    assert.equal(muted.title, "no reference: excluded from the scores");
});

test("buildDistribution always lists the five categories", () => {
    const empty = lib.buildDistribution([]);
    assert.equal(empty.n, 0);
    assert.equal(empty.rows.length, 5);

    const { n, rows } = lib.buildDistribution([
        { status: "ok", category: "perfect" },
        { status: "ok", category: "perfect" },
        { status: "ok", category: "garbage" },
        { status: "ok", category: "unknown" },
        { status: "generation_error" },
        { status: "judge_error" },
    ]);

    assert.equal(n, 6);
    assert.deepEqual(rows[0], {
        label: "perfect solution",
        count: 2,
        warn: false,
        pct: 33,
        text: "2 · 33%",
    });
    assert.deepEqual(
        rows.slice(5).map((r) => [r.label, r.warn]),
        [
            ["uncategorised", false],
            ["generation error", true],
            ["judge error", true],
        ],
    );
});

test("runTime reads the task id, falls back to the timestamp, then to 0", () => {
    assert.equal(lib.runTime({ task_id: "run_a_20260101_120000" }), new Date(2026, 0, 1, 12, 0, 0).getTime());
    assert.ok(lib.runTime({ task_id: "weird", timestamp: "2026-01-03T12:00:00" }) > 0);
    assert.equal(lib.runTime({ task_id: "weird", timestamp: "Unknown" }), 0);
    assert.equal(lib.runTime(null), 0);
});

test("sortHistory is newest first and does not mutate its input", () => {
    const runs = [
        { task_id: "run_a_20260101_000000" },
        { task_id: "run_a_20260102_000000" },
        { task_id: "weird", timestamp: "Unknown" },
    ];

    assert.deepEqual(
        lib.sortHistory(runs).map((r) => r.task_id),
        ["run_a_20260102_000000", "run_a_20260101_000000", "weird"],
    );
    assert.equal(runs[0].task_id, "run_a_20260101_000000");
    assert.deepEqual(lib.sortHistory("not a list"), []);
});

const CHART_MODELS = [
    { model: "a", mean: 90, median_cps: 50 },
    { model: "b", mean: 60, median_cps: 100 },
    { model: "c", mean: null, median_cps: 10 },
];

test("buildChart plots models with a mean and c/s and lists the rest", () => {
    const chart = lib.buildChart(CHART_MODELS, (m) => m, "a");

    assert.deepEqual(
        chart.points.map((p) => [p.model, p.best, p.top]),
        [
            ["a", true, 10],
            ["b", false, 40],
        ],
    );
    assert.deepEqual(chart.missing, ["c"]);
    assert.deepEqual(
        chart.xTicks.map((t) => t.text),
        ["0", "50", "100", "150"],
    );
    assert.deepEqual(
        chart.yTicks.map((t) => t.text),
        ["0", "25", "50", "75", "100"],
    );
    assert.equal(chart.mid!.cpsText, "median 75 c/s");
    assert.equal(chart.mid!.scoreText, "median 75");
    assert.equal(chart.points[0].title, "a: mean score 90 · 50 c/s");
});

test("buildChart draws the Pareto line through models nobody beats on both axes", () => {
    const chart = lib.buildChart(CHART_MODELS, (m) => m, "a");
    const [first, second] = chart.pareto.split(" ");

    assert.ok(first.endsWith(",10"));
    assert.ok(second.endsWith(",40"));
});

test("buildChart without plottable models", () => {
    const chart = lib.buildChart([{ model: "c", mean: null, median_cps: 10 }], (m) => m, null);

    assert.deepEqual(chart.points, []);
    assert.deepEqual(chart.missing, ["c"]);
    assert.equal(chart.mid, null);
    assert.equal(chart.pareto, "");
});

const FIGURE_MODELS = [
    { model: "a", mean: 90, pass_rate: 1, median_cps: 50, median_time_sec: 3 },
    { model: "b", mean: 60, pass_rate: 0.5, median_cps: 100, median_time_sec: 2 },
];

test("rankOf ranks a model among all that have a value", () => {
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "a", "mean", true), { rank: 1, n: 2, best: 90 });
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "b", "mean", true), { rank: 2, n: 2, best: 90 });
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "a", "median_time_sec", false), { rank: 2, n: 2, best: 2 });
    assert.equal(lib.rankOf(FIGURE_MODELS, "a", "missing", true), null);
});

test("verdictFigures gives four figures with their place in the run", () => {
    const figures = lib.verdictFigures(FIGURE_MODELS, "a");

    assert.deepEqual(
        figures.map((f) => [f.label, f.value, f.unit, f.caption]),
        [
            ["mean score", "90", "/ 100", "best of 2"],
            ["pass rate", "100", "%", "best of 2"],
            ["speed", "50", "c/s", "#2 of 2 · best 100"],
            ["median time", "3", "s", "#2 of 2 · best 2 s"],
        ],
    );
    assert.deepEqual(lib.verdictFigures(FIGURE_MODELS, "nope"), []);
    assert.equal(lib.verdictFigures([FIGURE_MODELS[0]], "a")[0].caption, "only model");
});

function runFixture(): any {
    return {
        schema_version: 3,
        judge_model: "j",
        mode: "local",
        judge_is_candidate: false,
        status: "completed",
        progress: { done: 6, total: 6 },
        finished_steps: [
            "reference:j:q1",
            "answer:a:q1",
            "answer:b:q1",
            "grading:a:q1",
            "grading:b:q1",
            "summary:j:",
        ],
        candidates: ["a", "b"],
        base_rationale: "",
        finished_at: "2026-01-01T12:00:30",
        questions_results: [
            {
                id: "q1",
                tag: "logic",
                question: "2+2?",
                no_reference: false,
                reference: { text: "Four.", source: "generated" },
                results: [
                    {
                        model_name: "a",
                        answer: "4",
                        status: "ok",
                        category: "perfect",
                        score: 95,
                        comment: "ok",
                        truncated: false,
                        error: null,
                        tps: 50,
                        time_sec: 1,
                    },
                    {
                        model_name: "b",
                        answer: "",
                        status: "generation_error",
                        category: null,
                        score: null,
                        comment: "",
                        truncated: false,
                        error: "oom",
                        tps: null,
                        time_sec: null,
                    },
                ],
            },
        ],
        summary: {
            models: [
                {
                    model: "a",
                    n: 1,
                    mean: 95,
                    median: 95,
                    pass_rate: 1,
                    fails: 0,
                    critical_fails: 0,
                    errors: 0,
                    judge_errors: 0,
                    median_tps: 50,
                    median_cps: 250,
                    median_time_sec: 1,
                },
                {
                    model: "b",
                    n: 1,
                    mean: 0,
                    median: 0,
                    pass_rate: 0,
                    fails: 0,
                    critical_fails: 1,
                    errors: 1,
                    judge_errors: 0,
                    median_tps: null,
                    median_cps: null,
                    median_time_sec: null,
                },
            ],
            recommendation: { model: "a", rule: "fastest_above_threshold", confidence: "low" },
            text: "## Summary\n\nA wins.",
        },
        metrics: { a: { total_time_sec: 2.5 } },
    };
}

test("buildReport rejects files in an older format", () => {
    assert.throws(() => lib.buildReport({ questions_results: [] }), lib.ReportFormatError);
    assert.throws(() => lib.buildReport(null), lib.ReportFormatError);
});

test("buildReport: verdict and notes", () => {
    const report = lib.buildReport(runFixture());

    assert.equal(report.verdict.model, "a");
    assert.equal(report.verdict.label, "recommended");
    assert.equal(report.verdict.rule, "the fastest model among those with a high pass rate");
    assert.equal(report.verdict.figures.length, 4);
    assert.deepEqual(report.notes, ["low confidence: too few graded questions."]);
    assert.equal(report.summaryBlocks[0].type, "heading");
});

test("buildReport: model rows", () => {
    const [a, b] = lib.buildReport(runFixture()).models;

    assert.equal(a.summaryLine, "mean 95 · median 95 · pass 100% · errors 0");
    assert.equal(
        a.metricsLine,
        "mean 95 · median 95 · pass 100% · fails 0 · critical 0 · errors 0 · judge errors 0 · 250 c/s · 50 t/s · 2.5 s total",
    );
    assert.equal(b.cells[0].text, "err");
    assert.equal(b.cells[0].warn, true);
    assert.equal(b.entries[0].error, true);
    assert.equal(b.entries[0].scoreText, "err");
    assert.equal(b.entries[0].caption, "generation failed");
    assert.equal(b.entries[0].comment, "oom");
});

test("buildReport: answer blocks are parsed lazily and once", () => {
    const report = lib.buildReport(runFixture());
    const [a] = report.models;
    const [card] = report.questionCards;
    const fromModel = a.entries[0];
    const fromQuestion = card.entries.find((e) => e.model === "a")!;

    assert.equal(typeof fromModel.answerBlocks, "function");
    assert.equal(fromModel.answerBlocks()[0].type, "paragraph");
    assert.equal(fromModel.answerBlocks(), fromModel.answerBlocks());
    // both views share the parsed blocks of one answer
    assert.equal(fromModel.answerBlocks(), fromQuestion.answerBlocks());
});

test("buildReport: reference blocks are parsed on demand and once", () => {
    const [ref] = lib.buildReport(runFixture()).references;

    assert.equal(typeof ref.blocks, "function");
    assert.equal(ref.blocks()[0].type, "paragraph");
    assert.equal(ref.blocks(), ref.blocks());
});

test("buildReport returns a frozen report", () => {
    assert.ok(Object.isFrozen(lib.buildReport(runFixture())));
});

test("buildReport: question cards rank answers and put failures last", () => {
    const [card] = lib.buildReport(runFixture()).questionCards;

    assert.equal(card.metricsLine, "2 models · generated reference");
    assert.deepEqual(
        card.entries.map((e) => [e.model, e.rankText]),
        [
            ["a", "rank 01 / 02"],
            ["b", "not ranked"],
        ],
    );
    assert.deepEqual(card.marks, [{ score: 95, many: false, title: "95: a" }]);
    assert.equal(card.spread, "one graded answer · 95");
});

test("buildReport: heads and references", () => {
    const report = lib.buildReport(runFixture());

    assert.deepEqual(report.questionHeads, [
        { id: "q1", title: "logic", anchor: domId("question", "q1") },
    ]);
    assert.equal(report.references[0].title, "q1 · logic · generated");
});

test("buildReport: anchors link the comparison table to the 03 cards", () => {
    const report = lib.buildReport(runFixture());
    const [a, b] = report.models;
    const [card] = report.questionCards;
    const answerA = domId("answer", "a", "q1");

    assert.equal(a.anchor, domId("model", "a"));
    assert.equal(card.anchor, report.questionHeads[0].anchor);
    // a cell, its per-model block and its per-question block share one id
    assert.equal(a.cells[0].anchor, answerA);
    assert.equal(a.entries[0].anchor, answerA);
    assert.equal(card.entries.find((e) => e.model === "a")!.anchor, answerA);
    // a failed cell still points to its eval block
    assert.equal(b.cells[0].anchor, domId("answer", "b", "q1"));

    // a model without a result for the question: nothing to jump to
    const data = runFixture();
    data.questions_results[0].results.pop();
    assert.equal(lib.buildReport(data).models[1].cells[0].anchor, null);
});

test("buildReport: notes for a judge that is a candidate and for missing references", () => {
    const data = runFixture();
    data.judge_is_candidate = true;
    data.questions_results[0].no_reference = true;

    const { notes } = lib.buildReport(data);

    assert.deepEqual(notes, [
        "the judge is also a candidate: its own score may be biased.",
        "1 question(s) have no reference answer: excluded from the scores.",
        "low confidence: too few graded questions.",
    ]);
});

test("buildReport: no recommendation and a cloud judge", () => {
    const data = runFixture();
    data.mode = "cloud";
    data.summary.recommendation = { model: null, rule: "none_graded", confidence: "low" };

    const report = lib.buildReport(data);

    assert.equal(report.verdict.label, "no recommendation");
    assert.equal(report.verdict.short, "");
    assert.deepEqual(report.verdict.figures, []);
    assert.equal(report.verdict.rule, "no answers could be graded");
    assert.deepEqual(report.notes, []);
});

test("buildReport: a run that did not finish says so and recommends only so far", () => {
    const data = runFixture();
    data.status = "stopped";
    data.progress = { done: 31, total: 73 };

    const report = lib.buildReport(data);

    assert.equal(report.verdict.label, "recommended so far");
    assert.deepEqual(report.notes, [
        "the run did not finish: 31 of 73 steps are done. resume continues from here.",
        "low confidence: too few graded questions.",
    ]);
});

test("quantile interpolates between ranks and ignores the input order", () => {
    assert.equal(lib.quantile([1, 2, 3, 4, 5], 0.25), 2);
    assert.equal(lib.quantile([5, 1, 4, 2, 3], 0.5), 3);
    assert.equal(lib.quantile([1, 2, 3, 4], 0.25), 1.75);
    assert.equal(lib.quantile([7], 0.75), 7);
    assert.equal(lib.quantile([1, 2, 3], 2), 3);
    assert.equal(lib.quantile([], 0.5), null);
});
