import assert from "node:assert/strict";
import test from "node:test";

import * as lib from "../../frontend/names.ts";

test("shortName strips hf.co/ and the GGUF quantisation", () => {
    assert.equal(lib.shortName("hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M"), "openbmb/MiniCPM5-2B");
    assert.equal(lib.shortName("llama3:8b"), "llama3:8b");
    assert.equal(lib.shortName(null), "");
});

test("variantOf reads the quantisation or the tag", () => {
    assert.equal(lib.variantOf("x-GGUF:Q4_K_M"), "Q4_K_M");
    assert.equal(lib.variantOf("llama3:8b"), "8b");
    assert.equal(lib.variantOf("llama3"), "latest");
});

test("shortNames keeps unique names and adds the quantisation on a collision", () => {
    assert.deepEqual(
        lib.shortNames(["hf.co/o/m-GGUF:Q4_K_M", "hf.co/o/m-GGUF:Q8_0", "llama3:8b"]),
        {
            "hf.co/o/m-GGUF:Q4_K_M": "o/m · Q4_K_M",
            "hf.co/o/m-GGUF:Q8_0": "o/m · Q8_0",
            "llama3:8b": "llama3:8b",
        },
    );
});

test("shortNames falls back to full names when the quantisation does not help", () => {
    assert.deepEqual(lib.shortNames(["hf.co/o/m-GGUF:Q4_K_M", "o/m-GGUF:Q4_K_M"]), {
        "hf.co/o/m-GGUF:Q4_K_M": "hf.co/o/m-GGUF:Q4_K_M",
        "o/m-GGUF:Q4_K_M": "o/m-GGUF:Q4_K_M",
    });
});

test("shortNames ignores duplicates and non-strings", () => {
    assert.deepEqual(lib.shortNames(["a", "a", null, ""]), { a: "a" });
    assert.deepEqual(lib.shortNames(undefined), {});
});

test("pad2 is one-based", () => {
    assert.equal(lib.pad2(0), "01");
    assert.equal(lib.pad2(11), "12");
});

test("domId gives a stable, valid id and keeps similar names apart", () => {
    const id = lib.domId("answer", "hf.co/o/m-GGUF:Q4_K_M", "q1");

    assert.match(id, /^answer-hf-co-o-m-gguf-q4_k_m-q1-[0-9a-z]+$/);
    assert.equal(lib.domId("answer", "hf.co/o/m-GGUF:Q4_K_M", "q1"), id);
    // same slug, different raw parts
    assert.notEqual(lib.domId("model", "a:b"), lib.domId("model", "a/b"));
    assert.notEqual(lib.domId("answer", "a-b", "c"), lib.domId("answer", "a", "b-c"));
    assert.notEqual(lib.domId("model", "q1"), lib.domId("question", "q1"));
    assert.match(lib.domId("model", null), /^model-[0-9a-z]+$/);
});
