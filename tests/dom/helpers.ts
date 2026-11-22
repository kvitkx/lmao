// Shared pieces of the browser smoke tests: the mocked API, the run fixtures and
// the check that a page never logs an error.

import { expect as baseExpect, test as base } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import type { HistoryRun } from "../../frontend/lib.ts";
import type {
    ApiResults,
    Entry,
    ModelMetrics,
    ModelStats,
    Question,
} from "../../types/results.js";

export const RUN_ID = "run_smoke_20260101_120000";
export const JUDGE = "judge:1b";
export const MODELS = [JUDGE, "cand-a:1b", "cand-b:1b"];

// Every test fails when the page logs an error: a broken Alpine expression, a
// script that does not load, an API call that nobody mocked (it answers 404).
export const test = base.extend<{ errors: string[] }>({
    errors: [
        async ({ page }, use) => {
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(`console: ${message.text()}`);
            });
            await use(errors);
            baseExpect(errors, "the page logged errors").toEqual([]);
        },
        { auto: true },
    ],
});

export const expect = baseExpect;

// --- mocked API -------------------------------------------------------------

export type Handler = (route: Route, url: URL) => Promise<void> | void;

export interface ApiOptions {
    models?: string[];
    history?: HistoryRun[];
    connection?: unknown;
    results?: Record<string, ApiResults>;
    // Anything else, keyed "METHOD /path": POST routes and the event stream.
    routes?: Record<string, Handler>;
}

export function json(route: Route, body: unknown, status = 200): Promise<void> {
    return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
    });
}

// The whole body at once: the client handles the events in order and closes the
// stream on the final one, before the end of the response is seen.
export function sse(route: Route, events: object[]): Promise<void> {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "no-cache" },
        contentType: "text/event-stream",
        body,
    });
}

// Returns the calls made so far, "METHOD /path", in order.
export async function mockApi(page: Page, options: ApiOptions = {}): Promise<string[]> {
    const calls: string[] = [];
    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const key = `${request.method()} ${url.pathname}`;
        calls.push(key);

        const custom = options.routes?.[key];
        if (custom) return custom(route, url);
        if (key === "GET /api/models") {
            return json(route, { models: options.models ?? MODELS });
        }
        if (key === "GET /api/history") return json(route, options.history ?? []);
        if (key === "GET /api/connection") {
            return json(route, { connection: options.connection ?? null });
        }
        const id = /^GET \/api\/results\/([^/]+)$/.exec(key)?.[1];
        const saved = id ? options.results?.[id] : undefined;
        if (saved) return json(route, saved);
        return json(route, { error: `unmocked: ${key}` }, 404);
    });
    return calls;
}

// --- the setup form ---------------------------------------------------------

// The checkbox is sr-only: a real click can miss a 1px box, so click it in the page.
export async function fillForm(
    page: Page,
    candidate: string,
    question = "What is 2+2?",
): Promise<void> {
    await page
        .getByRole("checkbox", { name: candidate })
        .evaluate((input) => (input as HTMLInputElement).click());
    await page.getByLabel("question", { exact: true }).fill(question);
}

// --- fixtures ---------------------------------------------------------------

function modelStats(model: string, mean: number): ModelStats {
    return {
        model,
        n: 1,
        mean,
        median: mean,
        pass_rate: 1,
        fails: 0,
        critical_fails: 0,
        errors: 0,
        judge_errors: 0,
        n_no_reference: 0,
        median_tps: 50,
        median_cps: 250,
        median_time_sec: 1,
        avg_chars: 120,
        tokens_per_pass: 40,
        score_per_gb: 41.8,
        size_bytes: 2e9,
        memory_bytes: 3e9,
        vram_bytes: 3e9,
    };
}

function answerEntry(model: string, score: number): Entry {
    return {
        model_name: model,
        answer: "4",
        status: "ok",
        category: "perfect",
        score,
        comment: "fine",
        truncated: false,
        done_reason: "stop",
        error: null,
        tps: 50,
        cps: 250,
        time_sec: 1,
        tokens: 40,
        chars: 120,
    };
}

function modelMetrics(): ModelMetrics {
    return {
        total_time_sec: 1,
        load_time_sec: 0.2,
        eval_time_sec: 0.5,
        tokens_generated: 40,
        tokens_per_second: 80,
    };
}

// A finished run of one question; the first candidate scores best.
export function runResults(taskId: string, candidates: string[]): ApiResults {
    const total = 1 * (1 + 2 * candidates.length) + 1;
    const question: Question = {
        id: "q1",
        tag: "smoke",
        question: "What is 2+2?",
        specific_rationale: "",
        reference: { text: "Four.", source: "generated" },
        no_reference: false,
        results: candidates.map((model, i) => answerEntry(model, 95 - 20 * i)),
    };
    return {
        schema_version: 4,
        task_id: taskId,
        judge_model: JUDGE,
        judge_provider: "ollama",
        mode: "local",
        judge_is_candidate: false,
        status: "completed",
        progress: { done: total, total },
        finished_steps: [],
        candidates,
        base_rationale: "",
        thresholds: { pass_min_score: 70, critical_below: 40, pass_rate: 0.7, min_questions: 5 },
        finished_at: "2026-01-01T12:00:30",
        run: {
            started_at: "2026-01-01T12:00:00",
            lmao_version: "3.0.1",
            ollama_version: "0.0.0-test",
            candidate_params: { think: false, num_predict: 1000 },
            judge_params: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1000 },
        },
        questions_results: [question],
        summary: {
            models: candidates.map((model, i) => modelStats(model, 95 - 20 * i)),
            recommendation: {
                model: candidates[0],
                rule: "fastest_above_threshold",
                confidence: "low",
            },
            text: "## Verdict\n\nThe first model wins.",
        },
        metrics: Object.fromEntries(candidates.map((model) => [model, modelMetrics()])),
    };
}

export function historyEntry(taskId: string, models: number): HistoryRun {
    const total = 1 * (1 + 2 * models) + 1;
    return {
        task_id: taskId,
        tag_name: "Smoke run",
        timestamp: "2026-01-01 12:00",
        models_tested: models,
        questions_count: 1,
        judge_model: JUDGE,
        status: "completed",
        progress: { done: total, total },
    };
}

// --- event streams of a run: one question, one candidate (4 steps) ------------

const TOTAL = 4;

function step(
    type: string,
    phase: string,
    model: string,
    done: number,
    extra: object = {},
    question: string | null = "q1",
): object {
    return {
        type,
        phase,
        model,
        question,
        progress: { done, total: TOTAL },
        timestamp: new Date().toISOString(),
        ...extra,
    };
}

// The run stops after its first reference.
export function stoppedStream(): object[] {
    return [
        { type: "info", message: "Task queued for execution." },
        step("reference_start", "reference", JUDGE, 0),
        step("reference_done", "reference", JUDGE, 1, { success: true, source: "generated" }),
        { type: "cancelled", message: "Run stopped.", progress: { done: 1, total: TOTAL } },
    ];
}

// A resumed run: the finished reference is replayed, the rest runs to the end.
export function completedStream(candidate: string): object[] {
    return [
        { type: "info", message: "Run resumed." },
        step("reference_done", "reference", JUDGE, 1, { success: true, source: "generated" }),
        step("answer_start", "answer", candidate, 1),
        step("answer_done", "answer", candidate, 2, { success: true, error: null }),
        step("grading_start", "grading", candidate, 2),
        step("grading_done", "grading", candidate, 3, { success: true, error: null }),
        step("summary_start", "summary", JUDGE, 3, {}, null),
        step("summary_done", "summary", JUDGE, 4, { success: true }, null),
        { type: "completed", message: "All tasks completed successfully." },
    ];
}
