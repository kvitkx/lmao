import { defineConfig, devices } from "@playwright/test";

// Browser smoke test: runs in the dom-test stage of the Dockerfile, against the
// production image (scripts/ci/test-dom.sh). Every /api call is mocked.
export default defineConfig({
    testDir: "tests/dom",
    forbidOnly: true,
    retries: 0,
    reporter: "list",
    use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.BASE_URL ?? "http://localhost:5000",
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        reducedMotion: "reduce",
    },
});
