// A minimal browser smoke test of the page: Alpine starts, a fold opens, a run
// can be stopped and resumed, the estimate of a remote judge shows. The API is
// mocked (helpers.ts); the logic itself is tested in tests/js and tests/*.py.

import type { Budget, Connection, Preview } from "../../frontend/lib.ts";
import {
    JUDGE,
    RUN_ID,
    completedStream,
    expect,
    fillForm,
    historyEntry,
    json,
    mockApi,
    runResults,
    sse,
    stoppedStream,
    test,
} from "./helpers";

test("the page boots: Alpine starts and the models are listed", async ({ page }) => {
    await mockApi(page);

    await page.goto("/");

    await expect(page).toHaveTitle("lmao");
    // x-cloak hides the first screen until Alpine has started
    await expect(page.getByText("new evaluation")).toBeVisible();
    await expect(page.getByText("ollama · 3 models")).toBeVisible();
});

test("a model row of the answers tab folds and opens", async ({ page }) => {
    const candidates = ["cand-a:1b", "cand-b:1b"];
    await mockApi(page, {
        history: [historyEntry(RUN_ID, 2)],
        results: { [RUN_ID]: runResults(RUN_ID, candidates) },
    });
    await page.goto("/");

    await page.locator("#archive").getByRole("button", { name: /Smoke run/ }).click();
    await expect(page.getByRole("tab", { name: "overview" })).toBeVisible();
    await page.getByRole("tab", { name: "answers", exact: true }).click();

    const models = page.locator("#sec-answers article");
    const head = (index: number) => models.nth(index).locator("button[aria-expanded]").first();
    const showAnswer = (index: number) =>
        models.nth(index).getByRole("button", { name: "show answer" });

    // the best model starts open, the other one folded
    await expect(head(0)).toHaveAttribute("aria-expanded", "true");
    await expect(head(1)).toHaveAttribute("aria-expanded", "false");
    await expect(showAnswer(1)).toHaveCount(0);

    await head(1).click();
    await expect(head(1)).toHaveAttribute("aria-expanded", "true");
    await showAnswer(1).click();
    await expect(models.nth(1).getByRole("button", { name: "raw", exact: true })).toBeVisible();

    await head(0).click();
    await expect(head(0)).toHaveAttribute("aria-expanded", "false");
    await expect(showAnswer(0)).toHaveCount(0);
});

test("a run is stopped, then resumed to its results", async ({ page }) => {
    const candidate = "cand-a:1b";
    let streams = 0;
    let release!: () => void;
    const cancelled = new Promise<void>((resolve) => (release = resolve));
    let started: unknown;

    const calls = await mockApi(page, {
        history: [historyEntry(RUN_ID, 1)],
        results: { [RUN_ID]: runResults(RUN_ID, [candidate]) },
        routes: {
            "POST /api/evaluate": (route) => {
                started = route.request().postDataJSON();
                return json(route, { task_id: RUN_ID, status: "started" }, 202);
            },
            // The first stream stays open until the server is asked to stop.
            [`GET /api/stream/${RUN_ID}`]: async (route) => {
                streams += 1;
                if (streams === 1) {
                    await cancelled;
                    return sse(route, stoppedStream());
                }
                return sse(route, completedStream(candidate));
            },
            [`POST /api/evaluate/${RUN_ID}/cancel`]: (route) => {
                release();
                return json(route, { task_id: RUN_ID, status: "stopping" }, 202);
            },
            [`POST /api/evaluate/${RUN_ID}/resume`]: (route) =>
                json(route, { task_id: RUN_ID, status: "started" }, 202),
        },
    });
    await page.goto("/");

    await expect(page.getByText("ollama · 3 models")).toBeVisible();
    await fillForm(page, candidate);
    await page.getByRole("button", { name: "run evaluation" }).click();
    expect(started).toEqual({
        judge: JUDGE,
        judge_provider: "ollama",
        candidates: [candidate],
        base_rationale: "",
        test_cases: [{ question: "What is 2+2?" }],
    });

    // stop asks first
    await page.getByRole("button", { name: "stop", exact: true }).click();
    await expect(page.getByText("stop run?")).toBeVisible();
    await page.getByRole("button", { name: "stop", exact: true }).click();
    await expect(page.getByText("run stopped · 1 of 4 steps done")).toBeVisible();

    await page.getByRole("button", { name: "resume", exact: true }).click();
    await expect(page.getByRole("tab", { name: "overview" })).toBeVisible();
    expect(streams).toBe(2);
    expect(calls).toContain(`POST /api/evaluate/${RUN_ID}/resume`);
});

test("a remote judge shows the budget and the request preview", async ({ page }) => {
    const candidate = "cand-a:1b";
    const connection: Connection = {
        base_url: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        price_in: 0.4,
        price_out: 1.6,
        key_last4: "1234",
    };
    const budget: Budget = {
        judge_calls: { references: 1, grades: 1, summary: 1, total: 3 },
        tokens: {
            input: { low: 1000, high: 1400 },
            output: { low: 300, high: 900 },
            total: { low: 1300, high: 2300 },
        },
        sent_chars: { low: 4000, high: 5600 },
        leaves_machine: true,
        cost: { low: 0.001, high: 0.003 },
    };
    const preview: Preview = {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ***" },
        body: { model: "gpt-4.1-mini", seed: 42 },
        curl: "curl -X POST https://api.openai.com/v1/chat/completions",
        leaves_machine: true,
    };
    let sent: unknown;

    await mockApi(page, {
        connection,
        routes: {
            "POST /api/budget": (route) => {
                sent = route.request().postDataJSON();
                return json(route, budget);
            },
            "POST /api/preview": (route) => json(route, preview),
        },
    });
    await page.goto("/");

    await page.getByRole("tab", { name: "openai api" }).click();
    await fillForm(page, candidate);

    await expect(page.getByText("1 refs · 1 grades · 1 summary")).toBeVisible();
    await expect(page.getByText("gpt-4.1-mini list price")).toBeVisible();
    await expect(
        page.locator("pre").filter({ hasText: "Authorization: Bearer ***" }),
    ).toBeVisible();
    expect(sent).toEqual({
        judge: "gpt-4.1-mini",
        judge_provider: "openai",
        candidates: [candidate],
        base_rationale: "",
        test_cases: [{ question: "What is 2+2?" }],
    });
});
