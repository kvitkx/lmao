// The test cases file and the cases of the setup form. Pure; tested in tests/js/cases.test.ts.

import { pad2 } from "./names.ts";

// The file holds the setup form the way /api/evaluate takes it:
// {"version": 1, "base_rationale": "...",
//  "test_cases": [{tag, question, specific_rationale, reference}]}
export const CASES_FILE_VERSION = 1;
export const CASES_MAX_BYTES = 256 * 1024;
export const CASES_MAX_COUNT = 200;
export const CASES_TOO_LARGE = "the file is too large (max 256 KB).";
const CASE_OPTIONAL_FIELDS = ["tag", "specific_rationale", "reference"] as const;

// A file the UI cannot import: the message is shown to the user as is.
export class CasesFileError extends Error {}

// A case of the setup form.
export interface FormCase {
    id?: number;
    tag?: string;
    question?: string;
    rationale?: string;
    reference?: string;
    open?: boolean;
}

// A case as the file and the /api/evaluate payload have it.
export interface PayloadCase {
    tag?: string;
    question: string;
    specific_rationale?: string;
    reference?: string;
}

// A case read from a file: every optional field is there, maybe empty.
export interface RawCase {
    question: string;
    tag: string;
    specific_rationale: string;
    reference: string;
}

// Form case -> the case of the payload and of the file. Empty optional fields
// are left out: the backend would keep an empty tag as the tag instead of
// using its default.
export function payloadCase(c: FormCase): PayloadCase {
    const text = (value: unknown) => String(value ?? "").trim();
    const optional = (key: string, value: unknown) =>
        text(value) ? { [key]: text(value) } : {};
    return {
        ...optional("tag", c.tag),
        question: text(c.question),
        ...optional("specific_rationale", c.rationale),
        ...optional("reference", c.reference),
    };
}

// File case -> form fields. lmao.ts adds `id` and `open` (caseCounter lives there).
export function caseFields(raw: RawCase): Required<Omit<FormCase, "id" | "open">> {
    return {
        tag: raw.tag,
        question: raw.question,
        rationale: raw.specific_rationale,
        reference: raw.reference,
    };
}

// A case with nothing typed in it (the initial empty case).
export function isBlankCase(c: FormCase): boolean {
    return !(["tag", "question", "rationale", "reference"] as const).some((key) =>
        String(c[key] ?? "").trim(),
    );
}

function isBlankQuestion(c: FormCase): boolean {
    return !String(c.question ?? "").trim();
}

// Cases without a question are skipped: the importer would reject them.
export function buildCasesFile({
    baseRationale,
    cases,
}: {
    baseRationale: string;
    cases: FormCase[];
}): string {
    const file = {
        version: CASES_FILE_VERSION,
        base_rationale: String(baseRationale ?? "").trim(),
        test_cases: cases.filter((c) => !isBlankQuestion(c)).map(payloadCase),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
}

// Text of a file -> { baseRationale, cases }. The cases are raw: they keep the
// file's field names (specific_rationale), see caseFields(). Unknown fields are
// ignored, null counts as a missing optional field. Throws CasesFileError.
export function parseCasesFile(text: unknown): { baseRationale: string; cases: RawCase[] } {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (new TextEncoder().encode(source).length > CASES_MAX_BYTES) {
        throw new CasesFileError(CASES_TOO_LARGE);
    }

    let data: unknown;
    try {
        data = JSON.parse(source);
    } catch {
        throw new CasesFileError("the file is not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new CasesFileError("the file must contain a JSON object.");
    }
    const file = data as Record<string, unknown>;
    if (file.version !== CASES_FILE_VERSION) {
        throw new CasesFileError(`unsupported file version: expected ${CASES_FILE_VERSION}.`);
    }

    const baseRationale = file.base_rationale ?? "";
    if (typeof baseRationale !== "string") {
        throw new CasesFileError('"base_rationale" must be a string.');
    }

    const list = file.test_cases;
    if (!Array.isArray(list) || list.length === 0) {
        throw new CasesFileError("the file has no test cases.");
    }
    if (list.length > CASES_MAX_COUNT) {
        throw new CasesFileError(`too many test cases (max ${CASES_MAX_COUNT}).`);
    }

    const cases = list.map((item: unknown, index: number): RawCase => {
        const label = `case ${pad2(index)}`;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new CasesFileError(`${label}: must be an object.`);
        }
        const fields = item as Record<string, unknown>;
        if (typeof fields.question !== "string") {
            throw new CasesFileError(`${label}: "question" must be a string.`);
        }
        if (!fields.question.trim()) {
            throw new CasesFileError(`${label}: the question is empty.`);
        }
        const out: Record<string, string> = { question: fields.question };
        for (const key of CASE_OPTIONAL_FIELDS) {
            const value = fields[key] ?? "";
            if (typeof value !== "string") {
                throw new CasesFileError(`${label}: "${key}" must be a string.`);
            }
            out[key] = value;
        }
        return out as unknown as RawCase;
    });

    return { baseRationale, cases };
}
