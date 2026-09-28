"use strict";

// Locates the pinned ESP32 emulator. The release is a prebuilt binary from a personal fork (see
// emulador.json), so it is downloaded and executed only on a disposable host; its archive must match
// the pinned sha256, must contain only plain files and directories inside itself, and is unpacked in a
// staging directory before it is put in the lab cache. LAB_QEMU (the qemu-system-xtensa binary) and
// LAB_QEMU_ROMS (its ROM directory) point to a build of the pinned commit instead.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { diretorioCache, removerSeguro, exigirHostDescartavel } = require("./ambiente");

const MANIFESTO = require("../emulador.json");

function plataforma() {
  return `${process.platform}-${process.arch}`;
}

async function baixar(url) {
  const resposta = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!resposta.ok) throw new Error(`emulator download failed: HTTP ${resposta.status} for ${url}`);
  const limite = 64 * 1024 * 1024;
  const bytes = Buffer.from(await resposta.arrayBuffer());
  if (bytes.length > limite) throw new Error("emulator archive larger than expected");
  return bytes;
}

function localizar(raiz) {
  const nome = process.platform === "win32" ? "qemu-system-xtensa.exe" : "qemu-system-xtensa";
  const binario = path.join(raiz, "qemu", "xtensa-softmmu", nome);
  const roms = path.join(raiz, "qemu", "share", "qemu-firmware");
  return fs.existsSync(binario) && fs.existsSync(roms) ? { binario, roms } : null;
}

/** Refuses archives with links, devices, absolute paths or parent references. */
function conferirEntradas(arquivo, cwd) {
  const lista = spawnSync("tar", ["-tvzf", arquivo], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (lista.status !== 0) throw new Error(`could not list the emulator archive: ${lista.stderr}`);
  const nomes = spawnSync("tar", ["-tzf", arquivo], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const linhas = lista.stdout.split(/\r?\n/).filter(Boolean);
  const tipos = linhas.filter((l) => !/^[-d]/.test(l));
  if (tipos.length) throw new Error(`the emulator archive has entries that are not plain files or directories: ${tipos.slice(0, 3).join(" | ")}`);
  const fora = nomes.stdout.split(/\r?\n/).filter(Boolean).filter((e) => path.isAbsolute(e) || /^[a-zA-Z]:/.test(e) || e.split(/[\\/]/).includes(".."));
  if (fora.length) throw new Error(`the emulator archive has entries outside its directory: ${fora.slice(0, 3).join(", ")}`);
}

async function obterEmulador() {
  exigirHostDescartavel("running the ESP32 emulator");
  if (process.env.LAB_QEMU) {
    const roms = process.env.LAB_QEMU_ROMS;
    if (!roms) throw new Error("LAB_QEMU is set: set LAB_QEMU_ROMS to its qemu-firmware directory too");
    return { binario: process.env.LAB_QEMU, roms, versao: "local", origem: process.env.LAB_QEMU };
  }
  const alvo = MANIFESTO.arquivos[plataforma()];
  if (!alvo) {
    throw new Error(`no pinned emulator build for ${plataforma()}; build ${MANIFESTO.projeto} at ${MANIFESTO.commit} and set LAB_QEMU/LAB_QEMU_ROMS`);
  }
  const raiz = path.join(diretorioCache(), "emulador", MANIFESTO.versao, plataforma());
  const marca = path.join(raiz, ".sha256");
  const pronto = fs.existsSync(marca) && fs.readFileSync(marca, "utf8").trim() === alvo.sha256 && localizar(raiz);
  if (!pronto) {
    removerSeguro(raiz);
    const preparo = `${raiz}.preparo`;
    removerSeguro(preparo);
    fs.mkdirSync(preparo, { recursive: true });
    const bytes = await baixar(alvo.url);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== alvo.sha256) throw new Error(`emulator archive sha256 ${hash} does not match the pinned ${alvo.sha256}`);
    fs.writeFileSync(path.join(preparo, "pacote.tar.gz"), bytes);
    conferirEntradas("pacote.tar.gz", preparo);
    const tar = spawnSync("tar", ["-xzf", "pacote.tar.gz"], { cwd: preparo, encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`could not unpack the emulator: ${tar.stderr}`);
    fs.rmSync(path.join(preparo, "pacote.tar.gz"));
    if (!localizar(preparo)) throw new Error("the emulator archive does not have the expected layout");
    fs.writeFileSync(path.join(preparo, ".sha256"), alvo.sha256);
    fs.renameSync(preparo, raiz);
  }
  const achado = localizar(raiz);
  if (!achado) throw new Error(`emulator unpacked without qemu-system-xtensa under ${raiz}`);
  return { ...achado, versao: `${MANIFESTO.versao} (${MANIFESTO.commit.slice(0, 8)})`, origem: alvo.url };
}

module.exports = { obterEmulador, plataforma, MANIFESTO };
