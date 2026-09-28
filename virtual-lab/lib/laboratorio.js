"use strict";

// One scenario's world: the real server (server.js as a child process on a throwaway data directory),
// the real firmware on virtual boards, and the network between them. It also records the evidence the
// scenario produced, in the shape every fault test states up front:
//
//   inicial     the state before the fault
//   falha       what is injected, and where
//   exigido     the safe behaviour that must be observed
//   proibido    what must not happen
//   recuperacao the condition that shows the system recovered
//
// Nothing here is hardware evidence. See virtual-lab/README.md for what each result can and cannot say.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");
const { iniciarServidorIsolado, RAIZ_SERVIDOR } = require("../../remoteifes-server/test/support/servidor-isolado");
const { obterEmulador } = require("./emulador");
const { construir, montarImagem } = require("./firmware");
const { PlacaVirtual } = require("./placa");
const { Intermediario } = require("./rede");
const { diretorioSaida, diretorioTrabalho, registrarSegredo, redigir, removerSeguro, registrarProcesso, registrarPorta, exigirHostDescartavel } = require("./ambiente");
const flash = require("./flash");

// The MAC the emulator gives every board (its default eFuse). The server binds rooms by it.
const MAC_PLACA = "10:01:00:C4:0A:24";
// One of the emulator's open access points; the board joins it like any open network.
const REDE_WIFI = "MasseyWifi";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const builds = new Map();

/**
 * A production installation already running on this disposable host (the deployment rehearsal's:
 * systemd unit behind nginx), used instead of a throwaway server when LAB_SERVIDOR_BASE is set. Its
 * service and proxy are controlled only through `sudo -n systemctl` on the fixed units named in
 * LAB_SERVICO_SYSTEMD and LAB_PROXY_SYSTEMD.
 */
function servidorExterno() {
  const base = process.env.LAB_SERVIDOR_BASE;
  const senha = process.env.LAB_SERVIDOR_SENHA;
  const url = new URL(base);
  if (url.hostname !== "127.0.0.1" || !senha) throw new Error("LAB_SERVIDOR_BASE must be a loopback URL and LAB_SERVIDOR_SENHA set");
  registrarSegredo(senha);
  const unidade = (nome) => {
    const u = process.env[nome];
    if (!/^[a-z0-9@._-]+\.service$/.test(u || "")) throw new Error(`${nome} must name a systemd service`);
    return u;
  };
  const systemctl = (...args) => {
    const r = require("child_process").spawnSync("sudo", ["-n", "systemctl", ...args], { encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`systemctl ${args.join(" ")}: ${r.stderr}`);
  };
  const servidor = {
    externo: true,
    base,
    porta: Number(url.port || 80),
    saida: "",
    token: null,
    async api(metodo, rota, corpo) {
      if (!servidor.token) {
        const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usuario: "superadmin", senha }) });
        const dados = await login.json().catch(() => ({}));
        if (!dados.token) throw new Error(`login on the installation failed (${login.status})`);
        servidor.token = dados.token;
      }
      const r = await fetch(`${base}${rota}`, { method: metodo, headers: { "content-type": "application/json", authorization: `Bearer ${servidor.token}` }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      if (r.status === 401) servidor.token = null;
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    async saudavel(limiteMs = 120_000) {
      const prazo = Date.now() + limiteMs;
      while (Date.now() < prazo) {
        try { if ((await (await fetch(`${base}/health`)).json()).ok) { servidor.token = null; return; } } catch {}
        await esperar(500);
      }
      throw new Error("the installation did not become healthy");
    },
    servico: (verbo, ...args) => systemctl(verbo, ...args, unidade("LAB_SERVICO_SYSTEMD")),
    proxy: (verbo) => systemctl(verbo, unidade("LAB_PROXY_SYSTEMD")),
    async encerrar() {
      const j = require("child_process").spawnSync("sudo", ["-n", "journalctl", "-u", unidade("LAB_SERVICO_SYSTEMD"), "--no-pager", "-n", "300"], { encoding: "utf8" });
      servidor.saida = j.stdout || "";
    },
  };
  return servidor;
}

/** Builds (or reuses from the lab cache) the firmware variants a scenario needs, before any board runs. */
async function prepararFirmware(variantes) {
  for (const v of variantes) if (!builds.has(v)) builds.set(v, await construir(v));
}

function firmware(variante) {
  const build = builds.get(variante);
  if (!build) throw new Error(`firmware variant ${variante} was not prepared: list it in the scenario's "firmware"`);
  return build;
}

function nomeDeArquivo(texto) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
}

class Laboratorio {
  constructor(meta) {
    this.meta = meta;
    this.observado = {};
    this.placas = [];
    this.intermediarios = [];
    this.arquivos = [];
    this.inicio = Date.now();
    this.dir = path.join(diretorioSaida(), nomeDeArquivo(meta.cenario));
  }

  static async abrir(meta) {
    const lab = new Laboratorio(meta);
    exigirHostDescartavel("a virtual hardware scenario");
    removerSeguro(lab.dir);
    fs.mkdirSync(lab.dir, { recursive: true });
    lab.emulador = await obterEmulador();
    await prepararFirmware(meta.firmware || ["producao"]);
    if (process.env.LAB_SERVIDOR_BASE) {
      lab.servidor = servidorExterno();
      await lab.servidor.saudavel();
      return lab;
    }
    const senha = crypto.randomBytes(18).toString("base64url");
    registrarSegredo(senha);
    lab.servidor = await iniciarServidorIsolado({ senha, dirBase: diretorioTrabalho(), aoIniciar: (filho) => registrarProcesso(filho, "servidor") });
    registrarPorta(lab.servidor.porta, "servidor");
    return lab;
  }

  firmware(variante = "producao") {
    return firmware(variante);
  }

  /** The flash of a board fresh from `pio run -t upload` + `-t uploadfs`: empty NVS, app in ota_0. */
  imagemDeFabrica(variante = "producao") {
    return montarImagem(this.firmware(variante));
  }

  /** Bytes of each known application image, to identify what a slot holds. */
  appsConhecidos() {
    const conhecidos = {};
    for (const [variante, build] of builds) conhecidos[variante] = fs.readFileSync(build.app);
    return conhecidos;
  }

  /**
   * A board whose only reachable server is `via`, the intermediary in front of this scenario's server
   * (the board sees it as 192.168.4.9:8080).
   */
  novaPlaca({ nome = "placa", imagem, variante = "producao", via } = {}) {
    if (!via) throw new Error("a board needs the intermediary it will reach");
    const arquivo = path.join(diretorioTrabalho(), `placa-${process.pid}-${crypto.randomBytes(4).toString("hex")}.flash`);
    fs.writeFileSync(arquivo, imagem || this.imagemDeFabrica(variante));
    this.arquivos.push(arquivo);
    const placa = new PlacaVirtual({ nome, emulador: this.emulador, arquivoFlash: arquivo, firmware: this.firmware(variante), portaDestino: via.porta });
    this.placas.push(placa);
    return placa;
  }

  /** The board's flash as it is now (read with the board off, or after its last power cycle). */
  lerFlash(placa) {
    return fs.readFileSync(placa.arquivoFlash);
  }

  gravarFlash(placa, imagem) {
    if (placa.processo) throw new Error("power the board off before editing its flash");
    fs.writeFileSync(placa.arquivoFlash, imagem);
  }

  nvs(placa) {
    return flash.lerNamespace(this.lerFlash(placa), "remoteifes");
  }

  async intermediario(opcoes = {}) {
    const i = await new Intermediario({ portaDestino: this.servidor.porta, ...opcoes }).iniciar();
    this.intermediarios.push(i);
    return i;
  }

  // --- Server-side operator actions (the same API the Administration screens use) ---------------------

  async api(metodo, rota, corpo) {
    const r = await this.servidor.api(metodo, rota, corpo);
    return r;
  }

  async prepararSala(sala, { protocolo = 16, credencial = true } = {}) {
    const mac = await this.api("PATCH", `/admin/salas/${encodeURIComponent(sala)}/mac`, { mac: MAC_PLACA });
    if (mac.status !== 200) throw new Error(`binding ${MAC_PLACA} to ${sala} failed: ${JSON.stringify(mac.corpo)}`);
    if (protocolo !== null) {
      const p = await this.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo });
      if (p.status !== 200) throw new Error(`setting IR protocol failed: ${JSON.stringify(p.corpo)}`);
    }
    if (!credencial) return null;
    const c = await this.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`);
    if (c.status !== 200) throw new Error(`provisioning a credential failed: ${JSON.stringify(c.corpo)}`);
    registrarSegredo(c.corpo.segredo);
    return { deviceId: c.corpo.deviceId, segredo: c.corpo.segredo };
  }

  /**
   * Gives the room an IR protocol that carries a failsafe OFF, then applies it through the API, which
   * pushes the failsafe to a connected board (failsafe_raw_set). A real protocol comes from an IR capture
   * on the cloner board; the emulator has no infrared receiver, so the record is written into this
   * scenario's own throwaway database. What the lab then observes is the firmware's side: storage,
   * transmission and latch.
   */
  async definirFailsafe(sala, { raw, carrierHz = 38000, protocolo = 16 }) {
    if (this.servidor.externo) throw new Error("definirFailsafe writes the scenario's own database: not available against an installation");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(this.servidor.caminhoBanco);
    let id;
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const r = db.prepare(`
        INSERT INTO protocolos_ir (label, isKnown, protocolId, protocol, rawJson, carrierHz, failsafeRawJson, failsafeCarrierHz, failsafeAtualizadoEm, origemSala, origemMac)
        VALUES (?, 1, ?, 'LAB', ?, ?, ?, ?, datetime('now'), ?, ?)
      `).run(`lab-${sala}-${Date.now()}`, protocolo, JSON.stringify(raw), carrierHz, JSON.stringify(raw), carrierHz, sala, MAC_PLACA);
      id = Number(r.lastInsertRowid);
    } finally {
      db.close();
    }
    const aplicar = await this.api("POST", `/admin/protocolos-ir/${id}/aplicar/${encodeURIComponent(sala)}`);
    if (aplicar.status !== 200) throw new Error(`applying the protocol failed: ${JSON.stringify(aplicar.corpo)}`);
    return { id, ...aplicar.corpo };
  }

  async estado(sala) {
    const r = await this.api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`);
    if (r.status !== 200) throw new Error(`device state of ${sala}: HTTP ${r.status}`);
    return r.corpo.dispositivo;
  }

  async aguardar(condicao, { descricao = "condition", limiteMs = 180_000, intervaloMs = 250 } = {}) {
    const prazo = Date.now() + limiteMs;
    let ultimo;
    for (;;) {
      try {
        ultimo = await condicao();
        if (ultimo) return ultimo;
      } catch (erro) {
        ultimo = erro.message;
      }
      if (Date.now() > prazo) throw new Error(`timed out waiting for ${descricao} (last: ${JSON.stringify(ultimo)?.slice(0, 500)})`);
      await esperar(intervaloMs);
    }
  }

  /** Connected and past the board's `info` message: the session a command can rely on. */
  aguardarConectada(sala, opcoes = {}) {
    return this.aguardar(async () => {
      const e = await this.estado(sala);
      return e.dispositivo.conectado && e.dispositivo.fwVersao ? e : false;
    }, { descricao: `${sala} connected`, ...opcoes });
  }

  aguardarDesconectada(sala, opcoes = {}) {
    return this.aguardar(async () => !(await this.estado(sala)).dispositivo.conectado, { descricao: `${sala} disconnected`, ...opcoes });
  }

  aguardarConfirmada(sala, opcoes = {}) {
    return this.aguardar(async () => {
      const e = await this.estado(sala);
      return e.dispositivo.conectado && e.dispositivo.estadoConfirmado === true ? e : false;
    }, { descricao: `${sala} confirmed`, ...opcoes });
  }

  /** Runs a production command-line tool of the server against this scenario's data directory. */
  cli(script, args = []) {
    if (this.servidor.externo) throw new Error("production CLI tools run against the scenario's own server only");
    return new Promise((resolve, reject) => {
      const filho = registrarProcesso(spawn(process.execPath, [script, ...args], { cwd: RAIZ_SERVIDOR, env: this.servidor.ambiente, windowsHide: true }), "cli");
      let saida = "";
      filho.stdout.on("data", (d) => { saida += d; });
      filho.stderr.on("data", (d) => { saida += d; });
      const limite = setTimeout(() => filho.kill(), 120_000);
      filho.once("error", reject);
      filho.once("exit", (codigo) => { clearTimeout(limite); resolve({ codigo, saida }); });
    });
  }

  // --- OTA -------------------------------------------------------------------------------------------

  /** Publishes an application image with the production tool (npm run firmware). */
  async publicarFirmware(caminho, versao) {
    const r = await this.cli("firmware-esp32.js", [caminho, versao, "virtual-lab"]);
    if (r.codigo !== 0) throw new Error(`publishing ${versao} failed: ${redigir(r.saida)}`);
    return r;
  }

  async ofertarOta(sala) {
    return this.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/ota`);
  }

  async estadoOta(sala) {
    return (await this.estado(sala)).dispositivo.ota;
  }

  aguardarFaseOta(sala, fases, opcoes = {}) {
    const lista = Array.isArray(fases) ? fases : [fases];
    return this.aguardar(async () => {
      const ota = await this.estadoOta(sala);
      return ota && lista.includes(ota.fase) ? ota : false;
    }, { descricao: `OTA of ${sala} in ${lista.join("/")}`, limiteMs: 600_000, ...opcoes });
  }

  /**
   * What the flash says about the application slots: which the bootloader will start, each slot's OTA
   * state, and which known image (by exact bytes) each slot holds.
   */
  slots(placa) {
    const imagem = this.lerFlash(placa);
    const ota = flash.lerOtadata(imagem);
    const conhecidos = this.appsConhecidos();
    return {
      boot: ota.boot,
      estado: { ota_0: ota.estadoDe("ota_0"), ota_1: ota.estadoDe("ota_1") },
      conteudo: { ota_0: flash.appNoSlot(imagem, "ota_0", conhecidos), ota_1: flash.appNoSlot(imagem, "ota_1", conhecidos) },
    };
  }

  // --- Board setup through its own portal -------------------------------------------------------------

  /**
   * Configures a factory-fresh board as an installer does: it boots into the RemoteIFES-Setup access
   * point, the form is posted to its portal, and it restarts into operation.
   */
  async configurarPeloPortal(placa, { credencial, tls = "off", rede = REDE_WIFI }) {
    await placa.aguardarSerial(/Ponto de Acesso 'RemoteIFES-Setup' ativo no IP: 192\.168\.4\.1/, { limiteMs: 120_000 });
    const campos = { ssid: rede, pass: "", host: placa.servidorNaRede.host, porta: String(placa.servidorNaRede.porta), tls };
    if (credencial) Object.assign(campos, { devId: credencial.deviceId, devSec: credencial.segredo });
    let resposta;
    for (let tentativa = 1; ; tentativa++) {
      try {
        resposta = await fetch(`http://127.0.0.1:${placa.portaPortal}/save`, { method: "POST", body: new URLSearchParams(campos), signal: AbortSignal.timeout(30_000) });
        break;
      } catch (erro) {
        if (tentativa >= 5) throw new Error(`the setup portal did not answer: ${erro.message}`);
        await esperar(2000);
      }
    }
    if (resposta.status !== 200) throw new Error(`the setup portal refused the form: HTTP ${resposta.status} ${await resposta.text()}`);
  }

  /**
   * A board in normal operation: factory image, configured through the portal with a fresh credential
   * for `sala`, connected over the WebSocket. `via` is an Intermediario when faults will be injected.
   */
  async placaEmOperacao({ sala = "A-103a", via = null, variante = "producao", protocolo = 16, nome = "placa" } = {}) {
    const credencial = await this.prepararSala(sala, { protocolo });
    const rede = via || (await this.intermediario());
    const placa = this.novaPlaca({ nome, variante, via: rede });
    await placa.ligar();
    await this.configurarPeloPortal(placa, { credencial });
    const estado = await this.aguardarConectada(sala, { limiteMs: 240_000 });
    return { placa, sala, credencial, estado, via: rede };
  }

  // --- Evidence ---------------------------------------------------------------------------------------

  observar(chave, valor) {
    this.observado[chave] = valor;
  }

  async fechar(erro) {
    for (const i of this.intermediarios) await i.encerrar().catch(() => {});
    for (const [n, p] of this.placas.entries()) {
      await p.encerrar().catch(() => {});
      p.salvarSerial(path.join(this.dir, `${n + 1}-${nomeDeArquivo(p.nome)}-serial.log`));
    }
    await this.servidor.encerrar().catch(() => {});
    const logServidor = redigir(this.servidor.saida || "");
    fs.writeFileSync(path.join(this.dir, "servidor.log"), logServidor);
    for (const a of this.arquivos) removerSeguro(a);
    const registro = {
      ...this.meta,
      resultado: erro ? "falhou" : "passou",
      erro: erro ? redigir(erro.stack || erro.message) : null,
      observado: JSON.parse(redigir(JSON.stringify(this.observado, (k, v) => (typeof v === "bigint" ? v.toString() : v)))),
      duracaoS: Math.round((Date.now() - this.inicio) / 1000),
      emulador: this.emulador ? this.emulador.versao : null,
      firmware: Object.fromEntries([...builds].map(([v, b]) => [v, { versao: b.versao, fonte: b.impressao.slice(0, 16) }])),
      host: `${os.platform()}-${os.arch()} ${os.release()}`,
      node: process.version,
    };
    fs.writeFileSync(path.join(this.dir, "evidencia.json"), JSON.stringify(registro, null, 2));
    fs.appendFileSync(path.join(diretorioSaida(), "cenarios.jsonl"), `${JSON.stringify(registro)}\n`);
  }
}

/**
 * Declares a scenario. `meta` states the fault test up front (inicial, falha, exigido, proibido,
 * recuperacao); `corpo(lab)` drives it and asserts. Evidence is written whether it passes or not.
 */
function cenario(nome, meta, corpo, { timeout = 30 * 60 * 1000, skip = false } = {}) {
  test(nome, { timeout, skip }, async () => {
    const lab = await Laboratorio.abrir({ cenario: nome, ...meta });
    let falha = null;
    try {
      await corpo(lab);
    } catch (erro) {
      falha = erro;
      throw erro;
    } finally {
      await lab.fechar(falha);
    }
  });
}

module.exports = { Laboratorio, cenario, prepararFirmware, servidorExterno, MAC_PLACA, REDE_WIFI, esperar };
