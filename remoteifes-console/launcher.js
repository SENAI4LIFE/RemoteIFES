#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");

const raiz = path.join(__dirname);
const config = require(path.join(raiz, "src", "config"));
const plataforma = require(path.join(raiz, "src", "plataforma"));
const moduloIdentidade = require(path.join(raiz, "src", "identidade"));

// Operations Console launcher.
//
// It is what the Start Menu shortcut, the `.desktop` entry and the `.app` bundle run. It solves
// three things that opening a browser on port 8099 does not:
//
//  1. **on-demand start**: starts the backend if it is not running and waits until it is ready;
//  2. **listener identity**: checks that whoever answers on the port is the installed Console
//     before sending the operator to type a password there;
//  3. **single instance**: if a Console is already running, it only opens the browser.
//
// No credential goes into a URL, a process argument or a shortcut. What travels is a random
// challenge; the proof is an HMAC computed with a secret that exists only in the protected state
// file, which an impostor holding the port cannot produce.

// Deadline for the backend to become ready. Adjustable because a cold Raspberry Pi takes longer
// than a desktop, and a test should not spend 30 s proving the wait ends.
const ESPERA_MAXIMA_MS = (() => {
  // Finite and capped: `Infinity` and `1e309` pass "> 0" and would turn a bounded deadline into an
  // endless wait, which is exactly what the deadline exists to prevent.
  const pedido = Number(process.env.CONSOLE_LANCADOR_ESPERA_MS);
  if (!Number.isFinite(pedido) || pedido <= 0) return 30_000;
  return Math.min(pedido, 10 * 60 * 1000);
})();

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

function erro(linha) {
  process.stderr.write(`${linha}\n`);
}

// Contract reading and identity proof live in src/identidade.js: the uninstaller asks the same
// question before stopping a process, and two implementations of the same proof is one more than
// can be audited.
const lerContrato = (...a) => moduloIdentidade.lerContrato(...a);
const verificarIdentidade = (...a) => moduloIdentidade.verificarIdentidade(...a);


function pedir(porta, caminho, { metodo = "GET", corpo = null, timeoutMs = 4000, comOrigem = false } = {}) {
  return new Promise((resolve) => {
    const dados = corpo === null ? null : JSON.stringify(corpo);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: porta,
        path: caminho,
        method: metodo,
        timeout: timeoutMs,
        headers: {
          Host: `127.0.0.1:${porta}`,
          // Mutating requests carry the exact origin the Console expects from its own page.
          ...(comOrigem ? { Origin: `http://127.0.0.1:${porta}` } : {}),
          ...(dados ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(dados) } : {}),
        },
      },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (texto.length < 64 * 1024) texto += d;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: "tempo esgotado" });
    });
    req.on("error", (e) => resolve({ ok: false, erro: e.code || e.message }));
    if (dados) req.end(dados);
    else req.end();
  });
}

/**
 * Listener identity proof.
 *
 * Without it, the launcher would open the browser on any process that took the port first: local
 * phishing with an identical login page. The challenge is random on every check and the answer is
 * `HMAC-SHA256(secret, challenge)`; the secret lives only in the protected state file, which the
 * impostor cannot read.
 */

function backendNoAr(contrato) {
  if (!contrato) return false;
  try {
    process.kill(contrato.pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function esperarPronto({ timeoutMs = ESPERA_MAXIMA_MS } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const contrato = lerContrato();
    if (contrato) {
      const identidade = await verificarIdentidade(contrato);
      if (identidade.ok) return { ok: true, contrato, versao: identidade.versao };
      if (identidade.impostor) return { ok: false, ...identidade };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, motivo: `o console não ficou pronto em ${Math.round(timeoutMs / 1000)}s` };
}

function caminhoDoBackend() {
  // Stable layer: the bootstrap resolves the active version. In development, console.js directly.
  const bootstrap = path.join(config.RAIZ_INSTALACAO, "console-bootstrap.js");
  return fs.existsSync(bootstrap) ? bootstrap : path.join(raiz, "console.js");
}

/**
 * Does the port accept connections? Distinguishes "nobody there" from "reserved by someone".
 */
function portaOcupada(porta) {
  return new Promise((resolver) => {
    const socket = net.connect({ host: "127.0.0.1", port: porta });
    const encerrar = (valor) => {
      socket.destroy();
      resolver(valor);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => encerrar(true));
    socket.once("timeout", () => encerrar(false));
    socket.once("error", () => encerrar(false));
  });
}

/**
 * Any HTTP connection, only so systemd activates the service behind the socket.
 */
function tocarPorta(porta) {
  return new Promise((resolver) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: "/api/sessao", method: "GET", timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () => resolver(true));
    });
    req.on("timeout", () => {
      req.destroy();
      resolver(false);
    });
    req.on("error", () => resolver(false));
    req.end();
  });
}

async function garantirBackend() {
  // Quick prerequisite check on every launch (no network, no reinstall): a Node below the minimum
  // would start a Console that fails in obscure ways.
  const runtime = plataforma.runtimeAtual();
  if (!runtime.atende) {
    return {
      ok: false,
      motivo: `${runtime.motivo}. O console e o RemoteIFES exigem Node ${runtime.minimoExigido} ou mais novo; atualize o Node e abra o console de novo.`,
    };
  }
  const contrato = lerContrato();
  if (contrato) {
    const identidade = await verificarIdentidade(contrato);
    if (identidade.ok) return { ok: true, jaEstava: true, contrato, versao: identidade.versao };
    if (identidade.impostor) return { ok: false, ...identidade };
    // Stale contract of a dead process: continue and start a new one.
    if (backendNoAr(contrato)) {
      return { ok: false, motivo: `o processo ${contrato.pid} está vivo mas não responde; encerre-o antes de tentar de novo` };
    }
  }

  // If someone already holds the port without a contract, the right path is to **connect**, not to
  // start another process.
  //
  // That is the normal state on Linux with socket activation after an idle exit: the contract was
  // removed, but systemd still owns the port. Creating a TCP backend there gets EADDRINUSE. One
  // connection is enough for systemd to start the service; then the new contract appears.
  if (await portaOcupada(config.PORTA)) {
    log("A porta já está reservada (ativação por socket); conectando para ativar o serviço...");
    await tocarPorta(config.PORTA);
    const ativado = await esperarPronto();
    if (ativado.ok) return { ok: true, jaEstava: false, contrato: ativado.contrato, versao: ativado.versao };
    return {
      ok: false,
      motivo:
        `a porta ${config.PORTA} está ocupada, mas o console não publicou identidade depois da conexão ` +
        `(${ativado.motivo}). Verifique quem detém a porta antes de prosseguir.`,
    };
  }

  // Where a service manager owns the Console (macOS LaunchAgent), it starts the process: status,
  // restart after an update and uninstall then act on that same job. A job that launchd started but
  // that does not become ready is reported, never followed by a second, directly spawned process.
  const gerenciado = await plataforma.iniciarConsoleGerenciado();
  if (gerenciado.disponivel) {
    log(`Iniciando o console pelo ${gerenciado.mecanismo}...`);
    const pronto = await esperarPronto();
    if (pronto.ok) return { ok: true, jaEstava: false, contrato: pronto.contrato, versao: pronto.versao, gerenciadoPor: gerenciado.mecanismo };
    return { ok: false, motivo: `o ${gerenciado.mecanismo} iniciou o console, mas ele não ficou pronto (${pronto.motivo})` };
  }
  if (gerenciado.estado === "indisponivel") {
    log(`O gerenciador de serviços não iniciou o console (${gerenciado.motivo}); iniciando o processo diretamente.`);
  }

  const alvo = caminhoDoBackend();
  if (!fs.existsSync(alvo)) return { ok: false, motivo: `o backend do console não foi encontrado em ${alvo}` };

  log("Iniciando o console...");
  const filho = spawn(process.execPath, [alvo], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      CONSOLE_INICIADO_PELO_LANCADOR: "1",
      // The bootstrap target is passed EXPLICITLY, never inherited.
      //
      // When the system shortcut runs `launcher-bootstrap.js`, it sets
      // CONSOLE_BOOTSTRAP_ALVO=launcher in this process's environment. Inheriting it would make the
      // child bootstrap load `launcher.js` again instead of `console.js`: a launcher starting
      // another launcher in a chain, each waiting 30 s and giving up, and the Console never
      // starting.
      CONSOLE_BOOTSTRAP_ALVO: "console",
    },
  });
  filho.unref();

  const pronto = await esperarPronto();
  if (!pronto.ok) return pronto;
  return { ok: true, jaEstava: false, contrato: pronto.contrato, versao: pronto.versao };
}

function urlDoConsole(contrato) {
  return `http://127.0.0.1:${contrato.porta}/`;
}

/**
 * Application URL from the actual configuration, not from a fixed port or an assumed scheme. Behind
 * an HTTPS proxy, the operator's address is the domain, not 127.0.0.1:8080.
 */
const urlDaAplicacao = config.urlDaAplicacao;

async function abrir(url) {
  let validada;
  try {
    validada = new URL(url);
  } catch {
    return { ok: false, motivo: `endereço inválido: ${url}` };
  }
  if (!["http:", "https:"].includes(validada.protocol)) return { ok: false, motivo: "só endereços HTTP(S) são abertos" };
  const r = await plataforma.abrirNavegador(validada.toString());
  if (!r.disponivel) {
    log(`Não foi possível abrir o navegador automaticamente (${r.motivo}).`);
    log(`Abra manualmente: ${validada.toString()}`);
    return { ok: true, manual: true };
  }
  return { ok: true };
}

// --- First access --------------------------------------------------------------------------------
//
// While the Console has no operator, whoever can read the installation secret file (the local
// administrator, by file permission) is authorized to create the first one. The launcher never
// shows the secret: it trades it for a single-use invitation valid for a few minutes and opens the
// browser on a private page (a file only this user can read) that redirects to the Console with the
// invitation in the URL fragment. The invitation never appears in a process argument, and the page
// removes it from the address bar and history before using it.

const ESPERA_NAVEGADOR_MS = (() => {
  const pedido = Number(process.env.CONSOLE_LANCADOR_ESPERA_NAVEGADOR_MS);
  return Number.isFinite(pedido) && pedido >= 0 ? Math.min(pedido, 120_000) : 45_000;
})();

function lerSegredoDeInstalacao() {
  try {
    const segredo = fs.readFileSync(path.join(config.DIR_ESTADO, "bootstrap-token"), "utf8").trim();
    return segredo ? { segredo } : { segredo: null, motivo: "o segredo de instalação está vazio" };
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM") {
      return { segredo: null, motivo: "sem permissão para ler o segredo de instalação; use uma conta de administrador deste host" };
    }
    return { segredo: null, motivo: "o segredo de instalação não existe (já foi usado ou a instalação precisa de reparo)" };
  }
}

async function precisaPrimeiroAcesso(contrato) {
  const r = await pedir(contrato.porta, "/api/sessao");
  return !!(r.json && r.json.precisaBootstrap);
}

function paginaDeRedirecionamento(destino) {
  return [
    "<!doctype html>",
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Console de Operações RemoteIFES</title></head>",
    "<body><p>Abrindo o primeiro acesso ao Console de Operações…</p>",
    `<script>location.replace(${JSON.stringify(destino)});</script>`,
    "</body></html>",
    "",
  ].join("\n");
}

/**
 * Opens the first-access page. `abrirNavegador` is injectable for tests; by default it is the
 * platform's.
 */
async function abrirPrimeiroAcesso(contrato, { abrirNavegador = (u) => plataforma.abrirNavegador(u), esperaMs = ESPERA_NAVEGADOR_MS } = {}) {
  const { segredo, motivo } = lerSegredoDeInstalacao();
  if (!segredo) {
    log(`Primeiro acesso: ${motivo}. A tela do console explica as alternativas.`);
    return abrir(urlDoConsole(contrato));
  }
  const r = await pedir(contrato.porta, "/api/bootstrap/convite", { metodo: "POST", corpo: { segredo }, comOrigem: true });
  if (!r.ok || !r.json || !r.json.convite) {
    log(`Primeiro acesso: o console recusou o convite (${(r.json && r.json.erro) || r.erro || r.status}).`);
    return abrir(urlDoConsole(contrato));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-console-"));
  const pagina = path.join(dir, "primeiro-acesso.html");
  fs.writeFileSync(pagina, paginaDeRedirecionamento(`${urlDoConsole(contrato)}#primeiro-acesso=${r.json.convite}`), { mode: 0o600 });
  try {
    const abertura = await abrirNavegador(require("url").pathToFileURL(pagina).toString());
    if (!abertura || !abertura.disponivel) {
      log(`Não foi possível abrir o navegador automaticamente (${(abertura && abertura.motivo) || "motivo desconhecido"}).`);
      log("Para criar o primeiro operador sem navegador, use: --criar-operador");
      return { ok: false, manual: true };
    }
    // The browser reads the page asynchronously; it is deleted once it had time to load.
    if (esperaMs > 0) {
      log("Abrindo o primeiro acesso no navegador...");
      await new Promise((resolver) => setTimeout(resolver, esperaMs));
    }
    return { ok: true, primeiroAcesso: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function perguntarOculto(rl, pergunta) {
  return new Promise((resolver) => {
    const escrever = rl._writeToOutput;
    rl._writeToOutput = (texto) => {
      if (texto.startsWith(pergunta)) escrever.call(rl, pergunta);
    };
    rl.question(pergunta, (resposta) => {
      rl._writeToOutput = escrever;
      process.stdout.write("\n");
      resolver(resposta);
    });
  });
}

/**
 * Operator name and password: prompted on a terminal (password hidden and confirmed), or read as two
 * lines from stdin for unattended use. Never from process arguments.
 */
async function lerCredenciais(entrada = process.stdin) {
  if (entrada.isTTY) {
    const rl = readline.createInterface({ input: entrada, output: process.stdout, terminal: true });
    try {
      const nome = (await new Promise((r) => rl.question("Nome do operador: ", r))).trim();
      const senha = await perguntarOculto(rl, "Senha (mínimo de 12 caracteres): ");
      const confirmacao = await perguntarOculto(rl, "Repita a senha: ");
      if (senha !== confirmacao) return { erro: "as senhas não conferem" };
      return { nome, senha };
    } finally {
      rl.close();
    }
  }
  const texto = await new Promise((resolver, rejeitar) => {
    let dados = "";
    entrada.setEncoding("utf8");
    entrada.on("data", (d) => {
      dados += d;
      if (dados.length > 4096) rejeitar(new Error("entrada grande demais"));
    });
    entrada.on("end", () => resolver(dados));
    entrada.on("error", rejeitar);
  });
  const [nome = "", senha = ""] = texto.split(/\r?\n/);
  return { nome: nome.trim(), senha };
}

async function criarOperadorPeloTerminal({ entrada = process.stdin } = {}) {
  const r = await garantirBackend();
  if (!r.ok) {
    erro(r.motivo);
    return 1;
  }
  if (!(await precisaPrimeiroAcesso(r.contrato))) {
    erro("O console já tem um operador; entre pela tela de login.");
    return 1;
  }
  const { segredo, motivo } = lerSegredoDeInstalacao();
  if (!segredo) {
    erro(`Não é possível criar o operador: ${motivo}.`);
    return 1;
  }
  const credenciais = await lerCredenciais(entrada);
  if (credenciais.erro) {
    erro(`Operador não criado: ${credenciais.erro}.`);
    return 1;
  }
  const resposta = await pedir(r.contrato.porta, "/api/bootstrap", {
    metodo: "POST",
    corpo: { segredo, nome: credenciais.nome, senha: credenciais.senha },
    comOrigem: true,
    timeoutMs: 15_000,
  });
  if (resposta.status === 201) {
    log(`Operador "${credenciais.nome}" criado. O segredo de instalação deixou de valer.`);
    log(`Entre em ${urlDoConsole(r.contrato)} (de outra máquina, por túnel SSH).`);
    return 0;
  }
  erro(`Operador não criado: ${(resposta.json && resposta.json.erro) || resposta.erro || `HTTP ${resposta.status}`}.`);
  return 1;
}

// --- Status -----------------------------------------------------------------------------------

async function coletarStatus() {
  const contrato = lerContrato();
  const consoleNoAr = contrato ? await verificarIdentidade(contrato) : { ok: false, motivo: "console não está no ar" };

  const coleta = require(path.join(raiz, "src", "coleta"));
  const saude = await coleta.consultarSaude({ timeoutMs: 2500 });
  const servico = await plataforma.estadoDoServico();

  let atualizacao = null;
  try {
    atualizacao = await require(path.join(raiz, "src", "atualizador")).situacao({ consultarRede: false });
  } catch {}

  return {
    console: {
      noAr: consoleNoAr.ok,
      motivo: consoleNoAr.ok ? null : consoleNoAr.motivo,
      impostor: !!consoleNoAr.impostor,
      url: contrato ? urlDoConsole(contrato) : null,
      versao: consoleNoAr.versao || null,
    },
    aplicacao: {
      respondendo: saude.respondeu,
      saudavel: !!saude.ok,
      commit: saude.commit || null,
      url: urlDaAplicacao(),
      servico: { estado: servico.estado, disponivel: !!servico.disponivel, ativo: servico.ativo ?? null, motivo: servico.motivo || null },
    },
    atualizacaoDoConsole: atualizacao
      ? {
          instalada: atualizacao.versaoEmExecucao,
          disponivel: atualizacao.disponivel,
          podeAtualizar: atualizacao.podeAtualizar,
          confiancaConfigurada: atualizacao.confiancaConfigurada,
          ressalva: atualizacao.ultimaObservacao ? atualizacao.ultimaObservacao.ressalva : null,
        }
      : null,
    plataforma: plataforma.rotulo,
  };
}

function imprimirStatus(s) {
  log("");
  log("  Console de Operações RemoteIFES");
  log("  ───────────────────────────────");
  log(`  Plataforma      : ${s.plataforma}`);
  if (s.console.impostor) {
    log(`  Console         : ⚠ PORTA OCUPADA POR OUTRO PROCESSO`);
    log(`                    ${s.console.motivo}`);
  } else {
    log(`  Console         : ${s.console.noAr ? `no ar — ${s.console.url}` : `parado (${s.console.motivo})`}`);
  }
  log(`  RemoteIFES      : ${s.aplicacao.respondendo ? (s.aplicacao.saudavel ? "saudável" : "degradado") : "sem resposta"}`);
  log(`                    ${s.aplicacao.url}`);
  const srv = s.aplicacao.servico;
  log(`  Serviço         : ${srv.disponivel ? (srv.ativo ? "ativo" : "parado") : `${srv.estado} — ${srv.motivo || ""}`}`);
  if (s.atualizacaoDoConsole) {
    const a = s.atualizacaoDoConsole;
    const disponivel = a.confiancaConfigurada ? a.disponivel || "não consultada" : "não configurada";
    log(`  Versão console  : ${a.instalada} (publicada: ${disponivel})`);
  }
  log("");
}

// --- Interactive menu ----------------------------------------------------------------------------

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const perguntar = (q) => new Promise((r) => rl.question(q, r));

  for (;;) {
    const s = await coletarStatus();
    imprimirStatus(s);
    log("  1) Abrir o Console de Operações");
    log("  2) Abrir o RemoteIFES");
    log("  3) Atualizar este status");
    log("  4) Iniciar/reiniciar o RemoteIFES");
    log("  5) Encerrar o console (ele volta sozinho na próxima abertura)");
    log("  0) Sair");
    const escolha = (await perguntar("\n  Opção: ")).trim();

    if (escolha === "0") break;
    if (escolha === "1") {
      const r = await garantirBackend();
      if (!r.ok) {
        erro(`\n  ${r.motivo}`);
        continue;
      }
      await abrir(urlDoConsole(r.contrato));
    } else if (escolha === "2") {
      await abrir(s.aplicacao.url);
    } else if (escolha === "4") {
      const servico = await plataforma.estadoDoServico();
      if (!servico.disponivel) {
        erro(`\n  Não é possível controlar o serviço aqui: ${servico.motivo}`);
        continue;
      }
      log("\n  Reiniciando o RemoteIFES...");
      const r = await plataforma.controlarServico(servico.ativo ? "reiniciar" : "iniciar");
      log(r.disponivel ? "  Pedido enviado." : `  Falhou: ${r.motivo}`);
    } else if (escolha === "5") {
      const contrato = lerContrato();
      if (!contrato) {
        log("\n  O console já não está no ar.");
        continue;
      }
      try {
        process.kill(contrato.pid, "SIGTERM");
        log("\n  Encerrado.");
      } catch (e) {
        erro(`\n  Não foi possível encerrar: ${e.message}`);
      }
    }
  }
  rl.close();
}

// --- Entry point ------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--ajuda") || args.includes("-h")) {
    log("uso: launcher.js [--menu|--status|--iniciar|--criar-operador|--abrir-app|--abrir-console]");
    log("  sem argumento: sobe o console se necessário, verifica a identidade e abre o navegador");
    log("  --iniciar: sobe o console e sai, sem abrir navegador (host sem interface gráfica)");
    log("  --criar-operador: cria o primeiro operador pelo terminal (nome e senha pedidos, nunca em argumentos)");
    return 0;
  }

  if (args.includes("--status")) {
    imprimirStatus(await coletarStatus());
    return 0;
  }

  if (args.includes("--iniciar")) {
    // Starts the Console and exits without opening a browser: serves a host without a graphical
    // interface (a Pi without systemd, for example), and is the path CI exercises to prove the
    // installed launcher really starts the **Console** and not another copy of itself.
    const r = await garantirBackend();
    if (!r.ok) {
      erro(r.motivo);
      return 1;
    }
    log(r.jaEstava ? "Console já estava no ar." : "Console iniciado.");
    log(urlDoConsole(r.contrato));
    return 0;
  }

  if (args.includes("--criar-operador")) {
    return criarOperadorPeloTerminal();
  }

  if (args.includes("--abrir-app")) {
    const r = await abrir(urlDaAplicacao());
    return r.ok ? 0 : 1;
  }

  if (args.includes("--menu")) {
    await menu();
    return 0;
  }

  const r = await garantirBackend();
  if (!r.ok) {
    erro(r.motivo);
    if (r.impostor) {
      erro("");
      erro("O navegador NÃO foi aberto de propósito: digitar a senha do console numa página servida");
      erro("por outro processo entregaria a credencial a ele.");
    }
    return 1;
  }
  if (r.jaEstava) log("Console já estava no ar.");
  if (await precisaPrimeiroAcesso(r.contrato)) {
    const primeiro = await abrirPrimeiroAcesso(r.contrato);
    return primeiro.ok ? 0 : 1;
  }
  const abertura = await abrir(urlDoConsole(r.contrato));
  return abertura.ok ? 0 : 1;
}

function executar() {
  return main()
    .then((codigo) => {
      process.exitCode = codigo;
    })
    .catch((e) => {
      erro(`Erro inesperado: ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    });
}

// Explicit entry, for the same reason as console.js: under the stable bootstrap layer the main
// module is the bootstrap, and `require.main === module` would make the launcher do nothing.
if (require.main === module) executar();

module.exports = {
  executar,
  lerContrato,
  verificarIdentidade,
  garantirBackend,
  urlDaAplicacao,
  urlDoConsole,
  coletarStatus,
  abrir,
  abrirPrimeiroAcesso,
  criarOperadorPeloTerminal,
};
