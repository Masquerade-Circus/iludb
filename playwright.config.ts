import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "persistent-browser.spec.ts",
  outputDir: "./tmp/playwright-results",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true
  }
});
