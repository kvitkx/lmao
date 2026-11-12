import assert from "node:assert/strict";
import test from "node:test";

import * as overview from "../../frontend/overview.ts";

// A full summary entry of one model; the fields a test cares about are overridden.
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

test("rankModels numbers by mean score, ties keep the order, no score is last", () => {
    const ranks = overview.rankModels(
        [
            stats("a", { mean: 60 }),
            stats("b", { mean: 80 }),
            stats("c", { mean: 60 }),
            stats("d", { mean: null }),
        ],
        null,
    );

    assert.deepEqual(
        [...ranks].map(([model, r]) => [model, r.rank, r.text]),
        [
            ["b", 1, "01"],
            ["a", 2, "02"],
            ["c", 3, "03"],
            ["d", 4, "04"],
        ],
    );
});

test("rankModels marks the recommended model, the best score and the fastest", () => {
    const models = [
        stats("a", { mean: 90, median_cps: 10 }),
        stats("b", { mean: 70, median_cps: 200 }),
        stats("c", { mean: 60, median_cps: 50 }),
        stats("d", { mean: 50, median_cps: 20 }),
    ];

    const ranks = overview.rankModels(models, "c");

    assert.deepEqual(
        ["a", "b", "c", "d"].map((m) => [ranks.get(m)!.kind, ranks.get(m)!.tag]),
        [
            ["best", "best score"],
            ["best", "fastest"],
            ["recommended", "recommended"],
            ["plain", ""],
        ],
    );
});

test("rankModels: the recommended model wins over the best score", () => {
    const ranks = overview.rankModels([stats("a", { mean: 90 }), stats("b", { mean: 10 })], "a");

    assert.equal(ranks.get("a")!.kind, "recommended");
    assert.equal(ranks.get("a")!.tag, "recommended");
});

test("buildTable formats cells, scales bars to the column maximum and marks the best", () => {
    const models = [
        stats("a", { mean: 80, pass_rate: 0.8, median_time_sec: 10, memory_bytes: 8e9, vram_bytes: 5e9 }),
        stats("b", { mean: 40, pass_rate: 0.4, median_time_sec: 5, memory_bytes: 2e9, vram_bytes: 2e9 }),
    ];

    const [a, b] = overview.buildTable(models, same, overview.rankModels(models, null));

    assert.equal(a.cells.pass.text, "80%");
    assert.equal(a.cells.mean.bar, 100);
    assert.equal(b.cells.mean.bar, 50);
    assert.equal(a.cells.mean.best, true);
    assert.equal(b.cells.mean.best, false);
    // lower is better for time
    assert.equal(b.cells.time.best, true);
    assert.equal(a.cells.time.best, false);
    // GB in VRAM + GB in RAM, and the share in VRAM
    assert.equal(a.cells.memory.text, "5.0+3.0");
    assert.equal(a.cells.memory.fill, 62.5);
    assert.equal(b.cells.memory.text, "2.0");
    assert.equal(b.cells.memory.fill, 100);
    // length has no best end
    assert.equal(a.cells.length.best, false);
});

test("buildTable shows a dash and no bar for a missing value", () => {
    const models = [stats("a", { score_per_gb: null, memory_bytes: null, vram_bytes: null })];

    const [a] = overview.buildTable(models, same, overview.rankModels(models, null));

    assert.equal(a.cells.scoreGb.text, "–");
    assert.equal(a.cells.scoreGb.bar, null);
    assert.equal(a.cells.scoreGb.best, false);
    assert.equal(a.cells.memory.text, "–");
});

test("sortRows sorts by a column, a missing value last, ties by rank", () => {
    const models = [
        stats("a", { mean: 80, median_cps: null }),
        stats("b", { mean: 70, median_cps: 10 }),
        stats("c", { mean: 60, median_cps: 30 }),
    ];
    const rows = overview.buildTable(models, same, overview.rankModels(models, null));
    const order = (key: overview.SortKey, dir: overview.SortDirection) =>
        overview.sortRows(rows, key, dir).map((r) => r.model);

    assert.deepEqual(order("cps", "desc"), ["c", "b", "a"]);
    assert.deepEqual(order("cps", "asc"), ["b", "c", "a"]);
    assert.deepEqual(order("mean", "desc"), ["a", "b", "c"]);
    assert.deepEqual(order("mean", "asc"), ["c", "b", "a"]);
});

test("defaultDirection puts the best values on top", () => {
    assert.equal(overview.defaultDirection("mean"), "desc");
    assert.equal(overview.defaultDirection("time"), "asc");
    assert.equal(overview.defaultDirection("tokPass"), "asc");
});

test("buildOverview builds the table and the chart of one run", () => {
    const data: any = {
        summary: {
            models: [
                stats("a", { mean: 90, median_cps: 10 }),
                stats("b", { mean: 60, median_cps: 100 }),
            ],
            recommendation: { model: "a", rule: "highest_median", confidence: "high" },
            text: "",
        },
    };

    const built = overview.buildOverview(data);

    assert.deepEqual(
        built.models.map((r) => [r.model, r.rank.kind]),
        [
            ["a", "recommended"],
            ["b", "best"],
        ],
    );
    assert.deepEqual(
        built.chart.points.map((p) => [p.model, p.rank.text, p.rank.tag]),
        [
            ["a", "01", "recommended"],
            ["b", "02", "fastest"],
        ],
    );
    assert.ok(built.models[0].anchor.startsWith("model-"));
    assert.ok(Object.isFrozen(built));
});
