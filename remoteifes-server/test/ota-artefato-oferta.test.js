const fs = require("fs");
const os = require("os");
const path = require("path");

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-artefato-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const otaService = require("../src/services/otaService");

let server;
let baseUrl;
let wsUrl;
const sockets = new Set();

function criarBin(semente, bytes = 128 * 1024) {
  const buf = Buffer.alloc(bytes, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = (i * semente) % 251;
  const alvo = path.join(RAIZ_TMP, `origem-${semente}-${bytes}.bin`);
  fs.writeFileSync(alvo, buf);
  return { origem: alvo, bytes: buf };
}

function sala(codigo, mac) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(codigo, codigo, mac);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await espera(10);
  return condicao();
}

async function placa(codigo, mac, fw = "4.0.0") {
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": codigo, "x-device-mac": mac } });
  sockets.add(ws);
  ws.once("close", () => sockets.delete(ws));
  const mensagens = [];
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ tipo: "info", fw, failsafeConfigurado: false, failsafeLatched: false }));
  await ate(() => deviceHub.estadoPublico(codigo).fwVersao === fw);
  return {
    ws,
    ofertas: () => mensagens.filter((m) => m.tipo === "ota_oferta"),
    enviar: (m) => ws.send(JSON.stringify(m)),
    fechar: async () => { ws.close(); await ate(() => !deviceHub.estadoPublico(codigo).conectado); },
  };
}

async function baixar(codigo, mac) {
  const resp = await fetch(`${baseUrl}/dispositivo/firmware?sala=${codigo}`, { headers: { "x-device-mac": mac } });
  const corpo = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, corpo, versao: resp.headers.get("x-firmware-versao"), sha256: resp.headers.get("x-firmware-sha256"), tamanho: resp.headers.get("content-length") };
}

function bins() {
  return fs.readdirSync(otaService.DIR_FIRMWARE).filter((n) => n.startsWith("firmware-") && n.endsWith(".bin")).sort();
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of sockets) {
    try { ws.terminate(); } catch {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("an offer's download returns exactly the offered artifact, even after other firmware is published", async () => {
  sala("ART-1", "AA:BB:CC:AA:00:01");
  sala("ART-2", "AA:BB:CC:AA:00:02");
  const a = criarBin(3);
  const b = criarBin(7, 160 * 1024);
  const manifestoA = otaService.publicarFirmware({ origem: a.origem, versao: "4.1.0", notas: "A" });
  const placaA = await placa("ART-1", "AA:BB:CC:AA:00:01");
  const oferta = otaService.ofertar("ART-1");
  assert.equal(oferta.fase, "ofertado");
  assert.equal(oferta.sha256, manifestoA.sha256);
  assert.ok(await ate(() => placaA.ofertas().length === 1));

  const manifestoB = otaService.publicarFirmware({ origem: b.origem, versao: "4.2.0", notas: "B" });
  assert.deepEqual(bins(), ["firmware-4.1.0.bin", "firmware-4.2.0.bin"], "o artefato A continua no disco enquanto a oferta estiver ativa");
  assert.equal(otaService.lerManifesto().versao, "4.2.0", "o publicado passa a ser B");

  const download = await baixar("ART-1", "AA:BB:CC:AA:00:01");
  assert.equal(download.status, 200);
  assert.equal(download.versao, "4.1.0");
  assert.equal(download.sha256, manifestoA.sha256);
  assert.equal(download.tamanho, String(manifestoA.tamanho));
  assert.ok(download.corpo.equals(a.bytes), "bytes idênticos aos ofertados");

  placaA.enviar({ tipo: "ota_progresso", recebido: 65536, total: manifestoA.tamanho });
  await ate(() => otaService.estadoDaSala("ART-1").fase === "baixando");
  const deNovo = await baixar("ART-1", "AA:BB:CC:AA:00:01");
  assert.equal(deNovo.sha256, manifestoA.sha256, "uma retomada durante o download continua no mesmo artefato");

  const placaB = await placa("ART-2", "AA:BB:CC:AA:00:02");
  const ofertaB = otaService.ofertar("ART-2");
  assert.equal(ofertaB.versao, "4.2.0");
  assert.equal(ofertaB.sha256, manifestoB.sha256);
  assert.ok(await ate(() => placaB.ofertas().length === 1));
  assert.equal(placaB.ofertas()[0].sha256, manifestoB.sha256, "ofertas novas recebem B");
  const downloadB = await baixar("ART-2", "AA:BB:CC:AA:00:02");
  assert.equal(downloadB.versao, "4.2.0");
  assert.ok(downloadB.corpo.equals(b.bytes));

  placaA.enviar({ tipo: "ota_resultado", resultado: "ok" });
  await ate(() => otaService.estadoDaSala("ART-1").fase === "gravado");
  otaService.verificarTimeouts();
  assert.deepEqual(bins(), ["firmware-4.2.0.bin"], "gravado o firmware, o artefato A deixa de ser necessário e é removido");
  assert.equal(otaService.estadoDaSala("ART-2").fase, "ofertado", "a oferta B segue intacta");

  placaB.enviar({ tipo: "ota_resultado", resultado: "ok" });
  await ate(() => otaService.estadoDaSala("ART-2").fase === "gravado");
  await placaA.fechar();
  await placaB.fechar();
  otaService.limparEstado("ART-1");
  otaService.limparEstado("ART-2");
});

test("without an active offer the room downloads the published firmware; a failed offer releases the old artifact", async () => {
  sala("ART-3", "AA:BB:CC:AA:00:03");
  sala("ART-4", "AA:BB:CC:AA:00:04");
  const c = criarBin(11);
  const d = criarBin(13, 192 * 1024);
  otaService.publicarFirmware({ origem: c.origem, versao: "4.3.0", notas: "C" });
  const placaC = await placa("ART-3", "AA:BB:CC:AA:00:03");
  otaService.ofertar("ART-3");
  await ate(() => placaC.ofertas().length === 1);
  const manifestoD = otaService.publicarFirmware({ origem: d.origem, versao: "4.4.0", notas: "D" });
  assert.deepEqual(bins(), ["firmware-4.3.0.bin", "firmware-4.4.0.bin"]);

  const semOferta = await baixar("ART-4", "AA:BB:CC:AA:00:04");
  assert.equal(semOferta.versao, "4.4.0");
  assert.equal(semOferta.sha256, manifestoD.sha256);

  placaC.enviar({ tipo: "ota_resultado", resultado: "erro", erro: "falhou de propósito" });
  await ate(() => otaService.estadoDaSala("ART-3").fase === "falhou");
  otaService.verificarTimeouts();
  assert.deepEqual(bins(), ["firmware-4.4.0.bin"], "artefato sem oferta ativa é removido na varredura seguinte");

  const depois = await baixar("ART-3", "AA:BB:CC:AA:00:03");
  assert.equal(depois.versao, "4.4.0", "sem oferta ativa, a sala recebe o publicado");
  await placaC.fechar();
  otaService.limparEstado("ART-3");
});

test("republishing the same version with different bytes is refused while an offer references it; with the same bytes it is accepted", async () => {
  sala("ART-5", "AA:BB:CC:AA:00:05");
  const e = criarBin(17);
  const manifestoE = otaService.publicarFirmware({ origem: e.origem, versao: "4.5.0", notas: "E" });
  const placaE = await placa("ART-5", "AA:BB:CC:AA:00:05");
  otaService.ofertar("ART-5");
  await ate(() => placaE.ofertas().length === 1);

  const outroConteudo = criarBin(19);
  assert.throws(() => otaService.publicarFirmware({ origem: outroConteudo.origem, versao: "4.5.0", notas: "E'" }), /4\.5\.0.*em andamento|em andamento.*4\.5\.0/);
  assert.equal(otaService.lerManifesto().sha256, manifestoE.sha256, "o publicado não mudou");
  assert.deepEqual(bins(), ["firmware-4.5.0.bin"], "o temporário recusado não fica no disco");

  const mesmoConteudo = criarBin(17);
  const republicado = otaService.publicarFirmware({ origem: mesmoConteudo.origem, versao: "4.5.0", notas: "E de novo" });
  assert.equal(republicado.sha256, manifestoE.sha256);
  assert.equal((await baixar("ART-5", "AA:BB:CC:AA:00:05")).sha256, manifestoE.sha256);

  placaE.enviar({ tipo: "ota_resultado", resultado: "ok" });
  await ate(() => otaService.estadoDaSala("ART-5").fase === "gravado");
  const outraVersao = otaService.publicarFirmware({ origem: outroConteudo.origem, versao: "4.5.1", notas: "E''" });
  assert.deepEqual(bins(), ["firmware-4.5.1.bin"], "sem oferta ativa, publicar substitui o artefato anterior na hora");
  assert.equal(otaService.lerManifesto().sha256, outraVersao.sha256);
  await placaE.fechar();
  otaService.limparEstado("ART-5");
});

test("if the offered artifact disappears from disk, the download is refused instead of delivering other firmware", async () => {
  sala("ART-6", "AA:BB:CC:AA:00:06");
  const f = criarBin(23);
  otaService.publicarFirmware({ origem: f.origem, versao: "4.6.0", notas: "F" });
  const placaF = await placa("ART-6", "AA:BB:CC:AA:00:06");
  otaService.ofertar("ART-6");
  await ate(() => placaF.ofertas().length === 1);
  const g = criarBin(29, 160 * 1024);
  otaService.publicarFirmware({ origem: g.origem, versao: "4.7.0", notas: "G" });
  fs.rmSync(path.join(otaService.DIR_FIRMWARE, "firmware-4.6.0.bin"));

  const resp = await baixar("ART-6", "AA:BB:CC:AA:00:06");
  assert.equal(resp.status, 409);
  assert.match(resp.corpo.toString(), /não está mais disponível/);
  assert.equal(otaService.estadoDaSala("ART-6").fase, "ofertado", "o estado da oferta não é alterado pelo download recusado");
  await placaF.fechar();
  otaService.limparEstado("ART-6");
});
