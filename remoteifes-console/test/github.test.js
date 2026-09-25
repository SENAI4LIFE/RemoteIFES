const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ajuda = require("./helpers");

// GitHub integration, exercised against a fake server. The cases that matter are the edges: missing
// credential, no permission, rate limit, dispatch without an id in the response, ambiguous
// dispatch, expired artifact and download with digest verification.

function servidorFalso(rotas) {
  const chamadas = [];
  const servidor = http.createServer((req, res) => {
    chamadas.push({ metodo: req.method, url: req.url, autorizacao: req.headers.authorization, versaoApi: req.headers["x-github-api-version"] });
    let corpo = "";
    req.on("data", (d) => {
      corpo += d;
    });
    req.on("end", () => {
      const chave = `${req.method} ${req.url.split("?")[0]}`;
      const manipulador = rotas[chave] || rotas[`${req.method} *`];
      if (!manipulador) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Not Found" }));
      }
      manipulador(req, res, corpo);
    });
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () => {
      resolve({
        chamadas,
        porta: servidor.address().port,
        base: `http://127.0.0.1:${servidor.address().port}`,
        fechar: () => new Promise((r) => servidor.close(() => r())),
      });
    });
  });
}

function json(res, status, corpo, cabecalhos = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...cabecalhos });
  res.end(JSON.stringify(corpo));
}

const BASE_REPO = "/repos/SENAI4LIFE/RemoteIFES";

test("without a credential the Console does not query GitHub and says why", async (t) => {
  const falso = await servidorFalso({});
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  const r = await amb.github.listarRuns({ workflow: "ci" });
  assert.equal(r.ok, false);
  assert.equal(r.semCredencial, true);
  assert.equal(falso.chamadas.length, 0, "não pode haver requisição sem credencial");

  const ci = await amb.mobile.estadoCI();
  assert.equal(ci.disponivel, false);
  assert.match(ci.orientacao, /não depende do GitHub/);
});

test("the token is stored outside the API and sent only in the header", async (t) => {
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/workflows/ci.yml/runs`]: (req, res) => json(res, 200, { workflow_runs: [] }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  await amb.github.listarRuns({ workflow: "ci" });

  assert.equal(falso.chamadas[0].autorizacao, "Bearer ghp_tokenfalsoparateste000000000000000");
  assert.equal(falso.chamadas[0].versaoApi, "2022-11-28", "a versão de API é fixada");
  assert.ok(!falso.chamadas[0].url.includes("ghp_"), "o token nunca vai na URL");

  const estado = amb.github.estadoDoToken();
  assert.equal(estado.presente, true);
  assert.equal(estado.valor, undefined);
  assert.ok(!JSON.stringify(estado).includes("ghp_tokenfalso"));

  const arquivo = path.join(amb.estadoDir, "segredos.json");
  assert.equal((fs.statSync(arquivo).mode & 0o777).toString(8).padStart(3, "0").slice(-3) <= "600" || process.platform === "win32", true);
});

test("workflows and repositories outside the list are refused before any request", async (t) => {
  const falso = await servidorFalso({});
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  assert.equal((await amb.github.listarRuns({ workflow: "qualquer-um" })).erro, "workflow não permitido");
  assert.equal((await amb.github.dispararWorkflow("malicioso")).erro, "workflow não permitido");
  assert.equal(falso.chamadas.length, 0);
});

test("dispatch inputs are validated", async (t) => {
  const falso = await servidorFalso({});
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  assert.match((await amb.github.dispararWorkflow("ci", { ramo: "main; rm -rf /" })).erro, /ramo inválido/);
  assert.match((await amb.github.dispararWorkflow("ci", { entradas: { "Chave-Ruim": "x" } })).erro, /entrada inválida/);
  assert.match((await amb.github.dispararWorkflow("ci", { entradas: { ok: "x".repeat(300) } })).erro, /valor inválido/);
  assert.equal(falso.chamadas.length, 0);
});

test("a rate limit is reported as such, not as a generic failure", async (t) => {
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/workflows/ci.yml/runs`]: (req, res) =>
      json(res, 403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
      }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.listarRuns({ workflow: "ci" });
  assert.equal(r.ok, false);
  assert.match(r.erro, /limite de requisições/);
  assert.ok(r.limite.reiniciaEm);
});

test("an invalid credential and insufficient permission have distinct messages", async (t) => {
  let status = 401;
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/workflows/ci.yml/runs`]: (req, res) => json(res, status, { message: "Bad credentials" }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  assert.match((await amb.github.listarRuns({ workflow: "ci" })).erro, /inválida ou expirada/);
  status = 403;
  assert.match((await amb.github.listarRuns({ workflow: "ci" })).erro, /sem permissão/);
  status = 404;
  assert.match((await amb.github.listarRuns({ workflow: "ci" })).erro, /não encontrado/);
});

test("a dispatch that returns the run id uses that id, without guessing", async (t) => {
  const falso = await servidorFalso({
    [`POST ${BASE_REPO}/actions/workflows/android.yml/dispatches`]: (req, res) => json(res, 201, { id: 99001 }),
    [`GET ${BASE_REPO}/actions/runs/99001`]: (req, res) =>
      json(res, 200, { id: 99001, name: "Android APK", path: ".github/workflows/android.yml", status: "queued", conclusion: null, head_sha: "a".repeat(40), head_branch: "main", run_number: 5, run_attempt: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: "https://exemplo", event: "workflow_dispatch" }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.dispararWorkflow("android", { ramo: "main" });
  assert.equal(r.ok, true);
  assert.equal(r.run.id, 99001);
  assert.match(r.correlacao, /id devolvido/);
});

test("a dispatch without a body (204) is correlated by time window, not by 'the most recent'", async (t) => {
  const criado = new Date().toISOString();
  const falso = await servidorFalso({
    [`POST ${BASE_REPO}/actions/workflows/ci.yml/dispatches`]: (req, res) => {
      res.writeHead(204);
      res.end();
    },
    [`GET ${BASE_REPO}/actions/workflows/ci.yml/runs`]: (req, res) =>
      json(res, 200, {
        workflow_runs: [
          { id: 4242, name: "CI", path: ".github/workflows/ci.yml", status: "queued", conclusion: null, head_sha: "b".repeat(40), head_branch: "main", run_number: 9, run_attempt: 1, created_at: criado, updated_at: criado, html_url: "https://exemplo", event: "workflow_dispatch" },
        ],
      }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.dispararWorkflow("ci", { ramo: "main" });
  assert.equal(r.ok, true);
  assert.equal(r.run.id, 4242);
  assert.match(r.correlacao, /janela de tempo/);
});

test("several dispatches in the same window are declared ambiguous instead of guessed", async (t) => {
  const criado = new Date().toISOString();
  const run = (id) => ({ id, name: "CI", path: ".github/workflows/ci.yml", status: "queued", conclusion: null, head_sha: "c".repeat(40), head_branch: "main", run_number: id, run_attempt: 1, created_at: criado, updated_at: criado, html_url: "https://exemplo", event: "workflow_dispatch" });
  const falso = await servidorFalso({
    [`POST ${BASE_REPO}/actions/workflows/ci.yml/dispatches`]: (req, res) => {
      res.writeHead(204);
      res.end();
    },
    [`GET ${BASE_REPO}/actions/workflows/ci.yml/runs`]: (req, res) => json(res, 200, { workflow_runs: [run(1), run(2)] }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.dispararWorkflow("ci", { ramo: "main" });
  assert.equal(r.ambiguo, true);
  assert.match(r.erro, /não é possível afirmar qual é a sua/);
  assert.equal(r.candidatos.length, 2);
});

test("an expired artifact is not downloaded", async (t) => {
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/runs/7/artifacts`]: (req, res) =>
      json(res, 200, { artifacts: [{ id: 55, name: "apks", size_in_bytes: 10, expired: true, expires_at: "2026-01-01T00:00:00Z", created_at: "2025-12-01T00:00:00Z" }] }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.baixarArtefato(7, 55, path.join(amb.estadoDir, "x.zip"));
  assert.equal(r.ok, false);
  assert.match(r.erro, /expirou/);
});

test("an artifact that does not belong to the run is refused", async (t) => {
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/runs/7/artifacts`]: (req, res) => json(res, 200, { artifacts: [{ id: 55, name: "apks", size_in_bytes: 10, expired: false }] }),
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const r = await amb.github.baixarArtefato(7, 999, path.join(amb.estadoDir, "x.zip"));
  assert.equal(r.ok, false);
  assert.match(r.erro, /não pertence a esta execução/);
});

test("the download checks the size and computes the digest of what was written", async (t) => {
  const conteudo = Buffer.from("PK-conteudo-de-teste-do-artefato");
  const falso = await servidorFalso({
    [`GET ${BASE_REPO}/actions/runs/7/artifacts`]: (req, res) =>
      json(res, 200, { artifacts: [{ id: 55, name: "apks", size_in_bytes: conteudo.length, expired: false, digest: "sha256:declarado" }] }),
    [`GET ${BASE_REPO}/actions/artifacts/55/zip`]: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(conteudo);
    },
  });
  const amb = ajuda.ambiente({ githubApi: falso.base });
  t.after(async () => {
    await falso.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  const destino = path.join(amb.estadoDir, "artefato.zip");
  const r = await amb.github.baixarArtefato(7, 55, destino);
  assert.equal(r.ok, true);
  assert.equal(r.bytes, conteudo.length);
  assert.equal(r.tamanhoConfere, true);
  assert.equal(r.sha256, crypto.createHash("sha256").update(conteudo).digest("hex"));
  assert.equal(r.digestDeclarado, "sha256:declarado");
  assert.ok(fs.existsSync(destino));
  // The zip is not extracted: CI content is untrusted input and safe extraction is another problem.
  // The Console delivers file + digest.
});

test("a token with an implausible format is refused on save", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  assert.throws(() => amb.github.gravarToken("curto"), /implausível/);
  assert.throws(() => amb.github.gravarToken("com espaco no meio do token 1234567890"), /espaços/);
  amb.github.gravarToken("ghp_tokenfalsoparateste000000000000000");
  assert.equal(amb.github.temToken(), true);
  amb.github.gravarToken(null);
  assert.equal(amb.github.temToken(), false);
});

test("the mobile panel distinguishes workflow success, artifact and publication", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const s = await amb.mobile.situacao();
  assert.equal(s.publicacao.suportadaNoConsole, false);
  assert.match(s.publicacao.motivo, /apksigner|apkanalyzer/);
  assert.match(s.publicacao.artefatosDaCi, /não é artefato de produção|Nenhum deles é artefato de produção/);
  assert.match(s.build.ios, /não produz IPA/);
  assert.ok(s.identidades.observacao.includes("independentes"));
});
