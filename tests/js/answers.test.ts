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

// --- folds ------------------------------------------------------------------

const answerEntries = (...ids: string[]): any[] => ids.map((anchor) => ({ anchor }));
const manyEntries = (n: number): any[] => answerEntries(...Array.from({ length: n }, (_, i) => `a${i}`));

test("visible and hiddenCount follow the limit and `show all`", () => {
    assert.deepEqual(answers.visible([1, 2, 3, 4, 5], 3, false), [1, 2, 3]);
    assert.deepEqual(answers.visible([1, 2, 3, 4, 5], 3, true), [1, 2, 3, 4, 5]);
    assert.equal(answers.hiddenCount(5, 3, false), 2);
    assert.equal(answers.hiddenCount(5, 3, true), 0);
    assert.equal(answers.hiddenCount(2, 3, false), 0);
});

test("initialFolds opens the best model and the first questions", () => {
    const folds = answers.initialFolds(
        [{ anchor: "m-a" }, { anchor: "m-b" }],
        [{ anchor: "q1" }, { anchor: "q2" }, { anchor: "q3" }],
    );

    assert.deepEqual(folds.models, { "m-a": true });
    assert.deepEqual(folds.questions, { q1: true, q2: true });
    assert.equal(folds.allQuestions, false);
    assert.deepEqual(answers.initialFolds([], []).models, {});
});

test("withRevealed opens the model of an answer and shows all answers when it is hidden", () => {
    const models: any[] = [
        { anchor: "m-a", entries: manyEntries(6) },
        { anchor: "m-b", entries: answerEntries("b0") },
    ];
    const folds = answers.initialFolds(models, []);

    const near = answers.withRevealed(folds, models, [], "a1");
    const far = answers.withRevealed(folds, models, [], "a5");
    const other = answers.withRevealed(folds, models, [], "b0");

    assert.equal(near.allAnswers["m-a"], undefined);
    assert.equal(far.allAnswers["m-a"], true);
    assert.deepEqual(other.models, { "m-a": true, "m-b": true });
    assert.deepEqual(folds.allAnswers, {}); // the input is not changed
});

test("withRevealed opens a question card and shows all cards when it is hidden", () => {
    const cards: any[] = Array.from({ length: 9 }, (_, i) => ({
        anchor: `q${i}`,
        entries: answerEntries(`e${i}`),
    }));
    const folds = answers.initialFolds([], cards);

    const early = answers.withRevealed(folds, [], cards, "q4");
    const late = answers.withRevealed(folds, [], cards, "e8");
    const none = answers.withRevealed(folds, [], cards, "nothing");

    assert.equal(early.questions.q4, true);
    assert.equal(early.allQuestions, false);
    assert.equal(late.questions.q8, true);
    assert.equal(late.allQuestions, true);
    assert.deepEqual(none, folds);
});
