const crypto = require("crypto");
const logger = require("../utils/logger");

// Optional mesh transport: boards that reach the server through a gateway board.
//
// The gateway is an ordinary board with its own credential and its own direct WebSocket; it relays
// frames for the boards behind it (an ESP-WIFI-MESH root or an ESP-NOW coordinator; the radio is
// the firmware's concern, remoteifes-esp32/MESH.md). The gateway is a courier, never an identity:
//
//  - each board proves itself with its own credential in a challenge-response the gateway cannot
//    answer (the key is derived from the board's secret; see esp32CredenciaisService.chaveMeshDe),
//    and the server proves itself back;
//  - after the handshake every frame is sealed with AES-256-GCM under a per-session key, with a
//    per-direction sequence number in the nonce: the gateway can drop or delay frames, but cannot
//    read them (credential rotation travels inside), forge them or replay them;
//  - route metadata sent by the gateway (parent, hops, RSSI) only feeds the topology view; it is
//    never used to authorize anything.
//
// Everything is bounded: nodes per gateway, pending handshakes, queued downlink frames per node,
// retransmissions, and the size of the topology cache. Nothing here is written to SQLite: the
// topology is an in-memory observation.

const VERSAO_PROTOCOLO = 1;
const MAX_NOS_POR_GATEWAY = 32;
const MAX_HANDSHAKES_PENDENTES = 8;
const HANDSHAKE_EXPIRA_MS = 15_000;
const MAX_FILA_POR_NO = 8;
const RETRANSMITIR_MS = 3_000;
const MAX_RETRANSMISSOES = 2;
const SEM_NOTICIAS_MS = 90_000;
const VARREDURA_MS = 15_000;
const MAX_NOS_OBSERVADOS = 256;
const MANTER_INALCANCAVEL_MS = 10 * 60 * 1000;
const RE_NO = /^esp_[0-9a-f]{16}$/;
const RE_B64 = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_CORPO_BYTES = 16 * 1024;

const DIRECAO = { servidor: 0x01, no: 0x02 };
// AES-GCM checks a shorter tag as a prefix of the real one unless the length is fixed, which would
// let a relaying gateway forge a frame with a 4-byte tag at 2^-32 odds. The firmware refuses any tag
// that is not 16 bytes; so does the server.
const TAG_BYTES = 16;

// deviceId -> observed node (topology + session).
const nos = new Map();
// gateway room -> { sala, deviceId, desde }
const gateways = new Map();
let varredura = null;

function hub() {
  return require("./deviceHub");
}

function credenciais() {
  return require("./esp32CredenciaisService");
}

function b64(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function hmac(chave, texto) {
  return crypto.createHmac("sha256", chave).update(texto).digest();
}

function iguais(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function nonceDe(direcao, seq) {
  const nonce = Buffer.alloc(12);
  nonce[0] = direcao;
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

function selar(chave, no, direcao, seq, payload) {
  const cifra = crypto.createCipheriv("aes-256-gcm", chave, nonceDe(direcao, seq));
  cifra.setAAD(Buffer.from(no));
  const dados = Buffer.concat([cifra.update(JSON.stringify(payload), "utf8"), cifra.final()]);
  return { t: "dados", seq, dados: b64(dados), tag: b64(cifra.getAuthTag()) };
}

function abrir(chave, no, direcao, quadro) {
  const tag = Buffer.from(quadro.tag, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error("tag de autenticação com tamanho inválido");
  const decifra = crypto.createDecipheriv("aes-256-gcm", chave, nonceDe(direcao, quadro.seq), { authTagLength: TAG_BYTES });
  decifra.setAAD(Buffer.from(no));
  decifra.setAuthTag(tag);
  const texto = Buffer.concat([decifra.update(Buffer.from(quadro.dados, "base64url")), decifra.final()]).toString("utf8");
  return JSON.parse(texto);
}

// --- Observation -------------------------------------------------------------------------------

function observar(deviceId) {
  let no = nos.get(deviceId);
  if (!no) {
    if (nos.size >= MAX_NOS_OBSERVADOS) podar(true);
    no = {
      deviceId,
      sala: null,
      gateway: null,
      gatewayDeviceId: null,
      pai: null,
      saltos: null,
      rssi: null,
      estado: "anunciado",
      desde: new Date().toISOString(),
      ultimaVez: Date.now(),
      // Last frame that proved the node itself (handshake or authenticated data). Session liveness
      // is measured from here; ultimaVez also moves with what the gateway reports about the node.
      ultimaProva: 0,
      mudancasDeRota: 0,
      ultimaMudancaRotaEm: null,
      entregas: { enviados: 0, confirmados: 0, falhas: 0 },
      rejeitados: 0,
      duplicados: 0,
      sessao: null,
      handshake: null,
      fila: [],
    };
    nos.set(deviceId, no);
  }
  return no;
}

function atualizarRota(no, rota) {
  if (!rota || typeof rota !== "object") return;
  const pai = typeof rota.pai === "string" && (RE_NO.test(rota.pai) || rota.pai === "gateway") ? rota.pai : null;
  const saltos = Number.isInteger(rota.saltos) && rota.saltos >= 1 && rota.saltos <= 15 ? rota.saltos : null;
  const rssi = typeof rota.rssi === "number" && rota.rssi >= -120 && rota.rssi <= 0 ? Math.round(rota.rssi) : null;
  if (no.pai !== null && (pai !== no.pai || (saltos !== null && saltos !== no.saltos))) {
    no.mudancasDeRota += 1;
    no.ultimaMudancaRotaEm = new Date().toISOString();
  }
  if (pai !== null) no.pai = pai;
  if (saltos !== null) no.saltos = saltos;
  if (rssi !== null) no.rssi = rssi;
  if (no.sessao) {
    const entrada = hub().conexaoDaSala(no.sala);
    if (entrada && entrada.mesh) Object.assign(entrada.mesh, { saltos: no.saltos, rssi: no.rssi, pai: no.pai });
  }
}

function podar(forcar = false) {
  const agora = Date.now();
  for (const [id, no] of nos) {
    const antigo = !no.sessao && agora - no.ultimaVez > MANTER_INALCANCAVEL_MS;
    if (antigo || (forcar && !no.sessao && no.estado !== "autenticando")) nos.delete(id);
    if (forcar && nos.size < MAX_NOS_OBSERVADOS) return;
  }
}

function enviarAoGateway(salaGateway, mensagem) {
  const entrada = hub().conexaoDaSala(salaGateway);
  if (!entrada || entrada.canal.transporte !== "direto" || !entrada.canal.aberto()) return false;
  try {
    return entrada.canal.enviar(mensagem) !== false;
  } catch (erro) {
    logger.warn("mesh-envio-gateway-falhou", { gateway: salaGateway, mensagem: erro.message });
    return false;
  }
}

// --- Gateway frames --------------------------------------------------------------------------

/**
 * Entry point for everything a gateway relays. `entradaGateway` is the gateway's own connection,
 * already authenticated by the device hub.
 */
function doGateway(salaGateway, entradaGateway, msg) {
  if (!entradaGateway.viaCredencial || !entradaGateway.deviceId) {
    // A board authenticated only by MAC has no key-based identity; it may not relay for others.
    logger.warn("mesh-gateway-sem-credencial", { gateway: salaGateway });
    return;
  }
  if (!gateways.has(salaGateway)) {
    gateways.set(salaGateway, { sala: salaGateway, deviceId: entradaGateway.deviceId, desde: new Date().toISOString() });
    iniciarVarredura();
  }
  const deviceId = msg.no;
  if (typeof deviceId !== "string" || !RE_NO.test(deviceId) || deviceId === entradaGateway.deviceId) return;

  if (msg.tipo === "mesh_evento") {
    const no = observar(deviceId);
    // Only the gateway a node's session goes through reports on it: another gateway announcing the
    // node starts a new handshake (a move), but does not rewrite the route of a working session.
    if (!no.sessao || no.gateway === salaGateway) {
      no.ultimaVez = Date.now();
      atualizarRota(no, msg.rota);
    }
    if (msg.evento === "entrou") iniciarHandshake(salaGateway, entradaGateway, no);
    else if (msg.evento === "saiu" && no.gateway === salaGateway) perderNo(no, "o gateway informou que o nó saiu da malha");
    return;
  }

  const quadro = msg.quadro;
  if (!quadro || typeof quadro !== "object") return;
  const no = nos.get(deviceId);
  if (!no) return;
  if (no.gateway !== salaGateway && quadro.t !== "ola") {
    // A frame for a session established through another gateway: moving a board between gateways
    // requires a new handshake.
    no.rejeitados += 1;
    return;
  }
  no.ultimaVez = Date.now();
  atualizarRota(no, msg.rota);
  if (quadro.t === "ola") concluirHandshake(salaGateway, entradaGateway, no, quadro);
  else if (quadro.t === "dados") receberDados(no, quadro);
}

function nosDoGatewayAtivos(salaGateway) {
  let n = 0;
  for (const no of nos.values()) if (no.gateway === salaGateway && (no.sessao || no.handshake)) n += 1;
  return n;
}

function iniciarHandshake(salaGateway, entradaGateway, no) {
  const agora = Date.now();
  // A node announcing again while its own challenge is pending is a retry, not one more handshake.
  const pendentes = Array.from(nos.values()).filter((n) => n !== no && n.handshake && n.gateway === salaGateway && n.handshake.expira > agora).length;
  if (pendentes >= MAX_HANDSHAKES_PENDENTES || (!no.sessao && nosDoGatewayAtivos(salaGateway) >= MAX_NOS_POR_GATEWAY)) {
    no.rejeitados += 1;
    enviarAoGateway(salaGateway, { tipo: "mesh_recusado", no: no.deviceId, motivo: "limite" });
    return;
  }
  const ns = b64(crypto.randomBytes(16));
  // The challenge this one replaces may already be answered and in flight (the node's announcement
  // was repeated or duplicated). Its answer is recognised as late instead of refused: a refusal
  // would make the node drop what it has and wait before announcing again.
  const anterior = no.handshake && no.handshake.gateway === salaGateway && no.handshake.expira > agora ? no.handshake : null;
  const superados = anterior ? [anterior.ns, ...anterior.superados].slice(0, 2) : [];
  no.handshake = { ns, superados, gateway: salaGateway, gatewayDeviceId: entradaGateway.deviceId, expira: agora + HANDSHAKE_EXPIRA_MS };
  if (!no.sessao) {
    no.gateway = salaGateway;
    no.gatewayDeviceId = entradaGateway.deviceId;
    no.estado = "autenticando";
  }
  enviarAoGateway(salaGateway, { tipo: "mesh", no: no.deviceId, v: VERSAO_PROTOCOLO, quadro: { t: "desafio", ns } });
}

function recusar(no, salaGateway, motivo) {
  no.rejeitados += 1;
  no.handshake = null;
  if (!no.sessao) no.estado = "recusado";
  enviarAoGateway(salaGateway, { tipo: "mesh_recusado", no: no.deviceId, motivo: "credencial" });
  logger.warn("mesh-no-recusado", { no: no.deviceId, gateway: salaGateway, motivo });
}

function concluirHandshake(salaGateway, entradaGateway, no, quadro) {
  const h = no.handshake;
  // The node holds a working session through this gateway: an answer arriving now is a copy of the
  // one that opened it (duplicated or delayed on the way) or a forgery. Neither may close the
  // session, and a refusal sent down would make the node drop it.
  const sessaoViva = !!no.sessao && no.gateway === salaGateway;
  const recusarTentativa = (motivo) => {
    if (!sessaoViva) return recusar(no, salaGateway, motivo);
    no.rejeitados += 1;
    no.handshake = null;
    logger.warn("mesh-no-tentativa-recusada-com-sessao", { no: no.deviceId, gateway: salaGateway, motivo });
  };
  if (!h || h.gateway !== salaGateway || h.expira < Date.now()) {
    if (sessaoViva) {
      no.duplicados += 1;
      return;
    }
    return recusar(no, salaGateway, "sem desafio válido");
  }
  if (typeof quadro.nn !== "string" || !RE_B64.test(quadro.nn) || typeof quadro.prova !== "string") {
    return recusarTentativa("resposta malformada");
  }
  const registro = credenciais().chavesMeshPara(no.deviceId);
  if (!registro || !registro.chaves.length) return recusarTentativa("sem chave de malha para esta credencial");
  const provaDe = (ns) => `ola|${no.deviceId}|${h.gatewayDeviceId}|${ns}|${quadro.nn}`;
  const texto = provaDe(h.ns);
  const usada = registro.chaves.find((c) => iguais(b64(hmac(c.chave, texto)), quadro.prova));
  if (!usada) {
    // A valid answer to a challenge the current one replaced: late, not wrong. The current
    // challenge stays open for the answer that is on its way.
    const tardia = h.superados.some((ns) => registro.chaves.some((c) => iguais(b64(hmac(c.chave, provaDe(ns))), quadro.prova)));
    if (tardia) {
      no.duplicados += 1;
      return;
    }
    return recusarTentativa("prova inválida");
  }
  if (usada.geracao === "pendente") credenciais().ativarPendentePorMesh(no.deviceId);
  credenciais().registrarUsoMesh(no.deviceId);

  const salaRow = require("./salasService").buscar(registro.sala);
  if (!salaRow) return recusar(no, salaGateway, "sala inexistente");

  no.handshake = null;
  const chaveSessao = hmac(usada.chave, `sessao|${h.ns}|${quadro.nn}`);
  const anterior = no.sessao;
  no.sessao = { chave: chaveSessao, seqEnvio: 0, seqRecebido: 0, iniciadaEm: new Date().toISOString() };
  no.ultimaProva = Date.now();
  no.fila = [];
  no.sala = registro.sala;
  no.gateway = salaGateway;
  no.gatewayDeviceId = h.gatewayDeviceId;
  no.estado = "conectado";

  enviarAoGateway(salaGateway, {
    tipo: "mesh",
    no: no.deviceId,
    v: VERSAO_PROTOCOLO,
    quadro: { t: "aceito", prova: b64(hmac(chaveSessao, `aceito|${no.deviceId}`)) },
  });

  // A session proven with the previous generation lives only until that generation's grace period
  // ends, as a direct connection does; a newer generation carries no deadline.
  const credencialGrace = usada.geracao === "anterior" ? usada.expiraEm || null : null;
  const entradaAtual = hub().conexaoDaSala(no.sala);
  const reaproveitavel = anterior && entradaAtual && entradaAtual.canal.transporte === "mesh" && entradaAtual.canal.deviceId === no.deviceId;
  if (reaproveitavel) {
    // Re-keyed session of an already connected board (a route change or a reboot of the node): the
    // logical device stays; the channel keeps pointing at the node. The re-key proved a generation
    // again, so the deadline follows it, and the credential delivery is the one a fresh connection
    // gets: a node back on the previous secret receives the current one again, otherwise a pending
    // rotation not yet delivered goes out.
    entradaAtual.mesh.gateway = salaGateway;
    entradaAtual.credencialExpiraEm = credencialGrace;
    if (credencialGrace) credenciais().reentregarAtual(no.sala);
    else credenciais().entregarPendente(no.sala);
    return;
  }
  hub().conectarDispositivo({
    sala: no.sala,
    mac: salaRow.mac || null,
    viaCredencial: true,
    deviceId: no.deviceId,
    ip: null,
    credencialGrace,
    canal: canalMesh(no),
    mesh: { gateway: salaGateway, saltos: no.saltos, rssi: no.rssi, pai: no.pai },
  });
  logger.info("mesh-no-autenticado", { no: no.deviceId, sala: no.sala, gateway: salaGateway, geracao: usada.geracao });
}

function receberDados(no, quadro) {
  if (!no.sessao) return;
  if (!Number.isInteger(quadro.seq) || quadro.seq < 1 || typeof quadro.dados !== "string" || typeof quadro.tag !== "string") {
    no.rejeitados += 1;
    return;
  }
  if (quadro.dados.length > (MAX_CORPO_BYTES * 4) / 3 + 4) {
    no.rejeitados += 1;
    return;
  }
  if (quadro.seq <= no.sessao.seqRecebido) {
    // Replay or duplicate delivery through the mesh: accepted at most once.
    no.duplicados += 1;
    return;
  }
  let payload;
  try {
    payload = abrir(no.sessao.chave, no.deviceId, DIRECAO.no, quadro);
  } catch {
    no.rejeitados += 1;
    return;
  }
  no.sessao.seqRecebido = quadro.seq;
  no.ultimaProva = Date.now();
  if (!payload || typeof payload.tipo !== "string") return;

  if (payload.tipo === "mesh_ack") {
    const confirmado = no.fila.find((f) => f.seq === payload.seq);
    if (confirmado) {
      no.fila = no.fila.filter((f) => f !== confirmado);
      no.entregas.confirmados += 1;
    }
    return;
  }

  const entrada = hub().conexaoDaSala(no.sala);
  if (!entrada || entrada.canal.transporte !== "mesh" || entrada.canal.deviceId !== no.deviceId) return;
  const salaAtual = require("./salasService").buscar(no.sala);
  if (!hub().vinculoValido(salaAtual, entrada)) {
    entrada.canal.fechar(4001, "vínculo do dispositivo alterado");
    return;
  }
  entrada.ultimaAtividadeEm = new Date().toISOString();
  hub().processarMensagem(no.sala, entrada, payload, salaAtual);
}

// --- Downlink --------------------------------------------------------------------------------

function transmitir(no, item) {
  item.tentativas += 1;
  item.ultimaTentativa = Date.now();
  const ok = enviarAoGateway(no.gateway, { tipo: "mesh", no: no.deviceId, v: VERSAO_PROTOCOLO, quadro: item.quadro });
  if (ok && item.tentativas === 1) no.entregas.enviados += 1;
  return ok;
}

/**
 * Seals and sends one payload to a node. True when the frame was handed to the gateway, which is
 * all a direct socket promises too; delivery to the node is confirmed separately by its ack.
 */
function enviarAoNo(no, payload) {
  if (!no.sessao || !gatewayAberto(no.gateway)) return false;
  // Only the newest desired state matters: an older one still waiting for its ack is superseded.
  if (payload && payload.tipo === "send_known_state") {
    no.fila = no.fila.filter((f) => f.tipo !== "send_known_state");
  }
  while (no.fila.length >= MAX_FILA_POR_NO) {
    no.fila.shift();
    no.entregas.falhas += 1;
  }
  no.sessao.seqEnvio += 1;
  const item = {
    seq: no.sessao.seqEnvio,
    tipo: payload && payload.tipo,
    quadro: selar(no.sessao.chave, no.deviceId, DIRECAO.servidor, no.sessao.seqEnvio, payload),
    tentativas: 0,
    ultimaTentativa: 0,
  };
  no.fila.push(item);
  return transmitir(no, item);
}

function gatewayAberto(salaGateway) {
  const entrada = salaGateway && hub().conexaoDaSala(salaGateway);
  return !!entrada && entrada.canal.transporte === "direto" && entrada.canal.aberto();
}

function canalMesh(no) {
  return {
    transporte: "mesh",
    deviceId: no.deviceId,
    aberto: () => !!no.sessao && gatewayAberto(no.gateway),
    enviar: (payload) => enviarAoNo(no, payload),
    fechar: (codigo, motivo) => encerrarSessao(no, codigo, motivo),
  };
}

function encerrarSessao(no, codigo = 1000, motivo = "") {
  const sala = no.sala;
  const entrada = sala ? hub().conexaoDaSala(sala) : null;
  if (no.sessao && no.gateway) {
    enviarAoGateway(no.gateway, { tipo: "mesh_recusado", no: no.deviceId, motivo: "encerrado" });
  }
  no.sessao = null;
  no.fila = [];
  no.estado = "inalcancavel";
  // Asynchronous, like a socket close: the device hub may be replacing this entry right now.
  if (entrada && entrada.canal.transporte === "mesh" && entrada.canal.deviceId === no.deviceId) {
    setImmediate(() => hub().desconectarDispositivo(sala, entrada, codigo, motivo));
  }
}

function perderNo(no, motivo) {
  if (no.sessao) logger.info("mesh-no-inalcancavel", { no: no.deviceId, sala: no.sala, motivo });
  encerrarSessao(no, 1001, motivo);
}

function aoDesconectarGateway(salaGateway) {
  if (!gateways.delete(salaGateway)) return;
  for (const no of nos.values()) {
    if (no.gateway === salaGateway) {
      no.handshake = null;
      perderNo(no, "o gateway se desconectou");
    }
  }
}

function varrer() {
  const agora = Date.now();
  for (const no of nos.values()) {
    if (no.handshake && no.handshake.expira < agora) {
      no.handshake = null;
      if (!no.sessao) no.estado = "inalcancavel";
    }
    if (!no.sessao) continue;
    if (agora - no.ultimaProva > SEM_NOTICIAS_MS) {
      perderNo(no, "sem notícias do nó pela malha");
      continue;
    }
    for (const item of [...no.fila]) {
      if (agora - item.ultimaTentativa < RETRANSMITIR_MS) continue;
      if (item.tentativas > MAX_RETRANSMISSOES) {
        no.fila = no.fila.filter((f) => f !== item);
        no.entregas.falhas += 1;
        continue;
      }
      transmitir(no, item);
    }
  }
  podar();
}

function iniciarVarredura() {
  if (varredura) return;
  varredura = setInterval(varrer, VARREDURA_MS);
  if (typeof varredura.unref === "function") varredura.unref();
}

function nosDoGateway(salaGateway) {
  let n = 0;
  for (const no of nos.values()) if (no.gateway === salaGateway && no.sessao) n += 1;
  return n;
}

// --- Topology --------------------------------------------------------------------------------

function topologia() {
  const conexoes = hub().listarConexoes();
  const diretos = conexoes
    .filter(([, e]) => e.canal.transporte === "direto")
    .map(([sala, e]) => ({
      sala,
      deviceId: e.deviceId,
      gateway: gateways.has(sala),
      rssi: e.wifiRssi,
      fwVersao: e.fwVersao,
      conectadoEm: e.conectadoEm,
      ultimaAtividadeEm: e.ultimaAtividadeEm,
      canalComandos: e.canal.aberto(),
    }));
  const lista = Array.from(nos.values()).map((no) => {
    const entrada = no.sala ? hub().conexaoDaSala(no.sala) : null;
    const viaMesh = entrada && entrada.canal.transporte === "mesh" && entrada.canal.deviceId === no.deviceId;
    return {
      deviceId: no.deviceId,
      sala: no.sala,
      gateway: no.gateway,
      pai: no.pai,
      saltos: no.saltos,
      rssi: no.rssi,
      estado: no.estado,
      ultimaVez: new Date(no.ultimaVez).toISOString(),
      mudancasDeRota: no.mudancasDeRota,
      ultimaMudancaRotaEm: no.ultimaMudancaRotaEm,
      entregas: { ...no.entregas, pendentes: no.fila.length },
      rejeitados: no.rejeitados,
      duplicados: no.duplicados,
      fwVersao: viaMesh ? entrada.fwVersao : null,
      canalComandos: viaMesh ? entrada.canal.aberto() : false,
    };
  });
  return {
    geradoEm: new Date().toISOString(),
    meshEmUso: gateways.size > 0 || lista.length > 0,
    diretos,
    gateways: Array.from(gateways.values()).map((g) => ({ ...g, nos: nosDoGateway(g.sala) })),
    nos: lista,
    limites: { nosPorGateway: MAX_NOS_POR_GATEWAY, filaPorNo: MAX_FILA_POR_NO, semNoticiasS: SEM_NOTICIAS_MS / 1000 },
  };
}

function encerrar() {
  if (varredura) clearInterval(varredura);
  varredura = null;
  nos.clear();
  gateways.clear();
}

module.exports = {
  doGateway,
  aoDesconectarGateway,
  nosDoGateway,
  topologia,
  encerrar,
  varrer,
  // Exposed for protocol tests and for a reference node implementation.
  protocolo: { VERSAO_PROTOCOLO, DIRECAO, selar, abrir, hmac, b64 },
};
