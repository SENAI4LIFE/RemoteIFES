"use strict";

// One virtual ESP32 running a flash image in the pinned QEMU fork.
//
// The board is driven only from outside, as hardware would be: Wi-Fi through the emulator's access
// point on a user-mode network, GPIO lines through the qtest protocol, the reset button and the power
// supply through QMP, and exact stop points through the emulator's GDB stub. The firmware is never
// told it is being tested.
//
// Containment. The emulator and the firmware are treated as untrusted, so a board only ever starts on
// a host declared disposable (LAB_HOST_DESCARTAVEL=1: an ephemeral CI runner). Its network is
// restricted (libslirp restrict=on): the one address it can reach, 192.168.4.9:8080, is forwarded per
// connection to relay.js, which splices it to the lab's intermediary on the loopback interface;
// the host and everything beyond it are unreachable. Every control channel is loopback-only, and the
// GDB stub is opened only while a stop point is armed.
//
// Time: every duration the lab asserts is in the board's own (virtual) time, read from a timer the
// firmware does not use (TIMG1 timer 0, armed by the lab at 1 MHz). With -icount the virtual clock
// advances with executed instructions, so it is reproducible and independent of how fast the host is;
// wall-clock bounds would pass on a slow host while the device retried three times faster.

const EventEmitter = require("events");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { comandoGdb, redigir, registrarProcesso, registrarPorta, exigirHostDescartavel } = require("./ambiente");

const ESPERA_PADRAO_MS = 120_000;
// The address the board is configured with. It exists only inside the emulator's network.
const SERVIDOR_NA_REDE_VIRTUAL = { host: "192.168.4.9", porta: 8080 };
const RELAY = path.join(__dirname, "relay.js");
const LIMITE_SERIAL = 16 * 1024 * 1024;
const LIMITE_BORDAS = 5_000_000;
const TIMG1 = 0x3ff60000;
const TIMG_CONFIG = ((1 << 31) | (1 << 30) | (80 << 13)) >>> 0; // enable, count up, APB/80 = 1 MHz
const GPIO_BASE = 0x3ff44000;
// Every RemoteIFES pin is RTC-capable, so ESP-IDF sets its pulls in the RTC IO pad register (bits
// RUE 27 / RDE 28), not in IO_MUX: GPIO 4 = TOUCH_PAD0, 14 = TOUCH_PAD6, 15 = TOUCH_PAD3,
// 26 = PAD_DAC2, 27 = TOUCH_PAD7.
const RTCIO_PAD = { 4: 0x3ff48494, 14: 0x3ff484ac, 15: 0x3ff484a0, 26: 0x3ff48488, 27: 0x3ff484b0 };

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function ouvirUmaConexao() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", () => {
      const conexao = new Promise((res) => servidor.once("connection", (s) => { servidor.close(); res(s); }));
      resolve({ porta: servidor.address().port, conexao, servidor });
    });
  });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGKILL to the child's own process group (it was started detached), else to the child itself. */
function matarGrupo(filho) {
  try { process.kill(-filho.pid, "SIGKILL"); } catch { try { filho.kill("SIGKILL"); } catch {} }
}

class PlacaVirtual extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.nome           label used in logs and artifacts
   * @param {object} o.emulador       { binario, roms } from obterEmulador()
   * @param {string} o.arquivoFlash   the board's flash; survives power cycles like the real chip's
   * @param {object} o.firmware       build from firmware.construir(): elf and main.ino for stop points
   * @param {number} o.portaDestino   loopback port of the intermediary behind 192.168.4.9:8080
   */
  constructor({ nome, emulador, arquivoFlash, firmware, portaDestino }) {
    super();
    if (!Number.isInteger(portaDestino) || portaDestino <= 0 || portaDestino > 65535) throw new Error("portaDestino must be the intermediary's port");
    this.nome = nome;
    this.emulador = emulador;
    this.arquivoFlash = arquivoFlash;
    this.firmware = firmware;
    this.portaDestino = portaDestino;
    this.servidorNaRede = SERVIDOR_NA_REDE_VIRTUAL;
    this.transbordou = null;
    this.serial = "";
    this.chegadas = [];
    this.bordas = [];
    this.partidas = 0;
    this.processo = null;
    this.deslocamentoUs = 0;
    this.ultimoUs = 0;
    this.leitorRelogio = null;
    this.gdbs = new Set();
  }

  // --- Power ---------------------------------------------------------------------------------------

  /** Powers the board on: a fresh emulator process on the same flash file. */
  async ligar() {
    exigirHostDescartavel("booting the virtual ESP32");
    if (process.platform === "win32") {
      throw new Error("the virtual board needs libslirp's per-connection guest forwarding to keep its network restricted, which does not work on Windows; run the Virtual Hardware Validation workflow");
    }
    if (this.processo) throw new Error(`${this.nome} is already on`);
    this.partidas += 1;
    this.portaPortal = await portaLivre();
    registrarPorta(this.portaPortal, "portal");
    const qt = await ouvirUmaConexao();
    const qmp = await ouvirUmaConexao();
    const execucao = process.env.LAB_EXECUCAO;
    const citar = (s) => {
      if (/[,'\s]/.test(s)) throw new Error(`path unusable in a QEMU option: ${s}`);
      return s;
    };
    // restrict=on: no route to the host or beyond. The only way out is the explicit guestfwd, a fresh
    // relay per connection with a fixed loopback destination. The portal forward is loopback-bound.
    const rede = [
      "user", "model=esp32_wifi", "net=192.168.4.0/24", "restrict=on",
      `hostfwd=tcp:127.0.0.1:${this.portaPortal}-192.168.4.1:80`,
      `guestfwd=tcp:${SERVIDOR_NA_REDE_VIRTUAL.host}:${SERVIDOR_NA_REDE_VIRTUAL.porta}-cmd:${citar(process.execPath)} --no-warnings ${citar(RELAY)} ${this.portaDestino} ${execucao}`,
    ].join(",");
    const args = [
      "-nographic", "-M", "esp32", "-m", "4M", "-L", this.emulador.roms,
      "-drive", `file=${citar(this.arquivoFlash)},if=mtd,format=raw`,
      "-nic", rede,
      "-S", "-accel", "tcg", "-icount", "shift=3,align=off,sleep=on",
      // Timer-group watchdogs off, as ESP-IDF's own `idf.py qemu` runs them: with -icount the two cores
      // share one host thread round-robin, so a core spinning with interrupts masked while the other
      // does a flash operation can starve the interrupt watchdog in a way parallel cores do not
      // (observed: repeated TG1WDT resets on a boot that is clean otherwise). Watchdog behaviour is
      // therefore not evidence here; it stays with the long-running hardware test.
      "-global", "driver=timer.esp32.timg,property=wdt_disable,value=true",
      "-chardev", `socket,id=qt,host=127.0.0.1,port=${qt.porta}`, "-qtest", "chardev:qt", "-qtest-log", "none",
      "-qmp", `tcp:127.0.0.1:${qmp.porta}`,
    ];
    // Its own process group, so the emulator is stopped together with anything it started.
    const processo = registrarProcesso(spawn(this.emulador.binario, args, { stdio: ["ignore", "pipe", "pipe"], detached: true }), "qemu");
    this.processo = processo;
    try { os.setPriority(processo.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const anexar = (d) => {
      if (this.transbordou) return;
      const texto = d.toString("latin1").replace(/\r/g, "");
      if (this.serial.length + texto.length > LIMITE_SERIAL) {
        // Runaway output is a failure of the scenario, not something to keep buffering.
        this.transbordou = `serial output passed ${LIMITE_SERIAL} bytes`;
        this.emit("serial", "");
        return;
      }
      this.chegadas.push({ ms: Date.now(), ate: this.serial.length + texto.length });
      this.serial += texto;
      this.emit("serial", texto);
    };
    processo.stdout.on("data", anexar);
    processo.stderr.on("data", anexar);
    this.fim = new Promise((resolve) => processo.once("exit", (codigo, sinal) => {
      this.processo = null;
      clearInterval(this.leitorRelogio);
      this.leitorRelogio = null;
      resolve({ codigo, sinal });
    }));
    const [soqueteQt, soqueteQmp] = await Promise.race([
      Promise.all([qt.conexao, qmp.conexao]),
      this.fim.then((r) => { throw new Error(`${this.nome}: emulator exited during start (${JSON.stringify(r)}):\n${this.serial.slice(-2000)}`); }),
      esperar(30_000).then(() => { throw new Error(`${this.nome}: emulator did not connect its control channels`); }),
    ]);
    this.qt = new CanalQtest(soqueteQt, (linha) => this.aoIrq(linha));
    this.qmp = new CanalQmp(soqueteQmp);
    await this.qmp.pronto;
    await this.qt.comando("irq_intercept_out /machine/soc/gpio esp32_gpios");
    // The emulator ignores the internal pull-up. The action switch (GPIO 26, INPUT_PULLUP, active
    // low) therefore starts released, as the resistor holds it on real hardware.
    await this.definirEntrada(26, 1);
    await this.armarRelogio();
    await this.qmp.executar("cont");
    this.leitorRelogio = setInterval(() => { this.agoraUs().catch(() => {}); }, 250);
    this.leitorRelogio.unref();
    return this;
  }

  /**
   * Cuts the power. The emulator is told to quit, which writes out what the emulated chip had already
   * written to flash; nothing that was still in the CPU or in RAM survives. Electrical effects of a
   * real brownout (a flash sector half-erased or half-programmed) are not modelled.
   */
  async desligar() {
    if (!this.processo) return;
    await this.agoraUs().catch(() => {});
    try { await this.qmp.executar("quit"); } catch {}
    const saiu = await Promise.race([this.fim, esperar(15_000).then(() => null)]);
    if (!saiu && this.processo) {
      matarGrupo(this.processo);
      await this.fim;
    }
  }

  async religar() {
    await this.desligar();
    return this.ligar();
  }

  /** The reset button (EN): the chip restarts, the flash and the emulator process stay. */
  async resetar() {
    await this.agoraUs();
    await this.qmp.executar("system_reset");
  }

  async encerrar() {
    for (const g of this.gdbs) g.kill("SIGKILL");
    await this.desligar();
  }

  // --- Clock ---------------------------------------------------------------------------------------

  async armarRelogio() {
    await this.qt.comando(`writel 0x${TIMG1.toString(16)} 0x${TIMG_CONFIG.toString(16)}`);
  }

  /**
   * Virtual microseconds since this board object was first powered, monotonic across resets and
   * power cycles (a reset clears the timer; the lab re-arms it and carries the offset).
   */
  async agoraUs() {
    if (!this.processo) return this.ultimoUs;
    const config = parseInt((await this.qt.comando(`readl 0x${TIMG1.toString(16)}`)).split(" ")[1], 16);
    if ((config >>> 0) !== TIMG_CONFIG) {
      this.deslocamentoUs = this.ultimoUs;
      await this.armarRelogio();
    }
    await this.qt.comando(`writel 0x${(TIMG1 + 0x0c).toString(16)} 0x1`);
    const lo = parseInt((await this.qt.comando(`readl 0x${(TIMG1 + 0x04).toString(16)}`)).split(" ")[1], 16);
    const hi = parseInt((await this.qt.comando(`readl 0x${(TIMG1 + 0x08).toString(16)}`)).split(" ")[1], 16);
    const us = this.deslocamentoUs + hi * 2 ** 32 + lo;
    if (us > this.ultimoUs) this.ultimoUs = us;
    return this.ultimoUs;
  }

  async agoraMs() {
    return (await this.agoraUs()) / 1000;
  }

  /** Waits until `ms` of the board's time have passed. */
  async aguardarVirtual(ms, { limiteMs = ms * 20 + 60_000 } = {}) {
    const alvo = (await this.agoraUs()) + ms * 1000;
    const prazo = Date.now() + limiteMs;
    while ((await this.agoraUs()) < alvo) {
      if (!this.processo) throw new Error(`${this.nome} powered off while waiting for virtual time`);
      if (Date.now() > prazo) throw new Error(`${this.nome}: ${ms} ms of virtual time did not pass within ${limiteMs} ms of wall time`);
      await esperar(20);
    }
  }

  // --- Serial --------------------------------------------------------------------------------------

  marca() {
    return this.serial.length;
  }

  /** Resolves with the first match of `re` in the serial output after `desde`. */
  aguardarSerial(re, { desde = 0, limiteMs = ESPERA_PADRAO_MS } = {}) {
    return new Promise((resolve, reject) => {
      const verificar = () => {
        if (this.transbordou) {
          fim();
          reject(new Error(`${this.nome}: ${this.transbordou}`));
          return true;
        }
        const m = re.exec(this.serial.slice(desde));
        if (!m) return false;
        fim();
        resolve(m);
        return true;
      };
      const aoSerial = () => verificar();
      const aoSair = () => { fim(); reject(new Error(`${this.nome}: powered off while waiting for ${re}`)); };
      const timer = setTimeout(() => { fim(); reject(new Error(`${this.nome}: ${re} not seen within ${limiteMs} ms\n--- serial tail ---\n${redigir(this.serial.slice(-3000))}`)); }, limiteMs);
      const fim = () => { clearTimeout(timer); this.off("serial", aoSerial); if (this.fim) this.fim.then(() => {}, () => {}); };
      if (verificar()) return;
      this.on("serial", aoSerial);
      if (this.fim) this.fim.then(() => { if (!this.processo) aoSair(); });
    });
  }

  /** Host time at which the serial text matching `re` (after `desde`) arrived, or null. */
  momentoDoSerial(re, desde = 0) {
    const m = re.exec(this.serial.slice(desde));
    if (!m) return null;
    const fim = desde + m.index + m[0].length;
    const chegada = this.chegadas.find((c) => c.ate >= fim);
    return chegada ? chegada.ms : null;
  }

  contarSerial(re, desde = 0) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    return (this.serial.slice(desde).match(global) || []).length;
  }

  salvarSerial(arquivo) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, redigir(this.serial));
  }

  // --- GPIO ----------------------------------------------------------------------------------------

  aoIrq(linha) {
    const [, tipo, pino] = linha.split(" ");
    if (this.bordas.length >= LIMITE_BORDAS) {
      this.transbordou = this.transbordou || `more than ${LIMITE_BORDAS} GPIO edges recorded`;
      return;
    }
    this.bordas.push({ pino: Number(pino), nivel: tipo === "raise" ? 1 : 0, ms: Date.now(), us: this.ultimoUs });
    this.emit("borda", Number(pino));
  }

  bordasDe(pino, desde = 0) {
    return this.bordas.slice(desde).filter((b) => b.pino === pino);
  }

  async definirEntrada(pino, nivel) {
    await this.qt.comando(`set_irq_in /machine/soc/gpio esp32_gpios_in ${pino} ${nivel}`);
  }

  /** Holds the action switch (active low) for `ms` of the board's time, then releases it. */
  async pressionarBotao(ms) {
    await this.definirEntrada(26, 0);
    const inicio = await this.agoraUs();
    await this.aguardarVirtual(ms);
    await this.definirEntrada(26, 1);
    return ((await this.agoraUs()) - inicio) / 1000;
  }

  /**
   * Contact bounce: `transicoes` level changes as fast as the lab can issue them. Returns the virtual
   * span they took, so a test can tell whether it really stayed inside the debounce window.
   */
  async quicarBotao(transicoes) {
    const inicio = await this.agoraUs();
    let nivel = 1;
    for (let i = 0; i < transicoes; i++) {
      nivel = nivel ? 0 : 1;
      await this.definirEntrada(26, nivel);
    }
    await this.definirEntrada(26, 1);
    return ((await this.agoraUs()) - inicio) / 1000;
  }

  async lerRegistrador(endereco) {
    const r = await this.qt.comando(`readl 0x${endereco.toString(16)}`);
    return parseInt(r.split(" ")[1], 16) >>> 0;
  }

  /** Direction, output level and pull-up of the RemoteIFES pins, as the chip's registers hold them. */
  async estadoPinos() {
    const habilitados = await this.lerRegistrador(GPIO_BASE + 0x20);
    const saida = await this.lerRegistrador(GPIO_BASE + 0x04);
    const pinos = {};
    for (const [pino, endereco] of Object.entries(RTCIO_PAD)) {
      const pad = await this.lerRegistrador(endereco);
      pinos[pino] = {
        saida: Boolean((habilitados >>> pino) & 1),
        nivel: (saida >>> pino) & 1,
        pullUp: Boolean((pad >>> 27) & 1),
        pullDown: Boolean((pad >>> 28) & 1),
      };
    }
    return pinos;
  }

  // --- Deterministic stop points -------------------------------------------------------------------

  linhaDoTrecho(trecho) {
    const linhas = fs.readFileSync(this.firmware.ino, "utf8").split(/\r?\n/);
    const achadas = linhas.map((l, i) => (l.includes(trecho) ? i + 1 : 0)).filter(Boolean);
    if (achadas.length !== 1) throw new Error(`stop point "${trecho}" must match exactly one line of main.ino (found ${achadas.length})`);
    return achadas[0];
  }

  /**
   * Arms a breakpoint at the line of main.ino containing `trecho` and, when the firmware reaches it
   * for the `ocorrencia`-th time, freezes the chip there and applies `acao`:
   *   "desligar"  power cut at that exact instruction (see desligar())
   *   "resetar"   reset button at that instruction, then the chip runs on
   * Resolves once the action was applied. The firmware runs untouched until then.
   */
  async pararEm(trecho, { ocorrencia = 1, acao = "desligar", limiteMs = ESPERA_PADRAO_MS * 3, funcao = null } = {}) {
    if (!["desligar", "resetar"].includes(acao)) throw new Error(`unknown stop action ${acao}`);
    // `funcao` stops at a function of the firmware or its libraries instead of a line of main.ino.
    if (funcao !== null && !/^[A-Za-z_][A-Za-z0-9_:]*$/.test(funcao)) throw new Error(`invalid function name ${funcao}`);
    const linha = funcao ? null : this.linhaDoTrecho(trecho);
    const local = funcao || `main.ino:${linha}`;
    // The GDB stub exists only while this stop point is armed, on a loopback port.
    const portaGdb = await portaLivre();
    await this.qmp.executar("human-monitor-command", { "command-line": `gdbserver tcp:127.0.0.1:${portaGdb}` });
    const args = ["-q", "-nx", "-batch",
      "-ex", "set pagination off", "-ex", "set confirm off",
      "-ex", `target remote 127.0.0.1:${portaGdb}`,
      "-ex", `break ${local}`];
    if (ocorrencia > 1) args.push("-ex", `ignore 1 ${ocorrencia - 1}`);
    args.push("-ex", "continue", "-ex", 'printf "LAB-PARADA\\n"');
    if (acao === "desligar") args.push("-ex", "monitor quit");
    else args.push("-ex", "monitor system_reset", "-ex", "detach");
    args.push(this.firmware.elf);
    return new Promise((resolve, reject) => {
      const gdb = registrarProcesso(spawn(comandoGdb(), args, { stdio: ["ignore", "pipe", "pipe"] }), "gdb");
      this.gdbs.add(gdb);
      let saida = "";
      gdb.stdout.on("data", (d) => { saida = (saida + d).slice(-20_000); });
      gdb.stderr.on("data", (d) => { saida = (saida + d).slice(-20_000); });
      const timer = setTimeout(() => { gdb.kill("SIGKILL"); reject(new Error(`${this.nome}: stop point ${local} not reached within ${limiteMs} ms`)); }, limiteMs);
      gdb.once("exit", async () => {
        clearTimeout(timer);
        this.gdbs.delete(gdb);
        if (this.processo && this.qmp) await this.qmp.executar("human-monitor-command", { "command-line": "gdbserver none" }).catch(() => {});
        if (!saida.includes("LAB-PARADA")) return reject(new Error(`${this.nome}: gdb ended before the stop point:\n${saida.slice(-1500)}`));
        if (acao === "desligar") await Promise.race([this.fim, esperar(15_000)]);
        resolve({ local, trecho });
      });
    });
  }
}

/** Line protocol of QEMU's qtest server: one reply per command, "IRQ ..." lines interleaved. */
class CanalQtest {
  constructor(soquete, aoIrq) {
    this.soquete = soquete;
    this.pendentes = [];
    this.buffer = "";
    soquete.setNoDelay(true);
    soquete.on("error", () => {});
    soquete.on("close", () => { for (const p of this.pendentes.splice(0)) p.reject(new Error("qtest channel closed")); });
    soquete.on("data", (d) => {
      this.buffer += d.toString("latin1");
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const linha = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (linha.startsWith("IRQ ")) aoIrq(linha);
        else {
          const p = this.pendentes.shift();
          if (!p) continue;
          if (linha.startsWith("OK")) p.resolve(linha);
          else p.reject(new Error(`qtest: ${linha}`));
        }
      }
    });
  }

  comando(texto) {
    return new Promise((resolve, reject) => {
      if (this.soquete.destroyed) return reject(new Error("qtest channel closed"));
      this.pendentes.push({ resolve, reject });
      this.soquete.write(`${texto}\n`);
    });
  }
}

/** Minimal QMP client: capabilities negotiation, then one command at a time. */
class CanalQmp {
  constructor(soquete) {
    this.soquete = soquete;
    this.buffer = "";
    this.pendente = null;
    this.fila = Promise.resolve();
    soquete.on("error", () => {});
    soquete.on("close", () => { if (this.pendente) this.pendente.reject(new Error("QMP channel closed")); });
    let saudou;
    this.pronto = new Promise((r) => { saudou = r; });
    soquete.on("data", (d) => {
      this.buffer += d.toString("utf8");
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const linha = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!linha) continue;
        const msg = JSON.parse(linha);
        if (msg.QMP) { soquete.write('{"execute":"qmp_capabilities"}\n'); continue; }
        if (msg.event) continue;
        if (!this.pendente && msg.return !== undefined) { saudou(); continue; }
        const p = this.pendente;
        this.pendente = null;
        if (!p) continue;
        if (msg.error) p.reject(new Error(`QMP: ${msg.error.desc}`));
        else p.resolve(msg.return);
      }
    });
  }

  executar(comando, argumentos) {
    const passo = this.fila.then(() => new Promise((resolve, reject) => {
      if (this.soquete.destroyed) return reject(new Error("QMP channel closed"));
      this.pendente = { resolve, reject };
      this.soquete.write(`${JSON.stringify(argumentos ? { execute: comando, arguments: argumentos } : { execute: comando })}\n`);
    }));
    this.fila = passo.catch(() => {});
    return passo;
  }
}

module.exports = { PlacaVirtual, portaLivre };
