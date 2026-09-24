#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Construção dos artefatos de distribuição.
//
// Só são produzidos formatos que a CI consegue **construir e instalar** numa máquina real do
// sistema alvo. MSI/WiX, NSIS e `.pkg` assinado ficaram de fora de propósito: sem credencial de
// assinatura e sem ambiente de validação, entregariam um instalador não testado — que é pior
// que não entregar.
//
//   payload .tar.gz   consumido pelo atualizador por release, em qualquer plataforma
//   .deb              Linux com dpkg (a CI instala e verifica)
//   .zip              Windows (a CI instala com instalar.ps1 e verifica)
//
// O `tar` é montado aqui, sem depender do binário do sistema: o Windows não tem `tar` GNU e a
// forma dos cabeçalhos precisa casar exatamente com o extrator do atualizador.
//
// Uso:
//   node empacotar/construir.js [--saida <dir>] [--alvo <so-arch>] [--formato payload|deb|zip|todos]

const RAIZ = path.join(__dirname, "..");
const PACOTE = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8"));
const VERSAO = PACOTE.version;

// O que entra no payload. Testes, empacotamento e artefatos de build ficam fora: o programa
// instalado não precisa deles e cada MiB conta num Raspberry Pi.
const INCLUIR = ["console.js", "launcher.js", "package.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd"];

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
}

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

// --- tar ----------------------------------------------------------------------------------

function cabecalhoTar({ nome, tamanho, modo, tipo = "0" }) {
  const b = Buffer.alloc(512);
  const escrever = (texto, inicio, tam) => b.write(String(texto).slice(0, tam - 1), inicio, tam, "utf8");
  if (Buffer.byteLength(nome) > 100) throw new Error(`nome longo demais para tar: ${nome}`);
  escrever(nome, 0, 100);
  escrever(`${(modo & 0o7777).toString(8).padStart(7, "0")}\0`, 100, 8);
  escrever("0000000\0", 108, 8);
  escrever("0000000\0", 116, 8);
  escrever(`${tamanho.toString(8).padStart(11, "0")}\0`, 124, 12);
  escrever("00000000000\0", 136, 12);
  b.write("        ", 148, 8, "utf8");
  // O typeflag tem exatamente 1 byte e NÃO é terminado por NUL, então não passa por
  // `escrever`, que reserva o último byte para o terminador — com tamanho 1 isso truncava o
  // campo para vazio. O byte ficava zerado (AREGTYPE), que a maioria dos leitores trata como
  // arquivo comum: os arquivos saíam certos e um diretório virava um arquivo vazio de mesmo
  // nome, quebrando tudo que viesse dentro dele.
  b.write(String(tipo), 156, 1, "utf8");
  b.write("ustar\0", 257, 6, "utf8");
  b.write("00", 263, 2, "utf8");
  let soma = 0;
  for (const byte of b) soma += byte;
  escrever(`${soma.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return b;
}

function listarArquivos(base, relativo = "") {
  const completo = path.join(base, relativo);
  const info = fs.statSync(completo);
  if (info.isFile()) return [{ relativo: relativo.split(path.sep).join("/"), completo, modo: info.mode, bytes: info.size }];
  if (!info.isDirectory()) return [];
  const saida = [];
  for (const entrada of fs.readdirSync(completo).sort()) {
    saida.push(...listarArquivos(base, path.join(relativo, entrada)));
  }
  return saida;
}

/**
 * Monta um `.tar.gz`. `prefixo` reposiciona a árvore copiada (o .deb precisa dela sob
 * `opt/...`); `extras` acrescenta arquivos que só existem no pacote, com caminho próprio e sem
 * passar pelo disco.
 */
function montarTarGz(base, itens, { prefixo = "", extras = [] } = {}) {
  const blocos = [];
  const diretoriosEmitidos = new Set();

  // Entradas de DIRETÓRIO, antes de cada arquivo que mora nelas.
  //
  // O extrator do atualizador cria os diretórios sozinho (`mkdir -p`), então um tar só de
  // arquivos passava nos testes — e o `dpkg` recusava o pacote com "No such file or directory",
  // porque ele extrai membro a membro e não inventa o caminho. Um tar sem diretórios é um tar
  // malformado; parecia funcionar só porque o único leitor era o nosso.
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
      // O bit de execução vem do shebang, não do índice do Git: o Git guarda 100644 para estes
      // arquivos e um runner sem +x falharia com EACCES na primeira operação real.
      const executavel = conteudo.slice(0, 2).toString() === "#!";
      acrescentar(`${prefixo}${arquivo.relativo}`, conteudo, executavel ? 0o755 : 0o644);
    }
  }
  for (const extra of extras) {
    // Extras trazem o caminho pronto dentro do arquivo: eles existem só no pacote e nem sempre
    // ficam sob o mesmo prefixo da árvore copiada.
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
  // Um .deb é um `ar` com debian-binary, control.tar.gz e data.tar.gz. Tudo é montado aqui, sem
  // dpkg-deb e sem o `tar` do sistema: a máquina de build pode ser qualquer uma das três, e o
  // Windows não tem GNU tar.
  //
  // O pacote é dono só da camada estável e da primeira versão. As atualizações seguintes vão
  // para `versoes/` sem tocar em arquivo registrado pelo dpkg, então o gerenciador de pacotes
  // nunca fica inconsistente por causa de uma autoatualização.
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

  const dados = montarTarGz(RAIZ, INCLUIR, {
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
      {
        nome: `${raizPacote}/estado-instalacao.json`,
        conteudo: `${JSON.stringify({ versaoAtiva: VERSAO, versaoAnterior: null, transacao: null, escopo: "sistema" }, null, 2)}\n`,
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
    // Node é pré-requisito do que o console administra; declarar a dependência é melhor do que
    // instalar algo que não subiria.
    `Depends: nodejs (>= 22.13.0)`,
    `Maintainer: RemoteIFES <brunoalexandersenai@gmail.com>`,
    `Description: Console de Operacoes do RemoteIFES`,
    ` Manutencao do servidor, do host e da infraestrutura do RemoteIFES:`,
    ` servico, atualizacao, backup, recuperacao, rede e diagnostico.`,
    "",
  ].join("\n");

  const controlTarGz = montarTarGz(RAIZ, [], { extras: [{ nome: "control", conteudo: controle }] });

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

// --- Principal ----------------------------------------------------------------------------------

function main() {
  const saida = path.resolve(arg("saida", path.join(RAIZ, "dist")));
  const formato = arg("formato", "todos");
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  const alvo = arg("alvo", `${so}-${process.arch}`);

  fs.mkdirSync(saida, { recursive: true });
  log(`Construindo Console de Operações ${VERSAO} para ${alvo}`);

  const artefatos = [];

  // Payload: é o que o atualizador por release consome, em qualquer plataforma.
  const nomePayload = `remoteifes-console-${VERSAO}-${alvo}.tar.gz`;
  const caminhoPayload = path.join(saida, nomePayload);
  const payload = montarTarGz(RAIZ, INCLUIR);
  fs.writeFileSync(caminhoPayload, payload);
  artefatos.push({ alvo, formato: "tar.gz", arquivo: nomePayload, caminho: caminhoPayload });
  log(`  payload: ${nomePayload} (${(payload.length / 1024).toFixed(0)} KiB)`);

  if (["todos", "zip"].includes(formato) && alvo.startsWith("windows")) {
    const nomeZip = `remoteifes-console-${VERSAO}-${alvo}.zip`;
    const caminhoZip = path.join(saida, nomeZip);
    fs.writeFileSync(caminhoZip, montarZip(RAIZ, [...INCLUIR, "instalar.ps1"].filter((i) => fs.existsSync(path.join(RAIZ, i)))));
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

  // Manifesto sem assinatura: quem assina é `assinar-manifesto.js`, com a chave privada que
  // não existe neste repositório. Um artefato sem assinatura não é aceito pelo atualizador.
  const manifesto = {
    esquema: 1,
    versao: VERSAO,
    canal: arg("canal", "estavel"),
    publicadoEm: new Date().toISOString(),
    expiraEm: new Date(Date.now() + 180 * 86400_000).toISOString(),
    minimoParaAtualizar: null,
    notas: `https://github.com/SENAI4LIFE/RemoteIFES/releases/tag/console-v${VERSAO}`,
    proximaChave: null,
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
  log(`  manifesto: manifesto.json (SEM assinatura — assine com empacotar/assinar-manifesto.js)`);

  // Procedência verificável do que foi construído.
  const proveniencia = {
    versao: VERSAO,
    alvo,
    construidoEm: new Date().toISOString(),
    node: process.version,
    plataformaDeBuild: `${process.platform}-${process.arch}`,
    commit: (() => {
      try {
        // stderr silenciado: construir fora de um checkout é legítimo (o payload extraído de um
        // artefato, por exemplo), e um "fatal: not a git repository" na tela faz um build que
        // deu certo parecer quebrado. A ausência do commit fica registrada como `null`.
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    })(),
    assinado: false,
    observacao:
      "Artefatos NÃO ASSINADOS. Sem credencial de assinatura de código (Windows) nem conta de desenvolvedor " +
      "(notarização macOS), estes artefatos são de desenvolvimento/validação e não devem ser publicados como release de produção.",
    artefatos: artefatos.map((a) => ({
      arquivo: a.arquivo,
      formato: a.formato,
      bytes: fs.statSync(a.caminho).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(a.caminho)).digest("hex"),
    })),
  };
  fs.writeFileSync(path.join(saida, "proveniencia.json"), `${JSON.stringify(proveniencia, null, 2)}\n`);
  log(`  procedência: proveniencia.json (assinado=false)`);

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

module.exports = { montarTarGz, montarZip, listarArquivos, crc32, INCLUIR };
