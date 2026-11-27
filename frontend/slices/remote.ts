// A remote judge: the saved connection, its test, the budget and the request preview.

import {
    type Budget,
    type Connection,
    type ConnectionBody,
    connectionBody,
    type ConnectionForm,
    type ConnectionStatus,
    budgetFigures as figuresOf,
    formOf,
    maskedKey as maskKey,
    preflightMeta as metaOf,
    type PreflightCheck,
    type PreflightReport,
    type Preview,
    previewText,
    type Route,
    routeOf,
    type SpecRow,
    specRows as specRowsOf,
    connectionStatus as statusOf,
} from "../remote.ts";
import type { Figure } from "../report.ts";
import type { EvaluatePayload } from "./setup.ts";
import { errorText, slice } from "./shared.ts";

// The estimate of the budget follows the form; the request waits until the typing stops.
let estimateTimer: ReturnType<typeof setTimeout> | null = null;
let estimateToken = 0; // ignores a late reply of a superseded request
let estimateKeyLast = "";

export function remoteSlice() {
    return slice({
        connection: null as Connection | null, // the saved connection: there is no key in it
        connectionLoaded: false,
        connectionEditing: false,
        connectionBusy: false,
        connectionError: "",
        connectionRev: 0, // changes with the saved connection: the estimate depends on its prices
        connectionForm: formOf(null, "") as ConnectionForm,
        preflight: null as PreflightReport | null,
        preflightBusy: false,
        budget: null as Budget | null,
        preview: null as Preview | null,
        estimating: false,
        estimateError: "",

        get route(): Route | null {
            return routeOf(this.judgeProvider, this.selected.length, this.connection?.base_url ?? null);
        },

        get maskedKey(): string {
            return maskKey(this.connection?.key_last4 ?? "");
        },

        get specRows(): SpecRow[] {
            if (!this.connection) return [];
            const body = this.preview?.body as { seed?: unknown } | undefined;
            return specRowsOf(this.connection, this.preflight, body?.seed);
        },

        get connectionStatus(): ConnectionStatus {
            return statusOf(this.preflight, this.preflightBusy);
        },

        preflightMeta(check: PreflightCheck): string {
            return metaOf(check);
        },

        async loadConnection(): Promise<void> {
            try {
                const response = await fetch("/api/connection");
                const data: { connection?: Connection | null } = await response.json();
                this.connection = data.connection ?? null;
            } catch (e) {
                console.error("Failed to load the connection:", e);
                this.connection = null;
            }
            this.connectionLoaded = true;
        },

        editConnection(): void {
            this.connectionForm = formOf(this.connection, this.connection?.model ?? "");
            this.connectionError = "";
            this.connectionEditing = true;
        },

        cancelConnection(): void {
            this.connectionForm = formOf(null, "");
            this.connectionEditing = false;
            this.connectionError = "";
        },

        // True when the connection is saved. An empty key keeps the saved one.
        async saveConnection(): Promise<boolean> {
            this.connectionError = "";
            let body: ConnectionBody;
            try {
                body = connectionBody(this.connectionForm);
            } catch (e) {
                this.connectionError = errorText(e);
                return false;
            }
            this.connectionBusy = true;
            try {
                const response = await fetch("/api/connection", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.connection = data.connection;
                this.connectionForm = formOf(null, ""); // the typed key is not kept
                this.connectionEditing = false;
                this.connectionRev += 1;
                this.preflight = null;
                return true;
            } catch (e) {
                this.connectionError = errorText(e);
                return false;
            } finally {
                this.connectionBusy = false;
            }
        },

        // The key never comes from the request: the form saves first, then the
        // saved connection is tested.
        async testConnection(): Promise<void> {
            if (this.connectionEditing && !(await this.saveConnection())) return;
            if (!this.connection) return;
            if (!this.connection.model) {
                this.connectionError = "set the judge model in the connection first.";
                return;
            }
            this.connectionError = "";
            this.preflightBusy = true;
            try {
                const response = await fetch("/api/connection/test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.preflight = data as PreflightReport;
                this.announce(this.preflight.ok ? "connection test passed." : "connection test failed.");
            } catch (e) {
                this.connectionError = errorText(e);
            } finally {
                this.preflightBusy = false;
            }
        },

        async removeConnection(): Promise<void> {
            this.connectionError = "";
            try {
                const response = await fetch("/api/connection", { method: "DELETE" });
                if (!response.ok) throw new Error(`request failed (${response.status})`);
                this.connection = null;
                this.connectionEditing = false;
                this.connectionRev += 1;
                this.preflight = null;
            } catch (e) {
                this.connectionError = errorText(e);
            }
        },

        // Empty while there is nothing to estimate: a local judge sends nothing out.
        get estimateKey(): string {
            if (this.judgeProvider === "ollama") return "";
            if (this.judgeProvider === "openai" && (!this.connection || this.connectionEditing)) return "";
            const payload = this.buildPayload(true);
            if (!payload.judge || !payload.candidates.length || !payload.test_cases.length) return "";
            return JSON.stringify({ payload, rev: this.connectionRev });
        },

        async refreshEstimate(key: string): Promise<void> {
            const token = ++estimateToken;
            this.estimating = true;
            const { payload } = JSON.parse(key) as { payload: EvaluatePayload };
            const post = async (url: string) => {
                try {
                    const response = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const data = await response.json().catch(() => ({}));
                    return { ok: response.ok, data };
                } catch (e) {
                    return { ok: false, data: { error: errorText(e) } };
                }
            };
            const [budget, preview] = await Promise.all([post("/api/budget"), post("/api/preview")]);
            if (token !== estimateToken) return;
            this.estimating = false;
            this.budget = budget.ok ? (budget.data as Budget) : null;
            this.preview = preview.ok ? (preview.data as Preview) : null;
            const failed = !budget.ok ? budget : !preview.ok ? preview : null;
            this.estimateError = failed ? failed.data.error || "the estimate failed." : "";
        },

        get budgetFigures(): Figure[] {
            if (!this.budget) return [];
            return figuresOf(this.budget, this.judgeProvider === "openai" ? this.judgeName : null);
        },

        get previewBody(): string {
            return this.preview ? previewText(this.preview) : "";
        },
        // The estimate follows the form; the request waits until the typing stops.
        watchEstimate(): void {
            Alpine.effect(() => {
                const key = this.estimateKey;
                if (key === estimateKeyLast) return;
                estimateKeyLast = key;
                if (estimateTimer) clearTimeout(estimateTimer);
                if (!key) {
                    estimateToken += 1;
                    this.budget = null;
                    this.preview = null;
                    this.estimateError = "";
                    this.estimating = false;
                    return;
                }
                estimateTimer = setTimeout(() => void this.refreshEstimate(key), 400);
            });
        },
    });
}

export type RemoteSlice = ReturnType<typeof remoteSlice>;
