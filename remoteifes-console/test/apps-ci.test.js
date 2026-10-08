const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const ajuda = require("./helpers");

// Apps and CI workflows driven from the Console (dispatch, follow, repeat, cancel, artifacts, the
// published APK and the GitHub credential), the uninstall modes and the update actions that need
// their target.

const BASE_REPO = "/repos/SENAI4LIFE/RemoteIFES";
const TOKEN = "ghp_tokenfalsoparateste000000000000000";

function githubFalso(rotas) {
  const chamadas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (d) => (corpo += d));
    req.on("end", () => {
      const caminho = req.url.split("?")[0];
      chamadas.push({ metodo: req.method, caminho, corpo, autorizacao: req.headers.authorization || null });
      const manipulador = rotas[`${req.method} ${caminho}`];
      if (!manipulador) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Not Found" }));
      }
      manipulador(req, res, servidor);
    });
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () => resolve({ chamadas, base: `http://127.0.0.1:${servidor.address().port}`, fechar: () => new Promise((r) => servidor.close(() => r())) }));
  });
}

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(corpo === undefined ? "" : JSON.stringify(corpo));
}

function run(id, arquivo, extra = {}) {
  return {
    id, name: "x", path: `.github/workflows/${arquivo}`, status: "completed", conclusion: "failure", head_sha: "a".repeat(40), head_branch: "main",
    run_number: 3, run_attempt: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: "https://exemplo", event: "push", ...extra,
  };
}

async function consoleComSessao(t, opcoes = {}) {
  const amb = ajuda.ambiente(opcoes);
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  const sessao = await ajuda.autenticar(amb, s.porta);
  const pedir = (caminho, extra = {}) => ajuda.pedir(s.porta, caminho, { cookie: sessao.cookie, csrf: sessao.csrf, origem: s.base, ...extra });
  return { amb, s, sessao, pedir };
}

test("a workflow dispatch needs a credential, a known workflow, consistent inputs and elevation", async (t) => {
  const { amb, s, sessao, pedir } = await consoleComSessao(t);
  const preparar = (args) => pedir("/api/acoes/ci.disparar/preparar", { metodo: "POST", corpo: { argumentos: args } });

  assert.match((await preparar({ workflow: "ci" })).json.impedimento, /credencial do GitHub/);
  amb.github.gravarToken(TOKEN);
  assert.equal((await preparar({ workflow: "ci" })).json.impedimento, null);
  assert.equal((await preparar({ workflow: "deploy" })).status, 400);
  assert.equal((await preparar({ workflow: "console" })).status, 400, "a Console release starts only from a pushed tag");
  assert.match((await preparar({ workflow: "android", commit: "a".repeat(40) })).json.impedimento, /só a validação/);
  assert.match((await preparar({ workflow: "pages", matrizAmpla: true })).json.impedimento, /matriz ampla/);
  assert.equal((await preparar({ workflow: "ci", commit: "abc" })).status, 400, "the expected commit is a full SHA");

  const semElevacao = await pedir("/api/acoes/ci.disparar/executar", { metodo: "POST", corpo: { argumentos: { workflow: "ci" } } });
  assert.equal(semElevacao.status, 403);
  assert.equal(semElevacao.json.precisaElevacao, true);
  assert.ok(s && sessao);
});

test("the dispatch sends only the inputs the workflow declares, on main", async (t) => {
  const falso = await githubFalso({
    [`POST ${BASE_REPO}/actions/workflows/ci.yml/dispatches`]: (req, res) => json(res, 200, { workflow_run_id: 555 }),
    [`GET ${BASE_REPO}/actions/runs/555`]: (req, res) => json(res, 200, run(555, "ci.yml", { status: "queued", conclusion: null, event: "workflow_dispatch" })),
  });
  t.after(() => falso.fechar());
  const { amb, sessao, s, pedir } = await consoleComSessao(t, { githubApi: falso.base });
  amb.github.gravarToken(TOKEN);
  await ajuda.elevar(amb, s.porta, sessao);
  const commit = "b".repeat(40);
  const r = await pedir("/api/acoes/ci.disparar/executar", { metodo: "POST", corpo: { argumentos: { workflow: "ci", commit, matrizAmpla: true }, aceitarAvisos: true } });
  assert.equal(r.status, 202);
  assert.equal(r.json.resultado.ok, true);
  assert.equal(r.json.resultado.run.id, 555, "a run id in the dispatch answer correlates exactly");
  const disparo = falso.chamadas.find((c) => c.metodo === "POST");
  assert.deepEqual(JSON.parse(disparo.corpo), { ref: "main", inputs: { expected_sha: commit, android_broad_matrix: true }, return_run_details: true });
});

test("runs of workflows the Console does not administer are neither shown, repeated, cancelled nor downloaded", async (t) => {
  const falso = await githubFalso({
    [`GET ${BASE_REPO}/actions/runs/31`]: (req, res) => json(res, 200, run(31, "outro.yml")),
    [`GET ${BASE_REPO}/actions/runs/31/artifacts`]: (req, res) => json(res, 200, { artifacts: [{ id: 5, name: "x", size_in_bytes: 1, expired: false }] }),
  });
  t.after(() => falso.fechar());
  const { amb, pedir } = await consoleComSessao(t, { githubApi: falso.base });
  amb.github.gravarToken(TOKEN);

  const detalhe = await pedir("/api/ci/runs/31");
  assert.equal(detalhe.status, 403);
  assert.match(detalhe.json.erro, /não administra/);
  assert.match((await amb.github.reexecutarRun(31)).erro, /não administra/);
  assert.match((await amb.github.cancelarRun(31)).erro, /não administra/);
  assert.equal((await pedir("/api/ci/runs/31/artefatos/5")).status, 403);
  assert.ok(!falso.chamadas.some((c) => c.metodo === "POST"), "nothing may be sent to GitHub for such a run");
});

test("loopback origins are recognised in every form an APK manifest can carry", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const checkout = checkoutComApk(t).checkout;
  const amb2 = ajuda.ambiente({ checkout });
  t.after(() => amb2.restaurar());
  for (const origem of ["http://127.0.0.2:8080", "http://[::ffff:127.0.0.1]:8080", "http://[::1]", "http://app.localhost", "http://app.localhost.", "http://localhost.:8080", "http://0.0.0.0:8080", "http://[::ffff:0:0]", "http://[::]:8080"]) {
    const pasta = path.join(checkout, "remoteifes-server", "data", "releases", "mobile");
    const meta = JSON.parse(fs.readFileSync(path.join(pasta, "release.json"), "utf8"));
    fs.writeFileSync(path.join(pasta, "release.json"), JSON.stringify({ ...meta, serverOrigin: origem }));
    fs.writeFileSync(path.join(checkout, "remoteifes-server", ".env"), `CORS_ORIGIN=${origem}\n`);
    const rel = amb2.mobile.releasePublicado();
    assert.equal(rel.valido, false, origem);
    assert.ok(rel.problemas.some((p) => /loopback/.test(p)), origem);
  }
  assert.ok(amb);
});

test("a run is followed with its jobs and artifacts, repeated only when finished and cancelled only while running", async (t) => {
  let estadoRun = run(41, "android.yml");
  const falso = await githubFalso({
    [`GET ${BASE_REPO}/actions/runs/41`]: (req, res) => json(res, 200, estadoRun),
    [`GET ${BASE_REPO}/actions/runs/41/jobs`]: (req, res) =>
      json(res, 200, { jobs: [{ id: 1, name: "Native smoke", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "emulador", status: "completed", conclusion: "failure" }] }] }),
    [`GET ${BASE_REPO}/actions/runs/41/artifacts`]: (req, res) => json(res, 200, { artifacts: [{ id: 9, name: "android-validation-apks", size_in_bytes: 3, expired: false }] }),
    [`POST ${BASE_REPO}/actions/runs/41/rerun-failed-jobs`]: (req, res) => json(res, 201, {}),
    [`POST ${BASE_REPO}/actions/runs/41/cancel`]: (req, res) => json(res, 202, {}),
  });
  t.after(() => falso.fechar());
  const { amb, pedir } = await consoleComSessao(t, { githubApi: falso.base });
  amb.github.gravarToken(TOKEN);

  const detalhe = await pedir("/api/ci/runs/41");
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.json.run.chave, "android");
  assert.equal(detalhe.json.jobs[0].etapas[0].conclusao, "failure");
  assert.equal(detalhe.json.artefatos[0].nome, "android-validation-apks");

  assert.equal((await amb.github.cancelarRun(41)).erro, "a execução já terminou");
  assert.equal((await amb.github.reexecutarRun(41)).ok, true);
  estadoRun = run(41, "android.yml", { status: "in_progress", conclusion: null });
  assert.match((await amb.github.reexecutarRun(41)).erro, /ainda não terminou/);
  assert.equal((await amb.github.cancelarRun(41)).ok, true);
  const auditoria = fs.readFileSync(path.join(amb.estadoDir, "auditoria.log"), "utf8");
  assert.match(auditoria, /workflow-reexecutado/);
  assert.match(auditoria, /workflow-cancelado/);
});

test("an artifact streams to the browser without the credential following the redirect", async (t) => {
  const conteudo = crypto.randomBytes(4096);
  const falso = await githubFalso({
    [`GET ${BASE_REPO}/actions/runs/51`]: (req, res) => json(res, 200, run(51, "ci.yml")),
    [`GET ${BASE_REPO}/actions/runs/51/artifacts`]: (req, res) => json(res, 200, { artifacts: [{ id: 7, name: "relatório/../e2e", size_in_bytes: conteudo.length, expired: false }] }),
    [`GET ${BASE_REPO}/actions/artifacts/7/zip`]: (req, res, servidor) => {
      res.writeHead(302, { Location: `http://localhost:${servidor.address().port}/armazenamento/7` });
      res.end();
    },
    "GET /armazenamento/7": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(conteudo);
    },
  });
  t.after(() => falso.fechar());
  const { amb, s, sessao } = await consoleComSessao(t, { githubApi: falso.base });
  amb.github.gravarToken(TOKEN);

  const semSessao = await ajuda.pedir(s.porta, "/api/ci/runs/51/artefatos/7");
  assert.equal(semSessao.status, 401);
  const r = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: s.porta, path: "/api/ci/runs/51/artefatos/7", headers: { Host: s.host, Cookie: sessao.cookie } }, (res) => {
      const partes = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve({ status: res.statusCode, cabecalhos: res.headers, corpo: Buffer.concat(partes) }));
    }).on("error", reject);
  });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.equals(conteudo));
  assert.equal(r.cabecalhos["content-disposition"], 'attachment; filename="relat_rio_.._e2e.zip"');
  const armazenamento = falso.chamadas.find((c) => c.caminho === "/armazenamento/7");
  assert.equal(armazenamento.autorizacao, null, "the token goes to the API host only");
  assert.equal((await ajuda.pedir(s.porta, "/api/ci/runs/51/artefatos/8", { cookie: sessao.cookie })).status, 404);
});

test("the GitHub credential goes in through an elevated action and never comes back", async (t) => {
  const falso = await githubFalso({
    [`GET ${BASE_REPO}`]: (req, res) => json(res, 200, { full_name: "SENAI4LIFE/RemoteIFES" }),
    [`GET ${BASE_REPO}/actions/workflows`]: (req, res) => json(res, 200, { total_count: 7 }),
  });
  t.after(() => falso.fechar());
  const { amb, s, sessao, pedir } = await consoleComSessao(t, { githubApi: falso.base });

  const preparo = await pedir("/api/acoes/github.credencial/preparar", { metodo: "POST", corpo: { argumentos: { token: TOKEN } } });
  assert.equal(preparo.status, 200);
  assert.ok(!preparo.texto.includes(TOKEN), "the preparation echo omits the secret");
  assert.equal((await pedir("/api/acoes/github.credencial/executar", { metodo: "POST", corpo: { argumentos: { token: TOKEN } } })).status, 403);
  await ajuda.elevar(amb, s.porta, sessao);
  const r = await pedir("/api/acoes/github.credencial/executar", { metodo: "POST", corpo: { argumentos: { token: TOKEN } } });
  assert.equal(r.status, 202);
  assert.equal(r.json.resultado.conferencia.ok, true);
  assert.ok(!r.texto.includes(TOKEN));
  assert.equal(amb.github.temToken(), true);
  for (const rota of ["/api/mobile", "/api/github/conferir", "/api/auditoria"]) {
    assert.ok(!(await pedir(rota)).texto.includes(TOKEN), `${rota} must not return the token`);
  }
  assert.ok(!fs.readFileSync(path.join(amb.estadoDir, "auditoria.log"), "utf8").includes(TOKEN));
  await pedir("/api/acoes/github.remover-credencial/executar", { metodo: "POST", corpo: {} });
  assert.equal(amb.github.temToken(), false);
});

function checkoutComApk(t, { adulterar = false, foraDaPasta = false, depuravel = false, nome = "RemoteIFES.apk", origem = "https://remoteifes.example.invalid" } = {}) {
  const checkout = ajuda.dirTemporario("console-checkout-");
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const pasta = path.join(checkout, "remoteifes-server", "data", "releases", "mobile");
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(checkout, "remoteifes-server", ".env"), "CORS_ORIGIN=https://remoteifes.example.invalid\n");
  const apk = crypto.randomBytes(200 * 1024);
  fs.writeFileSync(path.join(pasta, nome), adulterar ? Buffer.concat([apk, Buffer.from("x")]) : apk);
  fs.writeFileSync(path.join(checkout, "segredo.apk"), apk);
  fs.writeFileSync(path.join(pasta, "release.json"), JSON.stringify({
    file: foraDaPasta ? "../../../../segredo.apk" : nome,
    version: "2.0.0",
    build: 7,
    sha256: crypto.createHash("sha256").update(apk).digest("hex"),
    certificateSha256: "c".repeat(64),
    artifactType: "release",
    signed: true,
    debuggable: depuravel,
    minSdk: 24,
    targetSdk: 36,
    releaseDate: "2026-10-01",
    serverOrigin: origem,
  }));
  return { checkout, apk, arquivo: path.join(pasta, nome) };
}

function baixar(s, sessao, caminho) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: s.porta, path: caminho, headers: { Host: s.host, Cookie: sessao.cookie } }, (res) => {
      const partes = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve({ status: res.statusCode, completo: true, tamanho: Number(res.headers["content-length"]), dados: Buffer.concat(partes) }));
      res.on("error", () => resolve({ status: res.statusCode, completo: false, dados: Buffer.concat(partes) }));
      res.on("aborted", () => resolve({ status: res.statusCode, completo: false, dados: Buffer.concat(partes) }));
    });
    req.on("error", () => resolve({ status: null, completo: false, dados: Buffer.alloc(0) }));
  });
}

test("the published APK is downloaded and its integrity is recomputed", async (t) => {
  const { checkout, apk } = checkoutComApk(t);
  const { pedir, s, sessao } = await consoleComSessao(t, { checkout });
  const corpo = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: s.porta, path: "/api/mobile/apk", headers: { Host: s.host, Cookie: sessao.cookie } }, (res) => {
      const partes = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve({ status: res.statusCode, nome: res.headers["content-disposition"], dados: Buffer.concat(partes) }));
    });
  });
  assert.equal(corpo.status, 200);
  assert.ok(corpo.dados.equals(apk));
  assert.equal(corpo.nome, 'attachment; filename="RemoteIFES-2.0.0-7.apk"');
  assert.equal((await pedir("/api/mobile/apk/conferir")).json.ok, true);
  const situacao = (await pedir("/api/mobile")).json.release;
  assert.equal(situacao.arquivo, "RemoteIFES.apk");
  assert.equal(situacao.publicadoEm, "2026-10-01");
  assert.equal(situacao.certificadoSha256, "c".repeat(64));
});

test("an APK the application would refuse is neither offered nor served", async (t) => {
  const adulterado = checkoutComApk(t, { adulterar: true });
  const primeiro = await consoleComSessao(t, { checkout: adulterado.checkout });
  const conferencia = await primeiro.pedir("/api/mobile/apk/conferir");
  assert.equal(conferencia.json.ok, false);
  assert.match(conferencia.json.erro, /não confere/);
  assert.equal((await primeiro.pedir("/api/mobile/apk")).status, 409, "altered bytes are never served");
  const situacao = (await primeiro.pedir("/api/mobile")).json.release;
  assert.equal(situacao.baixavel, false);
  assert.match(situacao.impedimento, /não confere/);

  const depuravel = checkoutComApk(t, { depuravel: true });
  const segundo = await consoleComSessao(t, { checkout: depuravel.checkout });
  const rel = (await segundo.pedir("/api/mobile")).json.release;
  assert.equal(rel.valido, false);
  assert.equal(rel.baixavel, false);
  assert.match(rel.impedimento, /sem depuração/);
  assert.equal((await segundo.pedir("/api/mobile/apk")).status, 409);

  const fora = checkoutComApk(t, { foraDaPasta: true });
  const terceiro = await consoleComSessao(t, { checkout: fora.checkout });
  assert.equal((await terceiro.pedir("/api/mobile/apk")).status, 409);
  assert.match((await terceiro.pedir("/api/mobile")).json.release.impedimento, /nome de arquivo da pasta servida/);
});

test("an APK built for another deployment or for loopback is not offered", async (t) => {
  for (const [origem, motivo] of [["https://outro-campus.example.invalid", /não é uma origem desta instalação/], ["http://127.0.0.1:8080", /loopback/]]) {
    const { checkout } = checkoutComApk(t, { origem });
    const { pedir } = await consoleComSessao(t, { checkout });
    const rel = (await pedir("/api/mobile")).json.release;
    assert.equal(rel.baixavel, false, origem);
    assert.match(rel.impedimento, motivo);
    assert.equal((await pedir("/api/mobile/apk")).status, 409, origem);
  }
});

test("APK names the application refuses are not offered even with a matching hash", async (t) => {
  for (const nome of ["RemoteIFES.bin", "RemoteIFES-debug.apk", "app-release-unsigned.apk"]) {
    const { checkout } = checkoutComApk(t, { nome });
    const { pedir } = await consoleComSessao(t, { checkout });
    const rel = (await pedir("/api/mobile")).json.release;
    assert.equal(rel.baixavel, false, nome);
    assert.equal((await pedir("/api/mobile/apk")).status, 409, nome);
  }
});

test("bytes replaced after the check never reach the browser complete", async (t) => {
  const { checkout, arquivo, apk } = checkoutComApk(t);
  const { amb, pedir, s, sessao } = await consoleComSessao(t, { checkout });
  const aprovado = await amb.mobile.apkServivel();
  assert.ok(aprovado.arquivo);
  fs.writeFileSync(arquivo, crypto.randomBytes(apk.length));
  const original = amb.mobile.apkServivel;
  amb.mobile.apkServivel = async () => aprovado;
  t.after(() => (amb.mobile.apkServivel = original));
  const r = await baixar(s, sessao, "/api/mobile/apk");
  assert.ok(!(r.status === 200 && r.completo), "a download with unverified bytes must not complete");
  assert.ok(r.dados.length < apk.length);
  assert.match(fs.readFileSync(path.join(amb.estadoDir, "auditoria.log"), "utf8"), /apk-divergente-no-envio/);
  assert.equal((await pedir("/api/mobile/apk/conferir")).json.ok, false);
});

test("a Console running from the source code has nothing to uninstall and refuses to try", async (t) => {
  const { amb, s, sessao, pedir } = await consoleComSessao(t);
  const situacao = (await pedir("/api/desinstalacao")).json;
  assert.equal(situacao.modo, "indisponivel");
  assert.equal(situacao.simulavel, false);
  await ajuda.elevar(amb, s.porta, sessao);
  const r = await pedir("/api/acoes/console.desinstalar/executar", { metodo: "POST", corpo: { argumentos: {}, confirmacao: "desinstalar" } });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /código-fonte/);
  assert.equal((await pedir("/api/acoes/console.desinstalar/executar", { metodo: "POST", corpo: { argumentos: {} } })).status, 400, "the typed confirmation is required");
});

function situacaoInstalada(t, registro, { estadoDoProcesso } = {}) {
  const base = ajuda.dirTemporario("console-instalado-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const raiz = path.join(base, "programa");
  const payload = path.join(raiz, "versoes", "1.0.0");
  for (const nome of ["src", "instalacao", "package.json"]) fs.cpSync(path.join(ajuda.RAIZ, nome), path.join(payload, nome), { recursive: true });
  const estado = path.join(base, "estado");
  fs.mkdirSync(estado);
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: "1.0.0", ...registro(estado) }));
  const programa =
    "const d = require(process.argv[1]); let args = null; try { args = d.argumentosDoDesinstalador('--sim'); } catch (e) { args = 'recusado: ' + e.message; }" +
    "process.stdout.write(JSON.stringify({ situacao: d.situacao(), args }));";
  const saida = require("child_process").execFileSync(process.execPath, ["-e", programa, path.join(payload, "src", "desinstalacao.js")], {
    env: { ...process.env, CONSOLE_ESTADO_DIR: estadoDoProcesso || estado, CONSOLE_PLATAFORMA: "linux", CONSOLE_SEM_PRIVILEGIO: "1" },
  });
  return { ...JSON.parse(saida), raiz, estado, payload };
}

test("a user installation is uninstalled by the Console with the uninstaller pinned to its root, state and scope", (t) => {
  const r = situacaoInstalada(t, (estado) => ({ escopo: "usuario", estado }));
  assert.equal(r.situacao.modo, "console");
  assert.deepEqual(r.args, [path.join(r.payload, "instalacao", "desinstalar.js"), "--raiz", r.raiz, "--estado", r.estado, "--escopo", "usuario", "--sim"]);
});

test("an installation whose record names another state directory is never uninstalled from the Console", (t) => {
  const outro = ajuda.dirTemporario("console-outro-estado-");
  t.after(() => fs.rmSync(outro, { recursive: true, force: true }));
  const r = situacaoInstalada(t, (estado) => ({ escopo: "usuario", estado }), { estadoDoProcesso: outro });
  assert.equal(r.situacao.modo, "indisponivel");
  assert.equal(r.situacao.simulavel, false);
  assert.match(r.situacao.motivo, /bloqueada para não misturar/);
  assert.match(r.args, /^recusado:/);
  const semEstado = situacaoInstalada(t, () => ({ escopo: "usuario" }));
  assert.equal(semEstado.situacao.modo, "indisponivel");
});

test("a Linux system installation is uninstalled from the terminal, with the simulation still available", (t) => {
  const r = situacaoInstalada(t, (estado) => ({ escopo: "sistema", estado }));
  assert.equal(r.situacao.modo, "terminal");
  assert.equal(r.situacao.simulavel, true);
  assert.match(r.situacao.comando, /^sudo .*desinstalar\.js" --sim$|^sudo .*desinstalar\.js --sim$/);
  assert.match(r.situacao.motivo, /root/);
});

test("the Console release workflow is followed but never repeated or cancelled", async (t) => {
  const falso = await githubFalso({
    [`GET ${BASE_REPO}/actions/runs/61`]: (req, res) => json(res, 200, run(61, "console-release.yml")),
    [`GET ${BASE_REPO}/actions/runs/61/jobs`]: (req, res) => json(res, 200, { jobs: [] }),
    [`GET ${BASE_REPO}/actions/runs/61/artifacts`]: (req, res) => json(res, 200, { artifacts: [] }),
  });
  t.after(() => falso.fechar());
  const { amb, s, sessao, pedir } = await consoleComSessao(t, { githubApi: falso.base });
  amb.github.gravarToken(TOKEN);
  assert.equal((await pedir("/api/ci/runs/61")).status, 200);
  await ajuda.elevar(amb, s.porta, sessao);
  for (const [acao, args] of [["ci.reexecutar", { run: "61" }], ["ci.reexecutar", { run: "61", tudo: true }], ["ci.cancelar", { run: "61" }]]) {
    const r = await pedir(`/api/acoes/${acao}/executar`, { metodo: "POST", corpo: { argumentos: args } });
    assert.equal(r.json.resultado.ok, false);
    assert.match(r.json.resultado.erro, /só acompanha/);
  }
  assert.ok(!falso.chamadas.some((c) => c.metodo === "POST"), "nothing may be sent to GitHub for the release workflow");
});

test("updating the Console is refused without a target version", async (t) => {
  const { pedir } = await consoleComSessao(t);
  const r = await pedir("/api/acoes/console.atualizar/preparar", { metodo: "POST", corpo: { argumentos: {} } });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /versao/);
});
