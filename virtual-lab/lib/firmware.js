"use strict";

// Builds the firmware the virtual board runs, from the repository source, with PlatformIO, and lays
// it out as a 4 MB flash image.
//
//   producao           remoteifes-esp32 as it is (LAB_FIRMWARE_DIR points to another checkout)
//   candidato          the same source with only FW_VERSAO raised by one patch level: an OTA target
//   candidatoQueAborta the candidate with abort() as the first statement of setup(): a release that
//                      crashes at boot, for the bootloader's rollback
//
// Variants are built in copies under the lab cache. Each transformation must match exactly once, so a
// change to main.ino cannot quietly produce a variant other than the intended one.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { RAIZ, diretorioCache, nucleoPlatformio, comandoPio, removerSeguro, registrarProcesso, exigirHostDescartavel } = require("./ambiente");
const { lerParticoes } = require("./flash");

const TAMANHO_FLASH = 4 * 1024 * 1024;
const RE_VERSAO = /-DFW_VERSAO=\\"(\d+)\.(\d+)\.(\d+)\\"/;

function fonte() {
  return process.env.LAB_FIRMWARE_DIR || path.join(RAIZ, "remoteifes-esp32");
}

function versaoDe(dir) {
  const m = fs.readFileSync(path.join(dir, "platformio.ini"), "utf8").match(RE_VERSAO);
  if (!m) throw new Error(`FW_VERSAO not found in ${dir}/platformio.ini`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function substituirUmaVez(texto, de, para, onde) {
  const partes = texto.split(de);
  if (partes.length !== 2) throw new Error(`expected exactly one "${de}" in ${onde}, found ${partes.length - 1}`);
  return partes.join(para);
}

function elevarVersao(dir) {
  const ini = path.join(dir, "platformio.ini");
  const atual = versaoDe(dir);
  const [a, b, c] = atual.split(".").map(Number);
  const nova = `${a}.${b}.${c + 1}`;
  const texto = fs.readFileSync(ini, "utf8");
  fs.writeFileSync(ini, substituirUmaVez(texto, `-DFW_VERSAO=\\"${atual}\\"`, `-DFW_VERSAO=\\"${nova}\\"`, "platformio.ini"));
}

function abortarNoBoot(dir) {
  const ino = path.join(dir, "src", "main.ino");
  const texto = fs.readFileSync(ino, "utf8");
  fs.writeFileSync(ino, substituirUmaVez(texto, "void setup() {", "void setup() {\n  abort();", "main.ino"));
}

const VARIANTES = {
  producao: [],
  candidato: [elevarVersao],
  candidatoQueAborta: [elevarVersao, abortarNoBoot],
};

function arquivosDaFonte(dir) {
  const lista = ["platformio.ini"];
  for (const sub of ["src", "include", "data"]) {
    const base = path.join(dir, sub);
    if (!fs.existsSync(base)) continue;
    for (const nome of fs.readdirSync(base, { recursive: true })) {
      if (fs.statSync(path.join(base, nome)).isFile()) lista.push(path.join(sub, nome));
    }
  }
  return lista.sort();
}

function impressaoDaFonte(dir, variante) {
  const h = crypto.createHash("sha256").update(`variante:${variante}\n`);
  for (const rel of arquivosDaFonte(dir)) {
    h.update(`${rel.split(path.sep).join("/")}\n`);
    h.update(fs.readFileSync(path.join(dir, rel)).toString("utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
}

// Asynchronous on purpose: a scenario process also carries the network between board and server, and
// a build that blocked its event loop for a minute would stop the board's keepalive with it.
function executar(pio, args, cwd) {
  return new Promise((resolve, reject) => {
    const filho = registrarProcesso(spawn(pio, args, { cwd, windowsHide: true }), "pio");
    let saida = "";
    const guardar = (d) => { saida = (saida + d).slice(-8000); };
    filho.stdout.on("data", guardar);
    filho.stderr.on("data", guardar);
    const limite = setTimeout(() => filho.kill(), 20 * 60 * 1000);
    filho.once("error", reject);
    filho.once("exit", (codigo, sinal) => {
      clearTimeout(limite);
      if (codigo === 0) resolve();
      else reject(new Error(`pio ${args.join(" ")} failed in ${cwd} (${codigo ?? sinal}):\n${saida.slice(-4000)}`));
    });
  });
}

/** Serialises builds of one variant across the test processes that run in parallel. */
async function comTrava(dir, fn) {
  const trava = `${dir}.trava`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const prazo = Date.now() + 30 * 60 * 1000;
  for (;;) {
    try {
      fs.mkdirSync(trava);
      break;
    } catch (erro) {
      if (erro.code !== "EEXIST") throw erro;
      const idade = Date.now() - fs.statSync(trava).mtimeMs;
      if (idade > 30 * 60 * 1000) removerSeguro(trava);
      if (Date.now() > prazo) throw new Error(`timed out waiting for another build of ${dir}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    return await fn();
  } finally {
    removerSeguro(trava);
  }
}

const SAIDAS = ["bootloader.bin", "partitions.bin", "firmware.bin", "firmware.elf", "littlefs.bin"];

/** Builds (or reuses) a variant and returns the paths of everything a flash image needs. */
async function construir(variante) {
  exigirHostDescartavel("building firmware for the emulator");
  const passos = VARIANTES[variante];
  if (!passos) throw new Error(`unknown firmware variant ${variante}`);
  const origem = fonte();
  const destino = path.join(diretorioCache(), "firmware", variante);
  const impressao = impressaoDaFonte(origem, variante);
  const marca = path.join(destino, ".fonte");
  const build = path.join(destino, ".pio", "build", "esp32dev");
  const valido = () => fs.existsSync(marca) && fs.readFileSync(marca, "utf8") === impressao && SAIDAS.every((n) => fs.existsSync(path.join(build, n)));
  if (!valido()) await comTrava(destino, async () => {
    if (valido()) return;
    fs.mkdirSync(destino, { recursive: true });
    for (const sub of ["src", "include", "data", "platformio.ini", ".fonte"]) removerSeguro(path.join(destino, sub));
    for (const rel of arquivosDaFonte(origem)) {
      fs.mkdirSync(path.dirname(path.join(destino, rel)), { recursive: true });
      fs.copyFileSync(path.join(origem, rel), path.join(destino, rel));
    }
    for (const passo of passos) passo(destino);
    // Libraries already resolved for the source project are reused: a fresh copy would otherwise
    // download them again from the registry on every variant.
    const libsOrigem = path.join(origem, ".pio", "libdeps");
    const libsDestino = path.join(destino, ".pio", "libdeps");
    if (!fs.existsSync(libsDestino) && fs.existsSync(libsOrigem)) fs.cpSync(libsOrigem, libsDestino, { recursive: true });
    const pio = comandoPio();
    await executar(pio, ["run"], destino);
    await executar(pio, ["run", "-t", "buildfs"], destino);
    fs.writeFileSync(marca, impressao);
  });
  const bootApp0 = path.join(nucleoPlatformio(), "packages", "framework-arduinoespressif32", "tools", "partitions", "boot_app0.bin");
  return {
    variante,
    versao: versaoDe(destino),
    impressao,
    dir: destino,
    ino: path.join(destino, "src", "main.ino"),
    bootloader: path.join(build, "bootloader.bin"),
    particoes: path.join(build, "partitions.bin"),
    app: path.join(build, "firmware.bin"),
    elf: path.join(build, "firmware.elf"),
    littlefs: path.join(build, "littlefs.bin"),
    bootApp0,
  };
}

/**
 * The flash image a board leaves the factory with after `pio run -t upload` and `-t uploadfs`:
 * bootloader, partition table, the initial OTA selection (boot_app0), the application in ota_0 and
 * the LittleFS image. Byte-identical to `esptool.py merge_bin` of the same files.
 */
function montarImagem(build) {
  const imagem = Buffer.alloc(TAMANHO_FLASH, 0xff);
  const colocar = (arquivo, deslocamento) => {
    const bytes = fs.readFileSync(arquivo);
    if (deslocamento + bytes.length > TAMANHO_FLASH) throw new Error(`${arquivo} does not fit at 0x${deslocamento.toString(16)}`);
    bytes.copy(imagem, deslocamento);
  };
  colocar(build.bootloader, 0x1000);
  colocar(build.particoes, 0x8000);
  const particoes = lerParticoes(imagem);
  const onde = (filtro) => particoes.find((p) => Object.entries(filtro).every(([k, v]) => p[k] === v));
  colocar(build.bootApp0, onde({ tipo: "data", subtipo: 0 }).deslocamento);
  colocar(build.app, onde({ tipo: "app", subtipo: "ota_0" }).deslocamento);
  const sistemaArquivos = onde({ nome: "spiffs" });
  if (fs.statSync(build.littlefs).size > sistemaArquivos.tamanho) throw new Error("LittleFS image larger than its partition");
  colocar(build.littlefs, sistemaArquivos.deslocamento);
  return imagem;
}

module.exports = { construir, montarImagem, versaoDe, fonte, VARIANTES };
