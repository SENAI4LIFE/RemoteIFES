const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..", "..", "remoteifes-web");
const version = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "version.json"), "utf8")).version;

test("a versão do frontend é única em HTML, JavaScript, manifesto e service worker", () => {
  const index = fs.readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");
  const manifest = fs.readFileSync(path.join(WEB_ROOT, "manifest.webmanifest"), "utf8");
  const versionJs = fs.readFileSync(path.join(WEB_ROOT, "js", "version.js"), "utf8");
  const worker = fs.readFileSync(path.join(WEB_ROOT, "sw.js"), "utf8");

  assert.ok(index.includes(`name="remoteifes-version" content="${version}"`));
  assert.ok(versionJs.includes(`"${version}"`));
  assert.ok(worker.includes(`const FRONTEND_VERSION = "${version}"`));

  const referencias = [...index.matchAll(/(?:src|href)="([^"]+\.(?:js|css|png)(?:\?[^"]*)?)"/g)].map((m) => m[1]);
  referencias.forEach((referencia) => assert.equal(new URL(referencia, "https://remoteifes.invalid/").searchParams.get("v"), version, referencia));
  JSON.parse(manifest).icons.forEach((icone) => assert.equal(new URL(icone.src, "https://remoteifes.invalid/").searchParams.get("v"), version, icone.src));
});
