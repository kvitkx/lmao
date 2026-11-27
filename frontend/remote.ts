// A remote judge: provider choice, connection form, budget, preview and preflight. Pure; tested in tests/js/remote.test.ts.

import type { Figure } from "./report.ts";

export type JudgeProvider = "ollama" | "ollama_cloud" | "openai";

// Ollama cloud models are named `...-cloud` or `...:cloud`.
export function isCloudModel(name: string): boolean {
    return /[:-]cloud$/i.test(name);
}

// The installed models a judge of this provider can be. An openai judge is
// named by hand: it lives at the API, not in Ollama.
export function judgeChoices(models: string[], provider: JudgeProvider): string[] {
    if (provider === "openai") return [];
    return models.filter((m) => isCloudModel(m) === (provider === "ollama_cloud"));
}

export function hostOf(url: unknown): string {
    try {
        return new URL(String(url)).host;
    } catch {
        return "";
    }
}

export function isTls(url: unknown): boolean {
    return /^https:/i.test(String(url));
}

// 950 -> '950', 1234 -> '1.2k', 18432 -> '18k', 1300000 -> '1.3M'
export function fmtCount(n: number): string {
    if (n < 1000) return String(Math.round(n));
    if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface Range {
    low: number;
    high: number;
}

// '12k–31k', or '~18k' when both ends read the same.
export function fmtRange(range: Range, fmt: (n: number) => string): string {
    const low = fmt(range.low);
    const high = fmt(range.high);
    return low === high ? `~${low}` : `${low}–${high}`;
}

// The currency is the one of the prices the user entered.
export function fmtMoney(n: number): string {
    if (n < 0.01) return n.toFixed(4);
    return n < 1 ? n.toFixed(3) : n.toFixed(2);
}

// Reply of /api/budget.
export interface Budget {
    judge_calls: { references: number; grades: number; summary: number; total: number };
    tokens: { input: Range; output: Range; total: Range };
    sent_chars: Range;
    leaves_machine: boolean;
    cost: Range | null;
}

// Four key figures of the budget block: one short value each, the range is the
// tooltip. `model` is the judge model the prices belong to, or null when the
// provider has no prices (ollama cloud).
export function budgetFigures(budget: Budget, model: string | null): Figure[] {
    const { judge_calls: calls, tokens } = budget;
    const mid = (range: Range) => (range.low + range.high) / 2;
    const span = (range: Range, fmt: (n: number) => string) => `${fmt(range.low)}–${fmt(range.high)}`;

    let cost: Figure;
    if (budget.cost) {
        const dollars = (n: number) => `$${fmtMoney(n)}`;
        cost = {
            label: "cost",
            value: dollars(mid(budget.cost)),
            unit: "",
            caption: `${model} list price`,
            title: span(budget.cost, dollars),
        };
    } else {
        const caption = model === null ? "not priced" : "set the prices in the connection";
        cost = { label: "cost", value: "–", unit: "", caption };
    }
    return [
        {
            label: "judge calls",
            value: String(calls.total),
            unit: "",
            caption: `${calls.references} refs · ${calls.grades} grades · ${calls.summary} summary`,
        },
        {
            label: "tokens",
            value: `~${fmtCount(mid(tokens.total))}`,
            unit: "",
            caption: `in ~${fmtCount(mid(tokens.input))} · out ~${fmtCount(mid(tokens.output))}`,
            title: `${span(tokens.total, fmtCount)} tokens`,
        },
        cost,
        {
            label: "sent out",
            value: `${calls.grades} answers`,
            unit: "",
            caption: "graded blind, no names",
            title: `${span(budget.sent_chars, fmtCount)} characters`,
        },
    ];
}

export interface Route {
    from: string;
    via: string;
    to: string;
    secure: boolean;
    note: string;
}

// Where the data of a run goes. A local judge keeps everything on this machine.
export function routeOf(
    provider: JudgeProvider,
    candidates: number,
    baseUrl: string | null,
): Route | null {
    if (provider === "ollama") return null;
    const openai = provider === "openai";
    const secure = openai ? isTls(baseUrl) : true;
    return {
        from: `candidates · ${candidates} · local ollama`,
        via: "lmao · blind grading",
        to: openai ? `judge · ${hostOf(baseUrl) || "api"}` : "judge · ollama cloud",
        secure,
        note: secure ? "internet · tls" : "network · no tls",
    };
}

// The saved connection as the API returns it: the key is never in it.
export interface Connection {
    base_url: string;
    model: string;
    price_in: number | null;
    price_out: number | null;
    key_last4: string;
}

export interface ConnectionForm {
    base_url: string;
    api_key: string;
    model: string;
    price_in: string;
    price_out: string;
}

export interface ConnectionBody {
    base_url: string;
    api_key?: string;
    model: string;
    price_in: number | null;
    price_out: number | null;
}

// A form the UI cannot send: the message is shown to the user as is.
export class ConnectionFormError extends Error {}

export function formOf(connection: Connection | null, model: string): ConnectionForm {
    const price = (value: number | null | undefined) => (value == null ? "" : String(value));
    return {
        base_url: connection?.base_url ?? "",
        api_key: "",
        model,
        price_in: price(connection?.price_in),
        price_out: price(connection?.price_out),
    };
}

// The request body of PUT /api/connection. An empty key is left out: the server
// keeps the saved one (for the same base url only).
export function connectionBody(form: ConnectionForm): ConnectionBody {
    const price = (text: string, name: string): number | null => {
        const clean = text.trim().replace(",", ".");
        if (!clean) return null;
        const value = Number(clean);
        if (!Number.isFinite(value) || value < 0) {
            throw new ConnectionFormError(`${name} must be a number, 0 or more.`);
        }
        return value;
    };

    const baseUrl = form.base_url.trim();
    if (!baseUrl) throw new ConnectionFormError("enter the base url.");
    const body: ConnectionBody = {
        base_url: baseUrl,
        model: form.model.trim(),
        price_in: price(form.price_in, "price in"),
        price_out: price(form.price_out, "price out"),
    };
    if ((body.price_in === null) !== (body.price_out === null)) {
        throw new ConnectionFormError("set both prices or neither.");
    }
    const key = form.api_key.trim();
    if (key) body.api_key = key;
    return body;
}

export function maskedKey(last4: string): string {
    return last4 ? `••••${last4}` : "••••";
}

// Reply of POST /api/connection/test, see core/preflight.py.
export interface PreflightCheck {
    key: string;
    label: string;
    state: "done" | "error" | "skipped";
    detail: string;
    ms: number | null;
}

export interface PreflightReport {
    ok: boolean;
    checks: PreflightCheck[];
}

export function preflightMeta(check: PreflightCheck): string {
    const parts = [check.detail];
    if (check.ms !== null) parts.push(`${check.ms} ms`);
    return parts.filter(Boolean).join(" · ");
}

// How long the model list took: the latency shown in the topbar.
export function judgeLatency(report: PreflightReport | null): number | null {
    const check = report?.checks.find((c) => c.key === "models" && c.state === "done");
    return check?.ms ?? null;
}

// Reply of /api/preview.
export interface Preview {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    curl: string;
    leaves_machine: boolean;
}

export function previewText(preview: Preview): string {
    const headers = Object.entries(preview.headers).map(([key, value]) => `${key}: ${value}`);
    return [
        `${preview.method} ${preview.url}`,
        ...headers,
        "",
        JSON.stringify(preview.body, null, 2),
    ].join("\n");
}

// --- the saved connection as a spec sheet -----------------------------------

export interface SpecRow {
    label: string;
    value: string;
}

// 'https://api.openai.com/v1/' -> 'api.openai.com/v1'
export function endpointOf(url: unknown): string {
    try {
        const parsed = new URL(String(url));
        return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
        return String(url ?? "");
    }
}

// What is known about the judge call. `output` is known after a test; `seed` is
// the one the request preview sends.
export function specRows(
    connection: Connection,
    report: PreflightReport | null,
    seed: unknown,
): SpecRow[] {
    const structured = report?.checks.find((c) => c.key === "structured");
    let output = "–";
    if (structured?.state === "done") {
        const schema = !/plain JSON/i.test(structured.detail);
        output = [schema ? "json_schema" : "json object", typeof seed === "number" ? `seed ${seed}` : ""]
            .filter(Boolean)
            .join(" · ");
    }
    return [
        { label: "source", value: "openai-compatible" },
        { label: "endpoint", value: endpointOf(connection.base_url) },
        { label: "model", value: connection.model || "–" },
        { label: "auth", value: `Bearer ${maskedKey(connection.key_last4)}` },
        { label: "output", value: output },
        { label: "egress", value: "remote · answers sent" },
    ];
}

export interface ConnectionStatus {
    dot: boolean;
    tone: string;
    text: string;
}

// The line under the spec sheet: the result of the last test.
export function connectionStatus(report: PreflightReport | null, busy: boolean): ConnectionStatus {
    if (busy) return { dot: true, tone: "text-fg", text: "testing…" };
    if (!report) return { dot: false, tone: "text-fg-muted", text: "not tested yet" };
    if (report.ok) {
        const models = report.checks.find((c) => c.key === "models");
        const count = /^(\d+) listed/.exec(models?.detail ?? "")?.[1];
        const parts = ["reachable"];
        if (models?.ms != null) parts.push(`${models.ms} ms`);
        if (count) parts.push(`${count} model${count === "1" ? "" : "s"}`);
        return { dot: true, tone: "text-fg", text: parts.join(" · ") };
    }
    const failed = report.checks.find((c) => c.state === "error");
    const text = failed ? `${failed.label} · ${failed.detail}` : "the test failed";
    return { dot: false, tone: "text-warn", text };
}
