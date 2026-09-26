const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "test";
const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-malha-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");

const crypto = require("crypto");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const deviceHub = require("../src/services/deviceHub");
const meshService = require("../src/services/meshService");
const credenciais = require("../src/services/esp32CredenciaisService");
const salasService = require("../src/services/salasService");
const { Bancada } = require("./support/bancada-dispositivos");
const { NoDeReferencia, DIRECAO } = require("./support/mesh-reference");

// The mesh protocol above the radio, under topology churn, authentication edge cases, tampered
// frames, its bounds, and a gateway that behaves badly. Gateways and nodes are simulated
// (support/bancada-dispositivos.js, support/mesh-reference.js); no ESP-WIFI-MESH radio, range,
// root election or RF timing is involved, and none of this is evidence about them (MESH.md).

let server;
let porta;
let sequencia = 0;

function novaSala() {
  sequencia += 1;
  const sala = `MA-${sequencia}`;
  const mac = `AA:A0:${[(sequencia >> 8) & 255, sequencia & 255, 0, 1].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":")}`;
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo, mac, irProtocolo) VALUES (?, ?, 'M', 1, 0, 24, 0, ?, 16)").run(sala, sala, mac);
  const c = credenciais.provisionar(sala);
  return { sala, mac, credencial: { deviceId: c.deviceId, segredo: c.segredo } };
}

function ate(condicao, { limiteMs = 4000, descricao = "condição" } = {}) {
  return new Promise((resolve, reject) => {
    const verificar = () => {
      let v;
      try {
        v = condicao();
      } catch {
        v = false;
      }
      if (!v) return;
      fim();
      resolve(v);
    };
    const fim = () => {
      clearInterval(poll);
      clearTimeout(timer);
      deviceHub.eventos.off("conexao", verificar);
    };
    deviceHub.eventos.on("conexao", verificar);
    const poll = setInterval(verificar, 15);
    const timer = setTimeout(() => {
      fim();
      reject(new Error(`tempo esgotado aguardando ${descricao}`));
    }, limiteMs);
    verificar();
  });
}

const topo = (deviceId) => meshService.topologia().nos.find((n) => n.deviceId === deviceId);
const conectada = (sala) => ate(() => deviceHub.estadoPublico(sala).conectado, { descricao: `${sala} conectada` });
const desconectada = (sala) => ate(() => !deviceHub.estadoPublico(sala).conectado, { descricao: `${sala} desconectada` });
const comandosLocais = (sala) => db.prepare("SELECT cmd FROM comandos_log WHERE sala = ? AND origem = 'esp32_local'").all(sala).map((r) => r.cmd);

/** A gateway with `n` nodes, each already authenticated at both ends. */
async function malha(b, n = 1, { anunciar = true } = {}) {
  const gw = novaSala();
  const gateway = b.gateway({ credencial: gw.credencial, mac: gw.mac });
  await gateway.conectar();
  const nos = Array.from({ length: n }, () => {
    const s = novaSala();
    return { ...s, ref: gateway.no({ deviceId: s.credencial.deviceId, segredo: s.credencial.segredo }) };
  });
  if (anunciar) {
    for (const no of nos) gateway.anunciar(no.ref);
    await ate(() => nos.every((no) => no.ref.sessao && deviceHub.canalDeComandos(no.sala)), { descricao: "sessões nas duas pontas" });
  }
  return { gw, gateway, nos };
}

/** Hands a message to the mesh service as if it arrived on the gateway's socket, synchronously. */
function doGatewayAgora(gw, msg) {
  meshService.doGateway(gw.sala, deviceHub.conexaoDaSala(gw.sala), msg);
}

/** Advances the clock seen by the server for one synchronous call. */
function comRelogio(t, deslocamentoMs, fn) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + deslocamentoMs });
  try {
    return fn();
  } finally {
    t.mock.timers.reset();
  }
}

async function subirServidor(portaFixa = 0) {
  server = http.createServer(app);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(portaFixa, "127.0.0.1", resolve));
  porta = server.address().port;
}

async function derrubarServidor() {
  deviceHub.encerrar();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function bancada(t) {
  const b = new Bancada({ porta });
  t.after(() => b.encerrar());
  return b;
}

test.before(() => subirServidor());
test.after(async () => {
  await derrubarServidor();
  meshService.encerrar();
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

// --- Topology ----------------------------------------------------------------------------------

test("several gateways with several nodes; a node that moves re-authenticates and its old path is refused", async (t) => {
  const b = bancada(t);
  const a = await malha(b, 3);
  const c = await malha(b, 3);
  assert.equal(meshService.topologia().gateways.length >= 2, true);
  for (const no of [...a.nos, ...c.nos]) assert.equal(deviceHub.estadoPublico(no.sala).transporte, "mesh");

  // The first node of A reappears behind C (a parent change across gateways).
  const movido = a.nos[0];
  const antigo = movido.ref;
  const novo = c.gateway.no({ deviceId: movido.credencial.deviceId, segredo: movido.credencial.segredo });
  c.gateway.anunciar(novo);
  await ate(() => novo.sessao && deviceHub.estadoPublico(movido.sala).mesh?.gateway === c.gw.sala, { descricao: "node behind the new gateway" });

  // A frame sealed under the old session and relayed by the old gateway is not processed.
  const rejeitadosAntes = topo(movido.credencial.deviceId).rejeitados;
  a.gateway.doNo(antigo, { tipo: "comando", cmd: "pelo-caminho-antigo", valor: 1 });
  await ate(() => topo(movido.credencial.deviceId).rejeitados > rejeitadosAntes);
  c.gateway.doNo(novo, { tipo: "comando", cmd: "pelo-caminho-novo", valor: 1 });
  await ate(() => comandosLocais(movido.sala).includes("pelo-caminho-novo"));
  assert.ok(!comandosLocais(movido.sala).includes("pelo-caminho-antigo"));
});

test("hop counts up to the protocol bound are kept; values outside it are ignored", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1);
  const id = nos[0].credencial.deviceId;
  gateway.doNo(nos[0].ref, { tipo: "telemetria", temp: 21 }, { rota: { pai: "esp_00000000000000cc", saltos: 15, rssi: -90 } });
  await ate(() => topo(id).saltos === 15);
  gateway.doNo(nos[0].ref, { tipo: "telemetria", temp: 21 }, { rota: { pai: "esp_00000000000000cc", saltos: 16, rssi: -91 } });
  gateway.doNo(nos[0].ref, { tipo: "telemetria", temp: 21 }, { rota: { pai: "esp_00000000000000cc", saltos: 0, rssi: -92 } });
  await ate(() => topo(id).rssi === -92);
  assert.equal(topo(id).saltos, 15);
});

test("duplicate announcements keep a single node, and a restarted node re-keys without going offline", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1);
  const [no] = nos;
  let quedas = 0;
  const contar = (e) => {
    if (e.sala === no.sala && !e.conectado) quedas += 1;
  };
  deviceHub.eventos.on("conexao", contar);
  t.after(() => deviceHub.eventos.off("conexao", contar));

  // The node reboots: new random nonces, same credential. Its old session key must stop working.
  const reiniciado = gateway.no({ deviceId: no.credencial.deviceId, segredo: no.credencial.segredo });
  const antigo = no.ref;
  gateway.anunciar(reiniciado);
  gateway.anunciar(reiniciado);
  await ate(() => reiniciado.sessao);
  assert.equal(meshService.topologia().nos.filter((n) => n.deviceId === no.credencial.deviceId).length, 1);
  assert.equal(quedas, 0, "the logical device stays connected across the re-key");
  const rejeitados = topo(no.credencial.deviceId).rejeitados;
  const quadro = antigo.selar({ tipo: "comando", cmd: "chave-antiga", valor: 1 });
  gateway.enviar({ tipo: "mesh", no: no.credencial.deviceId, quadro, rota: gateway.rota });
  await ate(() => topo(no.credencial.deviceId).rejeitados > rejeitados);
  assert.ok(!comandosLocais(no.sala).includes("chave-antiga"));
});

test("a gateway restart takes its nodes offline until it announces them again", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 2);
  gateway.reconexao = { atrasoMs: 50 };
  gateway.on("aberta", () => nos.forEach((n) => gateway.anunciar(n.ref)));
  gateway.derrubar();
  await Promise.all(nos.map((n) => desconectada(n.sala)));
  await Promise.all(nos.map((n) => conectada(n.sala)));
  await ate(() => nos.every((n) => deviceHub.estadoPublico(n.sala).transporte === "mesh"));
});

test("a server restart drops every mesh session and rebuilds them from new handshakes", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 2);
  gateway.reconexao = { atrasoMs: 50 };
  gateway.on("aberta", () => nos.forEach((n) => gateway.anunciar(n.ref)));
  const chavesAntes = nos.map((n) => n.ref.sessao.chave.toString("hex"));
  const portaAtual = porta;
  await derrubarServidor();
  assert.equal(meshService.topologia().nos.length, 0, "no mesh state survives the stop");
  await subirServidor(portaAtual);
  await Promise.all(nos.map((n) => conectada(n.sala)));
  await ate(() => nos.every((n, i) => n.ref.sessao && n.ref.sessao.chave.toString("hex") !== chavesAntes[i]), { descricao: "new session keys" });
});

// --- Authentication ------------------------------------------------------------------------------

test("unknown, wrong and revoked identities are refused, and revocation ends a live mesh session", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1);
  const desconhecido = gateway.no({ deviceId: "esp_00000000deadbeef", segredo: "segredo-de-quem-nao-existe-0000000" });
  gateway.anunciar(desconhecido);
  await ate(() => desconhecido.recusado === "credencial");

  const [no] = nos;
  const fechou = desconectada(no.sala);
  credenciais.revogar(no.sala);
  await fechou;
  const deNovo = gateway.no({ deviceId: no.credencial.deviceId, segredo: no.credencial.segredo });
  gateway.anunciar(deNovo);
  await ate(() => deNovo.recusado === "credencial");
  assert.equal(deviceHub.estadoPublico(no.sala).conectado, false);
});

test("credential generations over the mesh: only the pending key's proof activates it; the previous one works during grace only", async (t) => {
  const b = bancada(t);
  const { gw, gateway, nos } = await malha(b, 1);
  const [no] = nos;
  const rotacao = credenciais.rotacionar(no.sala);
  await ate(() => no.ref.novoSegredo === rotacao.segredo, { descricao: "sealed rotation received" });
  assert.equal(credenciais.estado(no.sala).rotacaoPendente, true);

  // The gateway, which never saw the new secret, cannot prove it. The node's live session is kept,
  // and no refusal goes down to it (a refusal would make the real node drop that session).
  const id = no.credencial.deviceId;
  const rejeitadosAntes = topo(id).rejeitados;
  const forjado = gateway.no({ deviceId: id, segredo: "o-gateway-inventou-este-segredo-000" });
  gateway.anunciar(forjado);
  await ate(() => topo(id).rejeitados > rejeitadosAntes, { descricao: "forged proof rejected" });
  assert.equal(forjado.sessao, null);
  assert.equal(credenciais.estado(no.sala).rotacaoPendente, true, "a refused proof activates nothing");
  assert.equal(deviceHub.estadoPublico(no.sala).conectado, true);

  const comNovo = gateway.no({ deviceId: no.credencial.deviceId, segredo: rotacao.segredo });
  gateway.anunciar(comNovo);
  await ate(() => comNovo.sessao && credenciais.estado(no.sala).rotacaoPendente === false, { descricao: "pending activated by proof" });

  const comAnterior = gateway.no({ deviceId: no.credencial.deviceId, segredo: no.credencial.segredo });
  gateway.anunciar(comAnterior);
  await ate(() => comAnterior.sessao, { descricao: "previous generation during grace" });

  db.prepare("UPDATE esp_credenciais SET anteriorExpiraEm = datetime('now', '-1 minute') WHERE sala = ?").run(no.sala);
  const rejeitadosDepois = topo(id).rejeitados;
  const vencido = gateway.no({ deviceId: id, segredo: no.credencial.segredo });
  gateway.anunciar(vencido);
  await ate(() => topo(id).rejeitados > rejeitadosDepois, { descricao: "previous generation refused after grace" });
  assert.equal(vencido.sessao, null);
  // Without a live session the same proof is refused explicitly.
  const fechou = desconectada(no.sala);
  meshService.doGateway(gw.sala, deviceHub.conexaoDaSala(gw.sala), { tipo: "mesh_evento", evento: "saiu", no: id });
  await fechou;
  const semSessao = gateway.no({ deviceId: id, segredo: no.credencial.segredo });
  gateway.anunciar(semSessao);
  await ate(() => semSessao.recusado === "credencial");
});

test("an expired challenge is refused", async (t) => {
  const b = bancada(t);
  const { gw, gateway, nos } = await malha(b, 1, { anunciar: false });
  const [no] = nos;
  no.ref.mudo = true;
  gateway.anunciar(no.ref);
  const desafio = await gateway.aguardar((m) => m.tipo === "mesh" && m.no === no.credencial.deviceId && m.quadro.t === "desafio");
  const [ola] = no.ref.receber(desafio.quadro);
  // The answer arrives after the 15 s validity; the server's clock is moved, not waited for.
  comRelogio(t, 16_000, () => doGatewayAgora(gw, { tipo: "mesh", no: no.credencial.deviceId, quadro: ola, rota: gateway.rota }));
  assert.equal(topo(no.credencial.deviceId).estado, "recusado");
  assert.equal(deviceHub.estadoPublico(no.sala).conectado, false);
});

test("a proof relayed through a different gateway than the one challenged is refused", async (t) => {
  const b = bancada(t);
  const a = await malha(b, 1, { anunciar: false });
  const c = await malha(b, 0);
  const [no] = a.nos;
  no.ref.mudo = true;
  a.gateway.anunciar(no.ref);
  const desafio = await a.gateway.aguardar((m) => m.tipo === "mesh" && m.no === no.credencial.deviceId && m.quadro.t === "desafio");
  const [ola] = no.ref.receber(desafio.quadro);
  // Gateway C presents A's challenge answer as its own.
  c.gateway.enviar({ tipo: "mesh", no: no.credencial.deviceId, quadro: ola, rota: c.gateway.rota });
  await ate(() => topo(no.credencial.deviceId).rejeitados >= 1);
  assert.equal(deviceHub.estadoPublico(no.sala).conectado, false);
});

test("a duplicated or late answer after a successful handshake does not tear the session down", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1, { anunciar: false });
  const [no] = nos;
  // Every uplink frame arrives twice, the handshake answer included.
  gateway.relay.duplicar = true;
  gateway.anunciar(no.ref);
  await ate(() => no.ref.sessao && deviceHub.canalDeComandos(no.sala));
  await gateway.drenar();
  // A copy relayed again later, after the session exists.
  const ola = gateway.capturados.find((c) => c.no === no.credencial.deviceId && c.quadro.t === "ola");
  gateway.relay.duplicar = false;
  gateway.reenviar(no.ref, ola.quadro);
  gateway.doNo(no.ref, { tipo: "comando", cmd: "depois-da-copia", valor: 1 });
  await ate(() => comandosLocais(no.sala).includes("depois-da-copia"));
  // A refusal would make the real node drop its session and wait 30 s before announcing again.
  assert.ok(!gateway.recusas.some((r) => r.no === no.credencial.deviceId), "no refusal reached the node");
  assert.ok(!no.ref.recusado);
  assert.ok(topo(no.credencial.deviceId).duplicados >= 1, "the extra answers are counted as duplicates");
});

test("an answer to a superseded challenge does not refuse the current handshake", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1, { anunciar: false });
  const [no] = nos;
  no.ref.mudo = true;
  gateway.anunciar(no.ref);
  const primeiro = await gateway.aguardar((m) => m.tipo === "mesh" && m.no === no.credencial.deviceId && m.quadro.t === "desafio");
  // The node announces again (its retry fired) before the first answer arrives.
  const marca = gateway.totalRecebidas;
  gateway.anunciar(no.ref);
  const segundo = await gateway.aguardar((m) => m.tipo === "mesh" && m.no === no.credencial.deviceId && m.quadro.t === "desafio", { desde: marca });
  assert.notEqual(primeiro.quadro.ns, segundo.quadro.ns);
  const velho = new NoDeReferencia({ deviceId: no.credencial.deviceId, segredo: no.credencial.segredo, gatewayDeviceId: gateway.credencial.deviceId });
  const [olaVelho] = velho.receber(primeiro.quadro);
  gateway.enviar({ tipo: "mesh", no: no.credencial.deviceId, quadro: olaVelho, rota: gateway.rota });
  // Now the node answers the current challenge.
  no.ref.mudo = false;
  const [olaAtual] = no.ref.receber(segundo.quadro);
  gateway.enviar({ tipo: "mesh", no: no.credencial.deviceId, quadro: olaAtual, rota: gateway.rota });
  await ate(() => no.ref.sessao && deviceHub.canalDeComandos(no.sala), { descricao: "handshake completed with the current challenge" });
  assert.ok(!gateway.recusas.some((r) => r.no === no.credencial.deviceId));
});

// --- Frame security --------------------------------------------------------------------------

function selarBruto(chave, deviceId, direcao, seq, bytes) {
  const nonce = Buffer.alloc(12);
  nonce[0] = direcao;
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  const cifra = crypto.createCipheriv("aes-256-gcm", chave, nonce);
  cifra.setAAD(Buffer.from(deviceId));
  const dados = Buffer.concat([cifra.update(bytes), cifra.final()]);
  return { t: "dados", seq, dados: dados.toString("base64url"), tag: cifra.getAuthTag().toString("base64url") };
}

test("tampered, truncated, malformed, oversized and reflected frames are rejected and never processed", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1);
  const [no] = nos;
  const id = no.credencial.deviceId;
  const enviarQuadro = (quadro) => gateway.enviar({ tipo: "mesh", no: id, quadro, rota: gateway.rota });
  const base = () => no.ref.selar({ tipo: "comando", cmd: "adulterado", valor: 1 });
  const trocar = (texto) => (texto[0] === "A" ? "B" : "A") + texto.slice(1);

  const casos = [];
  let q = base();
  casos.push({ ...q, tag: trocar(q.tag) }); // tag
  q = base();
  casos.push({ ...q, dados: trocar(q.dados) }); // ciphertext
  q = base();
  casos.push({ ...q, dados: q.dados.slice(0, Math.floor(q.dados.length / 2)) }); // truncated
  q = base();
  casos.push({ t: "dados", seq: q.seq, dados: q.dados }); // no tag
  casos.push({ t: "dados", seq: 0, dados: base().dados, tag: base().tag }); // invalid sequence
  casos.push({ t: "dados", seq: -3, dados: base().dados, tag: base().tag });
  casos.push({ t: "dados", seq: 7.5, dados: base().dados, tag: base().tag });
  casos.push({ t: "dados", seq: "9", dados: base().dados, tag: base().tag });
  casos.push({ t: "dados", seq: 10 ** 6, dados: "A".repeat(30_000), tag: base().tag }); // oversized
  // Authentic encryption of something that is not a message.
  no.ref.sessao.seqEnvio += 1;
  casos.push(selarBruto(no.ref.sessao.chave, id, DIRECAO.no, no.ref.sessao.seqEnvio, Buffer.from("isto não é json")));
  // A server-to-node frame reflected back upstream: same key, other direction.
  const descida = gateway.recebidas.filter((m) => m.tipo === "mesh" && m.no === id && m.quadro.t === "dados").at(-1);
  casos.push(descida.quadro);

  const antes = topo(id);
  for (const quadro of casos) enviarQuadro(quadro);
  await ate(() => topo(id).rejeitados + topo(id).duplicados >= antes.rejeitados + antes.duplicados + casos.length - 1, { descricao: "every bad frame counted" });
  assert.ok(!comandosLocais(no.sala).includes("adulterado"));
  // The session still works afterwards.
  gateway.doNo(no.ref, { tipo: "comando", cmd: "valido", valor: 1 });
  await ate(() => comandosLocais(no.sala).includes("valido"));
});

test("replayed, duplicated and old sequence numbers are counted and processed at most once", async (t) => {
  const b = bancada(t);
  const { gateway, nos } = await malha(b, 1);
  const [no] = nos;
  const id = no.credencial.deviceId;
  const primeiro = gateway.doNo(no.ref, { tipo: "comando", cmd: "primeiro", valor: 1 });
  const segundo = gateway.doNo(no.ref, { tipo: "comando", cmd: "segundo", valor: 1 });
  await ate(() => comandosLocais(no.sala).includes("segundo"));
  const dup = topo(id).duplicados;
  gateway.reenviar(no.ref, segundo);
  gateway.reenviar(no.ref, primeiro); // older than the last accepted
  await ate(() => topo(id).duplicados === dup + 2);
  assert.deepEqual(comandosLocais(no.sala).filter((c) => c === "primeiro" || c === "segundo"), ["primeiro", "segundo"]);
});

// --- Limits and cleanup ----------------------------------------------------------------------

test("pending handshakes per gateway are bounded", async (t) => {
  const b = bancada(t);
  const { gateway } = await malha(b, 0);
  const ids = Array.from({ length: 12 }, (_, i) => `esp_${(0xa000 + i).toString(16).padStart(16, "0")}`);
  for (const deviceId of ids) {
    const no = gateway.no({ deviceId, segredo: "segredo-qualquer-com-tamanho-valido" });
    no.mudo = true;
    gateway.anunciar(no);
  }
  await ate(() => gateway.recusas.filter((r) => r.motivo === "limite").length === 4, { descricao: "four refused by the bound" });
  const desafios = gateway.recebidas.filter((m) => m.tipo === "mesh" && m.quadro.t === "desafio" && ids.includes(m.no));
  assert.equal(desafios.length, 8);
});

test("authenticated nodes per gateway are bounded at 32", async (t) => {
  const b = bancada(t);
  const { gw, gateway, nos } = await malha(b, 33, { anunciar: false });
  // At most eight handshakes are pending per gateway, so the nodes join in groups of eight.
  for (let i = 0; i < 32; i += 8) {
    const grupo = nos.slice(i, i + 8);
    for (const no of grupo) gateway.anunciar(no.ref);
    await ate(() => grupo.every((n) => n.ref.sessao), { descricao: `nodes ${i + 1}-${i + 8}` });
  }
  gateway.anunciar(nos[32].ref);
  await ate(() => gateway.recusas.some((r) => r.no === nos[32].credencial.deviceId && r.motivo === "limite"));
  assert.equal(meshService.nosDoGateway(gw.sala), 32);
});

test("the topology cache stays bounded under a flood of announcements", async (t) => {
  const b = bancada(t);
  const gateways = [];
  for (let g = 0; g < 3; g += 1) gateways.push((await malha(b, 0)).gateway);
  let n = 0;
  for (const gateway of gateways) {
    // Under the gateway's message budget (120 per 10 s without nodes).
    for (let i = 0; i < 100; i += 1) gateway.anunciar({ deviceId: `esp_${(0xf0000 + n++).toString(16).padStart(16, "0")}`, rota: null });
  }
  // Eight challenges per gateway at most; every other announcement is refused by the bound.
  await ate(() => gateways.every((g) => g.recusas.filter((r) => r.motivo === "limite").length === 92), { descricao: "every announcement handled" });
  assert.ok(gateways.every((g) => g.aberta()), "announcements under the budget do not close the gateway");
  const topologia = meshService.topologia();
  assert.ok(topologia.nos.length <= 256 + 3 * 8, `observed nodes stay near the 256 bound (${topologia.nos.length})`);
});

test("a node that stops sending authenticated frames goes unreachable even if its gateway keeps relaying for it", async (t) => {
  const b = bancada(t);
  const { gw, nos } = await malha(b, 1);
  const [no] = nos;
  const id = no.credencial.deviceId;
  // The board is gone. For two minutes the gateway (faulty or hostile) keeps relaying frames that do
  // not authenticate, and events, in its name. None of that is news from the node.
  const lixo = (seq) => ({ tipo: "mesh", no: id, quadro: { t: "dados", seq, dados: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA" }, rota: { pai: "gateway", saltos: 1, rssi: -50 } });
  comRelogio(t, 60_000, () => {
    doGatewayAgora(gw, lixo(999));
    doGatewayAgora(gw, { tipo: "mesh_evento", evento: "rota", no: id, rota: { pai: "gateway", saltos: 1, rssi: -50 } });
  });
  comRelogio(t, 120_000, () => doGatewayAgora(gw, lixo(1000)));
  assert.equal(topo(id).estado, "conectado");
  // 130 s after the node's last authenticated frame, beyond the 90 s limit.
  comRelogio(t, 130_000, () => meshService.varrer());
  await desconectada(no.sala);
  assert.equal(topo(id).estado, "inalcancavel");
});

test("a gateway cannot rewrite the route of a node it does not serve", async (t) => {
  const b = bancada(t);
  const a = await malha(b, 1);
  const c = await malha(b, 0);
  const [no] = a.nos;
  const id = no.credencial.deviceId;
  a.gateway.doNo(no.ref, { tipo: "telemetria", temp: 22 }, { rota: { pai: "gateway", saltos: 2, rssi: -61 } });
  await ate(() => topo(id).saltos === 2);
  const forjada = { pai: "esp_00000000000000ee", saltos: 9, rssi: -99 };
  doGatewayAgora(c.gw, { tipo: "mesh_evento", evento: "rota", no: id, rota: forjada });
  doGatewayAgora(c.gw, { tipo: "mesh_evento", evento: "saiu", no: id, rota: forjada });
  doGatewayAgora(c.gw, { tipo: "mesh", no: id, quadro: { t: "dados", seq: 50, dados: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA" }, rota: forjada });
  const visto = topo(id);
  assert.deepEqual([visto.pai, visto.saltos, visto.rssi, visto.estado], ["gateway", 2, -61, "conectado"]);
  assert.equal(deviceHub.estadoPublico(no.sala).conectado, true);
  assert.equal(deviceHub.estadoPublico(no.sala).mesh.gateway, a.gw.sala);
});

test("OTA stays unavailable over the mesh", async (t) => {
  const b = bancada(t);
  const { nos } = await malha(b, 1);
  assert.throws(() => require("../src/services/otaService").ofertar(nos[0].sala), (e) => e.transporte === "mesh");
  assert.equal(salasService.buscar(nos[0].sala).sala, nos[0].sala);
});
