#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

// Desinstalação do Console de Operações.
//
// Duas regras governam este arquivo, e valem mais do que qualquer conveniência:
//
//   1. **Nada é apagado sem prova de que é nosso.** Antes de qualquer remoção recursiva, o
//      diretório precisa exibir a assinatura de uma instalação do console (camada estável +
//      versoes/), estar contido num lugar plausível, não ser raiz de disco nem home, e
//      pertencer a quem está desinstalando. Um `--raiz` digitado errado não pode virar um
//      `rm -rf` no lugar errado.
//   2. **O estado fica, por padrão.** Operadores, auditoria e backups sobrevivem à remoção do
//      programa; quem quiser apagá-los pede explicitamente. Reinstalar e descobrir que a conta
//      sumiu é pior do que deixar um diretório para trás.
//
// O checkout do RemoteIFES (código e banco da aplicação) **nunca** é tocado: o console o
// administra, não é dono dele.
//
// Uso:
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
 * Autoriza (ou recusa) uma remoção recursiva. Devolve sempre um motivo legível: uma recusa que
 * não explica o que faltou leva o operador a apagar na mão, que é exatamente o risco.
 *
 * @param {string} caminho  diretório candidato
 * @param {object} exigido  `marcas`: nomes que **precisam** existir dentro; `rotulo`: o que é.
 */
function autorizarRemocao(caminho, { marcas, rotulo }) {
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

  // Contenção: nunca a raiz de um disco, nunca a home, nunca um caminho raso demais.
  const raizDoDisco = path.parse(alvo).root;
  if (alvo === raizDoDisco) return { ok: false, motivo: "recusado: o caminho é a raiz do sistema de arquivos" };
  if (alvo === path.resolve(os.homedir())) return { ok: false, motivo: "recusado: o caminho é o diretório do usuário" };
  const profundidade = alvo.slice(raizDoDisco.length).split(path.sep).filter(Boolean).length;
  if (profundidade < 2) return { ok: false, motivo: `recusado: ${alvo} é raso demais para ser removido recursivamente` };

  // Identidade: o diretório tem de parecer o que dizemos que é.
  const faltando = marcas.filter((m) => !fs.existsSync(path.join(alvo, m)));
  if (faltando.length === marcas.length) {
    return { ok: false, motivo: `${alvo} não tem nenhuma marca de ${rotulo} (esperado: ${marcas.join(", ")})` };
  }

  // Nunca dentro de um checkout do RemoteIFES: ali moram o código e o banco da aplicação.
  for (let dir = alvo; ; ) {
    if (fs.existsSync(path.join(dir, "remoteifes-server", "package.json"))) {
      return { ok: false, motivo: `recusado: ${alvo} está dentro do checkout do RemoteIFES (${dir}), que o console não é dono` };
    }
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }

  // Propriedade: em POSIX, de quem está desinstalando (ou root). No Windows, a prova prática é
  // conseguir escrever: o modelo de ACL não se reduz a um uid.
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
 * Se o desinstalador estiver rodando de DENTRO da instalação que vai apagar, ele se copia para
 * um diretório temporário e recomeça de lá.
 *
 * Não é preciosismo: no Windows, um arquivo com handle aberto só é removido quando o handle
 * fecha, e o diretório que o contém fica "não vazio" até lá. Apagar a instalação a partir de um
 * script que mora dentro dela deixava a raiz para trás com EPERM, com todo o conteúdo já
 * removido — o pior dos dois mundos. Recomeçar de fora resolve de uma vez, sem repetir
 * tentativas nem esperar por um handle.
 */
function reexecutarForaDaInstalacao(raiz, dirEstado) {
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

    // Os caminhos vão resolvidos: a cópia não deve recalcular padrões a partir de onde está.
    const repassar = process.argv.slice(2).filter((a, i, todos) => {
      const anterior = todos[i - 1];
      if (a === "--raiz" || a === "--estado") return false;
      if (anterior === "--raiz" || anterior === "--estado") return false;
      return true;
    });
    const r = require("child_process").spawnSync(
      process.execPath,
      [copia, ...repassar, "--raiz", alvo, "--estado", path.resolve(dirEstado)],
      { stdio: "inherit" }
    );
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

async function main() {
  const plataforma = require(path.join(__dirname, "..", "src", "plataforma"));
  const simular = temFlag("simular");
  const escopo = argumento("escopo", process.platform === "linux" ? "sistema" : "usuario");
  if (!["usuario", "sistema"].includes(escopo)) falhar("--escopo aceita apenas 'usuario' ou 'sistema'");

  const padroes = plataforma.diretoriosPadrao({ escopo });
  const raiz = path.resolve(argumento("raiz", padroes.raizInstalacao));
  const dirEstado = path.resolve(argumento("estado", padroes.estado));

  if (!temFlag("simular") && reexecutarForaDaInstalacao(raiz, dirEstado)) return;

  log("");
  log("  Console de Operações RemoteIFES — desinstalação");
  log("  ──────────────────────────────────────────────");
  log(`  Plataforma : ${plataforma.rotulo}`);
  log(`  Escopo     : ${escopo}`);
  log(`  Programa   : ${raiz}`);
  log(`  Estado     : ${dirEstado}${temFlag("apagar-estado") ? " (será apagado)" : " (preservado)"}`);
  if (simular) log("  Modo       : simulação — nada será removido");
  log("");

  const autorizacao = autorizarRemocao(raiz, {
    marcas: ["console-bootstrap.js", "versoes", "estado-instalacao.json"],
    rotulo: "instalação do console",
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

  // --- Integração com a plataforma ------------------------------------------------------------
  log("== Removendo a integração com o sistema");
  try {
    const r = await plataforma.removerInicializacao({ escopo });
    log(r.disponivel ? `   ${r.mecanismo || "registro de inicialização removido"}` : `   nada a remover (${r.motivo})`);
  } catch (erro) {
    log(`   não foi possível remover o registro de inicialização: ${erro.message}`);
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
    // No macOS o bundle **é** o programa: ele sai junto com a raiz, logo abaixo.
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

  // --- O que continua no host -----------------------------------------------------------------
  log("");
  log("  O que NÃO foi tocado:");
  log("   • o checkout do RemoteIFES, seu banco e seus backups;");
  log("   • o serviço da aplicação (remoteifes) e suas unidades do sistema;");
  log("   • o Node instalado no host.");
  if (!temFlag("apagar-estado")) log(`   • o estado do console em ${dirEstado}.`);
  log("");
  if (plataforma.nome === "linux" && escopo === "sistema") {
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
