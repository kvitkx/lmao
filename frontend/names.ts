// Names of models and the ids of DOM blocks. Pure: no DOM, no Alpine; tested in tests/js/names.test.ts.

// 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M' -> 'openbmb/MiniCPM5-2B'
// The full name stays in `title` attributes and in the archive meta.
export function shortName(name: unknown): string {
    if (typeof name !== "string") return "";
    return name.replace(/^hf\.co\//, "").replace(/-GGUF:[^:\s]+$/i, "");
}

// 'x-GGUF:Q4_K_M' -> 'Q4_K_M', 'llama3:8b' -> '8b', 'llama3' -> 'latest'
export function variantOf(name: string): string {
    const quant = /-GGUF:([^:\s]+)$/i.exec(name);
    if (quant) return quant[1];
    const tag = /:([^:/\s]+)$/.exec(name);
    return tag ? tag[1] : "latest";
}

// Display names for a set of models: { fullName: displayName }.
// Names whose short form collides get the quantisation as a suffix
// ('foo · Q4_K_M' / 'foo · Q8_0'); if that is still ambiguous, the full name.
export function shortNames(names: unknown): Record<string, string> {
    const list: unknown[] = Array.isArray(names) ? names : [];
    const unique = [
        ...new Set(list.filter((n): n is string => typeof n === "string" && n !== "")),
    ];
    const groups = new Map<string, string[]>();
    unique.forEach((name) => {
        const short = shortName(name);
        const group = groups.get(short);
        if (group) group.push(name);
        else groups.set(short, [name]);
    });

    const out: Record<string, string> = {};
    groups.forEach((group, short) => {
        if (group.length === 1) {
            out[group[0]] = short;
            return;
        }
        const variants = group.map(variantOf);
        const distinct = new Set(variants).size === group.length;
        group.forEach((name, i) => {
            out[name] = distinct ? `${short} · ${variants[i]}` : name;
        });
    });
    return out;
}

// 0 -> '01', 11 -> '12'
export function pad2(index: number): string {
    return String(index + 1).padStart(2, "0");
}

// Model names contain ':', '/' and '.', so they cannot be used as ids as is.
// The id is a readable slug plus a FNV-1a hash of the raw parts, so names
// with the same slug ('a:b' and 'a/b') still get different ids.
// domId('answer', 'hf.co/o/m-GGUF:Q4_K_M', 'q1')
//   -> 'answer-hf-co-o-m-gguf-q4_k_m-q1-<hash>'
export function domId(prefix: string, ...parts: unknown[]): string {
    const raw = parts.map((p) => String(p ?? "")).join("\n");
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return [prefix, slug, (hash >>> 0).toString(36)].filter(Boolean).join("-");
}
