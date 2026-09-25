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
const salasService = require("../src/services/salasService");
const agendamentos = require("../src/services/agendamentosService");
const configuracoesService = require("../src/services/configuracoesService");
const desligamento = require("../src/services/desligamentoDiarioService");
const scheduler = require("../src/scheduler/schedulerService");
const { brasiliaParaUtcSqlite } = require("../src/utils/tempo");

const SUPERADMIN = { id: 1, nivel: 3, usuario: "superadmin" };
const MANUAL = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };

let server;
let baseUrl;
let wsUrl;
const abertos = new Set();

// Local Brasília time (fixed UTC-3) to a Date.
function local(dataISO, hora, segundos = 0) {
  return new Date(`${dataISO}T${hora}:${String(segundos).padStart(2, "0")}-03:00`);
}

function sala(codigo, { ligado = false, mac = null } = {}) {
  db.prepare("INSERT OR REPLACE INTO salas (sala, nome, bloco, andar, mac, ligado, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'D', 1, ?, ?, 24, 16)")
    .run(codigo, codigo, mac, ligado ? 1 : 0);
}

function linha(codigo) {
  return db.prepare("SELECT ligado, estadoVersao FROM salas WHERE sala = ?").get(codigo);
}

function registros(codigo) {
  return db.prepare("SELECT data, hora, resultado FROM desligamento_diario_execucoes WHERE sala = ? ORDER BY data, hora").all(codigo).map((r) => ({ ...r }));
}

function logs(codigo) {
  return db.prepare("SELECT cmd, origem FROM comandos_log WHERE sala = ? ORDER BY id").all(codigo).map((l) => `${l.cmd}:${l.origem}`);
}

// Command log timestamps come from SQLite's real clock, which mock timers do not move: records made
// during a simulated instant are dated explicitly.
function datarLogs(codigo, instante) {
  db.prepare("UPDATE comandos_log SET criadoEm = ? WHERE sala = ? AND criadoEm > ?").run(instante, codigo, "2000-01-01 00:00:00");
}

function configurar({ ativo = true, hora = "00:00", escopo = "selecionadas", salas = [], vigenteDesde = "2026-01-01 00:00:00" } = {}) {
  db.prepare(`INSERT INTO configuracoes (chave, valor) VALUES ('desligamentoDiario', ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(JSON.stringify({ ativo, hora, escopo, salas, vigenteDesde }));
}

function limpar(...codigos) {
  for (const c of codigos) {
    db.prepare("DELETE FROM desligamento_diario_execucoes WHERE sala = ?").run(c);
    db.prepare("DELETE FROM comandos_log WHERE sala = ?").run(c);
  }
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
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
  scheduler.pararScheduler();
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("the midnight cutoff turns ON rooms off once, leaves OFF rooms unchanged and records every room", () => {
  sala("DS-1", { ligado: true });
  sala("DS-2", { ligado: false });
  limpar("DS-1", "DS-2");
  configurar({ salas: ["DS-1", "DS-2"], vigenteDesde: brasiliaParaUtcSqlite("2026-09-06", "12:00") });
  const v1 = linha("DS-1").estadoVersao;
  const v2 = linha("DS-2").estadoVersao;

  assert.equal(desligamento.verificar({ agora: local("2026-09-06", "23:59", 59) })?.desligado?.length ?? 0, 0, "nothing before the cutoff");
  assert.equal(linha("DS-1").ligado, 1);

  const r = desligamento.verificar({ agora: local("2026-09-07", "00:00", 5) });
  assert.deepEqual(r.desligado, ["DS-1"]);
  assert.deepEqual(r.ja_desligado, ["DS-2"]);
  assert.equal(linha("DS-1").ligado, 0);
  assert.equal(linha("DS-1").estadoVersao, v1 + 1, "the OFF intent advances the desired-state version");
  assert.equal(linha("DS-2").estadoVersao, v2, "an OFF room is not touched");
  assert.deepEqual(logs("DS-1"), ["desligar:desligamento_diario"]);
  assert.deepEqual(registros("DS-1"), [{ data: "2026-09-07", hora: "00:00", resultado: "desligado" }]);
  assert.deepEqual(registros("DS-2"), [{ data: "2026-09-07", hora: "00:00", resultado: "ja_desligado" }]);

  for (const s of [0, 30, 59]) assert.equal(desligamento.verificar({ agora: local("2026-09-07", "00:01", s) }), null, "duplicate ticks do nothing");
  assert.equal(linha("DS-1").estadoVersao, v1 + 1);
  assert.equal(logs("DS-1").length, 1);
});

test("an arbitrary cutoff time applies only once the local time is reached", () => {
  sala("DS-3", { ligado: true });
  limpar("DS-3");
  configurar({ hora: "22:30", salas: ["DS-3"], vigenteDesde: brasiliaParaUtcSqlite("2026-09-07", "12:00") });
  assert.equal(desligamento.verificar({ agora: local("2026-09-07", "22:29", 59) }), null);
  assert.equal(linha("DS-3").ligado, 1);
  assert.deepEqual(desligamento.verificar({ agora: local("2026-09-07", "22:30") }).desligado, ["DS-3"]);
  assert.equal(linha("DS-3").ligado, 0);
});

test("a restart before the cutoff does nothing until the cutoff tick, which applies it", (t) => {
  sala("DS-4", { ligado: true });
  limpar("DS-4");
  configurar({ salas: ["DS-4"], vigenteDesde: brasiliaParaUtcSqlite("2026-09-07", "12:00") });
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: local("2026-09-07", "23:58", 30) });
  t.after(() => scheduler.pararScheduler());
  scheduler.iniciarScheduler();
  assert.equal(linha("DS-4").ligado, 1, "the startup pass before the cutoff leaves the room on");
  t.mock.timers.tick(60000);
  assert.equal(linha("DS-4").ligado, 1, "23:59 is still before the cutoff");
  t.mock.timers.tick(60000);
  assert.equal(linha("DS-4").ligado, 0, "the 00:00 tick applies the cutoff");
  assert.deepEqual(registros("DS-4"), [{ data: "2026-09-08", hora: "00:00", resultado: "desligado" }]);
  scheduler.pararScheduler();
});

test("a cutoff missed during downtime is applied once at startup, and repeated restarts never replay it", (t) => {
  sala("DS-5", { ligado: true });
  limpar("DS-5");
  configurar({ salas: ["DS-5"] });
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: local("2026-09-08", "07:10") });
  t.after(() => scheduler.pararScheduler());

  scheduler.iniciarScheduler();
  assert.equal(linha("DS-5").ligado, 0, "the server was down at 00:00; the startup pass recovers the OFF");
  const versao = linha("DS-5").estadoVersao;
  scheduler.pararScheduler();

  for (let i = 0; i < 3; i++) {
    scheduler.iniciarScheduler();
    t.mock.timers.tick(60000);
    scheduler.pararScheduler();
  }
  assert.equal(linha("DS-5").estadoVersao, versao);
  assert.deepEqual(logs("DS-5"), ["desligar:desligamento_diario"]);
  assert.equal(registros("DS-5").length, 1);
});

test("a late-evening cutoff missed across midnight is recovered from the previous day", () => {
  sala("DS-6", { ligado: true });
  limpar("DS-6");
  configurar({ hora: "23:30", salas: ["DS-6"] });
  const r = desligamento.verificar({ agora: local("2026-09-09", "01:00") });
  assert.deepEqual(r.desligado, ["DS-6"]);
  assert.deepEqual(registros("DS-6"), [{ data: "2026-09-08", hora: "23:30", resultado: "desligado" }]);
});

test("newer manual intent after the cutoff instant is not overwritten by a late run", () => {
  sala("DS-7", { ligado: false });
  limpar("DS-7");
  configurar({ salas: ["DS-7"] });
  salasService.aplicarComando("DS-7", "ligar", undefined, MANUAL);
  datarLogs("DS-7", brasiliaParaUtcSqlite("2026-09-10", "00:10"));
  const r = desligamento.verificar({ agora: local("2026-09-10", "00:20") });
  assert.deepEqual(r.intencao_mais_nova, ["DS-7"]);
  assert.equal(linha("DS-7").ligado, 1, "the user's ON after the cutoff stays");
  assert.deepEqual(registros("DS-7"), [{ data: "2026-09-10", hora: "00:00", resultado: "intencao_mais_nova" }]);
});

test("a manual ON after the processed cutoff stays until the next day's cutoff", () => {
  sala("DS-8", { ligado: true });
  limpar("DS-8");
  configurar({ salas: ["DS-8"] });
  desligamento.verificar({ agora: local("2026-09-11", "00:00", 30) });
  assert.equal(linha("DS-8").ligado, 0);

  salasService.aplicarComando("DS-8", "ligar", undefined, MANUAL);
  datarLogs("DS-8", brasiliaParaUtcSqlite("2026-09-11", "08:00"));
  for (const hora of ["08:01", "12:00", "23:59"]) {
    assert.equal(desligamento.verificar({ agora: local("2026-09-11", hora) }), null, hora);
    assert.equal(linha("DS-8").ligado, 1, `still on at ${hora}`);
  }
  assert.deepEqual(desligamento.verificar({ agora: local("2026-09-12", "00:00", 10) }).desligado, ["DS-8"]);
  assert.equal(linha("DS-8").ligado, 0);
});

test("a schedule holding the room across the cutoff keeps it on; a schedule starting later is unaffected", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: local("2026-09-12", "19:00") });
  sala("DS-9", { ligado: false });
  sala("DS-10", { ligado: true });
  limpar("DS-9", "DS-10");
  configurar({ hora: "21:00", salas: ["DS-9", "DS-10"] });
  const superadmin = db.prepare("SELECT id FROM usuarios WHERE nivel = 3").get();
  const ag = agendamentos.criar({ sala: "DS-9", usuarioId: superadmin.id, data: "2026-09-12", temperatura: 24, horaInicio: "20:00", horaFim: "22:00" });
  salasService.aplicarInicioAgendamento("DS-9", 24, { registrarNaTransacao: () => agendamentos.registrarExecucao(ag.id, "ligar", "2026-09-12") });
  datarLogs("DS-9", brasiliaParaUtcSqlite("2026-09-12", "20:00"));
  agendamentos.criar({ sala: "DS-10", usuarioId: superadmin.id, data: "2026-09-12", temperatura: 24, horaInicio: "21:30", horaFim: "22:30" });

  const r = desligamento.verificar({ agora: local("2026-09-12", "21:00", 20) });
  assert.deepEqual(r.agendamento_ativo, ["DS-9"]);
  assert.deepEqual(r.desligado, ["DS-10"], "a schedule that has not turned the room on does not hold it");
  assert.equal(linha("DS-9").ligado, 1, "the running schedule's own OFF ends it");
  assert.equal(linha("DS-10").ligado, 0);
});

test("an offline device receives the OFF desired state when it reconnects", async () => {
  sala("DS-11", { ligado: true, mac: "AA:BB:CC:D5:00:11" });
  limpar("DS-11");
  configurar({ salas: ["DS-11"] });
  const r = desligamento.verificar({ agora: local("2026-09-13", "00:00", 10) });
  assert.deepEqual(r.desligado, ["DS-11"]);
  assert.equal(linha("DS-11").ligado, 0);

  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": "DS-11", "x-device-mac": "AA:BB:CC:D5:00:11" } });
  abertos.add(ws);
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await ate(() => mensagens.some((m) => m.tipo === "device_role"));
  ws.send(JSON.stringify({ tipo: "info", fw: "4.3.0", failsafeConfigurado: false, failsafeLatched: false }));
  assert.ok(await ate(() => mensagens.some((m) => m.tipo === "send_known_state")));
  const estado = mensagens.find((m) => m.tipo === "send_known_state");
  assert.equal(estado.power, false, "reconnection delivers the latest desired state");
  assert.equal(estado.versao, linha("DS-11").estadoVersao);
  ws.close();
  await ate(() => !deviceHub.estadoPublico("DS-11").conectado);
});

test("the execution is audited and appears in the command history", () => {
  sala("DS-12", { ligado: true });
  limpar("DS-12");
  configurar({ salas: ["DS-12"] });
  const antes = db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'desligamento_diario_executado'").get().n;
  desligamento.verificar({ agora: local("2026-09-14", "00:00", 10) });
  const eventos = db.prepare("SELECT atorLogin, alvoId, descricao FROM auditoria_eventos WHERE tipo = 'desligamento_diario_executado' ORDER BY id").all();
  assert.equal(eventos.length, antes + 1);
  const ultimo = eventos.at(-1);
  assert.equal(ultimo.atorLogin, null, "the actor is the system");
  assert.equal(ultimo.alvoId, "2026-09-14 00:00");
  assert.match(ultimo.descricao, /1 desligada/);
  assert.deepEqual(logs("DS-12"), ["desligar:desligamento_diario"]);
});

test("a disabled daily shutdown does nothing", () => {
  sala("DS-13", { ligado: true });
  limpar("DS-13");
  configurar({ ativo: false, salas: ["DS-13"] });
  assert.equal(desligamento.verificar({ agora: local("2026-09-15", "00:00", 10) }), null);
  assert.equal(linha("DS-13").ligado, 1);
  assert.deepEqual(registros("DS-13"), []);
});

test("enabling or changing the configuration never applies to an occurrence already due", (t) => {
  sala("DS-14", { ligado: true });
  limpar("DS-14");
  configurar({ ativo: false, salas: ["DS-14"] });
  t.mock.timers.enable({ apis: ["Date"], now: local("2026-09-16", "10:00") });
  const cfg = configuracoesService.validarEAtualizar({ desligamentoDiario: { ativo: true, hora: "00:00", escopo: "selecionadas", salas: ["DS-14"] } }, SUPERADMIN).desligamentoDiario;
  assert.equal(cfg.vigenteDesde, brasiliaParaUtcSqlite("2026-09-16", "10:00"));
  assert.equal(desligamento.verificar({ agora: local("2026-09-16", "10:01") }), null, "today's 00:00 was due before the shutdown was enabled");
  assert.equal(linha("DS-14").ligado, 1);

  t.mock.timers.setTime(local("2026-09-16", "11:00").getTime());
  configuracoesService.validarEAtualizar({ desligamentoDiario: { hora: "18:00" } }, SUPERADMIN);
  assert.equal(desligamento.verificar({ agora: local("2026-09-16", "17:59") }), null);
  assert.deepEqual(desligamento.verificar({ agora: local("2026-09-16", "18:00", 5) }).desligado, ["DS-14"], "the new time applies later the same day");

  const situacao = desligamento.situacao(local("2026-09-16", "18:01"));
  assert.deepEqual({ data: situacao.proxima.data, hora: situacao.proxima.hora }, { data: "2026-09-17", hora: "18:00" });
  assert.deepEqual({ data: situacao.ultima.data, hora: situacao.ultima.hora }, { data: "2026-09-16", hora: "18:00" });
  assert.equal(situacao.ultima.contagens.desligado >= 1, true);

  t.mock.timers.setTime(local("2026-09-16", "19:00").getTime());
  const semMudanca = configuracoesService.validarEAtualizar({ desligamentoDiario: { hora: "18:00" } }, SUPERADMIN).desligamentoDiario;
  assert.equal(semMudanca.vigenteDesde, brasiliaParaUtcSqlite("2026-09-16", "11:00"), "saving the same values keeps the effective-since instant");
  const desligado = configuracoesService.validarEAtualizar({ desligamentoDiario: { ativo: false } }, SUPERADMIN).desligamentoDiario;
  assert.equal(desligado.vigenteDesde, null);
});

test("the scope covers only the selected rooms, refuses unknown rooms and skips rooms removed later", () => {
  sala("DS-15", { ligado: true });
  sala("DS-16", { ligado: true });
  sala("DS-17", { ligado: true });
  limpar("DS-15", "DS-16", "DS-17");
  assert.throws(() => configuracoesService.validarEAtualizar({ desligamentoDiario: { ativo: true, escopo: "selecionadas", salas: ["DS-15", "NAO-EXISTE"] } }, SUPERADMIN), /sala desconhecida/);
  assert.throws(() => configuracoesService.validarEAtualizar({ desligamentoDiario: { ativo: true, escopo: "selecionadas", salas: [] } }, SUPERADMIN), /ao menos uma sala/);
  configurar({ salas: ["DS-15", "DS-17"] });
  db.prepare("DELETE FROM salas WHERE sala = 'DS-17'").run();
  const r = desligamento.verificar({ agora: local("2026-09-17", "00:00", 10) });
  assert.deepEqual(r.desligado, ["DS-15"]);
  assert.equal(linha("DS-16").ligado, 1, "a room outside the scope is not touched");
  assert.deepEqual(registros("DS-17"), []);
});

test("the all-rooms scope includes rooms created after the configuration", () => {
  sala("DS-18", { ligado: true });
  limpar("DS-18");
  configurar({ escopo: "todas", salas: [] });
  const r = desligamento.verificar({ agora: local("2026-09-18", "00:00", 10) });
  assert.ok(r.desligado.includes("DS-18"));
  assert.equal(linha("DS-18").ligado, 0);
  configurar({ ativo: false });
});

test("a failure recording one room rolls back that room's OFF and the next tick completes it exactly once", () => {
  sala("DS-19", { ligado: true });
  sala("DS-20", { ligado: true });
  limpar("DS-19", "DS-20");
  configurar({ salas: ["DS-19", "DS-20"] });
  db.exec(`CREATE TEMP TRIGGER falha_ds19 BEFORE INSERT ON desligamento_diario_execucoes
    WHEN NEW.sala = 'DS-19' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END`);
  const v19 = linha("DS-19").estadoVersao;
  const r = desligamento.verificar({ agora: local("2026-09-19", "00:00", 10) });
  assert.deepEqual(r.falhas, ["DS-19"]);
  assert.deepEqual(r.desligado, ["DS-20"]);
  assert.equal(linha("DS-19").ligado, 1, "the room's state change rolled back with the failed record");
  assert.equal(linha("DS-19").estadoVersao, v19);
  assert.deepEqual(logs("DS-19"), [], "no command history without the record");
  assert.deepEqual(registros("DS-19"), []);

  db.exec("DROP TRIGGER falha_ds19");
  const r2 = desligamento.verificar({ agora: local("2026-09-19", "00:01", 10) });
  assert.deepEqual(r2.desligado, ["DS-19"], "only the unfinished room is processed");
  assert.equal(linha("DS-19").ligado, 0);
  assert.equal(linha("DS-19").estadoVersao, v19 + 1);
  assert.equal(registros("DS-20").length, 1, "the finished room is not repeated");
});

test("a scheduled OFF recovery treats the daily shutdown as newer intent", () => {
  sala("DS-21", { ligado: false });
  limpar("DS-21");
  configurar({ salas: ["DS-21"] });
  salasService.aplicarComando("DS-21", "ligar", undefined, MANUAL);
  datarLogs("DS-21", brasiliaParaUtcSqlite("2026-09-19", "23:00"));
  desligamento.verificar({ agora: local("2026-09-20", "00:00", 10) });
  db.prepare("UPDATE comandos_log SET criadoEm = ? WHERE sala = 'DS-21' AND origem = 'desligamento_diario'").run(brasiliaParaUtcSqlite("2026-09-20", "00:00"));
  assert.equal(salasService.intencaoAlteradaDesde("DS-21", brasiliaParaUtcSqlite("2026-09-19", "23:30")), true);
});

test("invalid daily shutdown values are refused and only the superadministrator configures or reads it", async () => {
  for (const [entrada, erro] of [
    [{ hora: "24:00" }, /HH:MM/],
    [{ hora: "7:00" }, /HH:MM/],
    [{ ativo: "true" }, /verdadeiro ou falso/],
    [{ escopo: "algumas" }, /escopo/],
    [{ salas: "DS-1" }, /lista de salas/],
    ["ligado", /objeto/],
  ]) {
    assert.throws(() => configuracoesService.validarEAtualizar({ desligamentoDiario: entrada }, SUPERADMIN), erro, JSON.stringify(entrada));
  }
  assert.throws(() => configuracoesService.validarEAtualizar({ desligamentoDiario: { ativo: true } }, { id: 2, nivel: 2 }), /superadministrador/);

  const usuariosService = require("../src/services/usuariosService");
  usuariosService.criar({ usuario: "adm-desligamento", senha: "senhaSegura123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "adm-desligamento", senha: "senhaSegura123" }),
  });
  const { token } = await login.json();
  const patch = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ desligamentoDiario: { ativo: true } }),
  });
  assert.equal(patch.status, 403);
  const leitura = await fetch(`${baseUrl}/admin/desligamento-diario`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(leitura.status, 403);
});

test("the superadministrator saves the configuration over HTTP, it is audited, and the status endpoint reports it", async () => {
  sala("DS-22", { ligado: false });
  const bcrypt = require("bcryptjs");
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'").run(bcrypt.hashSync("senhaDesligamento123", 10));
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "superadmin", senha: "senhaDesligamento123" }),
  });
  const { token } = await login.json();
  const resp = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ desligamentoDiario: { ativo: true, hora: "23:45", escopo: "selecionadas", salas: ["DS-22"], vigenteDesde: "1999-01-01 00:00:00" } }),
  });
  assert.equal(resp.status, 200);
  const salvo = (await resp.json()).configuracoes.desligamentoDiario;
  assert.equal(salvo.hora, "23:45");
  assert.notEqual(salvo.vigenteDesde, "1999-01-01 00:00:00", "the effective-since instant is set by the server, never by the client");

  const auditoria = db.prepare("SELECT camposAlterados FROM auditoria_eventos WHERE tipo = 'configuracao_alterada' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditoria.camposAlterados.split(",").includes("desligamentoDiario"));

  const status = await (await fetch(`${baseUrl}/admin/desligamento-diario`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(status.ok, true);
  assert.equal(status.configuracao.hora, "23:45");
  assert.equal(status.proxima.hora, "23:45");
  configurar({ ativo: false });
});
