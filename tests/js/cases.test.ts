import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/cases.ts";

const FORM_STATE = {
    baseRationale: " Be strict. ",
    cases: [
        { id: 1, tag: " python ", question: " What is 2+2? ", rationale: "Must say 4.", reference: "Four.", open: false },
        { id: 2, tag: "", question: "Q2", rationale: "", reference: "", open: true },
        { id: 3, tag: "x", question: "   ", rationale: "", reference: "", open: true },
    ],
};

function rejects(text: string, message: string) {
    assert.throws(
        () => lib.parseCasesFile(text),
        (e: unknown) => e instanceof lib.CasesFileError && e.message === message
    );
}

function fileOf(testCases: unknown, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ version: 1, test_cases: testCases, ...extra });
}

test("payloadCase trims, maps rationale and leaves out empty optional fields", () => {
    assert.deepEqual(lib.payloadCase(FORM_STATE.cases[0]), {
        tag: "python",
        question: "What is 2+2?",
        specific_rationale: "Must say 4.",
        reference: "Four.",
    });
    assert.deepEqual(lib.payloadCase(FORM_STATE.cases[1]), { question: "Q2" });
});

test("isBlankCase is true only when nothing is typed", () => {
    assert.equal(lib.isBlankCase({ tag: "", question: " ", rationale: "", reference: "" }), true);
    assert.equal(lib.isBlankCase({ tag: "", question: "", rationale: "", reference: "r" }), false);
});

test("buildCasesFile writes the payload shape and skips cases without a question", () => {
    const text = lib.buildCasesFile(FORM_STATE);

    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text), {
        version: 1,
        base_rationale: "Be strict.",
        test_cases: [
            {
                tag: "python",
                question: "What is 2+2?",
                specific_rationale: "Must say 4.",
                reference: "Four.",
            },
            { question: "Q2" },
        ],
    });
});

test("a built file imports back into the same payload cases", () => {
    const parsed = lib.parseCasesFile(lib.buildCasesFile(FORM_STATE));

    assert.equal(parsed.baseRationale, "Be strict.");
    assert.deepEqual(
        parsed.cases.map((raw) => lib.payloadCase(lib.caseFields(raw))),
        FORM_STATE.cases.slice(0, 2).map(lib.payloadCase),
    );
});

test("imported cases take the shape the backend accepts", () => {
    const allowed = new Set(["tag", "question", "specific_rationale", "reference"]);
    const text = fileOf([{ question: "Q", tag: "t", unknown: 1, id: 7, open: true }], { extra: 1 });

    const { cases } = lib.parseCasesFile(text);
    const [payload] = cases.map((raw) => lib.payloadCase(lib.caseFields(raw)));

    assert.deepEqual(payload, { tag: "t", question: "Q" });
    assert.ok(Object.keys(payload).every((key) => allowed.has(key)));
    assert.equal(typeof payload.question, "string");
    assert.ok(payload.question.trim());
});

test("parseCasesFile fills missing optional fields and treats null as missing", () => {
    const { baseRationale, cases } = lib.parseCasesFile(fileOf([{ question: "Q", reference: null }]));

    assert.equal(baseRationale, "");
    assert.deepEqual(cases, [{ question: "Q", tag: "", specific_rationale: "", reference: "" }]);
});

test("parseCasesFile tolerates a BOM and accepts exactly the maximum number of cases", () => {
    const many = Array.from({ length: lib.CASES_MAX_COUNT }, (_, i) => ({ question: `Q${i}` }));

    assert.equal(lib.parseCasesFile(`\uFEFF${fileOf([{ question: "Q" }])}`).cases.length, 1);
    assert.equal(lib.parseCasesFile(fileOf(many)).cases.length, lib.CASES_MAX_COUNT);
});

test("parseCasesFile rejects files that are not valid", () => {
    rejects("{not json", "the file is not valid JSON.");
    rejects("[]", "the file must contain a JSON object.");
    rejects("null", "the file must contain a JSON object.");
    rejects(JSON.stringify({ test_cases: [{ question: "Q" }] }), "unsupported file version: expected 1.");
    rejects(JSON.stringify({ version: 2, test_cases: [{ question: "Q" }] }), "unsupported file version: expected 1.");
    rejects(fileOf([{ question: "Q" }], { base_rationale: 5 }), '"base_rationale" must be a string.');
    rejects(fileOf([]), "the file has no test cases.");
    rejects(JSON.stringify({ version: 1, test_cases: "Q" }), "the file has no test cases.");
});

test("parseCasesFile names the case that is wrong", () => {
    rejects(fileOf([{ question: "a" }, { question: "b" }, { question: "  " }]), "case 03: the question is empty.");
    rejects(fileOf([{ tag: "x" }]), 'case 01: "question" must be a string.');
    rejects(fileOf([{ question: "a" }, "text"]), "case 02: must be an object.");
    rejects(fileOf([{ question: "a" }, { question: "b", tag: 5 }]), 'case 02: "tag" must be a string.');
    rejects(fileOf([{ question: "a", reference: [] }]), 'case 01: "reference" must be a string.');
});

test("parseCasesFile limits the number of cases and the size in bytes", () => {
    const many = Array.from({ length: lib.CASES_MAX_COUNT + 1 }, () => ({ question: "Q" }));

    rejects(fileOf(many), "too many test cases (max 200).");
    rejects("x".repeat(lib.CASES_MAX_BYTES + 1), lib.CASES_TOO_LARGE);
    // fewer characters than the limit, but more bytes
    rejects("я".repeat(lib.CASES_MAX_BYTES / 2 + 1), lib.CASES_TOO_LARGE);
});
