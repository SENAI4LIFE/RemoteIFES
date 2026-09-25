#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Portable Operations Console installer.
//
// It always assembles the same layout, on every system:
//
//   <raiz>/console-bootstrap.js      stable layer (owned by the package)
//   <raiz>/launcher-bootstrap.js
//   <raiz>/estado-instalacao.json    active version pointer
//   <raiz>/versoes/<versao>/         payload, immutable
//
// The split lets the package manager keep owning a fixed set of files while the updater swaps the
// payload side by side. Without it, a `.deb` and a self-updater would overwrite each other's files
// and leave dpkg inconsistent.
//
// Usage:
//   node instalacao/instalar.js [--escopo usuario|sistema] [--raiz <dir>] [--estado <dir>]
//                              [--checkout <dir>] [--porta <n>] [--sem-servico] [--forcar]

const ORIGEM = path.resolve(path.join(__dirname, ".."));

// What never goes into the installed payload. `.signing/`, keys and signatures stay out because
// installing is not publishing: copying a private publishing key into an installation would spread
// it, possibly with looser permissions than the original.
const IGNORAR_NA_COPIA = new Set(["node_modules", ".git", "test", "empacotar", ".signing", "dist"]);

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

function ehAdministrador() {
  if (process.platform === "win32") {
    try {
      execFileSync("net", ["session"], { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function copiarArvore(origem, destino, { ignorar = new Set() } = {}) {
  fs.mkdirSync(destino, { recursive: true });
  for (const entrada of fs.readdirSync(origem, { withFileTypes: true })) {
    if (ignorar.has(entrada.name)) continue;
    const de = path.join(origem, entrada.name);
    const para = path.join(destino, entrada.name);
    if (entrada.isSymbolicLink()) continue;  // a payload does not distribute links
    if (entrada.isDirectory()) {
      copiarArvore(de, para, { ignorar });
      continue;
    }
    fs.copyFileSync(de, para);
    if (process.platform !== "win32" && /\.(sh|js)$/.test(entrada.name) && /^#!/.test(fs.readFileSync(de, "utf8").slice(0, 2))) {
      // Preserves the executable bit for files with a shebang: the Git index does not carry it, and
      // a runner without +x fails with EACCES on the first operation.
      fs.chmodSync(para, 0o755);
    }
  }
}

async function main() {
  const pacote = JSON.parse(fs.readFileSync(path.join(ORIGEM, "package.json"), "utf8"));
  const versao = pacote.version;

  // Loads the adapter with the requested scope, before any path decision.
  const plataforma = require(path.join(ORIGEM, "src", "plataforma"));
  const admin = ehAdministrador();
  const escopoPedido = argumento("escopo", admin ? (process.platform === "linux" ? "sistema" : "usuario") : "usuario");
  if (!["usuario", "sistema"].includes(escopoPedido)) falhar("--escopo aceita apenas 'usuario' ou 'sistema'");
  if (escopoPedido === "sistema" && !admin) {
    falhar("instalação de escopo 'sistema' exige privilégio de administrador/root.");
  }

  const padroes = plataforma.diretoriosPadrao({ escopo: escopoPedido });
  const raiz = path.resolve(argumento("raiz", padroes.raizInstalacao));
  const dirEstado = path.resolve(argumento("estado", padroes.estado));
  const dirLogs = path.resolve(argumento("logs", padroes.logs));

  // Node is a prerequisite of what the Console manages: RemoteIFES does not run without it.
  const runtime = plataforma.runtimeAtual();
  if (!runtime.atende && !temFlag("forcar")) {
    falhar(
      `${runtime.motivo}.\nO RemoteIFES exige Node ${runtime.minimoExigido} ou mais novo, e o console usa o mesmo runtime.\n` +
        "Instale um Node compatível e repita, ou use --forcar por sua conta e risco."
    );
  }

  log("");
  log("  Console de Operações RemoteIFES — instalação");
  log("  ───────────────────────────────────────────");
  log(`  Plataforma : ${plataforma.rotulo} (${process.arch})`);
  log(`  Versão     : ${versao}`);
  log(`  Escopo     : ${escopoPedido}${admin ? " (com privilégio)" : ""}`);
  log(`  Programa   : ${raiz}`);
  log(`  Estado     : ${dirEstado}`);
  log(`  Node       : ${runtime.versao}`);
  log("");

  // --- Migration from the previous Linux layout (atual/anterior) ----------------------------
  const migrado = migrarLayoutAntigo(raiz, log);

  // --- Payload lado a lado ------------------------------------------------------------------
  const destinoVersao = path.join(raiz, "versoes", versao);
  log(`== Instalando o payload em versoes/${versao}`);
  // Reinstalling over itself is the documented repair command: it runs
  // `versoes/<v>/instalacao/instalar.js --forcar`, where SOURCE **is** the destination. The copy
  // always goes to a staging directory beside the target and enters by rename; the old tree is
  // removed only afterwards.
  const origemEhODestino = ORIGEM === destinoVersao || ORIGEM.startsWith(destinoVersao + path.sep);
  if (fs.existsSync(destinoVersao) && !temFlag("forcar")) {
    log("   já presente; mantendo (use --forcar para reescrever).");
  } else {
    const parcial = `${destinoVersao}.parcial-${crypto.randomBytes(3).toString("hex")}`;
    fs.rmSync(parcial, { recursive: true, force: true });
    copiarArvore(ORIGEM, parcial, { ignorar: IGNORAR_NA_COPIA });
    if (!fs.existsSync(path.join(parcial, "console.js"))) {
      fs.rmSync(parcial, { recursive: true, force: true });
      falhar(`a cópia do payload ficou incompleta em ${parcial}; nada foi substituído.`);
    }
    fs.mkdirSync(path.dirname(destinoVersao), { recursive: true });
    if (fs.existsSync(destinoVersao)) {
      const aposentado = `${destinoVersao}.substituido-${crypto.randomBytes(3).toString("hex")}`;
      fs.renameSync(destinoVersao, aposentado);
      try {
        fs.renameSync(parcial, destinoVersao);
      } catch (erro) {
        // Between the two renames the active version does not exist. If the second fails, the old
        // one is put back: otherwise the payload would exist only under `.substituido-*` with no
        // automatic restoration, and the pointer would reference a missing directory.
        fs.renameSync(aposentado, destinoVersao);
        fs.rmSync(parcial, { recursive: true, force: true });
        falhar(`não foi possível instalar o payload (${erro.message}); a versão anterior foi restaurada.`);
      }
      // Only now does the old tree go; if it was the source, the copy is already done.
      fs.rmSync(aposentado, { recursive: true, force: true });
      log(origemEhODestino ? "   payload substituído a partir de si mesmo, com estágio intermediário." : "   payload substituído.");
    } else {
      fs.renameSync(parcial, destinoVersao);
    }
  }

  // node_modules is preserved across versions: the operator installs the optional terminal
  // (node-pty) there, and deleting it on every update would make the terminal disappear without
  // explanation.
  const modulosCompartilhados = path.join(raiz, "node_modules");
  if (fs.existsSync(modulosCompartilhados)) {
    log("   node_modules compartilhado preservado (dependências opcionais, como o PTY).");
  }

  // --- Stable layer ----------------------------------------------------------------------------
  log("== Instalando a camada estável");
  fs.copyFileSync(path.join(ORIGEM, "instalacao", "console-bootstrap.js"), path.join(raiz, "console-bootstrap.js"));
  fs.writeFileSync(
    path.join(raiz, "launcher-bootstrap.js"),
    "#!/usr/bin/env node\n" +
      "// Camada estável do lançador: resolve a versão ativa e a carrega.\n" +
      'process.env.CONSOLE_BOOTSTRAP_ALVO = "launcher";\n' +
      'require(require("path").join(__dirname, "console-bootstrap.js"));\n',
    { mode: 0o755 }
  );

  const estadoInstalacao = path.join(raiz, "estado-instalacao.json");
  const anteriorRegistrada = (() => {
    try {
      return JSON.parse(fs.readFileSync(estadoInstalacao, "utf8")).versaoAtiva || null;
    } catch {
      return null;
    }
  })();
  // The state location is RECORDED here.
  //
  // The program started from a shortcut has no environment variables, so without this record it
  // would fall back to the platform default (`/var/lib/...`, `%ProgramData%`) instead of the chosen
  // state directory, and the first operator would not find the token. A custom `--estado` is kept
  // the same way.
  fs.writeFileSync(
    estadoInstalacao,
    `${JSON.stringify(
      {
        versaoAtiva: versao,
        versaoAnterior: anteriorRegistrada && anteriorRegistrada !== versao ? anteriorRegistrada : null,
        transacao: null,
        atualizadoEm: new Date().toISOString(),
        escopo: escopoPedido,
        estado: dirEstado,
        logs: dirLogs,
        porta: Number(argumento("porta", "8099")),
      },
      null,
      2
    )}\n`
  );

  // --- Estado -------------------------------------------------------------------------------
  log("== Preparando o diretório de estado");
  fs.mkdirSync(dirEstado, { recursive: true });
  fs.mkdirSync(path.join(dirEstado, "saidas"), { recursive: true });
  fs.mkdirSync(dirLogs, { recursive: true });
  const protecao = plataforma.protegerArquivo(dirEstado, { diretorio: true });
  log(`   proteção do estado: ${protecao.disponivel ? protecao.mecanismo || "modo POSIX" : `não aplicada (${protecao.motivo})`}`);

  const checkout = argumento("checkout", null);
  if (checkout) {
    const resolvido = path.resolve(checkout);
    if (!fs.existsSync(path.join(resolvido, "remoteifes-server", "package.json"))) {
      falhar(`--checkout aponta para ${resolvido}, que não parece um checkout do RemoteIFES.`);
    }
    fs.writeFileSync(path.join(dirEstado, "checkout-dir"), `${resolvido}\n`, { mode: 0o600 });
    log(`   checkout administrado: ${resolvido}`);
  } else if (!fs.existsSync(path.join(dirEstado, "checkout-dir"))) {
    const palpite = path.resolve(path.join(ORIGEM, ".."));
    if (fs.existsSync(path.join(palpite, "remoteifes-server", "package.json"))) {
      fs.writeFileSync(path.join(dirEstado, "checkout-dir"), `${palpite}\n`, { mode: 0o600 });
      log(`   checkout administrado (detectado): ${palpite}`);
    } else {
      log("   nenhum checkout do RemoteIFES associado ainda; use --checkout <dir> para apontá-lo.");
    }
  }

  // --- Primeiro operador ---------------------------------------------------------------------
  const arquivoOperadores = path.join(dirEstado, "operadores.json");
  const jaTemOperador = (() => {
    try {
      return (JSON.parse(fs.readFileSync(arquivoOperadores, "utf8")).operadores || []).length > 0;
    } catch {
      return false;
    }
  })();

  let segredo = null;
  if (jaTemOperador) {
    log("== Operador já cadastrado; credenciais preservadas.");
  } else {
    segredo = crypto.randomBytes(24).toString("base64url").slice(0, 32);
    const arquivoSegredo = path.join(dirEstado, "bootstrap-token");
    fs.writeFileSync(arquivoSegredo, `${segredo}\n`, { mode: 0o600 });
    plataforma.protegerArquivo(arquivoSegredo);
  }

  // --- Platform integration --------------------------------------------------------------------
  const resultadoPlataforma = temFlag("sem-servico")
    ? { pulado: true }
    : await integrarComPlataforma({ plataforma, raiz, dirEstado, dirLogs, escopo: escopoPedido, admin, log });

  // --- Encerramento ----------------------------------------------------------------------------
  log("");
  log("  Instalação concluída.");
  log("");
  if (migrado.migrou) {
    log(`  Layout anterior migrado: ${migrado.detalhe}`);
    log("");
  }
  if (segredo) {
    log("  ================================================================");
    log("   Segredo de instalação (uso único, exibido apenas agora):");
    log("");
    log(`       ${segredo}`);
    log("");
    log("   Use-o na primeira tela do console para criar o operador.");
    log(`   Ele também está em ${path.join(dirEstado, "bootstrap-token")}, legível só por`);
    log("   quem administra este host, e é apagado assim que o operador for criado.");
    log("  ================================================================");
    log("");
  }
  log(`  Abrir o console:  ${comandoDoLancador(raiz)}`);
  if (resultadoPlataforma.atalho) log(`  Atalho criado em: ${resultadoPlataforma.atalho}`);
  if (resultadoPlataforma.observacao) log(`  ${resultadoPlataforma.observacao}`);
  log("");
  log("  A operação do prédio (salas, agendamentos, usuários, ESP32) continua no aplicativo RemoteIFES.");
  log("");
}

function comandoDoLancador(raiz) {
  return `"${process.execPath}" "${path.join(raiz, "launcher-bootstrap.js")}"`;
}

/**
 * Migrates the previous Linux layout (`<raiz>/atual` and `<raiz>/anterior`) to `versoes/`. Does not
 * move state, regenerate credentials or touch the checkout: it only relocates the program.
 */
function migrarLayoutAntigo(raiz, log) {
  const antigoAtual = path.join(raiz, "atual");
  if (!fs.existsSync(path.join(antigoAtual, "console.js"))) return { migrou: false };

  let versaoAntiga = "0.0.0";
  try {
    versaoAntiga = JSON.parse(fs.readFileSync(path.join(antigoAtual, "package.json"), "utf8")).version || "0.0.0";
  } catch {}

  const destino = path.join(raiz, "versoes", versaoAntiga);
  log(`== Migrando o layout anterior (atual/ → versoes/${versaoAntiga})`);
  fs.mkdirSync(path.join(raiz, "versoes"), { recursive: true });
  if (!fs.existsSync(destino)) {
    fs.renameSync(antigoAtual, destino);
  } else {
    fs.rmSync(antigoAtual, { recursive: true, force: true });
  }
  fs.rmSync(path.join(raiz, "anterior"), { recursive: true, force: true });
  return { migrou: true, detalhe: `versão ${versaoAntiga} movida para versoes/` };
}

async function integrarComPlataforma({ plataforma, raiz, dirEstado, dirLogs, escopo, admin, log }) {
  const comando = process.execPath;
  const argumentos = [path.join(raiz, "console-bootstrap.js")];

  if (plataforma.nome === "linux") {
    return integrarLinux({ plataforma, raiz, dirEstado, escopo, admin, log });
  }

  log("== Registrando a inicialização em segundo plano");
  let resultado;
  try {
    resultado = await plataforma.registrarInicializacao({ comando, argumentos, logs: dirLogs, escopo });
  } catch (erro) {
    resultado = { disponivel: false, motivo: erro.message };
  }
  log(resultado.disponivel ? `   ${resultado.mecanismo}` : `   não registrado: ${resultado.motivo}`);

  const atalho = criarAtalho({ plataforma, raiz, log });
  return {
    atalho,
    observacao:
      "Modelo de segundo plano: partida sob demanda pelo lançador. Não há serviço residente — o console sobe " +
      "quando alguém o abre e sai sozinho depois de ficar ocioso.",
  };
}

function criarAtalho({ plataforma, raiz, log }) {
  const padroes = plataforma.diretoriosPadrao({ escopo: "usuario" });
  if (!padroes.atalhos) return null;
  try {
    fs.mkdirSync(padroes.atalhos, { recursive: true });
  } catch {
    return null;
  }

  if (plataforma.nome === "linux") {
    const arquivo = path.join(padroes.atalhos, "remoteifes-console.desktop");
    // A desktop entry is a configuration file, not a script: no shebang, no +x.
    fs.writeFileSync(
      arquivo,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Console de Operações RemoteIFES",
        "Comment=Manutenção do servidor, do host e da infraestrutura do RemoteIFES",
        `Exec=${process.execPath} ${path.join(raiz, "launcher-bootstrap.js")}`,
        "Terminal=false",
        "Categories=System;Settings;",
        "StartupNotify=true",
        "",
      ].join("\n"),
      { mode: 0o644 }
    );
    log(`== Atalho criado: ${arquivo}`);
    return arquivo;
  }

  if (plataforma.nome === "windows") {
    // The shortcut targets wscript.exe, a GUI-subsystem program: otherwise opening the Console
    // would flash a black console window on every run. Extension .vbs, not .js: `wscript.exe` picks
    // the script engine by EXTENSION, so VBScript in a .js file is parsed as JScript and fails.
    // With `//B` the error is silent and the shortcut opens nothing.
    const oculto = path.join(raiz, "abrir-console.vbs");
    fs.writeFileSync(
      oculto,
      [
        "' Lançador do Console de Operações (Windows Script Host).",
        "' Executa o lançador Node sem janela de console.",
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Run """${process.execPath}"" ""${path.join(raiz, "launcher-bootstrap.js")}""", 0, False`,
        "",
      ].join("\r\n")
    );
    const arquivo = path.join(padroes.atalhos, "Console de Operações RemoteIFES.lnk");
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut('${arquivo.replace(/'/g, "''")}'); ` +
            `$s.TargetPath = 'wscript.exe'; $s.Arguments = '\"${oculto}\"'; $s.WorkingDirectory = '${raiz}'; ` +
            `$s.Description = 'Console de Operações RemoteIFES'; $s.Save()`,
        ],
        { stdio: "ignore", timeout: 30_000 }
      );
      log(`== Atalho criado: ${arquivo}`);
      return arquivo;
    } catch (erro) {
      log(`== Atalho não criado (${erro.message})`);
      return null;
    }
  }

  if (plataforma.nome === "macos") {
    // A .app bundle whose executable is a script with a shebang: Finder accepts it and nothing
    // needs to be compiled. The launcher runs in the user session, where the browser opens. The
    // root is already inside the bundle (Contents/Resources); the bundle is its grandparent. If
    // someone installed with --raiz outside a bundle, one is created in Applications pointing
    // there.
    const bundle = plataforma.bundleDaRaiz(raiz) || path.join(padroes.atalhos, "RemoteIFES Console.app");
    const macos = path.join(bundle, "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(
      path.join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleName</key><string>RemoteIFES Console</string>
    <key>CFBundleDisplayName</key><string>Console de Operações RemoteIFES</string>
    <key>CFBundleIdentifier</key><string>br.edu.ifes.remoteifes.console</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>abrir-console</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSUIElement</key><true/>
  </dict>
</plist>
`
    );
    const executavel = path.join(macos, "abrir-console");
    fs.writeFileSync(
      executavel,
      `#!/bin/sh\n# Aberto pelo Finder: sem arquivos de inicialização de shell, caminhos absolutos.\nexec "${process.execPath}" "${path.join(raiz, "launcher-bootstrap.js")}"\n`,
      { mode: 0o755 }
    );
    log(`== Bundle criado: ${bundle}`);
    return bundle;
  }

  return null;
}

async function integrarLinux({ plataforma, raiz, dirEstado, escopo, admin, log }) {
  const atalho = criarAtalho({ plataforma, raiz, log });
  if (!plataforma.temSystemd()) {
    log("== systemd não é o gerenciador deste sistema; nenhuma unidade instalada.");
    return {
      atalho,
      observacao:
        "Sem systemd, o console é iniciado sob demanda pelo lançador. O controle do serviço da aplicação " +
        "aparece como não aplicável em vez de chamar systemctl que não existe.",
    };
  }
  if (escopo !== "sistema" || !admin) {
    log("== Escopo de usuário: unidades systemd de sistema não instaladas.");
    return {
      atalho,
      observacao:
        "Para instalar o socket/serviço systemd e o auxiliar privilegiado, repita com sudo e --escopo sistema. " +
        "O console funciona sob demanda pelo lançador mesmo sem eles, com as operações privilegiadas indisponíveis.",
    };
  }

  // Console owner user: whoever invoked sudo, not root. The service runs as that user; root access
  // goes through the helper, which is root:root and accepts only fixed verbs.
  const usuario = process.env.SUDO_USER || os.userInfo().username;
  const checkout = lerCheckoutAssociado(dirEstado) || path.resolve(path.join(ORIGEM, ".."));
  const dirDados = dirDadosDaAplicacao(checkout);
  const porta = Number(argumento("porta", "8099"));
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) falhar("--porta precisa ser um número de porta válido");

  log("== Unidades systemd, auxiliar privilegiado e regra de sudo");
  const r = await plataforma.registrarInicializacao({
    origem: ORIGEM,
    raizInstalacao: raiz,
    dirEstado,
    dirDados,
    checkout,
    usuario,
    node: process.execPath,
    porta,
  });
  if (!r.disponivel) {
    log(`   não instaladas: ${r.motivo}`);
    return { atalho, observacao: `Integração com o systemd não concluída: ${r.motivo}` };
  }
  log(`   ${r.mecanismo}`);
  log(`   auxiliar privilegiado: ${r.auxiliar} (root:root, verbos fixos)`);

  // The installation root and state belong to the Console user: version switching is a rename
  // inside the root, and a root-only directory would prevent self-update without adding security;
  // the real privilege lives in the helper, not in file ownership.
  ajustarDono(raiz, usuario, log);
  ajustarDono(dirEstado, usuario, log);

  return {
    atalho,
    observacao:
      `Console acessível em http://127.0.0.1:${porta} neste host. De outra máquina, use um túnel SSH ` +
      `(ssh -L ${porta}:127.0.0.1:${porta} ${usuario}@este-host); o localhost do seu computador não é o do host.`,
  };
}

function lerCheckoutAssociado(dirEstado) {
  try {
    const valor = fs.readFileSync(path.join(dirEstado, "checkout-dir"), "utf8").trim();
    return valor || null;
  } catch {
    return null;
  }
}

/**
 * Application data directory, asking the server itself where it is.
 */
function dirDadosDaAplicacao(checkout) {
  try {
    const caminhos = require(path.join(checkout, "remoteifes-server", "src", "config", "paths.js"));
    if (caminhos && caminhos.DIR_DADOS) return caminhos.DIR_DADOS;
  } catch {}
  return path.join(checkout, "remoteifes-server", "data");
}

function ajustarDono(caminho, usuario, log) {
  try {
    execFileSync("chown", ["-R", usuario, caminho], { stdio: "ignore", timeout: 120_000 });
  } catch (erro) {
    log(`   aviso: não foi possível ajustar o dono de ${caminho} para ${usuario} (${erro.message})`);
  }
}

if (require.main === module) {
  main().catch((erro) => falhar(`falha na instalação: ${erro && erro.stack ? erro.stack : erro}`));
}

module.exports = { migrarLayoutAntigo, copiarArvore, comandoDoLancador };
