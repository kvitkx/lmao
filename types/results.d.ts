// Shape of evaluation_results.json (schema_version 3) and of /api/results/<id>.
// Written by core/evaluator.py and core/scoring.py, read by static/js/lib.js.
// Keep it in step with SCHEMA_VERSION in core/evaluator.py.

export type Category =
    | "perfect"
    | "acceptable"
    | "instruction_violation"
    | "broken_logic"
    | "garbage";

export type Status = "ok" | "truncated" | "generation_error" | "judge_error";
export type ReferenceSource = "generated" | "provided" | "none";
export type Mode = "local" | "cloud";
export type JudgeProvider = "ollama" | "ollama_cloud" | "openai";
export type Confidence = "high" | "low";
export type RecommendationRule =
    | "fastest_above_threshold"
    | "highest_median"
    | "none_graded";

/** One answer of one model to one question. */
export interface Entry {
    model_name: string;
    answer: string;
    status: Status;
    category: Category | null;
    score: number | null;
    comment: string;
    truncated: boolean;
    done_reason: string;
    error: string | null;
    /** Tokens per second. */
    tps: number | null;
    /** Characters of the cleaned answer per second. */
    cps: number | null;
    /** Answer time without model loading, seconds. */
    time_sec: number | null;
    /** Generated tokens. */
    tokens: number | null;
    /** Length of the cleaned answer in characters. */
    chars: number | null;
}

export interface Reference {
    text: string | null;
    source: ReferenceSource;
}

export interface Question {
    id: string;
    tag: string;
    question: string;
    specific_rationale: string;
    reference: Reference;
    no_reference: boolean;
    results: Entry[];
}

/** Aggregates of one model, computed in core/scoring.py. */
export interface ModelStats {
    model: string;
    /** Answers counted in the score. */
    n: number;
    mean: number | null;
    median: number | null;
    /** Fraction, 0..1. */
    pass_rate: number | null;
    fails: number;
    critical_fails: number;
    errors: number;
    judge_errors: number;
    n_no_reference: number;
    median_tps: number | null;
    median_cps: number | null;
    median_time_sec: number | null;
    /** Average answer length in characters. */
    avg_chars: number | null;
    /** Generated tokens spent per passed answer; null without a pass. */
    tokens_per_pass: number | null;
    /** Mean score per GB (10^9 bytes) on disk; null for cloud models. */
    score_per_gb: number | null;
    /** Size on disk in bytes; null for cloud models. */
    size_bytes: number | null;
    /** Memory taken while loaded, bytes; null when it was not measured. */
    memory_bytes: number | null;
    /** Part of memory_bytes in VRAM; the rest is RAM (offload). */
    vram_bytes: number | null;
}

export interface Recommendation {
    model: string | null;
    rule: RecommendationRule;
    confidence: Confidence;
}

export interface Summary {
    models: ModelStats[];
    recommendation: Recommendation;
    text: string;
}

/** Content of evaluation_results.json. */
export interface Results {
    schema_version: 3;
    task_id: string;
    judge_model: string;
    /** Where the judge ran. `mode` is "cloud" for every value but "ollama". */
    judge_provider: JudgeProvider;
    mode: Mode;
    judge_is_candidate: boolean;
    finished_at: string;
    questions_results: Question[];
    summary: Summary;
}

/** Content of technical_metrics.json for one model; times in seconds. */
export interface ModelMetrics {
    total_time_sec: number;
    load_time_sec: number;
    eval_time_sec: number;
    tokens_generated: number;
    tokens_per_second: number;
}

/** Body of GET /api/results/<task_id>. */
export interface ApiResults extends Results {
    metrics: Record<string, ModelMetrics>;
}