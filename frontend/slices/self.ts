// The type of `this` in every slice: all the slices put together. An interface,
// not an alias: the compiler reads its parts lazily, so the slices can refer to
// each other. A member defined by two slices is a type error here and a throw in mix().

import type { RemoteSlice } from "./remote.ts";
import type { ResultsSlice } from "./results.ts";
import type { RunSlice } from "./run.ts";
import type { SetupSlice } from "./setup.ts";
import type { ShellSlice } from "./shell.ts";

export interface Lmao extends ShellSlice, SetupSlice, RemoteSlice, RunSlice, ResultsSlice {}
