const { test, expect } = require("@playwright/test");
const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..", "..", "remoteifes-web");
const SOURCE_VERSION = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "version.json"), "utf8")).version;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

let server;
let origin;
let release = "pwa-a";

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const parsed = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && parsed.pathname === "/__release/b") {
      release = "pwa-b";
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"ok":true}');
      return;
    }

    const rel = parsed.pathname === "/" ? "index.html" : parsed.pathname.replace(/^\/+/, "");
    const target = path.normalize(path.join(WEB_ROOT, rel));
    if (target !== WEB_ROOT && !target.startsWith(`${WEB_ROOT}${path.sep}`)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.readFile(target, (error, body) => {
      if (error) {
        res.writeHead(404).end("not found");
        return;
      }
      const extension = path.extname(target);
      const textual = [".html", ".js", ".css", ".json", ".webmanifest"].includes(extension);
      const payload = textual ? body.toString("utf8").replaceAll(SOURCE_VERSION, release) : body;
      const noCache = ["index.html", "sw.js", "version.json", "manifest.webmanifest"].includes(rel);
      res.writeHead(200, {
        "Content-Type": TYPES[extension] || "application/octet-stream",
        "Cache-Control": noCache ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable",
      });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("PWA instalada atualiza A para B, remove cache obsoleto e continua offline", async ({ page, context }) => {
  await page.goto(origin);
  await expect.poll(() => page.locator('meta[name="remoteifes-version"]').getAttribute("content")).toBe("pwa-a");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || "")).toContain("pwa-a");
  await page.evaluate(() => caches.open("cache-de-outra-aplicacao"));

  await page.evaluate(() => fetch("/__release/b", { method: "POST" }));

  const naPagina = (fn) => page.evaluate(fn).catch(() => null);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  }).catch(() => null);

  await expect.poll(() => naPagina(() => window.REMOTEIFES_FRONTEND_VERSION), { timeout: 30_000 }).toBe("pwa-b");
  await page.waitForLoadState("load");
  await expect.poll(() => page.locator('meta[name="remoteifes-version"]').getAttribute("content"), { timeout: 20_000 }).toBe("pwa-b");
  await expect
    .poll(() => naPagina(() => caches.keys().then((k) => k.filter((n) => n.startsWith("remoteifes-shell-")).sort())), { timeout: 20_000 })
    .toEqual(["remoteifes-shell-pwa-b"]);
  await expect.poll(() => naPagina(() => navigator.serviceWorker.controller?.scriptURL || ""), { timeout: 20_000 }).toContain("pwa-b");
  expect(await page.evaluate(() => caches.keys())).toContain("cache-de-outra-aplicacao");

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('meta[name="remoteifes-version"]')).toHaveAttribute("content", "pwa-b");
  await expect(page.locator("#screen-portal")).toBeVisible();
  await context.setOffline(false);
});
