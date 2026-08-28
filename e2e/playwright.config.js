const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const API_PORT = Number(process.env.E2E_API_PORT || 8791);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 8790);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

process.env.E2E_API_PORT = String(API_PORT);
process.env.E2E_WEB_PORT = String(WEB_PORT);
process.env.E2E_API_URL = API_URL;
process.env.E2E_WEB_URL = WEB_URL;

module.exports = defineConfig({
  testDir: "./specs",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: WEB_URL,
    channel: process.env.E2E_BROWSER_CHANNEL || "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  globalSetup: require.resolve("./harness/global-setup.js"),
  projects: [{ name: "chrome-desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node ${path.join(__dirname, "harness", "api-server.js")}`,
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      env: { E2E_API_PORT: String(API_PORT) },
    },
    {
      command: `node ${path.join(__dirname, "harness", "static-server.js")}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: { E2E_WEB_PORT: String(WEB_PORT) },
    },
  ],
});
