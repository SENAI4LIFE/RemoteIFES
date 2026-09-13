const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "test";

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-eficiencia-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const http = require("http");
const WebSocket = require("ws");
const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const otaService = require("../src/services/otaService");
const otaRolloutService = require("../src/services/otaRolloutService");

let server;
let baseWsUrl;
const socketsAbertos = new Set();

async function abrirDispositivo(sala, mac, fw) {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-sala": sala, "x-device-mac": mac } });
  socketsAbertos.add(ws);
  ws.on("message", () => {});
  ws.once("close", () => socketsAbertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await new Promise((resolve) => {
    const ouvir = ({ sala: s }) => { if (s === sala && deviceHub.estadoPublico(sala).fwVersao === fw) { deviceHub.eventos.off("telemetria", ouvir); resolve(); } };
    deviceHub.eventos.on("telemetria", ouvir);
    ws.send(JSON.stringify({ tipo: "telemetria", fw, modo: "operation" }));
  });
  return ws;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

function criarBinFake(semente, bytes = 96 * 1024) {
  const buf = Buffer.alloc(bytes, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = (i + semente) % 251;
  const alvo = path.join(RAIZ_TMP, `firmware-fake-${semente}.bin`);
  fs.writeFileSync(alvo, buf);
  return alvo;
}

function contarHashes(fn) {
  const original = crypto.createHash;
  let n = 0;
  crypto.createHash = (...a) => { n += 1; return original(...a); };
  try {
    return { resultado: fn(), hashes: n };
  } finally {
    crypto.createHash = original;
  }
}

test.after(async () => {
  for (const ws of socketsAbertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("o hash da imagem publicada é calculado uma vez e reaproveitado enquanto o arquivo for o mesmo", () => {
  const publicado = otaService.publicarFirmware({ origem: criarBinFake(1), versao: "4.9.1", notas: "memo" });
  const primeira = contarHashes(() => otaService.lerManifesto());
  assert.equal(primeira.resultado.sha256, publicado.sha256);
  const repetidas = contarHashes(() => { for (let i = 0; i < 5; i += 1) otaService.lerManifesto(); });
  assert.equal(repetidas.hashes, 0, "cinco leituras seguidas não devem reler nem rehashear a imagem");
});

test("republicar outra imagem ou adulterar o arquivo invalida o hash memorizado", () => {
  const segundo = otaService.publicarFirmware({ origem: criarBinFake(2), versao: "4.9.2", notas: "memo" });
  const leitura = contarHashes(() => otaService.lerManifesto());
  assert.equal(leitura.resultado.sha256, segundo.sha256);
  assert.equal(leitura.hashes, 1);

  const caminho = path.join(otaService.DIR_FIRMWARE, segundo.arquivo);
  const adulterado = fs.readFileSync(caminho);
  adulterado[1000] ^= 0xff;
  fs.writeFileSync(caminho, adulterado);
  const futuro = new Date(Date.now() + 5000);
  fs.utimesSync(caminho, futuro, futuro);
  const recusada = contarHashes(() => otaService.lerManifesto());
  assert.equal(recusada.resultado, null, "arquivo alterado no disco não passa pela verificação, mesmo com hash memorizado");
  assert.equal(recusada.hashes, 1);
});

test("a distribuição só regrava seu arquivo de estado quando algo mudou", async () => {
  otaService.publicarFirmware({ origem: criarBinFake(3), versao: "4.9.3", notas: "persistencia" });
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES ('ROL-P1', 'P1', 'A', 1, 'AA:BB:CC:0E:00:01')").run();
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES ('ROL-P2', 'P2', 'A', 1, 'AA:BB:CC:0E:00:02')").run();
  await abrirDispositivo("ROL-P1", "AA:BB:CC:0E:00:01", "4.0.0");
  await abrirDispositivo("ROL-P2", "AA:BB:CC:0E:00:02", "4.0.0");
  const antes = fs.existsSync(otaRolloutService.ARQUIVO_ROLLOUT) ? fs.statSync(otaRolloutService.ARQUIVO_ROLLOUT).mtimeMs : 0;
  const rollout = otaRolloutService.iniciar({ salas: ["ROL-P1", "ROL-P2"], canario: "ROL-P1", tamanhoLote: 1, ator: { id: 1, usuario: "superadmin" } });
  assert.ok(rollout);
  const gravadoAoIniciar = fs.statSync(otaRolloutService.ARQUIVO_ROLLOUT).mtimeMs;
  assert.ok(gravadoAoIniciar >= antes);

  const escritas = () => {
    const original = fs.writeFileSync;
    let n = 0;
    fs.writeFileSync = (alvo, ...resto) => { if (String(alvo).includes("rollout-ota.json")) n += 1; return original(alvo, ...resto); };
    try {
      for (let i = 0; i < 10; i += 1) otaRolloutService.tick();
    } finally {
      fs.writeFileSync = original;
    }
    return n;
  };
  assert.equal(escritas(), 0, "dez ticks sem qualquer evento não devem regravar o estado da distribuição");
  assert.equal(JSON.parse(fs.readFileSync(otaRolloutService.ARQUIVO_ROLLOUT, "utf8")).versao, "4.9.3");
  otaRolloutService.cancelar({ id: 1, usuario: "superadmin" });
});
