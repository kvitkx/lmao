import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/remote.ts";

test("isCloudModel and judgeChoices split the models by where they run", () => {
    const models = ["llama3:8b", "gpt-oss:120b-cloud", "qwen3:cloud", "cloudy:7b", "hf.co/o/m-GGUF:Q4"];

    assert.equal(lib.isCloudModel("gpt-oss:120b-cloud"), true);
    assert.equal(lib.isCloudModel("qwen3:cloud"), true);
    assert.equal(lib.isCloudModel("cloudy:7b"), false);
    assert.deepEqual(lib.judgeChoices(models, "ollama"), ["llama3:8b", "cloudy:7b", "hf.co/o/m-GGUF:Q4"]);
    assert.deepEqual(lib.judgeChoices(models, "ollama_cloud"), ["gpt-oss:120b-cloud", "qwen3:cloud"]);
    assert.deepEqual(lib.judgeChoices(models, "openai"), []);
});

test("hostOf and isTls", () => {
    assert.equal(lib.hostOf("https://api.openai.com/v1"), "api.openai.com");
    assert.equal(lib.hostOf("http://localhost:1234/v1"), "localhost:1234");
    assert.equal(lib.hostOf("not a url"), "");
    assert.equal(lib.hostOf(null), "");
    assert.equal(lib.isTls("https://api.openai.com/v1"), true);
    assert.equal(lib.isTls("http://localhost:1234/v1"), false);
});

test("fmtCount, fmtRange and fmtMoney", () => {
    assert.deepEqual(
        [950, 1000, 1234, 18432, 1_300_000].map(lib.fmtCount),
        ["950", "1k", "1.2k", "18k", "1.3M"],
    );
    assert.equal(lib.fmtRange({ low: 12000, high: 31000 }, lib.fmtCount), "12k–31k");
    assert.equal(lib.fmtRange({ low: 18000, high: 18400 }, lib.fmtCount), "~18k");
    assert.deepEqual([0.0042, 0.12, 12.3456].map(lib.fmtMoney), ["0.0042", "0.120", "12.35"]);
});

const BUDGET: lib.Budget = {
    judge_calls: { references: 2, grades: 4, summary: 1, total: 7 },
    tokens: {
        input: { low: 12000, high: 12400 },
        output: { low: 600, high: 2000 },
        total: { low: 12600, high: 14400 },
    },
    sent_chars: { low: 48000, high: 50000 },
    leaves_machine: true,
    cost: { low: 0.0042, high: 0.12 },
};

test("budgetFigures: calls, tokens, cost and what is sent out", () => {
    assert.deepEqual(
        lib.budgetFigures(BUDGET, "gpt-4.1-mini").map((f) => [f.label, f.value, f.unit, f.caption]),
        [
            ["judge calls", "7", "", "2 refs · 4 grades · 1 summary"],
            ["tokens", "~14k", "", "in ~12k · out ~1.3k"],
            ["cost", "$0.062", "", "gpt-4.1-mini list price"],
            ["sent out", "4 answers", "", "graded blind, no names"],
        ],
    );
});

test("budgetFigures: no cost says why", () => {
    const unpriced = { ...BUDGET, cost: null };

    assert.equal(lib.budgetFigures(unpriced, "m")[2].caption, "set the prices in the connection");
    assert.deepEqual(
        [lib.budgetFigures(unpriced, null)[2].value, lib.budgetFigures(unpriced, null)[2].caption],
        ["–", "not priced"],
    );
});

test("routeOf: nothing for a local judge, the host and the transport for a remote one", () => {
    assert.equal(lib.routeOf("ollama", 3, null), null);
    assert.deepEqual(lib.routeOf("openai", 3, "https://api.openai.com/v1"), {
        from: "candidates · 3 · local ollama",
        via: "lmao · blind grading",
        to: "judge · api.openai.com",
        secure: true,
        note: "internet · tls",
    });
    assert.deepEqual(lib.routeOf("openai", 1, "http://localhost:1234/v1")?.note, "network · no tls");
    assert.equal(lib.routeOf("ollama_cloud", 2, null)?.to, "judge · ollama cloud");
});

test("connectionBody trims, leaves out an empty key and reads prices with a comma", () => {
    const form: lib.ConnectionForm = {
        base_url: " https://api.example.com/v1 ",
        api_key: " sk-1 ",
        model: " m ",
        price_in: "0,4",
        price_out: "1.6",
    };

    assert.deepEqual(lib.connectionBody(form), {
        base_url: "https://api.example.com/v1",
        api_key: "sk-1",
        model: "m",
        price_in: 0.4,
        price_out: 1.6,
    });
    const noKey = lib.connectionBody({ ...form, api_key: "  ", price_in: "", price_out: "" });
    assert.ok(!("api_key" in noKey));
    assert.deepEqual([noKey.price_in, noKey.price_out], [null, null]);
});

test("connectionBody rejects a form the server would reject", () => {
    const form: lib.ConnectionForm = {
        base_url: "https://api.example.com/v1",
        api_key: "",
        model: "",
        price_in: "",
        price_out: "",
    };
    const fails = (changes: Partial<lib.ConnectionForm>, message: string) =>
        assert.throws(
            () => lib.connectionBody({ ...form, ...changes }),
            (e: unknown) => e instanceof lib.ConnectionFormError && e.message === message,
        );

    fails({ base_url: "  " }, "enter the base url.");
    fails({ price_in: "x", price_out: "1" }, "price in must be a number, 0 or more.");
    fails({ price_in: "1", price_out: "-2" }, "price out must be a number, 0 or more.");
    fails({ price_in: "1" }, "set both prices or neither.");
});

test("formOf fills the form from the saved connection and never from a key", () => {
    const connection: lib.Connection = {
        base_url: "https://api.example.com/v1",
        model: "m",
        price_in: 0.4,
        price_out: 1.6,
        key_last4: "1234",
    };

    assert.deepEqual(lib.formOf(connection, "gpt"), {
        base_url: "https://api.example.com/v1",
        api_key: "",
        model: "gpt",
        price_in: "0.4",
        price_out: "1.6",
    });
    assert.deepEqual(lib.formOf(null, ""), {
        base_url: "",
        api_key: "",
        model: "",
        price_in: "",
        price_out: "",
    });
    assert.equal(lib.maskedKey("1234"), "••••1234");
    assert.equal(lib.maskedKey(""), "••••");
});

test("preflightMeta joins the detail and the time, judgeLatency reads the model list", () => {
    const check = (key: string, detail: string, ms: number | null): lib.PreflightCheck => ({
        key,
        label: key,
        state: "done",
        detail,
        ms,
    });

    assert.equal(lib.preflightMeta(check("usage", "20 in · 5 out", null)), "20 in · 5 out");
    assert.equal(lib.preflightMeta(check("models", "1 listed", 142)), "1 listed · 142 ms");
    assert.equal(lib.judgeLatency({ ok: true, checks: [check("models", "1 listed", 142)] }), 142);
    assert.equal(lib.judgeLatency({ ok: true, checks: [check("models", "x", null)] }), null);
    assert.equal(lib.judgeLatency(null), null);
});

test("previewText lays out the request like a request", () => {
    const preview: lib.Preview = {
        method: "POST",
        url: "https://x/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ***" },
        body: { model: "m" },
        curl: "",
        leaves_machine: true,
    };

    assert.equal(
        lib.previewText(preview),
        'POST https://x/v1/chat/completions\nContent-Type: application/json\nAuthorization: Bearer ***\n\n{\n  "model": "m"\n}',
    );
});

test("budgetFigures keeps the exact range in the tooltip", () => {
    const [, tokens, cost, sent] = lib.budgetFigures(BUDGET, "m");

    assert.equal(tokens.title, "13k–14k tokens");
    assert.equal(cost.title, "$0.0042–$0.120");
    assert.equal(sent.title, "48k–50k characters");
});

test("endpointOf drops the scheme and a trailing slash", () => {
    assert.equal(lib.endpointOf("https://api.openai.com/v1/"), "api.openai.com/v1");
    assert.equal(lib.endpointOf("http://localhost:1234"), "localhost:1234");
});

const CONNECTION: lib.Connection = {
    base_url: "https://api.openai.com/v1/",
    model: "gpt-4.1-mini",
    price_in: null,
    price_out: null,
    key_last4: "a1b2",
};

const check = (
    key: string,
    state: lib.PreflightCheck["state"],
    detail: string,
    ms: number | null = null,
): lib.PreflightCheck => ({ key, label: key, state, detail, ms });

test("specRows: the output is known after a test, the seed comes from the preview", () => {
    const untested = lib.specRows(CONNECTION, null, undefined);
    const schema = lib.specRows(
        CONNECTION,
        { ok: true, checks: [check("structured", "done", "schema accepted")] },
        42,
    );
    const plain = lib.specRows(
        CONNECTION,
        { ok: true, checks: [check("structured", "done", "plain JSON object: the server rejected the schema")] },
        undefined,
    );

    assert.deepEqual(untested.map((r) => [r.label, r.value]), [
        ["source", "openai-compatible"],
        ["endpoint", "api.openai.com/v1"],
        ["model", "gpt-4.1-mini"],
        ["auth", "Bearer ••••a1b2"],
        ["output", "–"],
        ["egress", "remote · answers sent"],
    ]);
    assert.equal(schema[4].value, "json_schema · seed 42");
    assert.equal(plain[4].value, "json object");
});

test("connectionStatus: testing, not tested, reachable and failed", () => {
    const ok = (detail: string): lib.PreflightReport => ({
        ok: true,
        checks: [check("models", "done", detail, 142)],
    });

    assert.deepEqual(lib.connectionStatus(null, true), { dot: true, tone: "text-fg", text: "testing…" });
    assert.deepEqual(lib.connectionStatus(null, false), {
        dot: false,
        tone: "text-fg-muted",
        text: "not tested yet",
    });
    assert.equal(lib.connectionStatus(ok("12 listed"), false).text, "reachable · 142 ms · 12 models");
    assert.equal(lib.connectionStatus(ok("1 listed"), false).text, "reachable · 142 ms · 1 model");
    assert.deepEqual(
        lib.connectionStatus(
            { ok: false, checks: [check("models", "error", "no models (HTTP 404)")] },
            false,
        ),
        { dot: false, tone: "text-warn", text: "models · no models (HTTP 404)" },
    );
});
