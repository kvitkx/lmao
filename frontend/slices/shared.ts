// What every slice shares: the typing of `this`, the mixer and two small helpers.

import type { Lmao } from "./self.ts";

export interface Magics {
    $nextTick(callback?: () => void): Promise<void>;
    $refs: Record<string, HTMLElement>;
}

export const magic = (self: unknown): Magics => self as Magics;

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Types a slice: inside it `this` is the whole page, not only the slice.
export function slice<T extends object>(parts: T & ThisType<Lmao>): T {
    return parts;
}

// Joins the slices by copying property descriptors. `{ ...a, ...b }` would run
// every getter once and keep its value, so the page would stop reacting.
export function mix(...parts: object[]): Lmao {
    const page: object = {};
    for (const part of parts) {
        const descriptors = Object.getOwnPropertyDescriptors(part);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (Object.hasOwn(page, key)) throw new Error(`two slices define "${String(key)}"`);
        }
        Object.defineProperties(page, descriptors);
    }
    return page as Lmao;
}
