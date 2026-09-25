#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

// Operations Console uninstaller.
//
// Three rules govern this file and outweigh any convenience:
//
//   1. **Nothing is deleted without proof that it is ours.** Before any recursive removal the
//      directory must show the signature of a Console installation (stable layer + versoes/), be in
//      a plausible location, not be a disk root or home, and belong to whoever is uninstalling. A
//      mistyped `--raiz` must not become an `rm -rf` in the wrong place.
//   2. **State stays by default.** Operators, audit and backups survive program removal; deleting
//      them must be requested explicitly. Reinstalling and finding the account gone is worse than
//      leaving a directory behind.
//   3. **No orphan process.** The running Console is stopped before the program is removed;
//      otherwise the uninstall "succeeds" and leaves a process serving on loopback, still able to
//      run privileged operations for a program that no longer exists. What authorizes the stop is
//      not the PID in the contract (PIDs are recycled) but the identity proof.
//
// The RemoteIFES checkout (application code and database) is **never** touched: the Console manages
// it and does not own it.
//
// Usage:
//   node instalacao/desinstalar.js [--escopo usuario|sistema] [--raiz <dir>] [--estado <dir>]
//                                 [--apagar-estado] [--simular] [--sim]

const RE_VERSAO = /^\d+\.\d+\.\d+$/;

function argumento(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
}

const temFlag = (nome) => process.argv.includes(`--${nome}`);

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

function falhar(mensagem) {
  process.stderr.write(`\n${mensagem}\n`);
  process.exit(1);
}

/**
 * Authorizes (or refuses) a recursive removal. Always returns a readable reason: a refusal that
 * does not explain what was missing leads the operator to delete by hand, which is exactly the
 * risk.
 *
 * @param {string} caminho  candidate directory
 * @param {object} exigido  `marcas`: names that identify the directory; `rotulo`: what it is;
 *   `exigirTodas`: when true, a missing mark refuses.
 */
function autorizarRemocao(caminho, { marcas, rotulo, exigirTodas = false }) {
  const alvo = path.resolve(caminho);

  if (!fs.existsSync(alvo)) return { ok: false, ausente: true, motivo: `${rotulo} não existe em ${alvo}` };
  let info;
  try {
    info = fs.lstatSync(alvo);
  } catch (erro) {
    return { ok: false, motivo: `não foi possível inspecionar ${alvo}: ${erro.message}` };
  }
  if (info.isSymbolicLink()) return { ok: false, motivo: `${alvo} é um link simbólico; remova-o à mão para não seguir o alvo` };
  if (!info.isDirectory()) return { ok: false, motivo: `${alvo} não é um diretório` };

  // Containment: never a disk root, never home, never a path that is too shallow.
  const raizDoDisco = path.parse(alvo).root;
  if (alvo === raizDoDisco) return { ok: false, motivo: "recusado: o caminho é a raiz do sistema de arquivos" };
  if (alvo === path.resolve(os.homedir())) return { ok: false, motivo: "recusado: o caminho é o diretório do usuário" };
  const profundidade = alvo.slice(raizDoDisco.length).split(path.sep).filter(Boolean).length;
  if (profundidade < 2) return { ok: false, motivo: `recusado: ${alvo} é raso demais para ser removido recursivamente` };

  // Identity: the directory must look like what we claim it is.
  //
  // For the program root ALL marks are required. Accepting "at least one" would let an arbitrary
  // directory that happens to contain a `versoes/` be removed recursively, and a mistyped `--raiz`
  // is exactly the case these checks exist to catch.
  const faltando = marcas.filter((m) => !fs.existsSync(path.join(alvo, m)));
  if (exigirTodas ? faltando.length > 0 : faltando.length === marcas.length) {
    return {
      ok: false,
      motivo: exigirTodas
        ? `${alvo} não tem as marcas de ${rotulo} (faltam: ${faltando.join(", ")})`
        : `${alvo} não tem nenhuma marca de ${rotulo} (esperado: ${marcas.join(", ")})`,
    };
  }

  // Never inside a RemoteIFES checkout: the application code and database live there.
  for (let dir = alvo; ; ) {
    if (fs.existsSync(path.join(dir, "remoteifes-server", "package.json"))) {
      return { ok: false, motivo: `recusado: ${alvo} está dentro do checkout do RemoteIFES (${dir}), que o console não é dono` };
    }
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }

  // Ownership: on POSIX, the uninstalling user (or root). On Windows the practical proof is being
  // able to write: the ACL model does not reduce to a uid.
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const eu = process.getuid();
    if (eu !== 0 && info.uid !== eu) {
      return { ok: false, motivo: `recusado: ${alvo} pertence ao uid ${info.uid} e você é o uid ${eu}` };
    }
  }
  try {
    fs.accessSync(alvo, fs.constants.W_OK);
  } catch {
    return { ok: false, motivo: `sem permissão de escrita em ${alvo}; repita com privilégio administrativo` };
  }

  return { ok: true, alvo };
}

function lerJsonSeguro(arquivo) {
  try {
    const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    return dados && typeof dados === "object" ? dados : {};
  } catch {
    return {};
  }
}

function remover(caminho, { simular, rotulo }) {
  if (simular) {
    log(`   [simulação] removeria ${rotulo}: ${caminho}`);
    return;
  }
  fs.rmSync(caminho, { recursive: true, force: true });
  log(`   removido: ${caminho}`);
}

function removerArquivo(caminho, { simular }) {
  if (!caminho || !fs.existsSync(caminho)) return false;
  if (simular) {
    log(`   [simulação] removeria ${caminho}`);
    return true;
  }
  fs.rmSync(caminho, { recursive: true, force: true });
  log(`   removido: ${caminho}`);
  return true;
}

/**
 * If the uninstaller runs from INSIDE the installation it will delete, it copies itself to a
 * temporary directory and restarts from there.
 *
 * On Windows a file with an open handle is removed only when the handle closes, and its directory
 * stays "not empty" until then. Deleting the installation from a script living inside it would
 * leave the root behind with EPERM after removing all content. Restarting from outside avoids
 * retries and handle waits.
 */
function reexecutarForaDaInstalacao(raiz, dirEstado, escopoEfetivo) {
  const aqui = path.resolve(__dirname);
  const alvo = path.resolve(raiz);
  if (!aqui.startsWith(alvo + path.sep)) return false;

  const payload = path.join(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "console-desinstalar-"));
  try {
    fs.cpSync(path.join(payload, "src"), path.join(temp, "src"), { recursive: true });
    fs.copyFileSync(path.join(payload, "package.json"), path.join(temp, "package.json"));
    fs.mkdirSync(path.join(temp, "instalacao"), { recursive: true });
    const copia = path.join(temp, "instalacao", "desinstalar.js");
    fs.copyFileSync(__filename, copia);

    // Paths are passed resolved: the copy must not recompute defaults from where it lives. The
    // SCOPE is passed resolved too. The temporary copy does not live inside an installation and
    // cannot infer anything: without it, a user-scope uninstall would become system scope in the
    // child, leave the user integration installed and possibly touch another installation's system
    // integration.
    const repassar = process.argv.slice(2).filter((a, i, todos) => {
      const anterior = todos[i - 1];
      if (a === "--raiz" || a === "--estado" || a === "--escopo") return false;
      if (anterior === "--raiz" || anterior === "--estado" || anterior === "--escopo") return false;
      return true;
    });
    // The cwd must leave the installation in both parent and child: on Windows an open directory
    // handle also prevents removing the root, and the parent stays alive during spawnSync.
    try {
      if (path.resolve(process.cwd()).startsWith(alvo)) process.chdir(os.tmpdir());
    } catch {}
    const r = require("child_process").spawnSync(
      process.execPath,
      [copia, ...repassar, "--raiz", alvo, "--estado", path.resolve(dirEstado), "--escopo", escopoEfetivo],
      { stdio: "inherit", cwd: temp }
    );
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

/**
 * Stops the running Console before deleting the program.
 *
 * Without this the uninstall "succeeds" and leaves a live process: it keeps serving on loopback,
 * keeps its identity contract published and keeps the ability to run privileged operations for a
 * program that, to the operator, no longer exists. On Windows and macOS the launcher starts the
 * Console, so nothing else stops it.
 *
 * The PID alone does not authorize a kill: PIDs are recycled. What authorizes it is the **identity
 * proof**: whoever answers on that port demonstrates possession of the secret only this Console
 * published. If the proof fails, nothing is terminated and the operator is told, because either the
 * contract is stale or another process holds the port, and killing someone else's process is worse
 * than leaving ours alive.
 */
async function encerrarConsoleEmExecucao({ plataforma, dirEstado, simular, log }) {
  const identidade = require(path.join(__dirname, "..", "src", "identidade"));
  const contrato = identidade.lerContrato(path.join(dirEstado, "endereco.json"));
  if (!contrato) {
    log("   nenhum console em execução (sem contrato publicado).");
    return { encerrado: false };
  }

  const prova = await identidade.verificarIdentidade(contrato);
  if (!prova.ok) {
    if (prova.impostor) {
      log(`   ATENÇÃO: há algo escutando em 127.0.0.1:${contrato.porta} que NÃO é este console.`);
      log("   Nada foi encerrado. Investigue qual processo tomou a porta antes de prosseguir.");
      return { encerrado: false, impostor: true };
    }
    log(`   o console não está respondendo (${prova.motivo}); nada a encerrar.`);
    return { encerrado: false };
  }

  if (simular) {
    log(`   [simulação] encerraria o console em execução (pid ${contrato.pid}, porta ${contrato.porta}).`);
    return { encerrado: false, simulado: true };
  }

  log(`   encerrando o console em execução (pid ${contrato.pid}, porta ${contrato.porta})...`);
  try {
    plataforma.encerrarArvore(contrato.pid, "SIGTERM");
  } catch (erro) {
    log(`   não foi possível encerrar: ${erro.message}`);
    return { encerrado: false, motivo: erro.message };
  }

  // Adjustable deadlines: a loaded Pi takes longer than a desktop, and a test should not spend 15 s
  // proving the wait ends.
  const prazoPedido = Number(process.env.CONSOLE_PARADA_MS);
  const prazoNormal = Number.isFinite(prazoPedido) && prazoPedido > 0 ? Math.min(prazoPedido, 5 * 60 * 1000) : 10_000;
  const prazoForcado = Math.max(Math.round(prazoNormal / 2), 500);

  if (await esperarPortaFechar(contrato.porta, prazoNormal)) {
    log("   console encerrado.");
    return { encerrado: true };
  }

  log("   o console não encerrou no prazo; forçando.");
  try {
    plataforma.encerrarArvore(contrato.pid, "SIGKILL");
  } catch (erro) {
    log(`   não foi possível forçar: ${erro.message}`);
  }
  // The SIGKILL result is RECHECKED: swallowing the error and declaring the process stopped would
  // claim success without proof on the very path where stopping had just failed.
  if (await esperarPortaFechar(contrato.porta, prazoForcado)) {
    log("   console encerrado à força.");
    return { encerrado: true, forcado: true };
  }
  return { encerrado: false, motivo: `a porta ${contrato.porta} continua aceitando conexão depois do encerramento forçado` };
}

/**
 * Waits for the port to stop ACCEPTING CONNECTIONS, not for "identity to stop matching".
 *
 * An identity request failing on timeout, malformed response or routing error looks exactly like a
 * dead process, and treating both as stopped would declare success over a possibly live Console.
 * Connection refusal is the proof that nothing is listening there anymore.
 */
function esperarPortaFechar(porta, prazoMs) {
  const limite = Date.now() + prazoMs;
  const tentar = () =>
    new Promise((resolver) => {
      const socket = net.connect({ host: "127.0.0.1", port: porta });
      const encerrar = (aceitou) => {
        socket.destroy();
        resolver(aceitou);
      };
      socket.setTimeout(1000);
      socket.once("connect", () => encerrar(true));
      socket.once("timeout", () => encerrar(true));  // accepted the connection but did not respond: something is still there
      socket.once("error", () => encerrar(false));
    });

  return (async () => {
    for (;;) {
      if (!(await tentar())) return true;
      if (Date.now() >= limite) return false;
      await new Promise((resolver) => setTimeout(resolver, 250));
    }
  })();
}

async function main() {
  const plataforma = require(path.join(__dirname, "..", "src", "plataforma"));
  const simular = temFlag("simular");
  const escopo = argumento("escopo", process.platform === "linux" ? "sistema" : "usuario");
  if (!["usuario", "sistema"].includes(escopo)) falhar("--escopo aceita apenas 'usuario' ou 'sistema'");

  // The installation containing THIS script is the reference: the uninstaller travels inside the
  // payload, so `../..` is the installed root. Presuming the scope from the system would treat a
  // Linux user-scope installation as system scope, complain that `/opt` is missing and leave
  // `~/.local/...` intact, and that is exactly the command the interface tells the operator to run.
  const raizDoProprioScript = path.resolve(path.join(__dirname, "..", "..", ".."));
  const pareceInstalacao = fs.existsSync(path.join(raizDoProprioScript, "estado-instalacao.json"));
  const registro = pareceInstalacao ? lerJsonSeguro(path.join(raizDoProprioScript, "estado-instalacao.json")) : {};
  const escopoEfetivo = argumento("escopo", registro.escopo || escopo);
  const padroes = plataforma.diretoriosPadrao({ escopo: escopoEfetivo });
  const raiz = path.resolve(argumento("raiz", pareceInstalacao ? raizDoProprioScript : padroes.raizInstalacao));
  const dirEstado = path.resolve(argumento("estado", registro.estado || padroes.estado));

  if (!temFlag("simular") && reexecutarForaDaInstalacao(raiz, dirEstado, escopoEfetivo)) return;

  log("");
  log("  Console de Operações RemoteIFES — desinstalação");
  log("  ──────────────────────────────────────────────");
  log(`  Plataforma : ${plataforma.rotulo}`);
  log(`  Escopo     : ${escopoEfetivo}`);
  log(`  Programa   : ${raiz}`);
  log(`  Estado     : ${dirEstado}${temFlag("apagar-estado") ? " (será apagado)" : " (preservado)"}`);
  if (simular) log("  Modo       : simulação — nada será removido");
  log("");

  const autorizacao = autorizarRemocao(raiz, {
    marcas: ["console-bootstrap.js", "versoes", "estado-instalacao.json"],
    rotulo: "instalação do console",
    exigirTodas: true,
  });
  if (!autorizacao.ok && !autorizacao.ausente) falhar(`  ${autorizacao.motivo}`);

  if (!simular && !temFlag("sim") && !process.stdin.isTTY) {
    falhar(
      "  Sem terminal interativo, a desinstalação exige --sim para confirmar.\n" +
        "  Use --simular primeiro para ver exatamente o que seria removido."
    );
  }
  if (!simular && !temFlag("sim") && process.stdin.isTTY) {
    const resposta = await perguntar("  Confirmar a desinstalação? digite 'desinstalar': ");
    if (resposta.trim() !== "desinstalar") falhar("  Cancelado.");
    log("");
  }

  // --- Platform integration --------------------------------------------------------------------
  //
  // Integration is removed BEFORE stopping. With socket activation still enabled, probing the port
  // would reactivate the service and the Console would come back right after being stopped.
  log("== Removendo a integração com o sistema");
  if (simular) {
    // `removerInicializacao` is destructive: on Linux it stops the Console and deletes the systemd
    // units, the sudo rule and the privileged helper. It must never run in simulation mode.
    log("   [simulação] removeria o registro de inicialização e, no Linux, unidades, regra de sudo e auxiliar.");
  } else {
    try {
      const r = await plataforma.removerInicializacao({ escopo: escopoEfetivo });
      log(r.disponivel ? `   ${r.mecanismo || "registro de inicialização removido"}` : `   nada a remover (${r.motivo})`);
    } catch (erro) {
      log(`   não foi possível remover o registro de inicialização: ${erro.message}`);
    }
  }

  // --- Running Console -----------------------------------------------------------------------
  log("== Encerrando o console, se estiver em execução");
  const encerramento = await encerrarConsoleEmExecucao({ plataforma, dirEstado, simular, log });
  if (encerramento.impostor && !temFlag("sim")) {
    falhar("  Desinstalação interrompida: a porta do console está ocupada por outro processo.");
  }
  // Failing to prove the stop PREVENTS removal: deleting the program while an authenticated process
  // stays alive is the worst possible outcome.
  if (encerramento.motivo && !simular) {
    falhar(
      `  Desinstalação interrompida: não foi possível confirmar que o console parou (${encerramento.motivo}).\n` +
        "  Encerre o processo à mão e repita. Nada foi removido."
    );
  }

  // --- Atalhos ---------------------------------------------------------------------------------
  log("== Removendo atalhos");
  let removeuAtalho = false;
  const atalhos = plataforma.diretoriosPadrao({ escopo: "usuario" }).atalhos;
  if (plataforma.nome === "linux" && atalhos) {
    removeuAtalho = removerArquivo(path.join(atalhos, "remoteifes-console.desktop"), { simular }) || removeuAtalho;
  }
  if (plataforma.nome === "windows" && atalhos) {
    removeuAtalho = removerArquivo(path.join(atalhos, "Console de Operações RemoteIFES.lnk"), { simular }) || removeuAtalho;
  }
  if (plataforma.nome === "macos") {
    // On macOS the bundle **is** the program: it goes with the root, just below.
    removeuAtalho = true;
  }
  if (!removeuAtalho) log("   nenhum atalho encontrado.");

  // --- Programa ---------------------------------------------------------------------------------
  log("== Removendo o programa");
  if (autorizacao.ausente) {
    log(`   nada a remover: ${autorizacao.motivo}`);
  } else {
    const versoes = (() => {
      try {
        return fs.readdirSync(path.join(raiz, "versoes")).filter((v) => RE_VERSAO.test(v));
      } catch {
        return [];
      }
    })();
    if (versoes.length) log(`   versões instaladas: ${versoes.join(", ")}`);

    // No macOS, remover a raiz (Contents/Resources) deixaria um bundle quebrado em Aplicativos.
    const bundle = plataforma.nome === "macos" && plataforma.bundleDaRaiz ? plataforma.bundleDaRaiz(raiz) : null;
    if (bundle) {
      const autBundle = autorizarRemocao(bundle, { marcas: [path.join("Contents", "Info.plist")], rotulo: "bundle do console" });
      if (autBundle.ok) remover(bundle, { simular, rotulo: "bundle" });
      else log(`   bundle mantido: ${autBundle.motivo}`);
    } else {
      remover(raiz, { simular, rotulo: "programa" });
    }
  }

  // --- Estado ------------------------------------------------------------------------------------
  log("== Estado (operadores, auditoria, saídas de trabalhos)");
  if (!temFlag("apagar-estado")) {
    log(`   preservado em ${dirEstado}`);
    log("   Para apagá-lo também, repita com --apagar-estado.");
  } else {
    const autEstado = autorizarRemocao(dirEstado, {
      marcas: ["operadores.json", "auditoria.log", "saidas", "checkout-dir"],
      rotulo: "estado do console",
    });
    if (autEstado.ok) remover(dirEstado, { simular, rotulo: "estado" });
    else log(`   mantido: ${autEstado.motivo}`);
  }

  // --- What stays on the host -----------------------------------------------------------------
  log("");
  log("  O que NÃO foi tocado:");
  log("   • o checkout do RemoteIFES, seu banco e seus backups;");
  log("   • o serviço da aplicação (remoteifes) e suas unidades do sistema;");
  log("   • o Node instalado no host.");
  if (!temFlag("apagar-estado")) log(`   • o estado do console em ${dirEstado}.`);
  log("");
  if (plataforma.nome === "linux" && escopoEfetivo === "sistema") {
    log("  Se o console foi instalado por pacote (.deb), remova-o também com:");
    log("      sudo apt-get remove remoteifes-console");
    log("");
  }
  log(simular ? "  Simulação concluída; nada foi alterado." : "  Desinstalação concluída.");
  log("");
}

function perguntar(rotulo) {
  return new Promise((resolve) => {
    process.stdout.write(rotulo);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(String(d));
    });
  });
}

if (require.main === module) {
  main().catch((erro) => falhar(`  Falha na desinstalação: ${erro.message}`));
}

module.exports = { autorizarRemocao };
