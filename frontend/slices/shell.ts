// The frame of the page: panels, hotkeys, tabs, the live region and navigation.

import { faviconHref } from "../favicon.ts";
import { pad2 } from "../names.ts";
import { magic, slice } from "./shared.ts";

export function shellSlice() {
    return slice({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results

        announcement: "", // text of the page live region
        // Clipboard API exists only in a secure context (localhost / https).
        canCopy: Boolean(window.isSecureContext && navigator.clipboard),
        init(): void {
            void this.loadModels();
            void this.loadHistory();
            void this.loadConnection();
            // A judge that is not among the models of its provider becomes the first one.
            Alpine.effect(() => this.ensureJudge());
            this.watchEstimate();
            // The tab shows the state of the run: its title and its icon.
            let icon = "";
            Alpine.effect(() => {
                document.title = this.pageTitle;
                const href = faviconHref(this.faviconBars);
                if (href !== icon) {
                    icon = href;
                    document.getElementById("favicon")?.setAttribute("href", href);
                }
            });
        },

        // Templates read it as `pad2(i)`: modules have no globals.
        pad2(index: number): string {
            return pad2(index);
        },

        // Clears first, so the same text can be announced twice.
        announce(text: string): void {
            this.announcement = "";
            setTimeout(() => {
                this.announcement = text;
            }, 50);
        },

        // Wordmark: back to the first screen. A run in progress keeps going;
        // the topbar status and the first screen lead back to it.
        goHome(): void {
            this.view = "idle";
            this.activeRunId = null;
            if (magic(this).$refs?.main) magic(this).$refs.main.scrollTop = 0;
        },

        showRun(): void {
            this.view = "running";
            this.activeRunId = null;
        },

        async copyText(text: unknown): Promise<boolean> {
            try {
                await navigator.clipboard.writeText(String(text ?? ""));
                return true;
            } catch (e) {
                console.error("Copy failed:", e);
                return false;
            }
        },

        // [ and ] toggle the panels, Esc goes to the first screen.
        // event.code: the same physical keys on any layout (х / ї in Ukrainian).
        // Ignored while typing and with modifiers.
        hotkey(event: KeyboardEvent): void {
            if (
                event.defaultPrevented ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
            ) {
                return;
            }
            const target = event.target as Element | null;
            if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

            if (event.code === "BracketLeft") this.setupOpen = !this.setupOpen;
            else if (event.code === "BracketRight") this.archiveOpen = !this.archiveOpen;
            else if (event.code === "Escape" && this.view !== "idle") this.goHome();
            else return;
            event.preventDefault();
        },

        // Tabs (ui.tabs): `key` is the state property, ids are tab-<key>-<value>.
        setTab(key: string, value: string): void {
            (this as unknown as Record<string, unknown>)[key] = value;
            void magic(this).$nextTick(() => document.getElementById(`tab-${key}-${value}`)?.focus());
        },

        // `list`: comma-separated values in tab order; `step`: +1 / -1, wraps around.
        cycleTab(key: string, list: string, step: number): void {
            const values = list.split(",");
            const current = (this as unknown as Record<string, unknown>)[key] as string;
            const index = values.indexOf(current);
            this.setTab(key, values[(index + step + values.length) % values.length]);
        },
    });
}

export type ShellSlice = ReturnType<typeof shellSlice>;
