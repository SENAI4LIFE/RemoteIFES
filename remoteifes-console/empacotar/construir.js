#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { listarDependencias } = require("../instalacao/dependencias");

// Builds the distribution artifacts.
//
// Only formats CI can **build and install** on a real machine of the target system are produced.
// MSI/WiX, NSIS and a signed `.pkg` are deliberately excluded: without signing credentials and a
// validation environment they would ship an untested installer.
//
//   payload .tar.gz   consumed by the release updater on every platform
//   .deb              Linux with dpkg (CI installs and verifies)
//   .zip              Windows (CI installs with instalar.ps1 and verifies)
//
// The `tar` is assembled here without the system binary: Windows has no GNU tar and the header
// layout must match the updater's extractor exactly.
//
// Usage:
//   node empacotar/construir.js [--saida <dir>] [--alvo <so-arch>] [--formato payload|deb|zip|todos]
//                               [--commit <sha>]
//
// The manifest records the commit built (from Git, or --commit outside a checkout); the release
// attestation must name the same commit. Payloads carry the production dependencies pinned by
// package-lock.json, and nothing else from node_modules.

const RAIZ = path.join(__dirname, "..");
const PACOTE = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8"));
const VERSAO = PACOTE.version;

// What goes into the payload. Tests, packaging and build artifacts stay out: the installed program
// does not need them and every MiB counts on a Raspberry Pi.
const INCLUIR = ["console.js", "launcher.js", "package.json", "package-lock.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd"];

/** Everything a payload carries: INCLUIR plus the production dependencies. */
function itensDoPayload(raiz = RAIZ) {
  return [...INCLUIR, ...listarDependencias(raiz)];
}

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
}

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

// --- tar ----------------------------------------------------------------------------------

/**
 * Splits a path for the ustar header: a name of up to 100 bytes, and the directories before it in
 * the 155-byte prefix field. dpkg and the updater's extractor both join them back with "/".
 */
function dividirNome(nome) {
  if (Buffer.byteLength(nome) <= 100) return { prefixo: "", nome };
  const semBarraFinal = nome.endsWith("/") ? nome.slice(0, -1) : nome;
  for (let i = semBarraFinal.lastIndexOf("/"); i > 0; i = semBarraFinal.lastIndexOf("/", i - 1)) {
    const prefixo = nome.slice(0, i);
    const resto = nome.slice(i + 1);
    if (Buffer.byteLength(prefixo) <= 155 && Buffer.byteLength(resto) <= 100) return { prefixo, nome: resto };
  }
  throw new Error(`nome longo demais para tar: ${nome}`);
}

function cabecalhoTar({ nome: completo, tamanho, modo, tipo = "0" }) {
  const b = Buffer.alloc(512);
  const escrever = (texto, inicio, tam) => b.write(String(texto).slice(0, tam - 1), inicio, tam, "utf8");
  const { prefixo, nome } = dividirNome(completo);
  // Written whole, not through `escrever`: a name of exactly 100 bytes has no terminator in ustar.
  b.write(nome, 0, 100, "utf8");
  if (prefixo) b.write(prefixo, 345, 155, "utf8");
  escrever(`${(modo & 0o7777).toString(8).padStart(7, "0")}\0`, 100, 8);
  escrever("0000000\0", 108, 8);
  escrever("0000000\0", 116, 8);
  escrever(`${tamanho.toString(8).padStart(11, "0")}\0`, 124, 12);
  escrever("00000000000\0", 136, 12);
  b.write("        ", 148, 8, "utf8");
  // The typeflag is exactly 1 byte and is NOT NUL-terminated, so it does not go through `escrever`,
  // which reserves the last byte for the terminator (with size 1 that truncates the field to
  // empty). A zero byte (AREGTYPE) makes a directory entry an empty file of the same name for
  // readers such as dpkg.
  b.write(String(tipo), 156, 1, "utf8");
  b.write("ustar\0", 257, 6, "utf8");
  b.write("00", 263, 2, "utf8");
  let soma = 0;
  for (const byte of b) soma += byte;
  escrever(`${soma.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return b;
}

/**
 * Files to package. Uses `lstat` and **refuses** any link.
 *
 * Following a link inside an included directory would package a file from outside the tree as
 * program content (Git configuration, credentials, whatever is on the other side), and a directory
 * cycle would recurse forever. A payload has no reason to contain links.
 */
function listarArquivos(base, relativo = "") {
  const completo = path.join(base, relativo);
  // npm's links to package executables: the Console runs none of them.
  if (path.basename(relativo) === ".bin" && relativo.includes("node_modules")) return [];
  const info = fs.lstatSync(completo);
  if (info.isSymbolicLink()) {
    throw new Error(`${relativo || completo} é um link simbólico; um payload não distribui links. Remova-o ou exclua-o da lista.`);
  }
  if (info.isFile()) return [{ relativo: relativo.split(path.sep).join("/"), completo, modo: info.mode, bytes: info.size }];
  if (!info.isDirectory()) return [];
  const saida = [];
  for (const entrada of fs.readdirSync(completo).sort()) {
    saida.push(...listarArquivos(base, path.join(relativo, entrada)));
  }
  return saida;
}

/**
 * Builds a `.tar.gz`. `prefixo` relocates the copied tree (the .deb needs it under `opt/...`);
 * `extras` adds package-only files with their own path, without touching the disk.
 */
function montarTarGz(base, itens, { prefixo = "", extras = [] } = {}) {
  const blocos = [];
  const diretoriosEmitidos = new Set();

  // DIRECTORY entries, before every file that lives in them.
  //
  // dpkg extracts member by member and does not create missing parent paths, so a tar without
  // directory entries is malformed even though the updater's extractor (`mkdir -p`) accepts it.
  const garantirDiretorio = (caminhoNoArquivo) => {
    const partes = caminhoNoArquivo.split("/").slice(0, -1);
    let acumulado = "";
    for (const parte of partes) {
      acumulado += `${parte}/`;
      if (diretoriosEmitidos.has(acumulado)) continue;
      diretoriosEmitidos.add(acumulado);
      blocos.push(cabecalhoTar({ nome: acumulado, tamanho: 0, modo: 0o755, tipo: "5" }));
    }
  };

  const acrescentar = (nome, conteudo, modo) => {
    garantirDiretorio(nome);
    blocos.push(cabecalhoTar({ nome, tamanho: conteudo.length, modo }));
    blocos.push(conteudo);
    const resto = conteudo.length % 512;
    if (resto) blocos.push(Buffer.alloc(512 - resto));
  };

  for (const item of itens) {
    for (const arquivo of listarArquivos(base, item)) {
      const conteudo = fs.readFileSync(arquivo.completo);
      // The executable bit comes from the shebang, not the Git index: Git stores 100644 for these
      // files and a runner without +x would fail with EACCES on the first real operation.
      const executavel = conteudo.slice(0, 2).toString() === "#!";
      acrescentar(`${prefixo}${arquivo.relativo}`, conteudo, executavel ? 0o755 : 0o644);
    }
  }
  for (const extra of extras) {
    // Extras carry their final path inside the archive: they exist only in the package and are not
    // always under the copied tree's prefix.
    const conteudo = Buffer.isBuffer(extra.conteudo) ? extra.conteudo : Buffer.from(extra.conteudo, "utf8");
    acrescentar(extra.nome, conteudo, extra.modo === undefined ? 0o644 : extra.modo);
  }
  blocos.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocos), { level: 9 });
}

// --- zip ------------------------------------------------------------------------------------

function montarZip(base, itens) {
  const entradas = [];
  const partes = [];
  let deslocamento = 0;

  for (const item of itens) {
    for (const arquivo of listarArquivos(base, item)) {
      const conteudo = fs.readFileSync(arquivo.completo);
      const comprimido = zlib.deflateRawSync(conteudo, { level: 9 });
      const crc = crc32(conteudo);
      const nome = Buffer.from(arquivo.relativo, "utf8");

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // nome em UTF-8
      local.writeUInt16LE(8, 8); // deflate
      local.writeUInt32LE(0, 10);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(comprimido.length, 18);
      local.writeUInt32LE(conteudo.length, 22);
      local.writeUInt16LE(nome.length, 26);
      local.writeUInt16LE(0, 28);

      partes.push(local, nome, comprimido);
      entradas.push({ nome, crc, comprimido: comprimido.length, bruto: conteudo.length, deslocamento });
      deslocamento += local.length + nome.length + comprimido.length;
    }
  }

  const central = [];
  for (const e of entradas) {
    const cab = Buffer.alloc(46);
    cab.writeUInt32LE(0x02014b50, 0);
    cab.writeUInt16LE(20, 4);
    cab.writeUInt16LE(20, 6);
    cab.writeUInt16LE(0x0800, 8);
    cab.writeUInt16LE(8, 10);
    cab.writeUInt32LE(0, 12);
    cab.writeUInt32LE(e.crc, 16);
    cab.writeUInt32LE(e.comprimido, 20);
    cab.writeUInt32LE(e.bruto, 24);
    cab.writeUInt16LE(e.nome.length, 28);
    cab.writeUInt32LE(e.deslocamento, 42);
    central.push(cab, e.nome);
  }
  const centralBuf = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(centralBuf.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...partes, centralBuf, fim]);
}

let tabelaCrc = null;
function crc32(buf) {
  if (!tabelaCrc) {
    tabelaCrc = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabelaCrc[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ tabelaCrc[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

// --- deb --------------------------------------------------------------------------------------

function montarDeb(saida) {
  // A .deb is an `ar` with debian-binary, control.tar.gz and data.tar.gz. Everything is assembled
  // here, without dpkg-deb and without the system `tar`: the build machine can be any of the three
  // systems, and Windows has no GNU tar.
  //
  // The package owns only the stable layer and the first version. Later updates go to `versoes/`
  // without touching files registered by dpkg, so the package manager never becomes inconsistent
  // because of a self-update. The version pointer (estado-instalacao.json) is not a package file:
  // the updater rewrites it, so the postinst creates it through the installer instead.
  //
  // Maintainer scripts delegate to the same installer and uninstaller used for manual
  // installation (`--pacote` mode), so there is one verified provisioning path:
  //   postinst configure  -> instalar.js --pacote (state, setup secret, units, helper, sudo rule)
  //   prerm remove        -> desinstalar.js --pacote (integration, running Console, non-package files)
  //   postrm purge        -> the Console state and logs
  const raizPacote = "opt/remoteifes-console";

  const atalho = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Console de Operações RemoteIFES",
    "Comment=Manutenção do servidor, do host e da infraestrutura do RemoteIFES",
    "Exec=/usr/bin/node /opt/remoteifes-console/launcher-bootstrap.js",
    "Terminal=false",
    "Categories=System;Settings;",
    "StartupNotify=true",
    "",
  ].join("\n");

  const dados = montarTarGz(RAIZ, itensDoPayload(), {
    prefixo: `${raizPacote}/versoes/${VERSAO}/`,
    extras: [
      {
        nome: `${raizPacote}/console-bootstrap.js`,
        conteudo: fs.readFileSync(path.join(RAIZ, "instalacao", "console-bootstrap.js")),
        modo: 0o755,
      },
      {
        nome: `${raizPacote}/launcher-bootstrap.js`,
        conteudo:
          '#!/usr/bin/env node\nprocess.env.CONSOLE_BOOTSTRAP_ALVO = "launcher";\nrequire(require("path").join(__dirname, "console-bootstrap.js"));\n',
        modo: 0o755,
      },
      { nome: "usr/share/applications/remoteifes-console.desktop", conteudo: atalho },
    ],
  });

  const controle = [
    `Package: remoteifes-console`,
    `Version: ${VERSAO}`,
    `Section: admin`,
    `Priority: optional`,
    `Architecture: all`,
    // Node is a prerequisite of what the Console manages; declaring the dependency is better than
    // installing something that would not start.
    `Depends: nodejs (>= 22.13.0)`,
    `Maintainer: RemoteIFES <brunoalexandersenai@gmail.com>`,
    `Description: Console de Operacoes do RemoteIFES`,
    ` Manutencao do servidor, do host e da infraestrutura do RemoteIFES:`,
    ` servico, atualizacao, backup, recuperacao, rede e diagnostico.`,
    "",
  ].join("\n");

  const payload = `/${raizPacote}/versoes/${VERSAO}`;
  const postinst = [
    "#!/bin/sh",
    "set -e",
    'if [ "$1" = "configure" ]; then',
    '  NODE="$(command -v node || true)"',
    '  if [ -z "$NODE" ]; then',
    '    echo "remoteifes-console: Node não encontrado no PATH; instale o Node 22.13+ e rode: sudo dpkg-reconfigure remoteifes-console" >&2',
    "    exit 1",
    "  fi",
    `  "$NODE" "${payload}/instalacao/instalar.js" --pacote --raiz "/${raizPacote}"`,
    "  # An upgrade restarts a running Console into the new active version. Jobs survive: the unit",
    "  # uses KillMode=process and each job has its own supervisor.",
    '  if [ -n "$2" ] && [ -d /run/systemd/system ]; then',
    "    systemctl try-restart remoteifes-console.service >/dev/null 2>&1 || true",
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const prerm = [
    "#!/bin/sh",
    "set -e",
    'if [ "$1" = "remove" ] || [ "$1" = "deconfigure" ]; then',
    '  NODE="$(command -v node || true)"',
    `  if [ -n "$NODE" ] && [ -f "${payload}/instalacao/desinstalar.js" ]; then`,
    `    "$NODE" "${payload}/instalacao/desinstalar.js" --pacote --sim --raiz "/${raizPacote}"`,
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const postrm = [
    "#!/bin/sh",
    "set -e",
    'if [ "$1" = "purge" ]; then',
    "  # Operators, audit and job outputs go only on purge; a plain remove keeps them.",
    "  rm -rf /var/lib/remoteifes-console /var/log/remoteifes-console /var/cache/remoteifes-console",
    `  rm -rf "/${raizPacote}"`,
    "fi",
    "exit 0",
    "",
  ].join("\n");

  const controlTarGz = montarTarGz(RAIZ, [], {
    extras: [
      { nome: "control", conteudo: controle },
      { nome: "postinst", conteudo: postinst, modo: 0o755 },
      { nome: "prerm", conteudo: prerm, modo: 0o755 },
      { nome: "postrm", conteudo: postrm, modo: 0o755 },
    ],
  });

  const membro = (nome, conteudo) => {
    const cab = Buffer.alloc(60, 0x20);
    cab.write(nome.padEnd(16), 0);
    cab.write(String(Math.floor(Date.now() / 1000)).padEnd(12), 16);
    cab.write("0".padEnd(6), 28);
    cab.write("0".padEnd(6), 34);
    cab.write("100644".padEnd(8), 40);
    cab.write(String(conteudo.length).padEnd(10), 48);
    cab.write("`\n", 58);
    return conteudo.length % 2 ? [cab, conteudo, Buffer.from("\n")] : [cab, conteudo];
  };

  const deb = Buffer.concat([
    Buffer.from("!<arch>\n"),
    ...membro("debian-binary", Buffer.from("2.0\n")),
    ...membro("control.tar.gz", controlTarGz),
    ...membro("data.tar.gz", dados),
  ]);
  fs.writeFileSync(saida, deb);
  return deb.length;
}

// --- Main ----------------------------------------------------------------------------------

function commitDoCheckout() {
  try {
    // stderr is silenced: building outside a checkout is legitimate (a payload extracted from an
    // artifact, a test's copy of the tree); --commit names the commit then.
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function main() {
  const saida = path.resolve(arg("saida", path.join(RAIZ, "dist")));
  const formato = arg("formato", "todos");
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  const alvo = arg("alvo", `${so}-${process.arch}`);

  fs.mkdirSync(saida, { recursive: true });
  log(`Construindo Console de Operações ${VERSAO} para ${alvo}`);

  const commit = arg("commit", commitDoCheckout());
  if (!/^[0-9a-f]{40}$/.test(String(commit || ""))) {
    throw new Error("sem o commit construído: rode dentro de um checkout Git ou informe --commit <sha de 40 caracteres>");
  }

  const artefatos = [];

  // Payload: what the release updater consumes, on every platform.
  const nomePayload = `remoteifes-console-${VERSAO}-${alvo}.tar.gz`;
  const caminhoPayload = path.join(saida, nomePayload);
  const payload = montarTarGz(RAIZ, itensDoPayload());
  fs.writeFileSync(caminhoPayload, payload);
  artefatos.push({ alvo, formato: "tar.gz", arquivo: nomePayload, caminho: caminhoPayload });
  log(`  payload: ${nomePayload} (${(payload.length / 1024).toFixed(0)} KiB)`);

  if (["todos", "zip"].includes(formato) && alvo.startsWith("windows")) {
    const nomeZip = `remoteifes-console-${VERSAO}-${alvo}.zip`;
    const caminhoZip = path.join(saida, nomeZip);
    fs.writeFileSync(caminhoZip, montarZip(RAIZ, [...itensDoPayload(), "instalar.ps1"].filter((i) => fs.existsSync(path.join(RAIZ, i)))));
    artefatos.push({ alvo, formato: "zip", arquivo: nomeZip, caminho: caminhoZip });
    log(`  zip: ${nomeZip}`);
  }

  if (["todos", "deb"].includes(formato) && alvo.startsWith("linux")) {
    const nomeDeb = `remoteifes-console_${VERSAO}_all.deb`;
    const caminhoDeb = path.join(saida, nomeDeb);
    try {
      const bytes = montarDeb(caminhoDeb);
      artefatos.push({ alvo, formato: "deb", arquivo: nomeDeb, caminho: caminhoDeb });
      log(`  deb: ${nomeDeb} (${(bytes / 1024).toFixed(0)} KiB)`);
    } catch (erro) {
      log(`  deb: não construído (${erro.message})`);
    }
  }

  // The release manifest. It carries no signature of its own: the release publication attests it and
  // every artifact with GitHub's keyless artifact attestation, and the Console accepts it only as
  // those exact bytes (src/atestacao.js).
  const manifesto = {
    esquema: 1,
    versao: VERSAO,
    canal: arg("canal", "estavel"),
    publicadoEm: new Date().toISOString(),
    commit,
    minimoParaAtualizar: null,
    notas: `https://github.com/SENAI4LIFE/RemoteIFES/releases/tag/console-v${VERSAO}`,
    artefatos: artefatos
      .filter((a) => a.formato === "tar.gz")
      .map((a) => ({
        alvo: a.alvo,
        formato: a.formato,
        arquivo: a.arquivo,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(a.caminho)).digest("hex"),
        bytes: fs.statSync(a.caminho).size,
      })),
  };
  const caminhoManifesto = path.join(saida, "manifesto.json");
  fs.writeFileSync(caminhoManifesto, `${JSON.stringify(manifesto, null, 2)}\n`);
  log(`  manifesto: manifesto.json (commit ${commit.slice(0, 12)}; a atestação é da publicação)`);

  // What was built, where and from what. Windows and macOS executables carry no platform code
  // signature (Authenticode, Apple notarization): no such credential exists. Their origin is proven
  // by the release attestation instead, which covers every file of a release.
  const proveniencia = {
    versao: VERSAO,
    alvo,
    construidoEm: new Date().toISOString(),
    node: process.version,
    plataformaDeBuild: `${process.platform}-${process.arch}`,
    commit,
    assinaturaDeCodigo: false,
    observacao:
      "Executáveis SEM ASSINATURA DE CÓDIGO da plataforma (Authenticode no Windows, notarização no macOS): o " +
      "SmartScreen e o Gatekeeper avisam ao abrir. A origem de cada arquivo de um release é provada pela " +
      "atestação de proveniência do GitHub (atestacao.sigstore.json), que o Console confere sozinho.",
    artefatos: artefatos.map((a) => ({
      arquivo: a.arquivo,
      formato: a.formato,
      bytes: fs.statSync(a.caminho).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(a.caminho)).digest("hex"),
    })),
  };
  fs.writeFileSync(path.join(saida, "proveniencia.json"), `${JSON.stringify(proveniencia, null, 2)}\n`);
  log(`  procedência: proveniencia.json`);

  log("");
  log(`Artefatos em ${saida}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (erro) {
    process.stderr.write(`falha na construção: ${erro && erro.stack ? erro.stack : erro}\n`);
    process.exitCode = 1;
  }
}

module.exports = { montarTarGz, montarZip, listarArquivos, crc32, dividirNome, itensDoPayload, INCLUIR };
