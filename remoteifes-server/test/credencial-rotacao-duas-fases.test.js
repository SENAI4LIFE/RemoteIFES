process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const credenciais = require("../src/services/esp32CredenciaisService");

let server;
let baseUrl;
let wsUrl;
const abertos = new Set();

function sala(codigo, mac) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(codigo, codigo, mac);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

function linha(codigo) {
  return db.prepare("SELECT * FROM esp_credenciais WHERE sala = ?").get(codigo);
}

async function conectar(deviceId, segredo) {
  const ws = new WebSocket(wsUrl, { headers: { "x-device-id": deviceId, "x-device-secret": segredo } });
  abertos.add(ws);
  const mensagens = [];
  let fechamento = null;
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.on("close", (codigo) => { fechamento = codigo; abertos.delete(ws); });
  ws.on("error", () => {});
  const abriu = await new Promise((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("close", () => resolve(false));
    ws.once("error", () => resolve(false));
  });
  if (abriu) await esperar(200);
  const aberto = abriu && fechamento === null;
  return { ws, mensagens, aberto, fechamento: () => fechamento, pushes: () => mensagens.filter((m) => m.tipo === "credencial_rotacionar") };
}

async function heartbeat(deviceId, segredo, codigo) {
  return fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": deviceId, "x-device-secret": segredo },
    body: JSON.stringify({ sala: codigo, ligado: false }),
  });
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("rotacionar cria uma geração pendente: a antiga segue válida até a placa provar a nova, e só então a antiga entra na tolerância", async () => {
  sala("ROT-1", "AA:CC:11:00:00:01");
  const atual = credenciais.provisionar("ROT-1");
  const nova = credenciais.rotacionar("ROT-1");
  assert.equal(nova.pendente, true);
  assert.equal(nova.enviadoAoDispositivo, false, "sem dispositivo conectado nada foi entregue");
  let estado = credenciais.estado("ROT-1");
  assert.equal(estado.rotacaoPendente, true);
  assert.equal(estado.pendenteEntregueEm, null);
  assert.equal(estado.graceRotacaoAtivo, false, "nada expira antes de a placa confirmar");
  assert.equal(linha("ROT-1").segredoHashAnterior, null);

  const antigaAindaVale = credenciais.verificar(atual.deviceId, atual.segredo);
  assert.ok(antigaAindaVale && !antigaAindaVale.grace, "a credencial antiga continua sendo a ativa");
  assert.equal(credenciais.estado("ROT-1").rotacaoPendente, true);

  const prova = credenciais.verificar(nova.deviceId, nova.segredo);
  assert.ok(prova && !prova.grace, "a placa provou a nova geração");
  estado = credenciais.estado("ROT-1");
  assert.equal(estado.rotacaoPendente, false);
  assert.equal(estado.graceRotacaoAtivo, true);
  const emTolerancia = credenciais.verificar(atual.deviceId, atual.segredo);
  assert.ok(emTolerancia && emTolerancia.grace && emTolerancia.expiraEm, "a antiga passa a valer só na tolerância limitada");
  assert.ok(new Date(emTolerancia.expiraEm).getTime() - Date.now() <= 24 * 3600 * 1000 + 5000);
});

test("uma placa que estava offline durante a rotação não fica inacessível: reconecta com a antiga, recebe a pendente e a ativa", async () => {
  sala("ROT-2", "AA:CC:11:00:00:02");
  const atual = credenciais.provisionar("ROT-2");
  const nova = credenciais.rotacionar("ROT-2");
  assert.equal(nova.enviadoAoDispositivo, false);
  db.prepare("UPDATE esp_credenciais SET pendenteCriadoEm = datetime('now', '-3 days') WHERE sala = 'ROT-2'").run();

  const placa = await conectar(atual.deviceId, atual.segredo);
  assert.equal(placa.aberto, true, "três dias depois a credencial antiga ainda autentica");
  assert.ok(await ate(() => placa.pushes().length === 1), "a geração pendente é entregue na reconexão");
  assert.equal(placa.pushes()[0].segredo, nova.segredo);
  assert.equal(placa.pushes()[0].deviceId, nova.deviceId);
  assert.ok(await ate(() => credenciais.estado("ROT-2").pendenteEntregueEm !== null));

  const reconectada = await conectar(nova.deviceId, nova.segredo);
  assert.equal(reconectada.aberto, true);
  assert.ok(await ate(() => placa.fechamento() === 4002), "a sessão anterior é substituída pela nova conexão");
  assert.equal(credenciais.estado("ROT-2").rotacaoPendente, false);
  assert.equal(credenciais.estado("ROT-2").graceRotacaoAtivo, true);
  reconectada.ws.close();
});

test("um heartbeat HTTP com a geração pendente também a ativa", async () => {
  sala("ROT-3", "AA:CC:11:00:00:03");
  credenciais.provisionar("ROT-3");
  const nova = credenciais.rotacionar("ROT-3");
  const resp = await heartbeat(nova.deviceId, nova.segredo, "ROT-3");
  assert.equal(resp.status, 200);
  assert.equal(credenciais.estado("ROT-3").rotacaoPendente, false);
  assert.equal(credenciais.estado("ROT-3").graceRotacaoAtivo, true);
});

test("depois de um reinício do servidor a pendente não é reentregável, mas a antiga continua valendo e uma nova rotação a substitui", async () => {
  sala("ROT-4", "AA:CC:11:00:00:04");
  const atual = credenciais.provisionar("ROT-4");
  const perdida = credenciais.rotacionar("ROT-4");
  credenciais.revogar("ROT-4");
  const outra = credenciais.provisionar("ROT-4");
  const perdida2 = credenciais.rotacionar("ROT-4");
  db.prepare("UPDATE esp_credenciais SET pendenteEntregueEm = NULL WHERE sala = 'ROT-4'").run();
  const { spawnSync } = require("child_process");
  const filho = spawnSync(process.execPath, ["-e", `
    process.env.NODE_ENV = 'test';
    process.env.REMOTEIFES_DB_PATH = ':memory:';
    const db = require(${JSON.stringify(require.resolve("../src/config/database"))});
    require(${JSON.stringify(require.resolve("../src/db/schema"))}).criarSchema();
    db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES ('ROT-4', 'ROT-4', 'A', 1, 'AA:CC:11:00:00:04')").run();
    db.prepare("INSERT INTO esp_credenciais (sala, deviceId, segredoHash, segredoHashPendente, pendenteCriadoEm) VALUES ('ROT-4', ?, ?, ?, datetime('now'))").run(${JSON.stringify(outra.deviceId)}, ${JSON.stringify(linha("ROT-4").segredoHash)}, ${JSON.stringify(linha("ROT-4").segredoHashPendente)});
    const cred = require(${JSON.stringify(require.resolve("../src/services/esp32CredenciaisService"))});
    const estado = cred.estado('ROT-4');
    const antiga = cred.verificar(${JSON.stringify(outra.deviceId)}, ${JSON.stringify(outra.segredo)});
    const entregue = cred.entregarPendente('ROT-4');
    process.stdout.write(JSON.stringify({ reentregavel: estado.pendenteReentregavel, pendente: estado.rotacaoPendente, antigaVale: !!antiga && !antiga.grace, entregue }));
  `], { encoding: "utf8" });
  assert.equal(filho.status, 0, filho.stderr);
  const resultado = JSON.parse(filho.stdout.trim().split("\n").pop());
  assert.deepEqual(resultado, { reentregavel: false, pendente: true, antigaVale: true, entregue: false });
  assert.equal(credenciais.verificar(perdida.deviceId, perdida.segredo), null, "a geração pendente de uma credencial revogada não vale");
  const terceira = credenciais.rotacionar("ROT-4");
  assert.equal(credenciais.verificar(perdida2.deviceId, perdida2.segredo), null, "uma nova rotação substitui a pendente anterior");
  assert.ok(credenciais.verificar(terceira.deviceId, terceira.segredo));
  assert.ok(credenciais.verificar(outra.deviceId, outra.segredo).grace);
});

test("um socket autenticado com a geração anterior é encerrado quando a tolerância termina, sem afetar a geração atual", async () => {
  sala("ROT-5", "AA:CC:11:00:00:05");
  const antiga = credenciais.provisionar("ROT-5");
  const nova = credenciais.rotacionar("ROT-5");
  assert.ok(credenciais.verificar(nova.deviceId, nova.segredo));
  const expira = new Date(Date.now() + 1500).toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE esp_credenciais SET anteriorExpiraEm = ? WHERE sala = 'ROT-5'").run(expira);

  const obsoleta = await conectar(antiga.deviceId, antiga.segredo);
  assert.equal(obsoleta.aberto, true, "dentro da tolerância a geração anterior ainda conecta");
  assert.equal(deviceHub.encerrarCredenciaisExpiradas(), 0, "ainda não expirou");
  await esperar(1700);
  assert.equal(deviceHub.encerrarCredenciaisExpiradas(), 1);
  assert.ok(await ate(() => obsoleta.fechamento() === 4001));
  const recusada = await conectar(antiga.deviceId, antiga.segredo);
  assert.equal(recusada.aberto, false, "após a tolerância a geração anterior não autentica mais");

  const atual = await conectar(nova.deviceId, nova.segredo);
  assert.equal(atual.aberto, true);
  assert.equal(deviceHub.encerrarCredenciaisExpiradas(), 0);
  atual.ws.close();
});

test("substituir e revogar descartam a geração pendente", async () => {
  sala("ROT-6", "AA:CC:11:00:00:06");
  credenciais.provisionar("ROT-6");
  const pendente = credenciais.rotacionar("ROT-6");
  const substituta = credenciais.substituir("ROT-6");
  assert.equal(credenciais.estado("ROT-6").rotacaoPendente, false);
  assert.equal(credenciais.verificar(pendente.deviceId, pendente.segredo), null);
  assert.ok(credenciais.verificar(substituta.deviceId, substituta.segredo));
  const pendente2 = credenciais.rotacionar("ROT-6");
  credenciais.revogar("ROT-6");
  assert.equal(credenciais.verificar(pendente2.deviceId, pendente2.segredo), null);
  assert.equal(linha("ROT-6").segredoHashPendente, null);
});

test("uma placa que volta com a geração anterior depois da ativação (gravação na NVS não durou) recebe o segredo atual de novo, enquanto a tolerância vale", async () => {
  sala("ROT-7", "AA:CC:11:00:00:07");
  const antiga = credenciais.provisionar("ROT-7");
  const nova = credenciais.rotacionar("ROT-7");
  assert.equal(credenciais.estado("ROT-7").atualReentregavel, false, "antes da ativação não há segredo ativado para reentregar");
  assert.ok(credenciais.verificar(nova.deviceId, nova.segredo), "a placa prova o novo segredo (só em RAM, no cenário)");
  assert.equal(credenciais.estado("ROT-7").rotacaoPendente, false);
  assert.equal(credenciais.estado("ROT-7").atualReentregavel, true);

  const reiniciada = await conectar(antiga.deviceId, antiga.segredo);
  assert.equal(reiniciada.aberto, true, "após reiniciar com a NVS antiga, a placa ainda conecta pela tolerância");
  assert.ok(await ate(() => reiniciada.pushes().length === 1), "o servidor reentrega o segredo atual à conexão em tolerância");
  assert.equal(reiniciada.pushes()[0].deviceId, nova.deviceId);
  assert.equal(reiniciada.pushes()[0].segredo, nova.segredo);
  assert.equal(linha("ROT-7").segredoHashPendente, null, "a reentrega não cria uma geração pendente");

  const atualizada = await conectar(nova.deviceId, nova.segredo);
  assert.equal(atualizada.aberto, true);
  assert.ok(await ate(() => atualizada.pushes().length === 0 && reiniciada.fechamento() === 4002));
  await esperar(150);
  assert.equal(atualizada.pushes().length, 0, "quem conecta com o segredo atual não recebe reentrega");
  atualizada.ws.close();

  db.prepare("UPDATE esp_credenciais SET anteriorExpiraEm = datetime('now', '-1 minute') WHERE sala = 'ROT-7'").run();
  assert.equal(credenciais.estado("ROT-7").atualReentregavel, false, "fora da tolerância o segredo ativado não fica mais em memória");
  assert.equal(credenciais.reentregarAtual("ROT-7"), false);
});

test("substituir, revogar e uma nova rotação ativada descartam o segredo ativado guardado para reentrega", () => {
  sala("ROT-8", "AA:CC:11:00:00:08");
  credenciais.provisionar("ROT-8");
  const primeira = credenciais.rotacionar("ROT-8");
  credenciais.verificar(primeira.deviceId, primeira.segredo);
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, true);
  const segunda = credenciais.rotacionar("ROT-8");
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, true, "a pendente nova não invalida a reentrega da atual");
  credenciais.verificar(segunda.deviceId, segunda.segredo);
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, true, "agora é a segunda geração que fica reentregável");
  credenciais.substituir("ROT-8");
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, false);
  const terceira = credenciais.rotacionar("ROT-8");
  credenciais.verificar(terceira.deviceId, terceira.segredo);
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, true);
  credenciais.revogar("ROT-8");
  assert.equal(credenciais.estado("ROT-8").atualReentregavel, false);
});
