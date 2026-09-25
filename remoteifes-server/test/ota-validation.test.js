const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "test";

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-validacao-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { spawnSync } = require("child_process");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const otaService = require("../src/services/otaService");
const otaRolloutService = require("../src/services/otaRolloutService");
const salasService = require("../src/services/salasService");
const credenciais = require("../src/services/esp32CredenciaisService");

const VERSAO_ANTIGA = "4.2.0";
const VERSAO_NOVA = "4.3.0";
const ATOR = { id: 1, usuario: "superadmin" };
let server;
let baseWsUrl;
let manifesto;
const socketsAbertos = new Set();

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 4000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

function criarBinFake(semente = 1) {
  const buf = Buffer.alloc(96 * 1024, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = (i + semente) % 251;
  const alvo = path.join(RAIZ_TMP, `firmware-fake-${semente}.bin`);
  fs.writeFileSync(alvo, buf);
  return alvo;
}

function novaSala(sala, mac) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(sala, sala, mac);
}

function info(fw, extras = {}) {
  return { tipo: "info", fw, otaValidacao: true, failsafeConfigurado: false, failsafePulsos: 0, failsafeCarrierHz: 0, failsafeProtocolRecordId: -1, ...extras };
}

async function abrirDispositivo(sala, mac, fw, { capaz = true, headers = {} } = {}) {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-sala": sala, "x-device-mac": mac, ...headers } });
  socketsAbertos.add(ws);
  const mensagens = [];
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.once("close", () => socketsAbertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const apresentacao = capaz ? info(fw) : { tipo: "info", fw, failsafeConfigurado: false, failsafePulsos: 0, failsafeCarrierHz: 0, failsafeProtocolRecordId: -1 };
  ws.send(JSON.stringify(apresentacao));
  await ate(() => deviceHub.estadoPublico(sala).fwVersao === fw);
  const d = {
    sala, mac, ws, mensagens,
    enviar: (m) => ws.send(JSON.stringify(m)),
    ofertas: () => mensagens.filter((m) => m.tipo === "ota_oferta"),
    acks: () => mensagens.filter((m) => m.tipo === "ota_validacao_ok"),
    fechar: async () => {
      const fechado = new Promise((r) => ws.once("close", r));
      ws.close();
      await fechado;
      await ate(() => !deviceHub.estadoPublico(sala).conectado);
    },
  };
  return d;
}

async function gravarEReiniciar(d) {
  d.enviar({ tipo: "ota_resultado", resultado: "ok" });
  await ate(() => otaService.estadoDaSala(d.sala).fase === "gravado");
  await d.fechar();
  await ate(() => otaService.estadoDaSala(d.sala).fase === "reiniciando");
}

function fase(sala) {
  return otaService.estadoDaSala(sala).fase;
}

function dispositivoDoRollout(sala) {
  return otaRolloutService.atual().dispositivos.find((d) => d.sala === sala);
}

test.before(async () => {
  manifesto = otaService.publicarFirmware({ origem: criarBinFake(), versao: VERSAO_NOVA, notas: "validação" });
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of socketsAbertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("the offer carries the attempt identifier and capable firmware completes only with boot evidence; duplicate reports are idempotent", async () => {
  novaSala("VAL-1", "AA:BB:CC:0A:00:01");
  const d = await abrirDispositivo("VAL-1", "AA:BB:CC:0A:00:01", VERSAO_ANTIGA);
  otaService.ofertar("VAL-1");
  assert.ok(await ate(() => d.ofertas().length === 1));
  const oferta = d.ofertas()[0];
  assert.equal(oferta.tentativa, otaService.estadoDaSala("VAL-1").tentativa);
  assert.equal(oferta.sha256, manifesto.sha256);
  await gravarEReiniciar(d);

  const novo = await abrirDispositivo("VAL-1", "AA:BB:CC:0A:00:01", VERSAO_NOVA);
  assert.equal(fase("VAL-1"), "validando", "reportar a versão-alvo ainda não é conclusão para firmware que sabe validar");
  novo.enviar({ tipo: "ota_validado", tentativa: "outra-tentativa", sha256: manifesto.sha256, versao: VERSAO_NOVA });
  await esperar(80);
  assert.equal(fase("VAL-1"), "validando", "evidência de outra tentativa é ignorada");
  assert.equal(novo.acks().length, 0);
  novo.enviar({ tipo: "ota_validado", tentativa: oferta.tentativa, sha256: manifesto.sha256, versao: VERSAO_NOVA });
  assert.ok(await ate(() => fase("VAL-1") === "concluido"));
  assert.equal(otaService.estadoDaSala("VAL-1").evidencia, "boot");
  assert.ok(await ate(() => novo.acks().length === 1));
  assert.equal(novo.acks()[0].tentativa, oferta.tentativa);
  novo.enviar({ tipo: "ota_validado", tentativa: oferta.tentativa, sha256: manifesto.sha256, versao: VERSAO_NOVA });
  assert.ok(await ate(() => novo.acks().length === 2), "o duplicado é confirmado de novo para a placa limpar sua evidência");
  assert.equal(fase("VAL-1"), "concluido");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificacoes WHERE tipo = 'esp32_ota_ok' AND sala = 'VAL-1'").get().n, 1);
  await novo.fechar();
});

test("firmware without the capability still completes by the reported version (previous semantics preserved)", async () => {
  novaSala("VAL-2", "AA:BB:CC:0A:00:02");
  const d = await abrirDispositivo("VAL-2", "AA:BB:CC:0A:00:02", VERSAO_ANTIGA, { capaz: false });
  otaService.ofertar("VAL-2");
  await ate(() => d.ofertas().length === 1);
  await gravarEReiniciar(d);
  const novo = await abrirDispositivo("VAL-2", "AA:BB:CC:0A:00:02", VERSAO_NOVA, { capaz: false });
  assert.ok(await ate(() => fase("VAL-2") === "concluido"));
  assert.equal(otaService.estadoDaSala("VAL-2").evidencia, "versao");
  await novo.fechar();
});

test("a canary that reports the target version and then reverts stops the rollout without starting the next batch", async () => {
  otaService.limparEstado("VAL-1");
  otaService.limparEstado("VAL-2");
  for (let i = 1; i <= 3; i += 1) novaSala(`ROL-V${i}`, `AA:BB:CC:0A:01:0${i}`);
  const canario = await abrirDispositivo("ROL-V1", "AA:BB:CC:0A:01:01", VERSAO_ANTIGA);
  const seguinte = await abrirDispositivo("ROL-V2", "AA:BB:CC:0A:01:02", VERSAO_ANTIGA);
  const terceiro = await abrirDispositivo("ROL-V3", "AA:BB:CC:0A:01:03", VERSAO_ANTIGA);
  otaRolloutService.iniciar({ salas: ["ROL-V1", "ROL-V2", "ROL-V3"], canario: "ROL-V1", tamanhoLote: 2, ator: ATOR });
  assert.ok(await ate(() => canario.ofertas().length === 1));
  const tentativa = canario.ofertas()[0].tentativa;
  await gravarEReiniciar(canario);

  const canarioNovo = await abrirDispositivo("ROL-V1", "AA:BB:CC:0A:01:01", VERSAO_NOVA);
  assert.ok(await ate(() => dispositivoDoRollout("ROL-V1").estado === "validando"));
  await esperar(150);
  assert.equal(seguinte.ofertas().length, 0, "o lote seguinte não começa enquanto o canário só reportou a versão");
  assert.equal(otaRolloutService.atual().loteAtual, 0);

  await canarioNovo.fechar();
  const revertido = await abrirDispositivo("ROL-V1", "AA:BB:CC:0A:01:01", VERSAO_ANTIGA);
  assert.ok(await ate(() => fase("ROL-V1") === "falhou"));
  assert.equal(otaService.estadoDaSala("ROL-V1").causa, "rollback");
  assert.equal(otaService.estadoDaSala("ROL-V1").tentativa, tentativa);
  assert.ok(await ate(() => !otaRolloutService.ativo()));
  assert.equal(otaRolloutService.atual().estado, "interrompido");
  assert.equal(dispositivoDoRollout("ROL-V1").estado, "revertido");
  assert.equal(dispositivoDoRollout("ROL-V1").comprovado, true);
  assert.equal(seguinte.ofertas().length, 0);
  assert.equal(terceiro.ofertas().length, 0);
  assert.ok(db.prepare("SELECT 1 FROM notificacoes WHERE tipo = 'esp32_ota_falha' AND sala = 'ROL-V1' AND mensagem LIKE '%revertida%'").get());
  await revertido.fechar();
  await seguinte.fechar();
  await terceiro.fechar();
});

function emProcessoNovo(script, sala = null, mac = null) {
  const codigo = `
    process.env.REMOTEIFES_DB_PATH = ':memory:';
    process.env.REMOTEIFES_FIRMWARE_DIR = ${JSON.stringify(process.env.REMOTEIFES_FIRMWARE_DIR)};
    process.env.NODE_ENV = 'test';
    const db = require(${JSON.stringify(path.join(__dirname, "../src/config/database"))});
    require(${JSON.stringify(path.join(__dirname, "../src/db/schema"))}).criarSchema();
    if (${JSON.stringify(sala)}) db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(${JSON.stringify(sala)}, ${JSON.stringify(sala)}, ${JSON.stringify(mac)});
    const ota = require(${JSON.stringify(path.join(__dirname, "../src/services/otaService"))});
    const resultado = (() => { ${script} })();
    process.stdout.write(JSON.stringify(resultado));
  `;
  const filho = spawnSync(process.execPath, ["-e", codigo], { encoding: "utf8" });
  assert.equal(filho.status, 0, filho.stderr || filho.stdout);
  return JSON.parse(filho.stdout.trim().split("\n").pop());
}

function envelhecerEstado(sala, minutos) {
  const persistidos = JSON.parse(fs.readFileSync(otaService.ARQUIVO_ESTADOS, "utf8"));
  persistidos[sala].atualizadoEm = new Date(Date.now() - minutos * 60 * 1000).toISOString();
  fs.writeFileSync(otaService.ARQUIVO_ESTADOS, JSON.stringify(persistidos));
}

test("validation survives a server restart and board reconnection and completes with the resent evidence", async () => {
  novaSala("VAL-3", "AA:BB:CC:0A:00:03");
  const d = await abrirDispositivo("VAL-3", "AA:BB:CC:0A:00:03", VERSAO_ANTIGA);
  otaService.ofertar("VAL-3");
  await ate(() => d.ofertas().length === 1);
  const tentativa = d.ofertas()[0].tentativa;
  await gravarEReiniciar(d);
  const novo = await abrirDispositivo("VAL-3", "AA:BB:CC:0A:00:03", VERSAO_NOVA);
  assert.ok(await ate(() => fase("VAL-3") === "validando"));
  await novo.fechar();
  assert.equal(fase("VAL-3"), "validando", "cair durante a validação não é falha nem conclusão");

  envelhecerEstado("VAL-3", 10);
  const depois = emProcessoNovo(`
    const antes = ota.estadoDaSala('VAL-3').fase;
    ota.verificarTimeouts();
    const aposTimeout = ota.estadoDaSala('VAL-3').fase;
    const aceita = ota.registrarValidacao('VAL-3', { tentativa: ${JSON.stringify(tentativa)}, sha256: ${JSON.stringify(manifesto.sha256)}, versao: ${JSON.stringify(VERSAO_NOVA)} });
    return { antes, aposTimeout, aceita, final: ota.estadoDaSala('VAL-3').fase, evidencia: ota.estadoDaSala('VAL-3').evidencia };
  `, "VAL-3", "AA:BB:CC:0A:00:03");
  assert.equal(depois.antes, "validando");
  assert.equal(depois.aposTimeout, "validando", "o reinício do servidor concede uma janela nova de validação");
  assert.equal(depois.aceita, true);
  assert.equal(depois.final, "concluido");
  assert.equal(depois.evidencia, "boot");
  otaService.limparEstado("VAL-3");
});

test("an identity replaced after flashing cannot validate the attempt", async () => {
  novaSala("VAL-5", "AA:BB:CC:0A:00:05");
  const outro = await abrirDispositivo("VAL-5", "AA:BB:CC:0A:00:05", VERSAO_ANTIGA);
  otaService.ofertar("VAL-5");
  await ate(() => outro.ofertas().length === 1);
  const tentativaOutro = outro.ofertas()[0].tentativa;
  await gravarEReiniciar(outro);
  salasService.cadastrarMac("VAL-5", "AA:BB:CC:0A:00:55");
  const substituto = await abrirDispositivo("VAL-5", "AA:BB:CC:0A:00:55", VERSAO_NOVA);
  assert.equal(otaService.registrarValidacao("VAL-5", { tentativa: tentativaOutro, sha256: manifesto.sha256, versao: VERSAO_NOVA }), false);
  assert.notEqual(fase("VAL-5"), "concluido");
  await substituto.fechar();
  otaService.limparEstado("VAL-5");
});

test("the validation deadline ends the attempt as a validation failure, which the rollout treats as unconfirmed", (t) => {
  novaSala("VAL-6", "AA:BB:CC:0A:00:06");
  const agoraMenos = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const estados = JSON.parse(fs.readFileSync(otaService.ARQUIVO_ESTADOS, "utf8"));
  estados["VAL-6"] = { fase: "validando", tentativa: "t-6", sha256: manifesto.sha256, versao: VERSAO_NOVA, versaoAnterior: VERSAO_ANTIGA, total: manifesto.tamanho, recebido: manifesto.tamanho, atualizadoEm: agoraMenos, iniciadoEm: agoraMenos };
  fs.writeFileSync(otaService.ARQUIVO_ESTADOS, JSON.stringify(estados));
  const resultado = emProcessoNovo(`
    const t0 = Date.now();
    const original = Date.now;
    Date.now = () => t0 + 5 * 60 * 1000;
    ota.verificarTimeouts();
    Date.now = original;
    return ota.estadoDaSala('VAL-6');
  `);
  assert.equal(resultado.fase, "falhou");
  assert.equal(resultado.causa, "validacao");
  assert.match(resultado.erro, /validação de boot/);
  const rollout = require("../src/services/otaRolloutService");
  const mapeado = rollout.estadoDeDispositivo ? rollout.estadoDeDispositivo(resultado) : null;
  if (mapeado) assert.equal(mapeado.estado, "indeterminado");
  const salvos = JSON.parse(fs.readFileSync(otaService.ARQUIVO_ESTADOS, "utf8"));
  delete salvos["VAL-6"];
  fs.writeFileSync(otaService.ARQUIVO_ESTADOS, JSON.stringify(salvos));
});

test("a validated device that reverts to the previous version after completion reconciles the state and the rollout", async () => {
  novaSala("ROL-T1", "AA:BB:CC:0A:02:01");
  const d = await abrirDispositivo("ROL-T1", "AA:BB:CC:0A:02:01", VERSAO_ANTIGA);
  otaRolloutService.iniciar({ salas: ["ROL-T1"], canario: "ROL-T1", tamanhoLote: 1, ator: ATOR });
  assert.ok(await ate(() => d.ofertas().length === 1));
  const tentativa = d.ofertas()[0].tentativa;
  await gravarEReiniciar(d);
  const novo = await abrirDispositivo("ROL-T1", "AA:BB:CC:0A:02:01", VERSAO_NOVA);
  novo.enviar({ tipo: "ota_validado", tentativa, sha256: manifesto.sha256, versao: VERSAO_NOVA });
  assert.ok(await ate(() => fase("ROL-T1") === "concluido"));
  assert.ok(await ate(() => !otaRolloutService.ativo() && otaRolloutService.atual().estado === "concluido"));
  await novo.fechar();

  const tardio = await abrirDispositivo("ROL-T1", "AA:BB:CC:0A:02:01", VERSAO_ANTIGA);
  assert.ok(await ate(() => fase("ROL-T1") === "falhou"));
  assert.equal(otaService.estadoDaSala("ROL-T1").causa, "rollback");
  assert.ok(await ate(() => dispositivoDoRollout("ROL-T1").estado === "revertido"));
  assert.equal(otaRolloutService.atual().reversoesTardias, 1);
  assert.match(otaRolloutService.atual().motivoParada, /reverteram/);
  const persistido = JSON.parse(fs.readFileSync(otaRolloutService.ARQUIVO_ROLLOUT, "utf8"));
  assert.equal(persistido.dispositivos[0].estado, "revertido");
  assert.equal(persistido.dispositivos[0].comprovado, true);
  await tardio.fechar();
});
