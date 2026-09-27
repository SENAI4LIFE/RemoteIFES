const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const ajuda = require("./helpers");

// The installed Console as a real process on a host with no Internet: no DNS in one test, no route
// off the host in the other (remoteifes-server/test/support/sem-internet.js). It must start, prove
// its identity to the launcher, serve every page and keep the installed version, while its
// automatic update check runs in the background, fails quietly and waits its turn.

const SEM_INTERNET = path.join(ajuda.RAIZ, "..", "remoteifes-server", "test", "support", "sem-internet.js");
const IMEDIATA = path.join(ajuda.RAIZ, "test", "support", "verificacao-imediata.js");

async function portaLivre() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const porta = s.address().port;
  await new Promise((r) => s.close(r));
  return porta;
}

async function esperar(condicao, limiteMs, descricao) {
  const fim = Date.now() + limiteMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando ${descricao}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * An installed layout whose active version is the source's, plus an operator, in a state
 * directory of its own.
 */
function prepararInstalacao(t) {
  const amb = ajuda.ambiente();
  const versao = amb.atualizador.versaoEmExecucao();
  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const raiz = ajuda.dirTemporario("console-inst-");
  const dir = path.join(raiz, "versoes", versao);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "remoteifes-console", version: versao }));
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: versao, versaoAnterior: null, transacao: null }));
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  return { estadoDir: amb.estadoDir, raiz, versao };
}

function ambienteDoFilho({ estadoDir, raiz, porta, modo, registro }) {
  const env = { ...process.env };
  for (const chave of Object.keys(env)) if (chave.startsWith("CONSOLE_")) delete env[chave];
  return {
    ...env,
    CONSOLE_ESTADO_DIR: estadoDir,
    CONSOLE_RAIZ_INSTALACAO: raiz,
    CONSOLE_CHECKOUT_DIR: path.join(ajuda.RAIZ, ".."),
    CONSOLE_SEM_PRIVILEGIO: "1",
    CONSOLE_PORTA: String(porta),
    CONSOLE_OCIOSIDADE_S: "0",
    SEM_INTERNET: modo,
    SEM_INTERNET_REGISTRO: registro,
  };
}

function tentativas(registro) {
  if (!fs.existsSync(registro)) return [];
  return fs.readFileSync(registro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function consoleSemInternet(t, modo) {
  const inst = prepararInstalacao(t);
  const porta = await portaLivre();
  const registro = path.join(inst.estadoDir, "tentativas-de-rede.jsonl");
  const filho = spawn(process.execPath, ["--require", SEM_INTERNET, "--require", IMEDIATA, path.join(ajuda.RAIZ, "console.js")], {
    env: ambienteDoFilho({ ...inst, porta, modo, registro }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  let erros = "";
  filho.stdout.on("data", (d) => (saida += d));
  filho.stderr.on("data", (d) => (erros += d));
  t.after(() => filho.kill());
  const inicio = Date.now();
  const contrato = await esperar(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(inst.estadoDir, "endereco.json"), "utf8"));
    } catch {
      return null;
    }
  }, 20_000, "o contrato de identidade do console");
  return { ...inst, porta, registro, filho, contrato, inicio, saida: () => saida, erros: () => erros };
}

async function exercitar(c) {
  // The launcher's readiness proof: HMAC of a challenge with the contract's secret.
  const desafio = crypto.randomBytes(16).toString("base64url");
  const id = await ajuda.pedir(c.porta, `/api/identidade?desafio=${desafio}`);
  assert.equal(id.status, 200, id.texto);
  const esperado = crypto.createHmac("sha256", Buffer.from(c.contrato.segredo, "base64url")).update(desafio).digest("base64url");
  assert.equal(id.json.prova, esperado, "the Console proves its identity");

  const login = await ajuda.pedir(c.porta, "/api/sessao", {
    metodo: "POST",
    corpo: { nome: "operador", senha: "senha-de-teste-12345" },
    origem: `http://127.0.0.1:${c.porta}`,
  });
  assert.equal(login.status, 200, login.texto);
  const cookie = ajuda.cookieDe(login);
  for (const caminho of ["/", "/api/painel", "/api/programa", "/api/atualizacao", "/api/host"]) {
    // /api/programa and /api/host probe the host's tools: tens of seconds on a Windows runner.
    const r = await ajuda.pedir(c.porta, caminho, { cookie, timeoutMs: 120_000 });
    assert.equal(r.status, 200, `${caminho}: ${r.texto.slice(0, 200)}`);
  }
  return cookie;
}

for (const [modo, codigo] of [
  ["dns", "EAI_AGAIN"],
  ["rota", "ENETUNREACH"],
]) {
  const descricao = modo === "dns" ? "DNS unavailable" : "no route off the host";
  test(`the installed Console starts and serves with ${descricao}, and its update check defers quietly`, async (t) => {
    const c = await consoleSemInternet(t, modo);
    assert.ok(Date.now() - c.inicio < 15_000, "startup did not wait for the network");
    const cookie = await exercitar(c);

    // The background check has run by itself, failed as a network result and scheduled a retry.
    const agenda = path.join(c.estadoDir, "verificacao-automatica.json");
    const estado = await esperar(() => {
      try {
        const s = JSON.parse(fs.readFileSync(agenda, "utf8"));
        return s.ultimaTentativa && s.ultimaTentativa.tipo !== "em-andamento" ? s : null;
      } catch {
        return null;
      }
    }, 20_000, "a verificação automática");
    assert.equal(estado.ultimaTentativa.tipo, "sem-rede");
    assert.match(estado.ultimaTentativa.motivo, new RegExp(codigo));
    assert.equal(estado.falhasSeguidas, 1);
    assert.ok(estado.proximaEm - Date.now() > 20 * 60_000, "the next attempt is a backoff away, not a loop");

    // Every attempt to leave the host came from the update check, and only went to the publication.
    const feitas = tentativas(c.registro);
    assert.ok(feitas.length >= 1, "the check did try");
    for (const f of feitas) {
      assert.match(f.destino, /^github\.com(:443)?$/, `unexpected destination ${f.destino}`);
      assert.ok(f.pilha.some((l) => /atualizador\.js/.test(l)), `an attempt did not come from the updater: ${f.pilha.join(" | ")}`);
    }

    // The Console goes on serving, with the installed version, and said nothing alarming.
    const r = await ajuda.pedir(c.porta, "/api/programa", { cookie, timeoutMs: 120_000 });
    assert.equal(r.status, 200);
    assert.equal(r.json.console.versaoEmExecucao, c.versao);
    assert.equal(r.json.console.verificacaoAutomatica.ultimaTentativa.tipo, "sem-rede");
    assert.deepEqual(fs.readdirSync(path.join(c.raiz, "versoes")), [c.versao]);
    assert.equal(c.erros().trim(), "", "nothing on stderr");
    const auditoria = fs.readFileSync(path.join(c.estadoDir, "auditoria.log"), "utf8");
    assert.equal((auditoria.match(/atualizacao-automatica-adiada/g) || []).length, 1);
  });
}

test("the launcher's status needs no network", async (t) => {
  const inst = prepararInstalacao(t);
  const registro = path.join(inst.estadoDir, "tentativas-de-rede.jsonl");
  const r = spawnSync(process.execPath, ["--require", SEM_INTERNET, path.join(ajuda.RAIZ, "launcher.js"), "--status"], {
    env: ambienteDoFilho({ ...inst, porta: await portaLivre(), modo: "rota", registro }),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Versão console\s*:/);
  assert.deepEqual(tentativas(registro), [], "the status tried to leave the host");
});
