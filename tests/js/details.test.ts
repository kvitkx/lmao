import assert from "node:assert/strict";
import test from "node:test";

import * as details from "../../frontend/details.ts";
import * as overview from "../../frontend/overview.ts";

const stats = (model: string, fields: Record<string, unknown> = {}): any => ({
    model,
    n: 5,
    mean: 50,
    median: 50,
    pass_rate: 0.5,
    fails: 0,
    critical_fails: 0,
    errors: 0,
    judge_errors: 0,
    n_no_reference: 0,
    median_tps: 10,
    median_cps: 50,
    median_time_sec: 5,
    avg_chars: 1000,
    tokens_per_pass: 500,
    score_per_gb: 10,
    size_bytes: 2e9,
    memory_bytes: 3e9,
    vram_bytes: 3e9,
    ...fields,
});

const same = (name: string) => name;

// Three models; the means fix the ranks a, b, c.
function three(fields: Record<string, Record<string, unknown>> = {}): any[] {
    return [
        stats("a", { mean: 90, ...fields.a }),
        stats("b", { mean: 60, ...fields.b }),
        stats("c", { mean: 50, ...fields.c }),
    ];
}

function build(models: any[], questions: any[] = []) {
    return details.buildDetails(models, same, overview.rankModels(models, null), questions);
}

// An answer to a question, as saved in the results.
const answer = (model: string, score: number | null, fields: Record<string, unknown> = {}): any => ({
    model_name: model,
    status: "ok",
    category: "perfect",
    score,
    ...fields,
});

const question = (id: string, results: any[], fields: Record<string, unknown> = {}): any => ({
    id,
    tag: "",
    question: id,
    no_reference: false,
    results,
    ...fields,
});

test("score per GB: bars in rank order, the best marked, the median line", () => {
    const { scoreGb } = build(
        three({ a: { score_per_gb: 10 }, b: { score_per_gb: 30 }, c: { score_per_gb: 20 } }),
    );

    assert.deepEqual(
        scoreGb.bars.map((b) => [b.model, b.text, Math.round(b.width)]),
        [
            ["a", "10.0", 33],
            ["b", "30.0 · best", 100],
            ["c", "20.0", 67],
        ],
    );
    assert.equal(scoreGb.medianText, "20.0");
    assert.equal(Math.round(scoreGb.medianLeft as number), 67);
});

test("tokens per correct answer: lower is better, a lone outlier is cut", () => {
    const { tokPass } = build(
        three({ a: { tokens_per_pass: 100 }, b: { tokens_per_pass: 5000 }, c: { tokens_per_pass: 120 } }),
    );

    assert.deepEqual(
        tokPass.bars.map((b) => [b.model, b.text, Math.round(b.width)]),
        [
            ["a", "100 · best", 79],
            ["b", "5000 · axis cut", 100],
            ["c", "120", 95],
        ],
    );
});

test("tokens per correct answer: no cut when the values are close", () => {
    const { tokPass } = build(
        three({ a: { tokens_per_pass: 100 }, b: { tokens_per_pass: 150 }, c: { tokens_per_pass: 120 } }),
    );

    assert.equal(tokPass.bars[1].width, 100);
    assert.ok(!tokPass.bars[1].text.includes("axis cut"));
});

test("a missing value is a dash with no bar", () => {
    const { scoreGb } = build(three({ b: { score_per_gb: null } }));

    assert.deepEqual(
        [scoreGb.bars[1].text, scoreGb.bars[1].width, scoreGb.bars[1].best],
        ["–", 0, false],
    );
});

test("memory: the share in VRAM and the GPU note when a model spills over", () => {
    const { memory } = build([
        stats("a", { mean: 90, memory_bytes: 8e9, vram_bytes: 5e9 }),
        stats("b", { mean: 60, memory_bytes: 4e9, vram_bytes: 4e9 }),
        stats("c", { mean: 50, memory_bytes: null, vram_bytes: null }),
    ]);

    assert.deepEqual(
        memory.map((m) => [m.model, m.text, m.width, m.gpu]),
        [
            ["a", "8.0 GB · 63% GPU", 100, 62.5],
            ["b", "4.0 GB", 50, 100],
            ["c", "–", 0, 100],
        ],
    );
});

test("tokens vs characters: round axes, a ray for the fewest and for the most characters per token", () => {
    const { scatter } = build([
        stats("a", { mean: 90, median_tps: 10, median_cps: 40 }),
        stats("b", { mean: 60, median_tps: 20, median_cps: 100 }),
        stats("c", { mean: 50, median_tps: null, median_cps: 30 }),
    ]);

    assert.deepEqual(scatter.xTicks.map((t) => t.text), ["0", "10", "20", "30"]);
    assert.deepEqual(scatter.yTicks.map((t) => t.text), ["0", "50", "100", "150"]);
    assert.deepEqual(
        scatter.points.map((p) => [p.model, Math.round(p.left), Math.round(p.bottom)]),
        [
            ["a", 33, 27],
            ["b", 67, 67],
        ],
    );
    assert.deepEqual(
        scatter.rays.map((r) => [r.label, r.x2, Math.round(r.y2), r.edge]),
        [
            ["min 4.0 chars/token", 100, 80, "right"],
            ["max 5.0 chars/token", 100, 100, "right"],
        ],
    );
    assert.deepEqual(scatter.missing, ["c"]);
});

test("tokens vs characters: a steep ray ends on the top edge", () => {
    const { scatter } = build([
        stats("a", { mean: 90, median_tps: 1, median_cps: 100 }),
        stats("b", { mean: 60, median_tps: 100, median_cps: 50 }),
    ]);

    const [lowest, highest] = scatter.rays;

    assert.deepEqual(
        [lowest.label, lowest.edge, lowest.x2, lowest.y2, lowest.title],
        ["min 0.5 chars/token", "right", 100, 50, "b"],
    );
    assert.deepEqual(
        [highest.label, highest.edge, highest.x2, highest.y2, highest.title],
        ["max 100.0 chars/token", "top", 1, 100, "a"],
    );
});

test("tokens vs characters: one ray when the models need the same chars per token", () => {
    const { scatter } = build([
        stats("a", { mean: 90, median_tps: 10, median_cps: 40 }),
        stats("b", { mean: 60, median_tps: 20, median_cps: 80 }),
    ]);

    assert.deepEqual(scatter.rays.map((r) => r.label), ["4.0 chars/token"]);
});

test("answers by category: counted like the scores, so the bar and the pass number agree", () => {
    const answers = [
        answer("a", 95),
        answer("a", 95),
        answer("a", 80, { category: "acceptable" }),
        answer("a", 5, { category: "garbage" }),
        answer("a", null, { status: "generation_error", category: null }),
        answer("a", 95, { status: "truncated" }),
        answer("a", null, { status: "judge_error", category: null }),
    ];
    const questions = [
        question("q1", answers),
        // no reference: left out of the scores, so left out of the bar
        question("q2", [answer("a", 40, { category: "instruction_violation" })], {
            no_reference: true,
        }),
    ];

    const { categories } = build([stats("a", { mean: 90 })], questions);
    const [bar] = categories.bars;

    assert.deepEqual(
        bar.segments.map((s) => [s.label, s.count, s.cls]),
        [
            ["perfect solution", 2, "bg-fg"],
            ["generally acceptable", 1, "bg-fg/65"],
            ["garbage", 1, "bg-fg/8"],
            ["truncated", 1, "border border-fg-muted"],
            ["generation error", 1, "bg-warn"],
        ],
    );
    // 6 counted answers, 3 of them pass
    assert.equal(bar.passText, "50% pass");
    assert.equal(Math.round(bar.segments[0].pct), 33);
    assert.equal(categories.threshold, 70);
    assert.deepEqual(
        categories.legend.map((l) => l.label),
        [
            "perfect solution",
            "generally acceptable",
            "violation of instructions",
            "broken logic",
            "garbage",
            "truncated",
            "generation error",
        ],
    );
    assert.deepEqual(categories.legend[0], { label: "perfect solution", cls: "bg-fg" });
});

test("answers by category: a model without counted answers has an empty bar", () => {
    const { categories } = build([stats("a", { mean: 90 })], [
        question("q1", [answer("a", null, { status: "judge_error", category: null })]),
    ]);

    assert.deepEqual(categories.bars[0].segments, []);
    assert.equal(categories.bars[0].passText, "–");
});

test("hardest questions: lowest mean first, errors count as 0, the best model named", () => {
    const models = [stats("a", { mean: 90 }), stats("b", { mean: 60 })];
    const ranks = overview.rankModels(models, null);
    const questions = [
        question("q1", [answer("a", 90), answer("b", 80)]),
        question("q2", [answer("a", 20), answer("b", 40)]),
        question("q3", [answer("a", null, { status: "generation_error" }), answer("b", 60)]),
        question("q4", [answer("a", 10), answer("b", 10)], { no_reference: true }),
        question("q5", [answer("a", null, { status: "judge_error" })]),
    ];

    const rows = details.buildHardest(questions, same, ranks);

    assert.deepEqual(
        rows.map((r) => [r.id, r.mean, r.min, r.max, r.passed, r.best?.model]),
        [
            ["q2", 30, 20, 40, "0/2", "b"],
            ["q3", 30, 0, 60, "0/2", "b"],
            ["q1", 85, 80, 90, "2/2", "a"],
        ],
    );
    assert.equal(rows[0].best?.rank.text, "02");
    assert.ok(rows[0].anchor.startsWith("question-"));
});

test("hardest questions: a truncated answer cannot pass, and the list is cut", () => {
    const models = [stats("a", { mean: 90 })];
    const ranks = overview.rankModels(models, null);
    const many = Array.from({ length: 8 }, (_, i) => question(`q${i + 1}`, [answer("a", 50 + i)]));

    assert.deepEqual(
        details.buildHardest(
            [question("q1", [answer("a", 95, { status: "truncated" })])],
            same,
            ranks,
        )[0].passed,
        "0/1",
    );
    assert.equal(details.buildHardest(many, same, ranks).length, 5);
    assert.equal(details.buildHardest(many, same, ranks, 2).length, 2);
});

function runData(extra: Record<string, unknown> = {}): any {
    return {
        judge_model: "j",
        judge_provider: "ollama",
        mode: "local",
        finished_at: "2026-10-31T20:09:00",
        summary: { models: [stats("a"), stats("b")] },
        questions_results: [{}, {}, {}],
        run: {
            started_at: "2026-10-31T17:42:00",
            lmao_version: "2.4.0",
            ollama_version: "0.21.0",
            candidate_params: { think: false, num_predict: 1000 },
            judge_params: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1000 },
        },
        ...extra,
    };
}

test("buildRunLines: the facts of the run and its generation parameters", () => {
    assert.deepEqual(details.buildRunLines(runData()), [
        "started 2026-10-31 17:42 · finished 20:09 · took 2 h 27 min · ollama 0.21.0 · lmao v2.4.0 · judge j (local) · 2 candidates · 3 questions · 16 steps",
        "candidates: temperature and seed are model defaults · num_predict 1000 · thinking off | judge: temperature 0 · seed 42 · num_ctx 8192 · num_predict 1000",
    ]);
});

test("buildRunLines: a run without the run block has one shorter line", () => {
    const lines = details.buildRunLines(runData({ run: undefined }));

    assert.deepEqual(lines, [
        "finished 2026-10-31 20:09 · judge j (local) · 2 candidates · 3 questions · 16 steps",
    ]);
});

test("buildRunLines: judge places, singular nouns and short durations", () => {
    const data = runData({
        judge_provider: "openai",
        finished_at: "2026-10-31T17:42:45",
        summary: { models: [stats("a")] },
        questions_results: [{}],
    });

    const [line] = details.buildRunLines(data);

    assert.ok(line.includes("took 45 s"));
    assert.ok(line.includes("judge j (openai api)"));
    assert.ok(line.endsWith("1 candidate · 1 question · 4 steps"));
});
