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

const NAVEGADORES = {
  chromium: { name: "chrome-desktop", use: { ...devices["Desktop Chrome"], channel: process.env.E2E_BROWSER_CHANNEL || undefined } },
  firefox: { name: "firefox-desktop", use: { ...devices["Desktop Firefox"] } },
  webkit: { name: "webkit-desktop", use: { ...devices["Desktop Safari"], serviceWorkers: "block" } },
};

const projects = (process.env.E2E_BROWSERS || "chromium")
  .split(",")
  .map((nome) => nome.trim())
  .filter(Boolean)
  .map((nome) => {
    if (!NAVEGADORES[nome]) throw new Error(`E2E_BROWSERS: navegador desconhecido "${nome}" (use chromium, firefox ou webkit)`);
    return NAVEGADORES[nome];
  });

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
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  globalSetup: require.resolve("./harness/global-setup.js"),
  globalTeardown: require.resolve("./harness/global-teardown.js"),
  projects,
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
