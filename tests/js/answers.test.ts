import assert from "node:assert/strict";
import test from "node:test";

import * as answers from "../../frontend/answers.ts";

// A cell of the report: `bar` is the score, null for an error.
const cell = (bar: number | null): any => ({
    text: bar === null ? "err" : String(bar),
    warn: bar === null,
    muted: false,
    title: "",
    bar,
    anchor: "answer-x",
});

// The rows of the overview table, in rank order.
const ranked = (names: string[]): any[] =>
    names.map((model, i) => ({
        model,
        short: model.toUpperCase(),
        anchor: `model-${model}`,
        rank: { rank: i + 1, text: `0${i + 1}`, kind: "plain", tag: "" },
    }));

const rows = () =>
    answers.buildScoreRows(
        [
            { model: "b", cells: [cell(50), cell(null), cell(70)] },
            { model: "a", cells: [cell(90), cell(40), cell(70)] },
            { model: "c", cells: [cell(50), cell(60), cell(null)] },
        ],
        ranked(["a", "b", "c", "d"]),
    );

const order = (list: answers.ScoreRow[]) => list.map((r) => r.model);

test("buildScoreRows joins the cells with the rank, in rank order, without models that have no cells", () => {
    const list = rows();

    assert.deepEqual(order(list), ["a", "b", "c"]);
    assert.deepEqual(
        [list[0].short, list[0].anchor, list[0].rank.text],
        ["A", "model-a", "01"],
    );
    assert.equal(list[1].cells.length, 3);
});

test("sortScoreRows by rank, either way", () => {
    assert.deepEqual(order(answers.sortScoreRows(rows(), null, "asc")), ["a", "b", "c"]);
    assert.deepEqual(order(answers.sortScoreRows(rows(), null, "desc")), ["c", "b", "a"]);
});

test("sortScoreRows by a question: a missing score is last, ties keep the rank order", () => {
    // question 1: a 90, b 50, c 50
    assert.deepEqual(order(answers.sortScoreRows(rows(), 0, "desc")), ["a", "b", "c"]);
    assert.deepEqual(order(answers.sortScoreRows(rows(), 0, "asc")), ["b", "c", "a"]);
    // question 2: a 40, b err, c 60
    assert.deepEqual(order(answers.sortScoreRows(rows(), 1, "desc")), ["c", "a", "b"]);
    assert.deepEqual(order(answers.sortScoreRows(rows(), 1, "asc")), ["a", "c", "b"]);
});

test("sortScoreRows does not change its input", () => {
    const list = rows();

    answers.sortScoreRows(list, 0, "asc");

    assert.deepEqual(order(list), ["a", "b", "c"]);
});

test("nextScoreSort: the best on top first, a second click reverses", () => {
    const start: answers.ScoreSort = { key: null, dir: "asc" };

    assert.deepEqual(answers.nextScoreSort(start, 2), { key: 2, dir: "desc" });
    assert.deepEqual(answers.nextScoreSort({ key: 2, dir: "desc" }, 2), { key: 2, dir: "asc" });
    assert.deepEqual(answers.nextScoreSort({ key: 2, dir: "asc" }, null), { key: null, dir: "asc" });
    assert.deepEqual(answers.nextScoreSort(start, null), { key: null, dir: "desc" });
});
