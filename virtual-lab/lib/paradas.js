"use strict";

// Exact stop points in the firmware without a debugger binary: addresses come from the toolchain's
// own line table (objdump) and symbol table (nm), and the emulator is driven through its GDB stub
// with the handful of remote-protocol packets a breakpoint needs. (PlatformIO's Xtensa GDB links a
// Python 2 runtime current Linux images no longer have; these binutils need nothing.)

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const { nucleoPlatformio } = require("./ambiente");

function ferramenta(nome) {
  const exe = process.platform === "win32" ? `${nome}.exe` : nome;
  const caminho = path.join(nucleoPlatformio(), "packages", "toolchain-xtensa-esp32", "bin", `xtensa-esp32-elf-${exe}`);
  if (!fs.existsSync(caminho)) throw new Error(`${caminho} not found: build the firmware first`);
  return caminho;
}

const linhasPorElf = new Map();

/**
 * The entry address of a line of main.ino, from the ELF's DWARF line table: its lowest statement start.
 * A line holding several statements (a call, a comparison, a return) has several; a breakpoint on each
 * would count one pass through the line as several occurrences.
 */
function enderecosDaLinha(elf, linha) {
  if (!linhasPorElf.has(elf)) {
    const r = spawnSync(ferramenta("objdump"), ["--dwarf=decodedline", elf], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`objdump failed: ${r.stderr}`);
    const mapa = new Map();
    for (const l of r.stdout.split("\n")) {
      const m = /^main\.ino\s+(\d+)\s+0x([0-9a-f]+)\s+(x)?/.exec(l);
      if (!m) continue;
      const n = Number(m[1]);
      if (!mapa.has(n)) mapa.set(n, { inicio: new Set(), todos: new Set() });
      mapa.get(n).todos.add(parseInt(m[2], 16));
      if (m[3]) mapa.get(n).inicio.add(parseInt(m[2], 16));
    }
    linhasPorElf.set(elf, mapa);
  }
  const e = linhasPorElf.get(elf).get(linha);
  if (!e) throw new Error(`main.ino:${linha} has no code in ${elf}`);
  return [Math.min(...(e.inicio.size ? e.inicio : e.todos))];
}

/** Entry addresses of a function (every overload), demangled names as nm -C prints them. */
function enderecosDaFuncao(elf, nome) {
  const r = spawnSync(ferramenta("nm"), ["-C", elf], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`nm failed: ${r.stderr}`);
  const achados = r.stdout.split("\n").map((l) => /^([0-9a-f]{8}) [Tt] (.+)$/.exec(l)).filter((m) => m && (m[2] === nome || m[2].startsWith(`${nome}(`)));
  if (!achados.length) throw new Error(`function ${nome} not found in ${elf}`);
  return [...new Set(achados.map((m) => parseInt(m[1], 16)))];
}

/** GDB remote serial protocol, just enough for breakpoints: ack mode off, Z/z, c, D. */
class ClienteGdb {
  static conectar(porta) {
    return new Promise((resolve, reject) => {
      const s = net.connect(porta, "127.0.0.1");
      s.once("connect", () => resolve(new ClienteGdb(s)));
      s.once("error", reject);
    });
  }

  constructor(soquete) {
    this.soquete = soquete;
    this.buffer = "";
    this.pacotes = [];
    this.esperas = [];
    this.fechado = false;
    soquete.setNoDelay(true);
    soquete.on("error", () => {});
    soquete.on("close", () => {
      this.fechado = true;
      for (const e of this.esperas.splice(0)) e.reject(new Error("GDB stub connection closed"));
    });
    soquete.on("data", (d) => {
      this.buffer += d.toString("latin1");
      for (;;) {
        this.buffer = this.buffer.replace(/^[+-]+/, "");
        const inicio = this.buffer.indexOf("$");
        const fim = this.buffer.indexOf("#", inicio);
        if (inicio < 0 || fim < 0 || this.buffer.length < fim + 3) break;
        const pacote = this.buffer.slice(inicio + 1, fim);
        this.buffer = this.buffer.slice(fim + 3);
        if (!this.semAck) this.soquete.write("+");
        const e = this.esperas.shift();
        if (e) { clearTimeout(e.timer); e.resolve(pacote); } else this.pacotes.push(pacote);
      }
    });
  }

  proximo(limiteMs) {
    if (this.pacotes.length) return Promise.resolve(this.pacotes.shift());
    if (this.fechado) return Promise.reject(new Error("GDB stub connection closed"));
    return new Promise((resolve, reject) => {
      const e = { resolve, reject, timer: setTimeout(() => { this.esperas.splice(this.esperas.indexOf(e), 1); reject(new Error(`no answer from the GDB stub within ${limiteMs} ms`)); }, limiteMs) };
      this.esperas.push(e);
    });
  }

  enviar(dados) {
    let soma = 0;
    for (const c of Buffer.from(dados, "latin1")) soma = (soma + c) & 0xff;
    this.soquete.write(`$${dados}#${soma.toString(16).padStart(2, "0")}`);
  }

  async comando(dados, limiteMs = 30_000) {
    this.enviar(dados);
    return this.proximo(limiteMs);
  }

  async preparar() {
    if ((await this.comando("QStartNoAckMode")) === "OK") this.semAck = true;
    await this.comando("?");
  }

  async quebrar(endereco) {
    for (const tipo of ["1", "0"]) {
      const r = await this.comando(`Z${tipo},${endereco.toString(16)},3`);
      if (r === "OK") return tipo;
    }
    throw new Error(`the GDB stub refused a breakpoint at 0x${endereco.toString(16)}`);
  }

  async retirar(tipo, endereco) {
    await this.comando(`z${tipo},${endereco.toString(16)},3`);
  }

  /** Resumes the chip and resolves at the next stop (a breakpoint hit). */
  async continuarAteParar(limiteMs) {
    this.enviar("c");
    for (;;) {
      const r = await this.proximo(limiteMs);
      if (/^[ST][0-9a-f]{2}/i.test(r)) return r;
      if (/^[WX]/.test(r)) throw new Error(`the emulated chip ended while running to the stop point (${r})`);
    }
  }

  async desconectar() {
    try { await this.comando("D", 5000); } catch {}
    this.soquete.destroy();
  }
}

module.exports = { enderecosDaLinha, enderecosDaFuncao, ClienteGdb };
