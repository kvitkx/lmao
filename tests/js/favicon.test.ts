import assert from "node:assert/strict";
import test from "node:test";

import * as favicon from "../../frontend/favicon.ts";

const WHITE = "#f6f8f7";
const BLUE = "#3b9ae1";

// The bars of an icon: [x, width, colour].
function bars(states: favicon.BarState[]): [number, number, string][] {
    const svg = favicon.faviconSvg(states);
    return [...svg.matchAll(/<rect x="(\d+)" y="8" width="(\d+)" height="16" fill="(#[0-9a-f]+)"\/>/g)].map(
        (m) => [Number(m[1]), Number(m[2]), m[3]],
    );
}

test("all bars done are four white rectangles, all off is a black square", () => {
    assert.deepEqual(bars(["done", "done", "done", "done"]), [
        [2, 2, WHITE],
        [6, 8, WHITE],
        [16, 6, WHITE],
        [24, 6, WHITE],
    ]);
    assert.deepEqual(bars(["off", "off", "off", "off"]), []);
});

test("every bar has its own colour, nothing is merged", () => {
    assert.deepEqual(bars(["active", "off", "off", "off"]), [[2, 2, BLUE]]);
    assert.deepEqual(bars(["done", "active", "off", "off"]), [
        [2, 2, WHITE],
        [6, 8, BLUE],
    ]);
    assert.deepEqual(bars(["done", "done", "active", "off"]), [
        [2, 2, WHITE],
        [6, 8, WHITE],
        [16, 6, BLUE],
    ]);
    assert.deepEqual(bars(["done", "done", "done", "active"]), [
        [2, 2, WHITE],
        [6, 8, WHITE],
        [16, 6, WHITE],
        [24, 6, BLUE],
    ]);
});

test("a cloud judge grades while the answers are written: two blue bars", () => {
    assert.deepEqual(bars(["done", "active", "active", "off"]), [
        [2, 2, WHITE],
        [6, 8, BLUE],
        [16, 6, BLUE],
    ]);
});

test("the href is a data URL of the same svg", () => {
    const states: favicon.BarState[] = ["done", "active", "off", "off"];
    const href = favicon.faviconHref(states);

    assert.ok(href.startsWith("data:image/svg+xml,"));
    assert.equal(decodeURIComponent(href.slice("data:image/svg+xml,".length)), favicon.faviconSvg(states));
});

const phases = (reference: string, answer: string, grading: string, summary: string) => ({
    reference: { state: reference },
    answer: { state: answer },
    grading: { state: grading },
    summary: { state: summary },
});

test("barStates follows the phases of a running run", () => {
    assert.deepEqual(favicon.barStates(phases("done", "running", "queued", "queued"), "running"), [
        "done",
        "active",
        "off",
        "off",
    ]);
    assert.deepEqual(favicon.barStates(phases("done", "running", "running", "queued"), "running"), [
        "done",
        "active",
        "active",
        "off",
    ]);
});

test("barStates: after an error what was in flight is dark, without a run all is done", () => {
    assert.deepEqual(favicon.barStates(phases("done", "running", "queued", "queued"), "error"), [
        "done",
        "off",
        "off",
        "off",
    ]);
    assert.deepEqual(favicon.barStates(phases("queued", "queued", "queued", "queued"), "idle"), [
        "done",
        "done",
        "done",
        "done",
    ]);
    assert.deepEqual(favicon.barStates(phases("done", "done", "done", "done"), "done"), [
        "done",
        "done",
        "done",
        "done",
    ]);
});
