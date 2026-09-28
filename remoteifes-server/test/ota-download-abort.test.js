const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "test";

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-abort-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");

const http = require("http");
const net = require("net");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const otaService = require("../src/services/otaService");

// A board that loses Wi-Fi, loses power or stalls in the middle of a firmware download closes the
// connection early. The server must then release the image it was streaming: with pipe() the read
// stream stayed open (found by the virtual lab: on Windows the same version could not be republished,
// on Linux a descriptor leaked per aborted update).

let server;
let porta;
const abertos = [];
const original = fs.createReadStream;

test.before(async () => {
  const bin = Buffer.alloc(2_500_000, 0);
  bin[0] = 0xe9;
  for (let i = 1; i < bin.length; i += 1) bin[i] = i % 251;
  const origem = path.join(RAIZ_TMP, "imagem.bin");
  fs.writeFileSync(origem, bin);
  otaService.publicarFirmware({ origem, versao: "9.0.0", notas: "abort" });
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES ('ABORT-1', 'ABORT-1', 'A', 1, 'AA:BB:CC:DD:0B:01')").run();
  fs.createReadStream = (...args) => {
    const s = original(...args);
    if (String(args[0]).startsWith(otaService.DIR_FIRMWARE)) abertos.push(s);
    return s;
  };
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  porta = server.address().port;
});

test.after(async () => {
  fs.createReadStream = original;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

async function ate(condicao, limiteMs = 3000) {
  const fim = Date.now() + limiteMs;
  while (!condicao() && Date.now() < fim) await new Promise((r) => setTimeout(r, 20));
  return condicao();
}

test("a download the board abandons midway releases the firmware image", async () => {
  const s = net.connect(porta, "127.0.0.1");
  await new Promise((r) => s.once("connect", r));
  s.write("GET /dispositivo/firmware?sala=ABORT-1 HTTP/1.1\r\nHost: x\r\nx-device-mac: AA:BB:CC:DD:0B:01\r\n\r\n");
  let recebido = 0;
  await new Promise((r) => s.on("data", (d) => { recebido += d.length; if (recebido > 64 * 1024) { s.pause(); r(); } }));
  assert.equal(abertos.length, 1, "the route opened the image");
  assert.equal(abertos[0].destroyed, false, "still streaming while the board reads");
  s.destroy();
  assert.ok(await ate(() => abertos[0].destroyed), "the image stream is closed once the board goes away");
});

test("the same version can be published again right after an abandoned download", async () => {
  const origem = path.join(RAIZ_TMP, "imagem.bin");
  const s = net.connect(porta, "127.0.0.1");
  await new Promise((r) => s.once("connect", r));
  s.write("GET /dispositivo/firmware?sala=ABORT-1 HTTP/1.1\r\nHost: x\r\nx-device-mac: AA:BB:CC:DD:0B:01\r\n\r\n");
  await new Promise((r) => s.once("data", r));
  s.destroy();
  await ate(() => abertos[abertos.length - 1].destroyed);
  const bin = fs.readFileSync(origem);
  bin[bin.length - 1] ^= 0xff;
  fs.writeFileSync(origem, bin);
  assert.doesNotThrow(() => otaService.publicarFirmware({ origem, versao: "9.0.0", notas: "republicado" }));
});
