process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-release-test-"));
process.env.MOBILE_APP_RELEASE_DIR = RELEASE_DIR;

const app = require("../src/app");

let server;
let baseUrl;
let token;

const BYTES = Buffer.from(`RemoteIFES-teste-${"0".repeat(4096)}`, "utf8");
const SHA256 = crypto.createHash("sha256").update(BYTES).digest("hex");
const NOME_APK = "RemoteIFES-1.0.1-10001.apk";

function metadadosBase(extra = {}) {
  return {
    file: NOME_APK,
    version: "1.0.1",
    build: "10001",
    sha256: SHA256,
    certificateSha256: crypto.createHash("sha256").update("certificado-de-teste").digest("hex"),
    serverOrigin: baseUrl,
    releaseDate: "2026-09-02",
    notes: ["Correções de estabilidade.", "Nova página do aplicativo."],
    artifactType: "release",
    signed: true,
    debuggable: false,
    minSdk: 24,
    targetSdk: 36,
    ...extra,
  };
}

function publicar(extra = {}, bytes = BYTES) {
  limpar();
  fs.writeFileSync(path.join(RELEASE_DIR, NOME_APK), bytes);
  fs.writeFileSync(path.join(RELEASE_DIR, "release.json"), JSON.stringify(metadadosBase(extra), null, 2));
}

function limpar() {
  for (const nome of fs.readdirSync(RELEASE_DIR)) fs.rmSync(path.join(RELEASE_DIR, nome), { force: true });
}

async function info(comToken = token) {
  const resp = await fetch(`${baseUrl}/mobile-app/info`, {
    headers: comToken ? { Authorization: `Bearer ${comToken}` } : {},
  });
  return { status: resp.status, cacheControl: resp.headers.get("cache-control"), corpo: await resp.json() };
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "superadmin", senha: "admin" }),
  });
  token = (await resp.json()).token;
  assert.ok(token, "não foi possível autenticar para os testes de release");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
});

test("a release publicada é anunciada com versão, build, data e notas", async () => {
  publicar();
  const { status, cacheControl, corpo } = await info();
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(corpo.versao, "1.0.1");
  assert.equal(corpo.android.disponivel, true);
  assert.equal(corpo.android.build, "10001");
  assert.equal(corpo.android.sha256, SHA256);
  assert.equal(corpo.android.dataPublicacao, "2026-09-02");
  assert.deepEqual(corpo.android.notas, ["Correções de estabilidade.", "Nova página do aplicativo."]);
});

test("uma release sem data nem notas continua sendo anunciada", async () => {
  publicar({ releaseDate: undefined, notes: undefined });
  const { corpo } = await info();
  assert.equal(corpo.android.disponivel, true);
  assert.equal(corpo.android.dataPublicacao, null);
  assert.deepEqual(corpo.android.notas, []);
});

test("data ou notas malformadas invalidam a release inteira em vez de serem ignoradas", async () => {
  publicar({ releaseDate: "02/09/2026" });
  assert.equal((await info()).corpo.android.disponivel, false);
  publicar({ notes: "uma nota só" });
  assert.equal((await info()).corpo.android.disponivel, false);
});

test("o APK e os metadados não podem divergir: um arquivo trocado deixa de ser anunciado", async () => {
  publicar({}, Buffer.from("outro-conteudo-qualquer"));
  const { corpo } = await info();
  assert.equal(corpo.android.disponivel, false);
  const download = await fetch(`${baseUrl}/mobile-app/android`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 404);
});

test("metadados que apontam para um APK inexistente não são anunciados", async () => {
  publicar();
  fs.rmSync(path.join(RELEASE_DIR, NOME_APK));
  assert.equal((await info()).corpo.android.disponivel, false);
});

test("uma release publicada para outra origem não é oferecida", async () => {
  publicar({ serverOrigin: "https://outro-campus.ifes.edu.br" });
  assert.equal((await info()).corpo.android.disponivel, false);
});

test("artefatos debug ou sem assinatura nunca são anunciados", async () => {
  publicar({ debuggable: true });
  assert.equal((await info()).corpo.android.disponivel, false);
  publicar({ signed: false });
  assert.equal((await info()).corpo.android.disponivel, false);
});

test("informações e download da release exigem sessão válida", async () => {
  publicar();
  const semToken = await fetch(`${baseUrl}/mobile-app/info`);
  assert.equal(semToken.status, 401);
  const tokenInvalido = await info("token-que-nao-existe");
  assert.equal(tokenInvalido.status, 401);
  const download = await fetch(`${baseUrl}/mobile-app/android`);
  assert.equal(download.status, 401);
});

test("o download entrega exatamente os bytes cujo hash foi anunciado, sem cache", async () => {
  publicar();
  const resp = await fetch(`${baseUrl}/mobile-app/android`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("cache-control"), "private, no-store");
  assert.equal(resp.headers.get("x-apk-sha256"), SHA256);
  const bytes = Buffer.from(await resp.arrayBuffer());
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), SHA256);
});

test("sem release publicada o servidor informa que não há aplicativo, sem erro", async () => {
  limpar();
  const { status, corpo } = await info();
  assert.equal(status, 200);
  assert.equal(corpo.ok, true);
  assert.equal(corpo.android.disponivel, false);
});
