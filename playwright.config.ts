import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./browser-tests",
    outputDir: "./test-results/playwright",
    fullyParallel: false,
    workers: 1,
    timeout: 90_000,
    expect: { timeout: 10_000 },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        ...devices["Desktop Chrome"],
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
    },
});
