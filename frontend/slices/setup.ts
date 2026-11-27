// The setup form: models, the judge, the test cases, validation and submit.

import {
    buildCasesFile,
    caseFields,
    CASES_MAX_BYTES,
    CASES_MAX_COUNT,
    CASES_TOO_LARGE,
    CasesFileError,
    type FormCase,
    isBlankCase,
    parseCasesFile,
    type PayloadCase,
    payloadCase,
} from "../cases.ts";
import { pad2, shortName, shortNames } from "../names.ts";
import { hostOf, judgeChoices as judgeModelsOf, type JudgeProvider } from "../remote.ts";
import { errorText, magic, slice } from "./shared.ts";

// A case of the setup form: every field is there.
interface TestCase extends FormCase {
    id: number;
    tag: string;
    question: string;
    rationale: string;
    reference: string;
    open: boolean;
}

export interface EvaluatePayload {
    judge: string;
    judge_provider: string;
    candidates: string[];
    base_rationale: string;
    test_cases: PayloadCase[];
}

interface ChecklistRow {
    key: string;
    label: string;
    state: string;
    meta: string;
}

type SetupSection = "judge" | "candidates" | "criteria" | "cases";

let caseCounter = 0;

// `fields`: values of an imported case (see caseFields in cases.ts).
const newCase = (fields: Partial<TestCase> = {}): TestCase => ({
    id: ++caseCounter,
    tag: "",
    question: "",
    rationale: "",
    reference: "",
    open: true,
    ...fields,
});

export function setupSlice() {
    return slice({
        models: [] as string[],
        names: {} as Record<string, string>, // full model name -> display name (see shortNames)
        modelsLoaded: false,
        judge: "",
        judgeProvider: "ollama" as JudgeProvider,
        selected: [] as string[],
        baseRationale: "",
        cases: [newCase()] as TestCase[],
        formError: "",
        casesError: "", // import / export of test cases
        // true: folded by the user. Never folded by the page itself.
        setupFolds: { judge: false, candidates: false, criteria: false, cases: false } as Record<
            SetupSection,
            boolean
        >,
        submitting: false,

        // First screen: the state of the form as status rows.
        get checklist(): ChecklistRow[] {
            let judge: { state: string; meta: string };
            if (this.judgeProvider === "openai") {
                if (this.connectionEditing) judge = { state: "queued", meta: "editing connection" };
                else if (!this.connectionLoaded) judge = { state: "queued", meta: "loading connection…" };
                else if (!this.connection) judge = { state: "error", meta: "no connection saved" };
                else if (!this.judgeName) judge = { state: "queued", meta: "set the judge model" };
                else judge = { state: "done", meta: `${this.judgeName} · ${hostOf(this.connection.base_url)}` };
            } else if (!this.modelsLoaded) judge = { state: "queued", meta: "loading models…" };
            else if (this.models.length === 0) {
                judge = { state: "error", meta: "no models. is ollama running?" };
            } else if (this.judge) {
                judge = {
                    state: "done",
                    meta: this.label(this.judge) + (this.judgeProvider === "ollama_cloud" ? " · cloud" : ""),
                };
            } else judge = { state: "queued", meta: "not selected" };

            const picked = this.selected.length;
            const candidates = picked
                ? { state: "done", meta: `${picked} selected` }
                : { state: "queued", meta: "none selected" };

            const ready = this.cases.filter((c) => c.question.trim()).length;
            const cases =
                ready === this.cases.length
                    ? { state: "done", meta: `${ready} ready` }
                    : { state: "queued", meta: `${ready} of ${this.cases.length} ready` };

            const all = [judge, candidates, cases].every((r) => r.state === "done");
            let runRow = { state: all ? "ready" : "", meta: all ? "press run evaluation" : "" };
            if (this.busy) {
                runRow = { state: "running", meta: `${this.run.done} / ${this.run.total} steps` };
            }
            return [
                { key: "judge", label: "01 judge", ...judge },
                { key: "candidates", label: "02 candidates", ...candidates },
                { key: "cases", label: "03 test cases", ...cases },
                { key: "run", label: "04 run evaluation", ...runRow },
            ];
        },

        label(model: string): string {
            return this.names[model] || shortName(model);
        },

        async loadModels(): Promise<void> {
            this.modelsLoaded = false;
            try {
                const response = await fetch("/api/models");
                const data: { models?: unknown } = await response.json();
                this.models = Array.isArray(data.models) ? (data.models as string[]) : [];
            } catch (e) {
                console.error("Failed to load models:", e);
                this.models = [];
            }
            this.names = shortNames(this.models);
            this.modelsLoaded = true;
            // Let x-for render the <option>s before the value is set.
            await magic(this).$nextTick();
            this.ensureJudge();
            this.selected = this.selected.filter((m) => this.models.includes(m));
        },

        get remoteJudge(): boolean {
            return this.judgeProvider !== "ollama";
        },

        // The model the judge calls name.
        get judgeName(): string {
            return this.judgeProvider === "openai" ? (this.connection?.model ?? "") : this.judge;
        },

        get judgeChoices(): string[] {
            return judgeModelsOf(this.models, this.judgeProvider);
        },

        ensureJudge(): void {
            if (this.judgeProvider === "openai") return;
            const list = this.judgeChoices;
            if (!list.includes(this.judge)) this.judge = list[0] ?? "";
        },

        addCase(): void {
            // Collapse the finished ones, never one that is still empty.
            this.cases.forEach((c) => {
                if (c.question.trim()) c.open = false;
            });
            this.cases.push(newCase());
        },

        removeCase(id: number): void {
            if (this.cases.length > 1) {
                this.cases = this.cases.filter((c) => c.id !== id);
            }
        },

        get canExport(): boolean {
            return this.cases.some((c) => c.question.trim());
        },

        exportCases(): void {
            this.casesError = "";
            const text = buildCasesFile({
                baseRationale: this.baseRationale,
                cases: this.cases,
            });
            const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "lmao-test-cases.json";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        // Empty form: the file replaces it. Otherwise the cases are added after
        // the existing ones; empty cases are dropped either way. The general
        // criteria of the file are used only while the field is empty.
        async importCases(event: Event): Promise<void> {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;
            this.casesError = "";
            try {
                // Checked before the file is read.
                if (file.size > CASES_MAX_BYTES) throw new CasesFileError(CASES_TOO_LARGE);
                const parsed = parseCasesFile(await file.text());

                const kept = this.cases.filter((c) => !isBlankCase(c));
                if (kept.length + parsed.cases.length > CASES_MAX_COUNT) {
                    throw new CasesFileError(`too many test cases (max ${CASES_MAX_COUNT}).`);
                }
                if (!this.baseRationale.trim()) this.baseRationale = parsed.baseRationale;
                this.cases = [
                    ...kept,
                    ...parsed.cases.map((raw) => newCase({ ...caseFields(raw), open: false })),
                ];
                this.announce(`imported ${parsed.cases.length} test cases`);
            } catch (e) {
                const known = e instanceof CasesFileError;
                if (!known) console.error("Failed to import test cases:", e);
                this.casesError = known ? e.message : "could not read the file.";
            } finally {
                input.value = ""; // the same file can be chosen again
            }
        },

        toggleSetup(section: SetupSection): void {
            this.setupFolds[section] = !this.setupFolds[section];
        },

        // The first problem of the form and the section it is in.
        problem(): { section: SetupSection; text: string } | null {
            const judge = (text: string) => ({ section: "judge" as const, text });
            if (this.judgeProvider === "openai") {
                if (!this.connection) return judge("connect the openai api first.");
                if (this.connectionEditing) return judge("save the connection first.");
                if (!this.judgeName) return judge("set the judge model in the connection.");
            } else if (!this.judgeName) {
                return judge("choose a judge model.");
            }
            if (this.selected.length === 0) {
                return { section: "candidates", text: "select at least one candidate." };
            }
            const index = this.cases.findIndex((c) => !c.question.trim());
            if (index !== -1) {
                this.cases[index].open = true;
                return { section: "cases", text: `case ${pad2(index)}: the question is empty.` };
            }
            return null;
        },

        // An error is never left inside a section the user folded.
        validate(): string {
            const found = this.problem();
            if (!found) return "";
            this.setupFolds[found.section] = false;
            return found.text;
        },

        // `estimate`: only the cases that have a question, the way the budget and
        // the preview take them while the form is still being filled.
        buildPayload(estimate = false): EvaluatePayload {
            return {
                judge: this.judgeName,
                judge_provider: this.judgeProvider,
                candidates: [...this.selected],
                base_rationale: this.baseRationale.trim(),
                test_cases: this.cases
                    .filter((c) => !estimate || c.question.trim())
                    .map((c) => payloadCase(c)),
            };
        },

        async submit(): Promise<void> {
            this.formError = this.validate();
            if (this.formError || this.busy) return;

            const payload = this.buildPayload();
            this.submitting = true;
            try {
                const response = await fetch("/api/evaluate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.startRun(data.task_id, {
                    judge: payload.judge,
                    cloud: payload.judge_provider !== "ollama",
                    candidates: payload.candidates,
                    questions: payload.test_cases.length,
                });
            } catch (e) {
                this.formError = errorText(e);
            } finally {
                this.submitting = false;
            }
        },
    });
}

export type SetupSlice = ReturnType<typeof setupSlice>;
