const crypto = require("crypto");
const EventEmitter = require("events");
const WebSocket = require("ws");
const { NoDeReferencia } = require("./mesh-reference");

// Simulated devices at the protocol level, for fault injection against a running server.
//
// A Bancada owns every board, gateway, socket and timer it creates. Boards speak the message shapes
// of firmware 4.3.0 (src/main.ino) on /ws/dispositivo; a gateway board relays frames for mesh nodes
// whose side of the protocol is mesh-reference.js. Faults are injected where a real board or a
// hostile gateway could produce them: what is sent, when, how often, and whether it is answered.
//
// This validates the server and the protocol state machines only. No radio, GPIO, IR, NVS, flash or
// bootloader is involved, and nothing here is evidence about ESP32 hardware.
//
// Synchronisation is by event: a test waits for the message, close or state it needs, and a timeout
// only turns a missing event into a readable failure. encerrar() stops reconnection before closing
// anything, so no board comes back after a test, and it reports what was left open.

const FW_PADRAO = "4.3.0";

class Bancada {
  constructor({ porta, host = "127.0.0.1" }) {
    this.urlWs = `ws://${host}:${porta}/ws/dispositivo`;
    this.urlHttp = `http://${host}:${porta}`;
    this.dispositivos = new Set();
    this.timers = new Set();
    this.encerrada = false;
  }

  placa(opcoes = {}) {
    return this.registrar(new PlacaSimulada(this, opcoes));
  }

  gateway(opcoes = {}) {
    return this.registrar(new GatewaySimulado(this, opcoes));
  }

  registrar(dispositivo) {
    if (this.encerrada) throw new Error("bancada encerrada");
    this.dispositivos.add(dispositivo);
    return dispositivo;
  }

  // Timers are tracked so that teardown can prove none is left behind.
  depois(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  cancelar(t) {
    if (!t) return;
    clearTimeout(t);
    clearInterval(t);
    this.timers.delete(t);
  }

  intervalo(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }

  recursos() {
    let sockets = 0;
    let ouvintes = 0;
    for (const d of this.dispositivos) {
      if (d.ws && d.ws.readyState !== WebSocket.CLOSED) sockets += 1;
      ouvintes += d.ouvintesPendentes();
    }
    return { dispositivos: this.dispositivos.size, sockets, timers: this.timers.size, esperas: ouvintes };
  }

  /** Stops every device and waits for its socket to close. Safe to call more than once. */
  async encerrar() {
    this.encerrada = true;
    await Promise.all([...this.dispositivos].map((d) => d.encerrar()));
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    return this.recursos();
  }
}

/**
 * A board that follows the firmware protocol, with switches for the faults a test injects.
 *
 * Credential: `credencial: { deviceId, segredo }` (per-device credential) or `sala` + `mac` (legacy
 * identification, where the server still accepts it). `mac` is sent in both cases, as the firmware
 * does.
 */
class PlacaSimulada extends EventEmitter {
  constructor(bancada, { credencial = null, sala = null, mac = null, fw = FW_PADRAO, telemetriaMs = 0, reconectar = null, temp = 23.5 } = {}) {
    super();
    this.setMaxListeners(100);
    this.bancada = bancada;
    this.credencial = credencial ? { ...credencial } : null;
    this.sala = sala;
    this.mac = mac;
    this.fw = fw;
    this.temp = temp;
    this.telemetriaMs = telemetriaMs;
    // { atrasoMs } re-opens the socket after an unrequested close, as the firmware's loop does.
    this.reconexao = reconectar;
    this.ws = null;
    this.encerrada = false;
    this.conexoes = 0;
    this.recebidas = [];
    this.totalRecebidas = 0;
    this.fechamentos = [];
    this.ligado = null;
    this.versaoEstado = null;
    this.segredoRecebido = null;
    this.timerTelemetria = null;
    this.timerReconexao = null;
    this.esperas = new Set();
    // Behaviour switches. Each one is a fault a real board (or its network) can produce.
    this.falhas = {
      silenciosa: false, // answers nothing and sends no telemetry, socket still open
      semConfirmacao: false, // applies desired state but never reports it
      confirmacaoAtrasadaMs: 0,
      confirmacaoDuplicada: false,
      naoAplicarCredencial: false, // loses the rotated secret (e.g. connection lost before NVS)
    };
    // reinicioManual: after writing, wait for reiniciarAposOta() instead of rebooting at once, so a
    // test can act in between (restart the server, for example).
    this.ota = { modo: "ok", baixar: false, progresso: 2, validar: true, atrasoReinicioMs: 20, reinicioManual: false };
    this.otaGravada = null;
    this.otaOfertas = [];
  }

  // --- Connection -----------------------------------------------------------------------------

  cabecalhos() {
    const h = {};
    if (this.mac) h["x-device-mac"] = this.mac;
    if (this.credencial) {
      h["x-device-id"] = this.credencial.deviceId;
      h["x-device-secret"] = this.credencial.segredo;
    } else if (this.sala) {
      h["x-device-sala"] = this.sala;
    }
    return h;
  }

  /**
   * Opens the socket. The server upgrades first and authenticates afterwards, so an open socket
   * proves nothing: this resolves at the server's first message (every accepted device receives its
   * role at once) and rejects with the close code when the server closes first (4001 is a refused
   * identity).
   */
  conectar({ atrasoMs = 0, cabecalhos = null } = {}) {
    if (this.encerrada) return Promise.reject(new Error("placa encerrada"));
    const abrir = () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(this.bancada.urlWs, { headers: cabecalhos || this.cabecalhos() });
        this.ws = ws;
        let aceita = false;
        ws.on("open", () => {
          this.conexoes += 1;
          this.aoAbrir();
        });
        ws.on("message", (dados) => {
          if (!aceita) {
            aceita = true;
            resolve(this);
          }
          this.aoReceber(dados);
        });
        ws.on("close", (codigo) => {
          this.fechamentos.push(codigo);
          this.pararTelemetria();
          this.emit("fechada", codigo);
          if (!aceita) reject(Object.assign(new Error(`conexão recusada (${codigo})`), { codigo }));
          // Like the firmware, a board that wants a connection keeps trying, also after an attempt
          // that never opened (the server is down) or was refused.
          if (this.ws === ws && !this.encerrada && this.reconexao) {
            this.timerReconexao = this.bancada.depois(this.reconexao.atrasoMs || 0, () => {
              this.timerReconexao = null;
              this.conectar().catch(() => {});
            });
          }
        });
        ws.on("error", () => {});
      });
    if (!atrasoMs) return abrir();
    return new Promise((resolve, reject) => {
      this.timerReconexao = this.bancada.depois(atrasoMs, () => {
        this.timerReconexao = null;
        abrir().then(resolve, reject);
      });
    });
  }

  aberta() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  aoAbrir() {
    if (!this.falhas.silenciosa) this.info();
    if (this.telemetriaMs > 0) {
      this.timerTelemetria = this.bancada.intervalo(this.telemetriaMs, () => {
        if (!this.falhas.silenciosa) this.telemetria();
      });
    }
    this.emit("aberta");
  }

  pararTelemetria() {
    this.bancada.cancelar(this.timerTelemetria);
    this.timerTelemetria = null;
  }

  /** Clean close from the board side. Does not trigger reconnection. */
  async fechar(codigo = 1000) {
    const reconexao = this.reconexao;
    this.reconexao = null;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const fechou = this.aguardarFechamento({ limiteMs: 5000 });
      this.ws.close(codigo);
      await fechou;
    }
    this.reconexao = reconexao;
  }

  /** Abrupt loss (power, Wi-Fi): the TCP connection disappears without a close frame. */
  derrubar() {
    if (this.ws && this.ws._socket) this.ws._socket.destroy();
  }

  async encerrar() {
    this.encerrada = true;
    this.reconexao = null;
    this.bancada.cancelar(this.timerReconexao);
    this.pararTelemetria();
    for (const cancelar of [...this.esperas]) cancelar();
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const fechou = new Promise((resolve) => this.ws.once("close", resolve));
      this.ws.terminate();
      await fechou;
    }
  }

  // --- Messages -------------------------------------------------------------------------------

  enviar(obj) {
    if (!this.aberta()) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  enviarBruto(dados) {
    if (!this.aberta()) return false;
    this.ws.send(dados);
    return true;
  }

  estadoReportado() {
    const campos = { failsafeConfigurado: false, failsafePulsos: 0, failsafeCarrierHz: 0, failsafeProtocolRecordId: -1, failsafeLatched: false };
    if (this.versaoEstado !== null) campos.versao = this.versaoEstado;
    if (this.ligado !== null) campos.ligado = this.ligado;
    return campos;
  }

  info(extra = {}) {
    return this.enviar({ tipo: "info", fw: this.fw, otaValidacao: true, ...this.estadoReportado(), ...extra });
  }

  telemetria(extra = {}) {
    return this.enviar({ tipo: "telemetria", temp: this.temp, hum: 55, rssi: -58, modo: "operation", fw: this.fw, ...this.estadoReportado(), ...extra });
  }

  aoReceber(dados) {
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.tipo !== "string") return;
    this.recebidas.push(msg);
    if (this.recebidas.length > 200) this.recebidas.shift();
    this.totalRecebidas += 1;
    this.emit("mensagem", msg);
    if (this.falhas.silenciosa) return;
    if (msg.tipo === "send_known_state") this.aplicarEstado(msg);
    else if (msg.tipo === "ota_oferta") this.responderOta(msg);
    else if (msg.tipo === "credencial_rotacionar" || msg.tipo === "credencial_provisionar") this.receberCredencial(msg);
  }

  aplicarEstado(msg) {
    // An automatic restoration and an explicit command both carry the intent version (4.3.0+).
    if (Number.isInteger(msg.versao)) this.versaoEstado = msg.versao;
    if (typeof msg.power === "boolean") this.ligado = msg.power;
    if (this.falhas.semConfirmacao) return;
    const confirmar = () => {
      this.telemetria();
      if (this.falhas.confirmacaoDuplicada) this.telemetria();
    };
    if (this.falhas.confirmacaoAtrasadaMs > 0) this.bancada.depois(this.falhas.confirmacaoAtrasadaMs, confirmar);
    else confirmar();
  }

  receberCredencial(msg) {
    if (typeof msg.segredo !== "string" || typeof msg.deviceId !== "string") return;
    this.segredoRecebido = { deviceId: msg.deviceId, segredo: msg.segredo };
    if (this.falhas.naoAplicarCredencial) return;
    this.enviar({ tipo: "comando", cmd: "credencial", valor: "aplicada" });
  }

  /** Adopts the secret the server delivered and reconnects with it, as the firmware does. */
  async adotarCredencialRecebida() {
    if (!this.segredoRecebido) throw new Error("nenhuma credencial recebida");
    this.credencial = { ...this.segredoRecebido };
    await this.fechar();
    return this.conectar();
  }

  // --- OTA ----------------------------------------------------------------------------------

  /**
   * ota.modo:
   *   "ok"                  progress, "ok" result, restart into the offered version, boot validation
   *   "erro"                explicit failure report
   *   "interromper"         connection lost in the middle of the transfer
   *   "rollback"            "ok", then comes back on the previous version (bootloader rollback)
   *   "versao-inesperada"   "ok", then comes back on a version that is neither
   *   "resultado-duplicado" sends the "ok" result twice
   *   "sem-validacao"       restarts into the new version but never confirms the boot validation
   *   "parado"              acknowledges nothing (tests a transfer timeout)
   */
  async responderOta(oferta) {
    this.otaOfertas.push(oferta);
    const modo = this.ota.modo;
    if (modo === "parado") return;
    if (this.ota.baixar) {
      const baixado = await this.baixarFirmware(oferta).catch((erro) => ({ erro }));
      if (baixado.erro) {
        this.enviar({ tipo: "ota_resultado", resultado: "erro", erro: String(baixado.erro.message || baixado.erro), versao: this.fw });
        return;
      }
    }
    for (let i = 1; i <= this.ota.progresso; i += 1) {
      this.enviar({ tipo: "ota_progresso", recebido: Math.round((oferta.tamanho * i) / (this.ota.progresso + 1)), total: oferta.tamanho });
    }
    if (modo === "interromper") return this.derrubar();
    if (modo === "erro") {
      this.enviar({ tipo: "ota_resultado", resultado: "erro", erro: "sha256 divergente", versao: this.fw });
      return;
    }
    this.enviar({ tipo: "ota_resultado", resultado: "ok", versao: this.fw });
    if (modo === "resultado-duplicado") this.enviar({ tipo: "ota_resultado", resultado: "ok", versao: this.fw });
    const anterior = this.fw;
    const proxima = modo === "rollback" ? anterior : modo === "versao-inesperada" ? "0.0.1-inesperada" : oferta.versao;
    this.otaGravada = { oferta, proxima, modo };
    this.emit("ota-gravada", this.otaGravada);
    if (this.ota.reinicioManual) return;
    this.bancada.depois(this.ota.atrasoReinicioMs, () => this.reiniciarAposOta().catch(() => {}));
  }

  /** The reboot after writing: goes down, comes back on the new (or rolled back) image, validates. */
  async reiniciarAposOta() {
    const gravada = this.otaGravada;
    if (!gravada || this.encerrada) return;
    this.otaGravada = null;
    await this.fechar(1012);
    this.fw = gravada.proxima;
    await this.conectar();
    const validar = this.ota.validar && !["sem-validacao", "rollback", "versao-inesperada"].includes(gravada.modo);
    if (validar) this.enviar({ tipo: "ota_validado", tentativa: gravada.oferta.tentativa, sha256: gravada.oferta.sha256, versao: this.fw });
  }

  async baixarFirmware(oferta) {
    // As the firmware does: the offered path plus the board's room.
    const url = `${this.bancada.urlHttp}${oferta.caminho || "/dispositivo/firmware"}?sala=${encodeURIComponent(this.sala || "")}`;
    const resposta = await fetch(url, { headers: this.cabecalhos() });
    if (resposta.status !== 200) throw new Error(`download retornou HTTP ${resposta.status}`);
    const corpo = Buffer.from(await resposta.arrayBuffer());
    if (corpo.length !== oferta.tamanho) throw new Error("tamanho do download difere da oferta");
    if (crypto.createHash("sha256").update(corpo).digest("hex") !== oferta.sha256) throw new Error("sha256 divergente");
    return { bytes: corpo.length };
  }

  // --- Waiting ------------------------------------------------------------------------------

  ouvintesPendentes() {
    return this.esperas.size;
  }

  /**
   * Waits for a message of `tipo` (or matching a predicate) received after `desde` (a value of
   * totalRecebidas taken before the action). Messages already buffered count.
   */
  aguardar(filtro, { limiteMs = 4000, desde = 0 } = {}) {
    const casa = typeof filtro === "function" ? filtro : (m) => m.tipo === filtro;
    const jaRecebidas = this.recebidas.slice(Math.max(0, this.recebidas.length - (this.totalRecebidas - desde)));
    const achada = jaRecebidas.find(casa);
    if (achada) return Promise.resolve(achada);
    return this.esperarEvento("mensagem", casa, limiteMs, `mensagem ${typeof filtro === "string" ? filtro : "esperada"}`);
  }

  aguardarAbertura({ limiteMs = 4000 } = {}) {
    if (this.aberta()) return Promise.resolve();
    return this.esperarEvento("aberta", () => true, limiteMs, "abertura da conexão");
  }

  aguardarFechamento({ limiteMs = 4000 } = {}) {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(this.fechamentos[this.fechamentos.length - 1]);
    return this.esperarEvento("fechada", () => true, limiteMs, "fechamento da conexão");
  }

  esperarEvento(evento, casa, limiteMs, descricao) {
    return new Promise((resolve, reject) => {
      const ouvinte = (valor) => {
        if (!casa(valor)) return;
        limpar();
        resolve(valor);
      };
      const timer = this.bancada.depois(limiteMs, () => {
        limpar();
        reject(new Error(`tempo esgotado aguardando ${descricao} (${limiteMs} ms)`));
      });
      const limpar = () => {
        this.off(evento, ouvinte);
        this.bancada.cancelar(timer);
        this.esperas.delete(cancelar);
      };
      const cancelar = () => {
        limpar();
        reject(new Error("placa encerrada"));
      };
      this.esperas.add(cancelar);
      this.on(evento, ouvinte);
    });
  }
}

/**
 * A gateway board: its own credential and socket (a PlacaSimulada), plus a relay for the mesh nodes
 * behind it. Relay faults: delay, duplication, replay of a captured frame, a silent node, route
 * metadata that changes or goes stale.
 */
class GatewaySimulado extends PlacaSimulada {
  constructor(bancada, opcoes = {}) {
    super(bancada, opcoes);
    this.nos = new Map();
    this.rota = { pai: "gateway", saltos: 1, rssi: -58 };
    this.relay = { atrasoMs: 0, duplicar: false };
    this.emTransito = 0;
    this.capturados = [];
    this.recusas = [];
  }

  info(extra = {}) {
    return super.info({ gateway: true, ...extra });
  }

  /** A node joining through this gateway. `segredo` may be wrong on purpose. */
  no({ deviceId, segredo, rota = null }) {
    const no = new NoDeReferencia({ deviceId, segredo, gatewayDeviceId: this.credencial && this.credencial.deviceId });
    no.rota = rota;
    this.nos.set(deviceId, no);
    return no;
  }

  anunciar(no, evento = "entrou") {
    return this.enviar({ tipo: "mesh_evento", evento, no: no.deviceId, rota: no.rota || this.rota });
  }

  /** Sends a sealed payload from a node, as the node would, through this gateway. Returns the frame. */
  doNo(no, payload, { rota } = {}) {
    const quadro = no.selar(payload);
    this.capturados.push({ no: no.deviceId, quadro });
    this.encaminhar({ tipo: "mesh", no: no.deviceId, quadro, rota: rota || no.rota || this.rota });
    return quadro;
  }

  /** Re-sends a frame seen earlier, byte for byte (replay). Defaults to the last captured one. */
  reenviar(no, quadro = null) {
    const item = quadro ? { no: no.deviceId, quadro } : this.capturados.at(-1);
    if (!item) return false;
    return this.enviar({ tipo: "mesh", no: item.no, quadro: item.quadro, rota: this.rota });
  }

  encaminhar(msg) {
    const enviar = () => {
      this.enviar(msg);
      if (this.relay.duplicar) this.enviar(msg);
    };
    if (this.relay.atrasoMs <= 0) {
      enviar();
      return true;
    }
    this.emTransito += 1;
    this.bancada.depois(this.relay.atrasoMs, () => {
      enviar();
      this.emTransito -= 1;
      if (this.emTransito === 0) this.emit("drenado");
    });
    return true;
  }

  /** Resolves once every delayed frame has been handed to the server. */
  drenar({ limiteMs = 4000 } = {}) {
    if (this.emTransito === 0) return Promise.resolve();
    return this.esperarEvento("drenado", () => true, limiteMs, "frames em trânsito no gateway");
  }

  aoReceber(dados) {
    super.aoReceber(dados);
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.tipo === "mesh_recusado") {
      this.recusas.push(msg);
      const no = this.nos.get(msg.no);
      if (no) no.recusado = msg.motivo;
      return;
    }
    if (msg.tipo !== "mesh") return;
    const no = this.nos.get(msg.no);
    if (!no || no.mudo) return;
    let respostas;
    try {
      respostas = no.receber(msg.quadro);
    } catch (erro) {
      no.erro = erro.message;
      return;
    }
    for (const quadro of respostas) {
      this.capturados.push({ no: no.deviceId, quadro });
      this.encaminhar({ tipo: "mesh", no: no.deviceId, quadro, rota: no.rota || this.rota });
    }
  }
}

module.exports = { Bancada, PlacaSimulada, GatewaySimulado, FW_PADRAO };
