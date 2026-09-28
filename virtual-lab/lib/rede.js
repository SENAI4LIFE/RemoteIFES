"use strict";

// The network between the virtual board and the server, where the lab injects faults.
//
// The board is configured (through its own setup portal) to reach the server at 192.168.4.9:8080, the
// one address its restricted network forwards (lib/relay.js) to this intermediary on 127.0.0.1.
// Everything passes through here unchanged unless a fault is armed.
//
// Payload faults (frames injected, firmware bytes altered) exist only for the plaintext transport the
// firmware supports for trusted LANs (tls = off). Under TLS the same edits would only break records,
// which is transport evidence, not parser evidence; the lab does not mix the two.

const net = require("net");
const tls = require("tls");
const { registrarPorta } = require("./ambiente");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function quadroTexto(texto) {
  const payload = Buffer.from(texto, "utf8");
  let cabecalho;
  if (payload.length < 126) cabecalho = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { cabecalho = Buffer.alloc(4); cabecalho[0] = 0x81; cabecalho[1] = 126; cabecalho.writeUInt16BE(payload.length, 2); }
  else { cabecalho = Buffer.alloc(10); cabecalho[0] = 0x81; cabecalho[1] = 127; cabecalho.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([cabecalho, payload]);
}

/** Length of the first complete WebSocket frame in `buf`, or 0 while it is still partial. */
function tamanhoDoQuadro(buf) {
  if (buf.length < 2) return 0;
  const mascara = (buf[1] & 0x80) ? 4 : 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return 0; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return 0; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const total = off + mascara + len;
  return buf.length >= total ? total : 0;
}

class Intermediario {
  constructor({ portaDestino, hostDestino = "127.0.0.1", tlsOpcoes = null }) {
    this.portaDestino = portaDestino;
    this.hostDestino = hostDestino;
    this.tlsOpcoes = tlsOpcoes;
    this.modo = "normal"; // "normal" | "recusar" | "buraco"
    this.atrasoMs = 0;
    this.firmware = {}; // { cortarApos, corromperByte, pararApos, tamanhoDeclarado }
    // Pace of a firmware download toward the board, bytes per second (null: as fast as it reads). The
    // loopback socket to the relay buffers megabytes, so without a pace a whole image "leaves" at once
    // and the time it spends reaching the board is invisible here.
    this.ritmoFirmware = null;
    this.conexoes = [];
    this.vivas = new Set();
    this.injecoes = [];
    this.daPlaca = [];
    this.controles = [];
    this.aoQuadroDoServidor = null; // (texto, conexao) => "cortar" | undefined
    this.modoAposCorte = null;
  }

  async iniciar() {
    const tratar = (s) => this.aoConectar(s);
    this.servidor = this.tlsOpcoes ? tls.createServer(this.tlsOpcoes, tratar) : net.createServer(tratar);
    this.servidor.on("tlsClientError", (erro) => this.conexoes.push({ id: this.conexoes.length + 1, inicio: Date.now(), tipo: "tls-recusada", erro: erro.code || erro.message }));
    await new Promise((r) => this.servidor.listen(0, "127.0.0.1", r));
    this.porta = this.servidor.address().port;
    registrarPorta(this.porta, "intermediario");
    return this;
  }

  aoConectar(cliente) {
    const c = { id: this.conexoes.length + 1, inicio: Date.now(), tipo: "?", requisicao: null, bytesParaPlaca: 0, bytesParaServidor: 0, corpoParaPlaca: 0, fim: null, motivo: null };
    this.conexoes.push(c);
    cliente.on("error", () => {});
    if (this.modo === "recusar") {
      c.fim = Date.now(); c.motivo = "recusada";
      if (typeof cliente.resetAndDestroy === "function" && !this.tlsOpcoes) cliente.resetAndDestroy(); else cliente.destroy();
      return;
    }
    this.vivas.add(cliente);
    cliente.once("close", () => { this.vivas.delete(cliente); if (!c.fim) c.fim = Date.now(); });
    if (this.modo === "buraco") { c.motivo = "buraco"; cliente.on("data", () => {}); return; }

    const servidor = net.connect(this.portaDestino, this.hostDestino);
    servidor.on("error", () => cliente.destroy());
    this.vivas.add(servidor);
    // The board's side ends only after everything already queued toward it has been written.
    servidor.once("close", () => { this.vivas.delete(servidor); enviandoPlaca.then(() => cliente.end()); });
    cliente.once("close", () => servidor.destroy());
    c.cliente = cliente;

    let cabecalhoCliente = "";
    let quadrosDaPlaca = null;
    const filaServidor = [];
    let enviandoServidor = Promise.resolve();
    cliente.on("data", (d) => {
      c.bytesParaServidor += d.length;
      if (!c.cabecalhos) {
        cabecalhoCliente += d.toString("latin1");
        const fimLinha = cabecalhoCliente.indexOf("\r\n");
        if (!c.requisicao && fimLinha >= 0) {
          c.requisicao = cabecalhoCliente.slice(0, fimLinha);
          c.tipo = / \/ws\/dispositivo/.test(c.requisicao) ? "ws" : / \/dispositivo\/firmware/.test(c.requisicao) ? "firmware" : "http";
        }
        const fim = cabecalhoCliente.indexOf("\r\n\r\n");
        if (fim >= 0) {
          // Request headers, kept only in memory so tests can check which credential was presented.
          c.cabecalhos = Object.fromEntries(cabecalhoCliente.slice(0, fim).split("\r\n").slice(1)
            .map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
          if (c.tipo === "ws") quadrosDaPlaca = Buffer.from(cabecalhoCliente.slice(fim + 4), "latin1");
        } else if (cabecalhoCliente.length > 16384) {
          c.cabecalhos = {};
        }
      } else if (c.tipo === "ws" && quadrosDaPlaca) {
        quadrosDaPlaca = Buffer.concat([quadrosDaPlaca, d]);
      }
      // What the board says on its WebSocket (masked client frames), for tests to assert on.
      if (c.tipo === "ws" && quadrosDaPlaca) {
        let n;
        while (quadrosDaPlaca && (n = tamanhoDoQuadro(quadrosDaPlaca)) > 0) {
          this.registrarDaPlaca(quadrosDaPlaca.subarray(0, n), c);
          quadrosDaPlaca = quadrosDaPlaca.subarray(n);
        }
      }
      filaServidor.push(d);
      enviandoServidor = enviandoServidor.then(async () => {
        const bloco = filaServidor.shift();
        if (this.atrasoMs) await esperar(this.atrasoMs);
        if (!servidor.destroyed) servidor.write(bloco);
      });
    });

    let cabecalho = Buffer.alloc(0);
    let cabecalhoPronto = false;
    c.pendente = Buffer.alloc(0);
    let enviandoPlaca = Promise.resolve();
    // Writes toward the board in order. A firmware download honours backpressure, so the server side
    // is read only as fast as the board consumes: byte offsets and times then describe what the board
    // has actually been handed, not what the local server produced in a burst.
    const paraPlaca = (bloco, aoEscrever) => {
      c.bytesParaPlaca += bloco.length;
      enviandoPlaca = enviandoPlaca.then(async () => {
        if (this.atrasoMs) await esperar(this.atrasoMs);
        if (cliente.destroyed) return;
        // Body blocks carry a callback; the body starts when its first byte is written.
        if (aoEscrever && c.tipo === "firmware" && !c.corpoInicioEm) c.corpoInicioEm = Date.now();
        const ritmo = c.tipo === "firmware" ? this.ritmoFirmware : null;
        let cabe = true;
        if (ritmo) {
          // A slow link: 2 KiB at a time at `ritmo`, the server read no faster than that.
          servidor.pause();
          for (let i = 0; i < bloco.length && !cliente.destroyed; i += 2048) {
            const pedaco = bloco.subarray(i, i + 2048);
            cabe = cliente.write(pedaco);
            await esperar((pedaco.length / ritmo) * 1000);
          }
          if (cliente.destroyed) return;
        } else {
          cabe = cliente.write(bloco);
        }
        if (aoEscrever) aoEscrever();
        if (!cabe && c.tipo === "firmware") {
          servidor.pause();
          await new Promise((r) => {
            const seguir = () => { cliente.off("drain", seguir); cliente.off("close", seguir); r(); };
            cliente.once("drain", seguir);
            cliente.once("close", seguir);
          });
        }
        if (c.tipo === "firmware" && (ritmo || !cabe) && !c.parado && !c.cortado && !servidor.destroyed) servidor.resume();
      });
    };
    servidor.on("data", (d) => {
      if (!cabecalhoPronto) {
        cabecalho = Buffer.concat([cabecalho, d]);
        const fim = cabecalho.indexOf("\r\n\r\n");
        if (fim < 0) return;
        cabecalhoPronto = true;
        let head = cabecalho.subarray(0, fim + 4);
        const resto = cabecalho.subarray(fim + 4);
        const declarado = /Content-Length: (\d+)/i.exec(head.toString("latin1"));
        if (declarado) c.tamanhoCorpo = Number(declarado[1]);
        if (c.tipo === "firmware" && this.firmware.tamanhoDeclarado !== undefined) {
          head = Buffer.from(head.toString("latin1").replace(/Content-Length: \d+/i, `Content-Length: ${this.firmware.tamanhoDeclarado}`), "latin1");
        }
        paraPlaca(head);
        d = resto;
        if (!d.length) return;
      }
      if (c.tipo === "firmware") return this.corpoDoFirmware(c, d, paraPlaca, cliente, servidor);
      if (c.tipo === "ws") {
        c.pendente = Buffer.concat([c.pendente, d]);
        let n;
        while ((n = tamanhoDoQuadro(c.pendente)) > 0) {
          const opcode = c.pendente[0] & 0x0f;
          if (opcode === 0x09) this.controles.push({ ms: Date.now(), tipo: "ping", conexao: c.id });
          let depois = null;
          if (opcode === 0x01 && this.aoQuadroDoServidor) {
            let len = c.pendente[1] & 0x7f;
            let off = 2;
            if (len === 126) { len = c.pendente.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(c.pendente.readBigUInt64BE(2)); off = 10; }
            depois = this.aoQuadroDoServidor(c.pendente.subarray(off, off + len).toString("utf8"), c);
          }
          paraPlaca(c.pendente.subarray(0, n));
          if (depois === "cortar") {
            // After the frame reached the board's socket buffer: the board gets it, its answer does not.
            this.modo = this.modoAposCorte || this.modo;
            enviandoPlaca.then(() => setTimeout(() => this.cortarTudo(), 20));
          }
          c.pendente = c.pendente.subarray(n);
          this.descarregarInjecoes(c);
        }
        return;
      }
      paraPlaca(d);
    });
    c.paraPlaca = paraPlaca;
  }

  corpoDoFirmware(c, d, paraPlaca, cliente, servidor) {
    const f = this.firmware;
    let bloco = Buffer.from(d);
    const inicio = c.corpoParaPlaca;
    if (c.cortado || c.parado) { servidor.pause(); return; }
    if (f.corromperByte !== undefined && f.corromperByte >= inicio && f.corromperByte < inicio + bloco.length) {
      bloco[f.corromperByte - inicio] ^= 0xff;
      c.corrompido = f.corromperByte;
    }
    let acao = null;
    for (const [limite, tipo] of [[f.cortarApos, "cortar"], [f.pararApos, "parar"]]) {
      if (limite === undefined || limite === null || acao) continue;
      if (inicio + bloco.length >= limite) {
        bloco = bloco.subarray(0, limite - inicio);
        acao = { tipo, limite };
        servidor.pause();
      }
    }
    c.corpoParaPlaca += bloco.length;
    const fim = c.corpoParaPlaca;
    paraPlaca(bloco, () => {
      if (!c.corpoInicioEm) c.corpoInicioEm = Date.now();
      if (c.tamanhoCorpo && fim >= c.tamanhoCorpo && !c.corpoCompletoEm) c.corpoCompletoEm = Date.now();
      if (!acao) return;
      if (acao.tipo === "cortar") { c.cortado = acao.limite; setImmediate(() => { cliente.destroy(); servidor.destroy(); }); }
      else c.parado = acao.limite;
    });
  }

  registrarDaPlaca(quadro, c) {
    const opcode = quadro[0] & 0x0f;
    if (opcode === 0x0a) this.controles.push({ ms: Date.now(), tipo: "pong", conexao: c.id });
    if (opcode !== 1) return;
    let len = quadro[1] & 0x7f;
    let off = 2;
    if (len === 126) { len = quadro.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(quadro.readBigUInt64BE(2)); off = 10; }
    const mascara = (quadro[1] & 0x80) ? quadro.subarray(off, off + 4) : null;
    if (mascara) off += 4;
    const payload = Buffer.from(quadro.subarray(off, off + len));
    if (mascara) for (let i = 0; i < payload.length; i++) payload[i] ^= mascara[i & 3];
    let mensagem = null;
    try { mensagem = JSON.parse(payload.toString("utf8")); } catch {}
    this.daPlaca.push({ ms: Date.now(), mensagem, texto: mensagem ? null : payload.toString("utf8").slice(0, 200) });
  }

  /**
   * Server pings forwarded to the board between `inicioMs` and `fimMs` (host time) and, for each, how
   * long the board took to answer (null when it never did). Pongs are paired with pings one to one, in
   * order, on the same connection, so a single late pong cannot stand for several pings.
   */
  pingsRespondidos(inicioMs, fimMs) {
    const pares = [];
    const abertos = new Map();
    for (const x of this.controles) {
      if (!abertos.has(x.conexao)) abertos.set(x.conexao, []);
      const fila = abertos.get(x.conexao);
      if (x.tipo === "ping") {
        const par = { ping: x.ms, respostaMs: null };
        fila.push(par);
        pares.push(par);
      } else if (fila.length) {
        const par = fila.shift();
        par.respostaMs = x.ms - par.ping;
      }
    }
    return pares.filter((p) => p.ping >= inicioMs && p.ping <= fimMs);
  }

  /** Messages the board sent after index `desde` that match `filtro` (an object of expected fields). */
  mensagensDaPlaca(filtro = {}, desde = 0) {
    return this.daPlaca.slice(desde).map((m) => m.mensagem).filter((m) => m && Object.entries(filtro).every(([k, v]) => (v instanceof RegExp ? v.test(String(m[k])) : m[k] === v)));
  }

  descarregarInjecoes(c) {
    while (this.injecoes.length) {
      const q = this.injecoes.shift();
      c.paraPlaca(q.bytes);
      q.entregue(c.id);
    }
  }

  /**
   * Queues a server-to-board frame on the live WebSocket, written at once when the stream is at a
   * frame boundary and otherwise right after the frame in transit.
   */
  injetar(bytes) {
    const promessa = new Promise((entregue) => this.injecoes.push({ bytes, entregue }));
    const ws = [...this.conexoes].reverse().find((c) => c.tipo === "ws" && !c.fim && c.paraPlaca);
    if (ws && ws.pendente && ws.pendente.length === 0) this.descarregarInjecoes(ws);
    return promessa;
  }

  injetarTexto(texto) {
    return this.injetar(quadroTexto(texto));
  }

  conexoesDo(tipo, desde = 0) {
    return this.conexoes.slice(desde).filter((c) => c.tipo === tipo);
  }

  /** Drops every live connection at once, as a switch reboot or a pulled cable would. */
  cortarTudo() {
    for (const s of this.vivas) s.destroy();
  }

  async encerrar() {
    this.cortarTudo();
    await new Promise((r) => this.servidor.close(() => r()));
  }
}

module.exports = { Intermediario, quadroTexto };
