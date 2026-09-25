const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..", "..", "remoteifes-web");
const version = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "version.json"), "utf8")).version;

test("the frontend version is unique across HTML, JavaScript, manifest and service worker", () => {
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

test("the service worker shell covers exactly the files index.html loads", () => {
  const worker = fs.readFileSync(path.join(WEB_ROOT, "sw.js"), "utf8");
  const index = fs.readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");
  const lista = worker.match(/const VERSIONED_SHELL = \[([\s\S]*?)\];/);
  assert.ok(lista, "VERSIONED_SHELL not found in sw.js");
  const shell = [...lista[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  assert.equal(new Set(shell).size, shell.length, "VERSIONED_SHELL has a repeated path");
  shell.forEach((ativo) => assert.ok(fs.existsSync(path.join(WEB_ROOT, ativo)), `VERSIONED_SHELL points to a missing file (${ativo}): cache.addAll rejects, the worker does not install and the PWA loses offline support`));

  const referenciados = [...index.matchAll(/(?:src|href)="([^"?]+\.(?:js|css))(?:\?[^"]*)?"/g)].map((m) => m[1]);
  referenciados.forEach((ativo) => assert.ok(shell.includes(ativo), `index.html loads ${ativo}, but the service worker does not cache it`));
});
