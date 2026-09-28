"use strict";

// The fault-injecting intermediary between the virtual board and the server, exercised with ordinary
// sockets: it must be transparent unless a fault is armed, and exact when one is.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");

process.env.LAB_EXECUCAO = process.env.LAB_EXECUCAO || require("../lib/ambiente").novoIdExecucao();
const WebSocket = require("../../remoteifes-server/node_modules/ws");
const { Intermediario } = require("../lib/rede");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function servidorWs(t) {
  const wss = new WebSocket.Server({ port: 0, host: "127.0.0.1", path: "/ws/dispositivo" });
  await new Promise((r) => wss.on("listening", r));
  t.after(() => new Promise((r) => wss.close(r)));
  return wss;
}

test("WebSocket traffic passes unchanged; pings are answered; the board's frames and headers are observed", async (t) => {
  const wss = await servidorWs(t);
  let pongs = 0;
  const recebidas = [];
  wss.on("connection", (ws) => {
    ws.on("pong", () => { pongs += 1; });
    ws.on("message", (m) => recebidas.push(String(m)));
    ws.send(JSON.stringify({ tipo: "ola" }));
    const i = setInterval(() => ws.ping(), 50);
    ws.on("close", () => clearInterval(i));
  });
  const via = await new Intermediario({ portaDestino: wss.address().port }).iniciar();
  t.after(() => via.encerrar());
  const c = new WebSocket(`ws://127.0.0.1:${via.porta}/ws/dispositivo`, { headers: { "x-device-id": "esp_1" } });
  const doServidor = [];
  c.on("message", (m) => doServidor.push(JSON.parse(m)));
  await new Promise((r) => c.once("open", r));
  c.send(JSON.stringify({ tipo: "info", fw: "9.9.9" }));
  await via.injetarTexto(JSON.stringify({ tipo: "injetado" }));
  await esperar(400);
  c.close();
  assert.ok(pongs >= 3, `pongs crossed the intermediary (${pongs})`);
  assert.deepEqual(recebidas, [JSON.stringify({ tipo: "info", fw: "9.9.9" })]);
  assert.deepEqual(doServidor.map((m) => m.tipo).sort(), ["injetado", "ola"]);
  assert.deepEqual(via.mensagensDaPlaca({ tipo: "info" }).map((m) => m.fw), ["9.9.9"]);
  assert.equal(via.conexoes[0].cabecalhos["x-device-id"], "esp_1");
  assert.ok(via.pingsRespondidos(0, Date.now()).every((p) => p.respostaMs !== null));
});

test("a firmware download is cut, stalled or altered at the exact byte, following the reader's pace", async (t) => {
  const corpo = Buffer.alloc(2_000_000);
  for (let i = 0; i < corpo.length; i++) corpo[i] = i % 251;
  const srv = http.createServer((q, r) => { r.writeHead(200, { "Content-Length": corpo.length }); r.end(corpo); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const via = await new Intermediario({ portaDestino: srv.address().port }).iniciar();
  t.after(() => via.encerrar());

  const baixar = async () => {
    const s = net.connect(via.porta, "127.0.0.1");
    const partes = [];
    s.on("data", (d) => partes.push(d));
    s.write("GET /dispositivo/firmware?sala=x HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((r) => { s.once("close", r); setTimeout(() => { s.destroy(); r(); }, 3000); });
    const tudo = Buffer.concat(partes);
    return tudo.subarray(tudo.indexOf("\r\n\r\n") + 4);
  };

  via.firmware = { cortarApos: 777_777 };
  let b = await baixar();
  assert.equal(b.length, 777_777);
  assert.ok(b.equals(corpo.subarray(0, 777_777)));

  via.firmware = { corromperByte: 1_000_000 };
  b = await baixar();
  assert.equal(b.length, corpo.length);
  assert.equal(b[1_000_000], corpo[1_000_000] ^ 0xff);
  assert.ok(b.subarray(0, 1_000_000).equals(corpo.subarray(0, 1_000_000)));

  via.firmware = { pararApos: 500_000 };
  b = await baixar();
  assert.equal(b.length, 500_000, "nothing past the stall point");
  assert.ok(via.conexoesDo("firmware").pop().parado);
});

test("refused and silent modes", async (t) => {
  const srv = net.createServer((s) => s.end("resposta"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const via = await new Intermediario({ portaDestino: srv.address().port }).iniciar();
  t.after(() => via.encerrar());
  via.modo = "recusar";
  const recusa = await new Promise((r) => { const s = net.connect(via.porta, "127.0.0.1"); s.on("error", () => r("erro")); s.on("close", () => r("fechada")); s.on("data", () => r("dados")); });
  assert.notEqual(recusa, "dados");
  via.modo = "buraco";
  const mudo = await new Promise((r) => { const s = net.connect(via.porta, "127.0.0.1", () => s.write("oi")); s.on("data", () => r("dados")); setTimeout(() => { s.destroy(); r("silencio"); }, 500); });
  assert.equal(mudo, "silencio");
  assert.equal(via.conexoes.length, 2);
});
