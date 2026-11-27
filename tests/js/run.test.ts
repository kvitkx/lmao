import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/run.ts";

test("stepKey has the same shape as the SSE fields", () => {
    assert.equal(lib.stepKey("answer", "m", "q1"), "answer:m:q1");
    assert.equal(lib.stepKey("reference", null, "q1"), "reference::q1");
    assert.equal(lib.stepKey("summary", "j", null), "summary:j:");
});

test("totalSteps matches the backend formula", () => {
    assert.equal(lib.totalSteps(1, 2), 6);
    assert.equal(lib.totalSteps(2, 3), 15);
});

test("buildSteps lists every row up front, once per unique candidate, grading model by model", () => {
    const steps = lib.buildSteps("j", ["a", "a", "b"], 2);

    assert.equal(steps.length, lib.totalSteps(2, 2));
    assert.deepEqual(
        steps.map((s) => s.key),
        [
            "reference:j:q1",
            "reference:j:q2",
            "answer:a:q1",
            "answer:a:q2",
            "answer:b:q1",
            "answer:b:q2",
            "grading:a:q1",
            "grading:a:q2",
            "grading:b:q1",
            "grading:b:q2",
            "summary:j:",
        ],
    );
    assert.ok(steps.every((s) => s.state === "queued"));
    assert.equal(steps[0].label, "reference · q1 · j");
    assert.equal(steps[2].label, "a · q1");
    assert.equal(steps[6].label, "judge · a · q1");
    assert.equal(steps[10].label, "final summary");
});

test("buildSteps shows short names", () => {
    const steps = lib.buildSteps("j", ["hf.co/o/m-GGUF:Q4"], 1);

    assert.equal(steps[1].label, "o/m · q1");
});

test("loadGroup tells which model has to be loaded", () => {
    assert.equal(lib.loadGroup("answer", "m", false), "cand:m");
    assert.equal(lib.loadGroup("answer", "m", true), "cand:m");
    assert.equal(lib.loadGroup("reference", "j", false), "judge-1");
    assert.equal(lib.loadGroup("grading", "j", false), "judge-2");
    assert.equal(lib.loadGroup("summary", "j", false), "judge-2");
    assert.equal(lib.loadGroup("reference", "j", true), null);
    assert.equal(lib.loadGroup("grading", "j", true), null);
});

function setRow(steps: lib.Step[], key: string, fields: Partial<lib.Step>) {
    Object.assign(steps.find((s) => s.key === key)!, fields);
}

const PHASES = [
    { phase: "reference", title: "01 reference answers" },
    { phase: "answer", title: "02 candidate answers" },
    { phase: "grading", title: "03 grading" },
    { phase: "summary", title: "04 summary" },
];

test("phaseStats counts every phase in one pass", () => {
    const steps = lib.buildSteps("j", ["a"], 2);
    setRow(steps, "reference:j:q1", { state: "done", startTs: 1000, endTs: 3000 });
    setRow(steps, "reference:j:q2", { state: "done", startTs: 3000, endTs: 5000 });
    setRow(steps, "answer:a:q1", { state: "error", startTs: 5000, endTs: 6000 });
    setRow(steps, "answer:a:q2", { state: "running", startTs: 6000 });
    setRow(steps, "grading:a:q1", { state: "skipped" });

    const stats = lib.phaseStats(steps, PHASES);

    assert.equal(stats.reference.state, "done");
    assert.equal(stats.reference.side, "2 / 2");
    assert.equal(stats.reference.span, "4.0 s");
    assert.equal(stats.reference.pct, 100);
    assert.equal(stats.reference.title, "01 reference answers");
    assert.equal(stats.answer.state, "running");
    assert.equal(stats.answer.errors, 1);
    assert.equal(stats.answer.side, "1 / 2");
    assert.equal(stats.answer.span, "");
    assert.equal(stats.answer.pct, 50);
    assert.equal(stats.grading.state, "queued");
    assert.equal(stats.grading.finished, 1);
    assert.equal(stats.summary.total, 1);
    assert.equal(stats.summary.side, "");
});

test("phaseStats of an empty run is queued everywhere", () => {
    const stats = lib.phaseStats([], PHASES);

    assert.deepEqual(Object.keys(stats), ["reference", "answer", "grading", "summary"]);
    assert.equal(stats.answer.total, 0);
    assert.equal(stats.answer.state, "queued");
    assert.equal(stats.answer.pct, 0);
    assert.equal(stats.answer.side, "");
});

test("fmtSeconds is empty for broken durations", () => {
    assert.equal(lib.fmtSeconds(1.234), "1.2 s");
    assert.equal(lib.fmtSeconds(0), "0.0 s");
    assert.equal(lib.fmtSeconds(NaN), "");
    assert.equal(lib.fmtSeconds(-1), "");
    assert.equal(lib.fmtSeconds("x"), "");
});

test("fmtClock and fmtSpan", () => {
    assert.equal(lib.fmtClock(151), "02:31");
    assert.equal(lib.fmtClock(-5), "00:00");
    assert.equal(lib.fmtSpan(41.2), "41.2 s");
    assert.equal(lib.fmtSpan(312), "05:12");
    assert.equal(lib.fmtSpan(NaN), "");
});

// A layout with one counter column: columnsThatFit no longer has a default.
const ONE_COUNTER: lib.MatrixLayout = { name: 254, tail: 0, cell: 48, counter: 48, counters: 1 };

test("columnsThatFit fills the width and leaves room for one counter", () => {
    // 254 (model) + 48 per question + 48 for the counter
    assert.equal(lib.columnsThatFit(1094, 30, ONE_COUNTER), 16);
    assert.equal(lib.columnsThatFit(1374, 30, ONE_COUNTER), 22);
    assert.equal(lib.columnsThatFit(2494, 30, ONE_COUNTER), 30);
});

test("columnsThatFit shows everything that fits without a counter", () => {
    assert.equal(lib.columnsThatFit(1094, 17, ONE_COUNTER), 17);
    assert.equal(lib.columnsThatFit(1094, 10, ONE_COUNTER), 10);
    assert.equal(lib.columnsThatFit(1094, 18, ONE_COUNTER), 16);
});

test("columnsThatFit copes with no room and no questions", () => {
    assert.equal(lib.columnsThatFit(200, 30, ONE_COUNTER), 0);
    assert.equal(lib.columnsThatFit(NaN, 30, ONE_COUNTER), 0);
    assert.equal(lib.columnsThatFit(1094, 0, ONE_COUNTER), 0);
    assert.equal(lib.columnsThatFit(310, 30, ONE_COUNTER), 1);
});

test("columnWindow shows everything when it fits", () => {
    assert.deepEqual(lib.columnWindow(10, 10, 4), { start: 0, end: 10, before: 0, after: 0 });
    assert.deepEqual(lib.columnWindow(10, 16, 4), { start: 0, end: 10, before: 0, after: 0 });
    assert.deepEqual(lib.columnWindow(0, 16, 0), { start: 0, end: 0, before: 0, after: 0 });
});

test("columnWindow sticks to the edges and centres on the question in progress", () => {
    assert.deepEqual(lib.columnWindow(30, 16, 0), { start: 0, end: 16, before: 0, after: 14 });
    assert.deepEqual(lib.columnWindow(30, 16, 29), { start: 14, end: 30, before: 14, after: 0 });
    assert.deepEqual(lib.columnWindow(30, 16, 15), { start: 8, end: 24, before: 8, after: 6 });
});

test("columnWindow follows manual paging and clamps it", () => {
    assert.deepEqual(lib.columnWindow(30, 16, 0, 5), { start: 5, end: 21, before: 5, after: 9 });
    assert.deepEqual(lib.columnWindow(30, 16, 0, 99), { start: 14, end: 30, before: 14, after: 0 });
    assert.deepEqual(lib.columnWindow(30, 16, 0, -3), { start: 0, end: 16, before: 0, after: 14 });
    assert.deepEqual(lib.columnWindow(30, 0, 3), { start: 0, end: 0, before: 0, after: 30 });
});

test("columnsThatFit for the running matrix reserves both counters", () => {
    // 270 (model) + 80 (time) fixed, 52 per question, 2 x 44 for the counters
    assert.equal(lib.columnsThatFit(1094, 24, lib.RUNNING_MATRIX), 12);
    assert.equal(lib.columnsThatFit(1094, 10, lib.RUNNING_MATRIX), 10);
    assert.equal(lib.columnsThatFit(2494, 30, lib.RUNNING_MATRIX), 30);
    assert.equal(lib.columnsThatFit(300, 30, lib.RUNNING_MATRIX), 0);
});

test("buildMatrix: a reference row and a row per candidate, a cell per question", () => {
    const rows = lib.buildMatrix(lib.buildSteps("j", ["a", "b"], 3), 3, (m) => m);

    assert.deepEqual(
        rows.map((r) => [r.label, r.reference, r.sub, r.cells.length]),
        [
            ["reference", true, "j", 3],
            ["a", false, "", 3],
            ["b", false, "", 3],
        ],
    );
    assert.ok(rows.every((r) => r.state === "queued" && r.time === "–"));
    assert.ok(rows.every((r) => r.cells.every((c) => c.state === "planned")));
});

test("buildMatrix: a cell follows the answer and the grading of its question", () => {
    const steps = lib.buildSteps("j", ["a", "b"], 3);
    setRow(steps, "answer:a:q1", { state: "running" });
    setRow(steps, "answer:a:q2", { state: "done" });
    setRow(steps, "answer:a:q3", { state: "error" });
    setRow(steps, "grading:a:q3", { state: "skipped" });
    setRow(steps, "answer:b:q1", { state: "done" });
    setRow(steps, "grading:b:q1", { state: "running" });
    setRow(steps, "answer:b:q2", { state: "done" });
    setRow(steps, "grading:b:q2", { state: "done" });
    setRow(steps, "answer:b:q3", { state: "done" });
    setRow(steps, "grading:b:q3", { state: "error" });

    const [, a, b] = lib.buildMatrix(steps, 3, (m) => m);

    assert.deepEqual(
        a.cells.map((c) => c.state),
        ["answering", "ready", "generation_error"],
    );
    assert.deepEqual(
        b.cells.map((c) => c.state),
        ["grading", "graded", "judge_error"],
    );
    assert.equal(a.state, "running");
    assert.equal(b.state, "running");

    setRow(steps, "grading:b:q1", { state: "done" });
    assert.equal(lib.buildMatrix(steps, 3, (m) => m)[2].state, "done");
});

test("buildMatrix: the reference row follows the reference steps", () => {
    const steps = lib.buildSteps("j", ["a"], 3);
    setRow(steps, "reference:j:q1", { state: "done" });
    setRow(steps, "reference:j:q2", { state: "error" });
    setRow(steps, "reference:j:q3", { state: "running" });

    const [reference] = lib.buildMatrix(steps, 3, (m) => m);

    assert.deepEqual(
        reference.cells.map((c) => c.state),
        ["graded", "generation_error", "answering"],
    );
    assert.equal(reference.state, "running");
});

test("buildMatrix: time is the total answering time, the title names the cell", () => {
    const steps = lib.buildSteps("j", ["a"], 2);
    setRow(steps, "answer:a:q1", { state: "done", startTs: 0, endTs: 4100 });
    setRow(steps, "answer:a:q2", { state: "done", startTs: 5000, endTs: 6900 });

    const [, a] = lib.buildMatrix(steps, 2, (m) => m);

    assert.equal(a.time, "00:06");
    assert.equal(a.cells[0].title, "a · q1: answer ready · 4.1 s");
    assert.equal(a.cells[1].title, "a · q2: answer ready · 1.9 s");
});

test("activeQuestion is the first question in progress, or null", () => {
    const steps = lib.buildSteps("j", ["a"], 3);

    assert.equal(lib.activeQuestion(steps), null);
    setRow(steps, "answer:a:q3", { state: "running" });
    setRow(steps, "grading:a:q2", { state: "running" });
    assert.equal(lib.activeQuestion(steps), 1);
});

test("hiddenSummary counts the hidden cells and warns about errors", () => {
    const cell = (state: lib.CellState): lib.MatrixCellInfo => ({ state, title: "" });
    const cells = [
        cell("graded"),
        cell("graded"),
        cell("judge_error"),
        cell("graded"),
        cell("planned"),
    ];

    assert.deepEqual(lib.hiddenSummary(cells, 0, 4), {
        count: 4,
        warn: true,
        title: "q1–q4: 3 graded · 1 judge error (q3)",
    });
    assert.deepEqual(lib.hiddenSummary(cells, 4, 5), {
        count: 1,
        warn: false,
        title: "q5: 1 planned",
    });
    assert.deepEqual(lib.hiddenSummary(cells, 2, 2), { count: 0, warn: false, title: "" });
});

test("nowRows lists the running steps with a verb", () => {
    const steps = lib.buildSteps("j", ["a"], 1);
    setRow(steps, "answer:a:q1", { state: "running" });
    setRow(steps, "grading:a:q1", { state: "running" });

    assert.deepEqual(
        lib.nowRows(steps).map((r) => [r.key, r.verb]),
        [
            ["answer:a:q1", "answering"],
            ["grading:a:q1", "grading"],
        ],
    );
});

test("buildMatrix: a candidate is loaded only while its own answers are in progress", () => {
    const steps = lib.buildSteps("j", ["a", "b"], 2);
    const loaded = () => lib.buildMatrix(steps, 2, (m) => m).map((r) => r.loaded);

    assert.deepEqual(loaded(), [false, false, false]);
    setRow(steps, "answer:a:q1", { state: "running" });
    assert.deepEqual(loaded(), [false, true, false]);
    // between two answers the model is still loaded
    setRow(steps, "answer:a:q1", { state: "done" });
    assert.deepEqual(loaded(), [false, true, false]);
    setRow(steps, "answer:a:q2", { state: "done" });
    setRow(steps, "answer:b:q1", { state: "running" });
    assert.deepEqual(loaded(), [false, false, true]);
});

test("buildMatrix: a local judge is loaded for the references, then for grading and the summary", () => {
    const steps = lib.buildSteps("j", ["a"], 2);
    const judge = () => lib.buildMatrix(steps, 2, (m) => m)[0].loaded;

    setRow(steps, "reference:j:q1", { state: "running" });
    assert.equal(judge(), true);
    setRow(steps, "reference:j:q1", { state: "done" });
    setRow(steps, "reference:j:q2", { state: "done" });
    assert.equal(judge(), false); // the candidates answer now
    setRow(steps, "answer:a:q1", { state: "done" });
    setRow(steps, "answer:a:q2", { state: "error" });
    setRow(steps, "grading:a:q2", { state: "skipped" }); // a failed answer is skipped at once
    assert.equal(judge(), false);
    setRow(steps, "grading:a:q1", { state: "running" });
    assert.equal(judge(), true);
    setRow(steps, "grading:a:q1", { state: "done" }); // the summary is still to come
    assert.equal(judge(), true);
    setRow(steps, "summary:j:", { state: "done" });
    assert.equal(judge(), false);
});

test("buildMatrix: a cloud judge is loaded from its first call to the summary", () => {
    const steps = lib.buildSteps("j", ["a"], 1);
    const judge = () => lib.buildMatrix(steps, 1, (m) => m, true)[0].loaded;

    assert.equal(judge(), false);
    setRow(steps, "reference:j:q1", { state: "running" });
    assert.equal(judge(), true);
    // waiting for an answer to grade: it still works beside the candidates
    setRow(steps, "reference:j:q1", { state: "done" });
    assert.equal(judge(), true);
    setRow(steps, "grading:a:q1", { state: "done" });
    setRow(steps, "summary:j:", { state: "done" });
    assert.equal(judge(), false);
});

test("buildMatrix: a stopped run shows its pending steps as stopped and loads nothing", () => {
    const steps = lib.buildSteps("j", ["a"], 2);
    setRow(steps, "reference:j:q1", { state: "done" });
    setRow(steps, "answer:a:q1", { state: "done" });

    const live = lib.buildMatrix(steps, 2, (m) => m);
    const [reference, a] = lib.buildMatrix(steps, 2, (m) => m, false, true);

    assert.deepEqual(
        reference.cells.map((c) => c.state),
        ["graded", "stopped"],
    );
    assert.deepEqual(
        a.cells.map((c) => c.state),
        ["ready", "stopped"],
    );
    assert.deepEqual([reference.loaded, a.loaded], [false, false]);
    assert.deepEqual([live[0].loaded, live[1].loaded], [true, true]);
    assert.equal(a.cells[1].title, "a · q2: stopped");
});

test("buildMatrix: a row that is all stopped counts as queued", () => {
    const steps = lib.buildSteps("j", ["a"], 2);

    const rows = lib.buildMatrix(steps, 2, (m) => m, false, true);

    assert.ok(rows.every((r) => r.state === "queued"));
    assert.ok(rows.every((r) => r.cells.every((c) => c.state === "stopped")));
});

test("CELL_LEGEND lists every state once, in the order of the design", () => {
    assert.deepEqual(
        lib.CELL_LEGEND.map((s) => [s.state, s.label]),
        [
            ["planned", "planned"],
            ["answering", "answering"],
            ["ready", "answer ready"],
            ["grading", "grading"],
            ["graded", "graded"],
            ["generation_error", "generation error"],
            ["judge_error", "judge error"],
            ["stopped", "stopped"],
        ],
    );
});

test("hiddenSummary counts stopped cells", () => {
    const cell = (state: lib.CellState): lib.MatrixCellInfo => ({ state, title: "" });

    assert.deepEqual(lib.hiddenSummary([cell("graded"), cell("stopped"), cell("stopped")], 0, 3), {
        count: 3,
        warn: false,
        title: "q1–q3: 1 graded · 2 stopped",
    });
});

test("buildSteps rows start without a preview of the answer", () => {
    assert.ok(lib.buildSteps("j", ["a"], 2).every((s) => s.preview === ""));
});
