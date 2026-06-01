import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "test-results/visual",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run dev -- --strictPort",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.002
    }
  }
});
