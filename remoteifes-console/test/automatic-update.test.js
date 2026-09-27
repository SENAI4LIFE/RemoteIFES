const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const zlib = require("zlib");
const ajuda = require("./helpers");
const { criarAutoridade, confiarEm, sha256 } = require("./support/atestacoes");
const semInternet = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "test", "support", "sem-internet.js"));

// The automatic update check, and what must stay true around it on a campus with no Internet:
// nothing local waits for it, a failure changes nothing installed, failures back off, recovery is
// automatic, and nothing accumulates. The attestations come from a private test Sigstore
// (test/support/atestacoes.js).

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let autoridade;
test.before(async () => {
  autoridade = await criarAutoridade();
});

function alvoLocal() {
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  return `${so}-${process.arch}`;
}

function tarGz(arquivos) {
  const blocos = [];
  for (const [nome, texto] of Object.entries(arquivos)) {
    const dados = Buffer.from(texto, "utf8");
    const c = Buffer.alloc(512);
    c.write(nome, 0, 100, "utf8");
    c.write("0000644\0", 100, 8, "utf8");
    c.write("0000000\0", 108, 8, "utf8");
    c.write("0000000\0", 116, 8, "utf8");
    c.write(`${dados.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    c.write("00000000000\0", 136, 12, "utf8");
    c.write("        ", 148, 8, "utf8");
    c.write("0", 156, 1, "utf8");
    c.write("ustar\u000000", 257, 8, "utf8");
    let soma = 0;
    for (const b of c) soma += b;
    c.write(`${soma.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocos.push(c, dados, Buffer.alloc((512 - (dados.length % 512)) % 512));
  }
  blocos.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocos));
}

function payload(versao) {
  return tarGz({
    "package.json": JSON.stringify({ name: "remoteifes-console", version: versao }),
    "console.js": "module.exports = { executar() {} };\n",
    "src/servidor.js": "module.exports = {};\n",
    // Big enough for a transfer to be cut in the middle.
    "web/grande.txt": "x".repeat(200_000),
  });
}

async function publicacao(versao) {
  const arquivos = {};
  const conteudo = payload(versao);
  const arquivo = `remoteifes-console-${versao}-${alvoLocal()}.tar.gz`;
  arquivos[arquivo] = conteudo;
  arquivos["manifesto.json"] = Buffer.from(
    `${JSON.stringify({
      esquema: 1,
      versao,
      canal: "estavel",
      publicadoEm: new Date().toISOString(),
      commit: COMMIT,
      minimoParaAtualizar: null,
      artefatos: [{ alvo: alvoLocal(), formato: "tar.gz", arquivo, sha256: sha256(conteudo), bytes: conteudo.length }],
    })}\n`
  );
  const sujeitos = Object.entries(arquivos).map(([name, c]) => ({ name, sha256: sha256(c) }));
  arquivos["atestacao.sigstore.json"] = await autoridade.atestar({ sujeitos, versao, commit: COMMIT });
  return arquivos;
}

/**
 * A release origin whose behaviour the test switches: "normal", "fora" (connection refused, as if
 * the host were unreachable), "mudo" (accepts and never answers) or "corta" (sends half of each
 * artifact and hangs up).
 */
async function origem(arquivos) {
  const pedidos = [];
  let modo = "normal";
  const sockets = new Set();
  const servidor = http.createServer((req, res) => {
    pedidos.push(req.url);
    if (modo === "mudo") return;
    const nome = decodeURIComponent(req.url.replace(/^\//, ""));
    const conteudo = arquivos[nome];
    if (conteudo === undefined) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Length": conteudo.length });
    if (modo === "corta" && nome.endsWith(".tar.gz")) {
      res.write(conteudo.subarray(0, Math.floor(conteudo.length / 2)));
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    res.end(conteudo);
  });
  servidor.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  const porta = servidor.address().port;
  return {
    base: `http://127.0.0.1:${porta}`,
    pedidos,
    definir(novo) {
      modo = novo;
    },
    fechar: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        servidor.close(() => r());
      }),
  };
}

/** A port on which nothing listens: connections are refused, like a host that is down. */
async function portaFechada() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const porta = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${porta}`;
}

/** An installation whose active version is the one this process runs: nothing pending. */
function instalacao(amb) {
  const versao = amb.atualizador.versaoEmExecucao();
  const raiz = ajuda.dirTemporario("console-inst-");
  const dir = path.join(raiz, "versoes", versao);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "remoteifes-console", version: versao }));
  fs.writeFileSync(path.join(dir, "console.js"), "module.exports={executar(){}};");
  fs.writeFileSync(path.join(dir, "src", "servidor.js"), "module.exports={};");
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: versao, versaoAnterior: null, transacao: null }));
  return { raiz, versao };
}

function preparar(t, { base, confiar = true } = {}) {
  const raiz = ajuda.dirTemporario("console-inst-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RELEASE_BASE: base, CONSOLE_RAIZ_INSTALACAO: raiz } });
  const inst = instalacao(amb);
  fs.rmSync(raiz, { recursive: true, force: true });
  process.env.CONSOLE_RAIZ_INSTALACAO = inst.raiz;
  // config reads the environment on require: reload with the installation in place.
  amb.restaurar();
  const final = ajuda.ambiente({ env: { CONSOLE_RELEASE_BASE: base, CONSOLE_RAIZ_INSTALACAO: inst.raiz } });
  const desfazer = confiar ? confiarEm(final, autoridade) : () => {};
  // Nothing restarts during a test.
  const reinicios = [];
  final.plataforma.reiniciarConsole = async () => {
    reinicios.push(Date.now());
    return { disponivel: false, motivo: "teste" };
  };
  t.after(() => {
    desfazer();
    final.restaurar();
    fs.rmSync(inst.raiz, { recursive: true, force: true });
  });
  return { amb: final, raiz: inst.raiz, versao: inst.versao, reinicios };
}

function auditoria(amb) {
  const arquivo = path.join(amb.estadoDir, "auditoria.log");
  if (!fs.existsSync(arquivo)) return [];
  return fs
    .readFileSync(arquivo, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function eventos(amb, prefixo) {
  return auditoria(amb).filter((e) => String(e.evento || e.tipo || "").startsWith(prefixo));
}

// --- Installing ------------------------------------------------------------------------------

test("a newer attested version is installed side by side and activates at the next start, with no restart", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  const { amb, raiz, versao, reinicios } = preparar(t, { base: srv.base });

  const r = await amb.atualizador.atualizarAutomaticamente();
  assert.equal(r.tipo, "atualizado", r.motivo);
  assert.equal(r.versao, "99.1.0");

  const info = amb.atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, "99.1.0");
  assert.equal(info.versaoAnterior, versao, "the running version stays for rollback");
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "99.1.0", "console.js")));
  assert.ok(fs.existsSync(path.join(raiz, "versoes", versao, "console.js")), "the running payload is never pruned");
  assert.deepEqual(reinicios, [], "an automatic update never restarts the Console in use");

  const s = await amb.atualizador.situacao();
  assert.equal(s.divergenciaDeVersao && s.divergenciaDeVersao.reinicioPendente, true, "reported as waiting for the next start");

  // While that restart is pending, the automatic check does not touch the network again.
  const antes = srv.pedidos.length;
  assert.equal((await amb.atualizador.atualizarAutomaticamente()).tipo, "reinicio-pendente");
  assert.equal(srv.pedidos.length, antes);
});

test("an installation already at the published version stays as it is", async (t) => {
  const { amb, versao } = preparar(t, { base: "http://127.0.0.1:9" });
  const srv = await origem(await publicacao(versao));
  t.after(() => srv.fechar());
  process.env.CONSOLE_RELEASE_BASE = srv.base;

  const r = await amb.atualizador.atualizarAutomaticamente();
  assert.equal(r.tipo, "em-dia", r.motivo);
  assert.ok(!srv.pedidos.some((u) => u.endsWith(".tar.gz")), "nothing downloaded");
});

test("a run from source never checks: no layout to update, no network", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  const amb = ajuda.ambiente({ env: { CONSOLE_RELEASE_BASE: srv.base } });
  t.after(async () => {
    amb.restaurar();
    await srv.fechar();
  });
  assert.equal((await amb.atualizador.atualizarAutomaticamente()).tipo, "fora-do-escopo");
  assert.equal(srv.pedidos.length, 0);
});

// --- Failures leave everything as it was ---------------------------------------------------------

test("without the network the installed version is untouched and the result is a deferral, not an error", async (t) => {
  const { amb, raiz, versao } = preparar(t, { base: await portaFechada() });

  const r = await amb.atualizador.atualizarAutomaticamente();
  assert.equal(r.tipo, "sem-rede");
  assert.match(r.motivo, /não está acessível agora/);
  assert.match(r.motivo, /segue funcionando/);
  assert.equal(amb.atualizador.lerEstadoInstalacao().versaoAtiva, versao);
  assert.deepEqual(fs.readdirSync(path.join(raiz, "versoes")), [versao]);
  assert.ok(!fs.existsSync(path.join(raiz, "operacao-em-andamento.json")), "the lock is released");
});

test("an interrupted download leaves nothing that could be installed", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  srv.definir("corta");
  const { amb, raiz, versao } = preparar(t, { base: srv.base });

  const r = await amb.atualizador.atualizarAutomaticamente();
  assert.equal(r.tipo, "sem-rede", r.motivo);
  assert.match(r.motivo, /download falhou/);
  const info = amb.atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, versao);
  assert.ok(!info.transacao || info.transacao.etapa === "concluida" || !/baixando|instalando/.test(info.transacao.etapa), "no transaction stays open");
  assert.deepEqual(fs.readdirSync(path.join(raiz, "versoes")), [versao], "no version or partial directory");
  const descargas = path.join(raiz, "descargas");
  assert.ok(!fs.existsSync(descargas) || fs.readdirSync(descargas).length === 0, "the partial file was removed");
});

test("a release that fails provenance is never downloaded, so never extracted", async (t) => {
  const arquivos = await publicacao("99.1.0");
  const manifesto = JSON.parse(arquivos["manifesto.json"].toString("utf8"));
  // A genuine-looking attestation from another repository over the same files.
  const sujeitos = Object.entries(arquivos)
    .filter(([n]) => n !== "atestacao.sigstore.json")
    .map(([name, c]) => ({ name, sha256: sha256(c) }));
  arquivos["atestacao.sigstore.json"] = await autoridade.atestar({
    sujeitos,
    versao: manifesto.versao,
    commit: COMMIT,
    identidade: { repositorio: "https://github.com/outro/RemoteIFES", repositorioId: "999" },
  });
  const srv = await origem(arquivos);
  t.after(() => srv.fechar());
  const { amb, raiz, versao } = preparar(t, { base: srv.base });

  const r = await amb.atualizador.atualizarAutomaticamente();
  assert.equal(r.tipo, "recusado");
  assert.match(r.motivo, /outro repositório/);
  assert.ok(!srv.pedidos.some((u) => u.endsWith(".tar.gz")), "the artifact was never requested");
  assert.deepEqual(fs.readdirSync(path.join(raiz, "versoes")), [versao]);
});

test("rollback needs no network at all", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  const { amb, versao } = preparar(t, { base: srv.base });
  assert.equal((await amb.atualizador.atualizarAutomaticamente()).tipo, "atualizado");
  await srv.fechar();

  const registro = path.join(amb.estadoDir, "rede.jsonl");
  semInternet.ativar({ modo: "rota", registro });
  t.after(() => semInternet.desativar());
  const r = await amb.atualizador.reverter();
  semInternet.desativar();
  assert.equal(r.ok, true, r.erro);
  assert.equal(amb.atualizador.lerEstadoInstalacao().versaoAtiva, versao);
  assert.ok(!fs.existsSync(registro), "rollback did not try to leave the host");
});

// --- Pacing ------------------------------------------------------------------------------------

test("failures back off exponentially with jitter, up to a day", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const va = amb["verificacao-automatica"];
  const MIN = 60_000;
  const meio = () => 0.5;
  const esperados = [30, 60, 120, 240, 480, 960, 1440, 1440, 1440].map((m) => m * MIN);
  let s = { proximaEm: null, falhasSeguidas: 0, ultimaTentativa: null, ultimoSucessoEm: null };
  const vistos = [];
  for (let i = 0; i < esperados.length; i += 1) {
    s = va.proximoEstado(s, { tipo: "sem-rede", motivo: "sem rota" }, 0, meio);
    vistos.push(s.proximaEm);
  }
  assert.deepEqual(vistos, esperados);
  // Jitter: +-20% around the step, never below or above.
  assert.equal(va.atrasoDeFalha(1, () => 0), 24 * MIN);
  assert.equal(va.atrasoDeFalha(1, () => 1), 36 * MIN);
  assert.equal(va.atrasoDeFalha(50, () => 1), 1728 * MIN, "the ceiling holds for any count");

  // A success resets the count and returns to the twice-a-day rhythm.
  const ok = va.proximoEstado(s, { tipo: "em-dia" }, 0, meio);
  assert.equal(ok.falhasSeguidas, 0);
  assert.equal(ok.proximaEm, 12 * 60 * MIN);
  const atualizado = va.proximoEstado(s, { tipo: "atualizado", versao: "9.9.9" }, 0, meio);
  assert.equal(atualizado.falhasSeguidas, 0, "an installed update resets the backoff too");
  // A refused publication is not retried sooner than the normal rhythm.
  assert.equal(va.proximoEstado(s, { tipo: "recusado", motivo: "x" }, 0, meio).proximaEm, 12 * 60 * MIN);
});

test("recovery is automatic when the publication comes back, and resets the backoff", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  srv.definir("mudo");
  const { amb } = preparar(t, { base: srv.base });
  amb.atualizador.PRAZOS.consultaMs = 300;
  const va = amb["verificacao-automatica"];

  let agora = 1_000_000;
  const controle = va.iniciar({ agora: () => agora, aleatorio: () => 0.5 });
  t.after(() => controle.parar());

  const intervalos = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await controle.executarAgora();
    assert.equal(s.ultimaTentativa.tipo, "sem-rede");
    assert.equal(s.falhasSeguidas, i + 1);
    intervalos.push(s.proximaEm - agora);
    agora = s.proximaEm;
  }
  assert.deepEqual(intervalos, [30, 60, 120].map((m) => m * 60_000), "each failure waits twice as long");

  srv.definir("normal");
  const s = await controle.executarAgora();
  assert.equal(s.ultimaTentativa.tipo, "atualizado", s.ultimaTentativa.motivo);
  assert.equal(s.falhasSeguidas, 0);
  assert.equal(s.proximaEm - agora, 12 * 3600_000);
  assert.equal(amb.atualizador.lerEstadoInstalacao().versaoAtiva, "99.1.0");

  // The audit log says it once when it started failing and once when it came back, not per attempt.
  assert.equal(eventos(amb, "atualizacao-automatica-adiada").length, 1);
  assert.equal(eventos(amb, "atualizacao-automatica-restabelecida").length, 0, "an installed update is logged as such");
  assert.equal(eventos(amb, "atualizacao-automatica-instalada").length, 1);
});

test("the schedule survives restarts and never checks the moment the Console starts", async (t) => {
  const { amb } = preparar(t, { base: await portaFechada() });
  const va = amb["verificacao-automatica"];
  const agora = 50_000_000;
  const arquivo = path.join(amb.estadoDir, "verificacao-automatica.json");

  // Nothing recorded: the first check waits the initial delay.
  let c = va.iniciar({ agora: () => agora, aleatorio: () => 0.5, verificar: async () => ({ tipo: "em-dia" }) });
  assert.equal(c.agendadoPara() - agora, va.TEMPOS.esperaInicialMs);
  c.parar();

  // A check due in 5 hours (after failures) stays there across the restart.
  fs.writeFileSync(arquivo, JSON.stringify({ proximaEm: agora + 5 * 3600_000, falhasSeguidas: 4 }));
  c = va.iniciar({ agora: () => agora, aleatorio: () => 0.5, verificar: async () => ({ tipo: "em-dia" }) });
  assert.equal(c.agendadoPara() - agora, 5 * 3600_000);
  c.parar();

  // Overdue: still the initial delay, never at once.
  fs.writeFileSync(arquivo, JSON.stringify({ proximaEm: agora - 3600_000, falhasSeguidas: 1 }));
  c = va.iniciar({ agora: () => agora, aleatorio: () => 0.5, verificar: async () => ({ tipo: "em-dia" }) });
  assert.equal(c.agendadoPara() - agora, va.TEMPOS.esperaInicialMs);
  c.parar();

  // A date far in the future (clock set back, a hand-edited file) is capped.
  fs.writeFileSync(arquivo, JSON.stringify({ proximaEm: agora + 400 * 86_400_000 }));
  c = va.iniciar({ agora: () => agora, aleatorio: () => 0.5, verificar: async () => ({ tipo: "em-dia" }) });
  assert.ok(c.agendadoPara() - agora <= 2 * va.TEMPOS.recuoTetoMs);
  c.parar();
});

test("a check cut short by the end of the process is not retried at once on the next start", async (t) => {
  const { amb } = preparar(t, { base: await portaFechada() });
  const va = amb["verificacao-automatica"];
  const agora = 10_000_000;
  let liberar;
  const pendente = new Promise((r) => {
    liberar = r;
  });
  const c = va.iniciar({ agora: () => agora, aleatorio: () => 0.5, verificar: () => pendente });
  t.after(() => c.parar());
  const ciclo = c.executarAgora();
  await new Promise((r) => setImmediate(r));
  // In flight: the file already says "as if it failed".
  const gravado = JSON.parse(fs.readFileSync(path.join(amb.estadoDir, "verificacao-automatica.json"), "utf8"));
  assert.equal(gravado.proximaEm - agora, 30 * 60_000);
  liberar({ tipo: "em-dia" });
  await ciclo;
});

test("repeated failures accumulate no timers, sockets or pending checks", async (t) => {
  const { amb } = preparar(t, { base: await portaFechada() });
  const va = amb["verificacao-automatica"];
  const contar = () => {
    const tipos = process.getActiveResourcesInfo();
    return { timeouts: tipos.filter((x) => x === "Timeout").length, sockets: tipos.filter((x) => /TCP|TLS|Pipe/.test(x) && x !== "TCPServerWrap").length };
  };
  const antes = contar();
  const c = va.iniciar({ aleatorio: () => 0.5 });
  t.after(() => c.parar());
  for (let i = 0; i < 25; i += 1) await c.executarAgora();
  await new Promise((r) => setTimeout(r, 50));
  const depois = contar();
  assert.equal(c.emCurso(), null, "no check left in flight");
  assert.equal(c.temporizadorAtivo(), true, "exactly the next scheduled check");
  assert.ok(depois.timeouts <= antes.timeouts + 1, `timers grew from ${antes.timeouts} to ${depois.timeouts}`);
  assert.ok(depois.sockets <= antes.sockets, `sockets grew from ${antes.sockets} to ${depois.sockets}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(amb.estadoDir, "verificacao-automatica.json"), "utf8")).falhasSeguidas, 25);
  assert.equal(eventos(amb, "atualizacao-automatica-adiada").length, 1, "twenty-five failures, one line");
  c.parar();
  assert.equal(c.temporizadorAtivo(), false);
});

// --- The Console keeps serving ------------------------------------------------------------------

// The Programa page probes the host's service manager, event log and tools, which on a Windows
// runner can take tens of seconds by itself.
const LENTA_MS = 120_000;

async function consoleNoAr(t, amb, { sondarPlataforma = true } = {}) {
  if (!sondarPlataforma) {
    // Timing tests measure whether a hung check blocks the Console; the host probing behind the
    // Programa page has its own cost, unrelated to updates, and is left out of the measurement.
    const original = amb.plataforma.capacidades;
    amb.plataforma.capacidades = async () => ({ plataforma: "teste", rotulo: "teste", arquitetura: null, runtime: {}, ferramentas: {}, recursos: {} });
    t.after(() => {
      amb.plataforma.capacidades = original;
    });
  }
  const srv = await ajuda.subir(amb);
  t.after(() => srv.fechar());
  const sessao = await ajuda.autenticar(amb, srv.porta);
  const pedir = (caminho) => ajuda.pedir(srv.porta, caminho, { cookie: sessao.cookie, timeoutMs: LENTA_MS });
  return { srv, pedir };
}

async function cronometrar(fn) {
  const inicio = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - inicio };
}

// Some pages cost what they cost (/api/programa probes the platform's tools, about 2 s on a
// Windows runner). What matters is that a hung check adds nothing: each page is timed without a
// check first, then while one hangs. /api/sessao answers in milliseconds and shows a blocked event
// loop at once.
const PAGINAS = ["/api/sessao", "/api/programa", "/api/painel", "/api/atualizacao"];

async function linhaDeBase(pedir) {
  const base = {};
  for (const caminho of PAGINAS) base[caminho] = (await cronometrar(() => pedir(caminho))).ms;
  return base;
}

async function conferirSemAtraso(pedir, base, contexto) {
  for (const caminho of PAGINAS) {
    const { r, ms } = await cronometrar(() => pedir(caminho));
    assert.equal(r.status, 200, `${caminho}: ${r.texto.slice(0, 200)}`);
    const teto = caminho === "/api/sessao" ? 300 : base[caminho] * 1.5 + 500;
    assert.ok(ms <= teto, `${caminho} took ${ms} ms while ${contexto} (${base[caminho]} ms without it)`);
  }
}

test("a publication that never answers does not slow the Console, and the check ends by its deadline", async (t) => {
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  srv.definir("mudo");
  const { amb } = preparar(t, { base: srv.base });
  amb.atualizador.PRAZOS.consultaMs = 1500;
  const { pedir } = await consoleNoAr(t, amb, { sondarPlataforma: false });
  const base = await linhaDeBase(pedir);
  amb.atualizador.PRAZOS.consultaMs = 8000;

  const inicio = Date.now();
  const verificacao = amb.atualizador.atualizarAutomaticamente();
  await new Promise((r) => setTimeout(r, 100));
  await conferirSemAtraso(pedir, base, "the check hung");
  assert.ok(Date.now() - inicio < 8000, "the pages were timed while the check was still hanging");
  const r = await verificacao;
  assert.equal(r.tipo, "sem-rede");
  const total = Date.now() - inicio;
  assert.ok(total >= 7500 && total < 10_000, `the hung check ended after ${total} ms, not by its 8 s deadline`);
});

test("a Sigstore trusted root service that never answers does not slow the Console either", async (t) => {
  // Manifest and attestation come back; the TUF refresh then hits a black hole.
  const srv = await origem(await publicacao("99.1.0"));
  t.after(() => srv.fechar());
  const mudo = await origem({});
  mudo.definir("mudo");
  t.after(() => mudo.fechar());
  const { amb, versao } = preparar(t, { base: srv.base, confiar: false });
  // The refresh starts from the root the Console carries, then asks the (silent) mirror. The TUF
  // client only has embedded roots for Sigstore's own mirror, so this one is seeded by hand, in the
  // per-mirror directory @sigstore/tuf uses.
  const cache = path.join(amb.estadoDir, "sigstore", "tuf", encodeURIComponent(new URL(mudo.base).host));
  fs.mkdirSync(path.join(cache, "targets"), { recursive: true });
  const semente = require("@sigstore/tuf/seeds.json")["https://tuf-repo-cdn.sigstore.dev"];
  fs.writeFileSync(path.join(cache, "root.json"), Buffer.from(semente["root.json"], "base64"));
  const original = { espelho: amb.atestacao.ESPELHO_TUF, tempo: amb.atestacao.TEMPO_TUF_MS };
  amb.atestacao.ESPELHO_TUF = mudo.base;
  t.after(() => {
    amb.atestacao.ESPELHO_TUF = original.espelho;
    amb.atestacao.TEMPO_TUF_MS = original.tempo;
  });
  const { pedir } = await consoleNoAr(t, amb, { sondarPlataforma: false });
  const base = await linhaDeBase(pedir);
  amb.atestacao.TEMPO_TUF_MS = 8000;

  const inicio = Date.now();
  const verificacao = amb.atualizador.atualizarAutomaticamente();
  await new Promise((r) => setTimeout(r, 300));
  await conferirSemAtraso(pedir, base, "the trusted root refresh hung");
  assert.ok(Date.now() - inicio < 8000, "the pages were timed while the refresh was still hanging");
  const r = await verificacao;
  assert.equal(r.tipo, "sem-rede", r.motivo);
  assert.match(r.motivo, /raiz de confiança do Sigstore/);
  const total = Date.now() - inicio;
  assert.ok(total < 11_000, `the hung refresh lasted ${total} ms`);
  assert.ok(mudo.pedidos.length >= 1, "the refresh did go to the mirror");
  assert.equal(amb.atualizador.lerEstadoInstalacao().versaoAtiva, versao);
});

test("opening the Console's pages never reaches the network; only an explicit check does", async (t) => {
  const { amb } = preparar(t, { base: "https://github.com/SENAI4LIFE/RemoteIFES/releases/latest/download" });
  const { pedir } = await consoleNoAr(t, amb);
  const registro = path.join(amb.estadoDir, "rede.jsonl");
  semInternet.ativar({ modo: "rota", registro });
  t.after(() => semInternet.desativar());

  for (const caminho of ["/api/sessao", "/api/painel", "/api/programa", "/api/atualizacao", "/api/host", "/api/mobile", "/api/rede", "/api/acoes", "/api/trabalhos", "/api/backups", "/"]) {
    const r = await pedir(caminho);
    assert.ok(r.status < 500, `${caminho} answered ${r.status}`);
  }
  assert.ok(!fs.existsSync(registro), `a page tried to leave the host: ${fs.existsSync(registro) ? fs.readFileSync(registro, "utf8").slice(0, 600) : ""}`);

  // The operator's explicit check does try, and without Internet it is a result, not a failure.
  const r = await pedir("/api/programa?rede=1");
  assert.equal(r.status, 200);
  assert.equal(r.json.console.consultaAgora.semRede, true);
  assert.match(r.json.console.consultaAgora.motivo, /não está acessível agora/);
  const tentativas = fs.readFileSync(registro, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(tentativas.length >= 1 && tentativas.every((x) => /github\.com/.test(x.destino)), "only the publication was contacted");
});

test("the launcher's status reads local update state only", async (t) => {
  const { amb } = preparar(t, { base: "https://github.com/SENAI4LIFE/RemoteIFES/releases/latest/download" });
  const registro = path.join(amb.estadoDir, "rede.jsonl");
  semInternet.ativar({ modo: "rota", registro });
  t.after(() => semInternet.desativar());
  const s = await amb.atualizador.situacao({ consultarRede: false });
  assert.equal(s.consultaAgora, null);
  assert.ok(!fs.existsSync(registro), "the status did not try to leave the host");
  // launcher.js asks for exactly this.
  assert.match(fs.readFileSync(path.join(ajuda.RAIZ, "launcher.js"), "utf8"), /situacao\(\{ consultarRede: false \}\)/);
});
