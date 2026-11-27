// Alpine state of the whole page, joined from the slices in frontend/slices/.
// Registered on 'alpine:init'; this module is loaded before Alpine itself (see templates/base.html).

import { registerMd } from "./directives.ts";
import { remoteSlice } from "./slices/remote.ts";
import { resultsSlice } from "./slices/results.ts";
import { runSlice } from "./slices/run.ts";
import { setupSlice } from "./slices/setup.ts";
import { shellSlice } from "./slices/shell.ts";
import { mix } from "./slices/shared.ts";

document.addEventListener("alpine:init", () => {
    registerMd();
    Alpine.data("lmao", () =>
        mix(shellSlice(), setupSlice(), remoteSlice(), runSlice(), resultsSlice()),
    );
});
