// The icon of the tab. Its four bars are the four phases of a run: reference,
// answers, grading, summary. A bar is off (black), active (blue) or done
// (white); every bar is its own rectangle, as in the design. Pure: the caller
// puts the result into the page.

export type BarState = "off" | "active" | "done";

const BARS = [
    { x: 2, w: 2 },
    { x: 6, w: 8 },
    { x: 16, w: 6 },
    { x: 24, w: 6 },
];

// The colours of the page tokens (link, fg): the icon renders outside the page.
const COLORS = { active: "#3b9ae1", done: "#f6f8f7" };

const PHASES = ["reference", "answer", "grading", "summary"];

export function faviconSvg(states: BarState[]): string {
    const rects: string[] = [];
    BARS.forEach((bar, i) => {
        const state = states[i] ?? "off";
        if (state === "off") return;
        rects.push(`<rect x="${bar.x}" y="8" width="${bar.w}" height="16" fill="${COLORS[state]}"/>`);
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000"/>${rects.join("")}</svg>`;
}

export function faviconHref(states: BarState[]): string {
    return `data:image/svg+xml,${encodeURIComponent(faviconSvg(states))}`;
}

// The bars of a run: while it runs they follow the phases; after an error what
// was in flight goes dark; without a run (and when it is over) all are done.
export function barStates(phases: Record<string, { state: string }>, status: string): BarState[] {
    if (status !== "running" && status !== "error") return PHASES.map((): BarState => "done");
    return PHASES.map((phase): BarState => {
        const state = phases[phase]?.state;
        if (state === "done") return "done";
        return state === "running" && status === "running" ? "active" : "off";
    });
}
