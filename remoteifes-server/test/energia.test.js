process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const energiaService = require("../src/services/energiaService");
const usuariosService = require("../src/services/usuariosService");
const salasService = require("../src/services/salasService");
const retencaoService = require("../src/services/retencaoService");

let server;
let baseUrl;
let superToken;
let adminToken;
let userToken;

async function request(caminho, { token, method = "GET", body } = {}) {
  return fetch(`${baseUrl}${caminho}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(usuario, senha) {
  const resp = await request("/login", { method: "POST", body: { usuario, senha } });
  return (await resp.json()).token;
}

test.before(async () => {
  usuariosService.criar({ usuario: "energia-admin", senha: "SenhaAdmin123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "energia-user", senha: "SenhaUser123", nome: "User" }, { nivel: 3 });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  superToken = await login("superadmin", "admin");
  adminToken = await login("energia-admin", "SenhaAdmin123");
  userToken = await login("energia-user", "SenhaUser123");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("API de energia é exclusiva do superadministrador", async () => {
  for (const [token, status] of [[null, 401], [userToken, 403], [adminToken, 403], [superToken, 200]]) {
    assert.equal((await request("/admin/energia", { token })).status, status);
  }
  assert.equal((await request("/admin/energia/A-103a", { token: adminToken, method: "PATCH", body: { potenciaWatts: 1200, tipo: "inverter" } })).status, 403);
});

test("potência e tipo persistem, validam limites e podem permanecer ausentes", async () => {
  const sala = "A-103a";
  let resp = await request(`/admin/energia/${sala}`, { token: superToken, method: "PATCH", body: { potenciaWatts: 1450, tipo: "inverter" } });
  assert.equal(resp.status, 200);
  const salva = db.prepare("SELECT potenciaWatts, tipo FROM energia_configuracoes WHERE sala = ?").get(sala);
  assert.equal(salva.potenciaWatts, 1450);
  assert.equal(salva.tipo, "inverter");
  resp = await request(`/admin/energia/${sala}`, { token: superToken, method: "PATCH", body: { potenciaWatts: 99, tipo: "fixo" } });
  assert.equal(resp.status, 400);
  resp = await request(`/admin/energia/${sala}`, { token: superToken, method: "PATCH", body: { potenciaWatts: null, tipo: "inverter" } });
  assert.equal(resp.status, 200);
  assert.equal(db.prepare("SELECT * FROM energia_configuracoes WHERE sala = ?").get(sala), undefined);
  const corpo = await (await request("/admin/energia", { token: superToken })).json();
  const semConfig = corpo.salas.find((item) => item.sala === sala);
  assert.equal(semConfig.configuracao, null);
  assert.equal(semConfig.hoje.kwhEstimado, null);
  assert.match(corpo.modelo.potenciaNaoRepresenta, /BTU\/h/);
});

test("modelo usa potência elétrica, horas e fator de carga de forma consistente", () => {
  const linha = {
    segundosObservados: 3600,
    segundosLigado: 3600,
    segundosCargaInverter: 2340,
    segundosTelemetriaLigado: 1800,
    temperaturaAlvoPonderada: 22 * 3600,
  };
  const fixo = energiaService.estimativaPeriodo(linha, { potenciaWatts: 1000, tipo: "fixo" }, 3600);
  const inverter = energiaService.estimativaPeriodo(linha, { potenciaWatts: 1000, tipo: "inverter" }, 3600);
  assert.equal(fixo.kwhEstimado, 1);
  assert.equal(inverter.kwhEstimado, 0.65);
  assert.equal(inverter.potenciaMediaEstimadaWatts, 650);
  assert.equal(inverter.temperaturaAlvoMedia, 22);
  assert.equal(energiaService.fatorInverter(26, 22), 0.83);
  assert.equal(energiaService.fatorInverter(null, 22), energiaService.FATOR_INVERTER_SEM_TELEMETRIA);
});

test("agregação diária é compacta e marca ausência de telemetria sem inventar temperatura", () => {
  const sala = "A-104";
  const inicio = Date.parse("2026-08-30T12:00:00Z");
  db.prepare("DELETE FROM energia_estados WHERE sala = ?").run(sala);
  db.prepare("DELETE FROM energia_resumos_diarios WHERE sala = ?").run(sala);
  db.prepare("UPDATE salas SET ligado = 1, temperatura = 26, temperaturaAlvo = 22, ultimoHeartbeat = ? WHERE sala = ?").run("2026-08-30 12:00:00", sala);
  energiaService.sincronizarSala(sala, new Date(inicio));
  for (let minutos = 5; minutos <= 20; minutos += 5) energiaService.consolidarSala(sala, new Date(inicio + minutos * 60000));
  const resumo = db.prepare("SELECT * FROM energia_resumos_diarios WHERE sala = ?").get(sala);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM energia_resumos_diarios WHERE sala = ?").get(sala).n, 1);
  assert.equal(resumo.segundosLigado, 1200);
  assert.equal(resumo.segundosTelemetriaLigado, 300);
  assert.ok(Math.abs(resumo.segundosCargaInverter - 834) < 0.01);
  assert.equal(resumo.temperaturaAmbienteMin, 26);
  assert.equal(resumo.temperaturaAmbienteMax, 26);
  const estimado = energiaService.estimativaPeriodo(resumo, { potenciaWatts: 1000, tipo: "inverter" }, 1200);
  assert.equal(estimado.temperaturaAmbienteMedia, 26);
});

test("configuração ausente e falha do estimador não alteram controle normal", () => {
  const sala = "A-105";
  db.prepare("DELETE FROM energia_configuracoes WHERE sala = ?").run(sala);
  const antes = db.prepare("SELECT COUNT(*) n FROM energia_configuracoes WHERE sala = ?").get(sala).n;
  const consolidarOriginal = energiaService.consolidarSala;
  const sincronizarOriginal = energiaService.sincronizarSala;
  energiaService.consolidarSala = () => { throw new Error("falha sintética"); };
  energiaService.sincronizarSala = () => { throw new Error("falha sintética"); };
  let resultado;
  try {
    resultado = salasService.aplicarComando(sala, "ligar", undefined, { usuario: { usuario: "teste", isAdmin: true }, origem: "manual" });
  } finally {
    energiaService.consolidarSala = consolidarOriginal;
    energiaService.sincronizarSala = sincronizarOriginal;
  }
  assert.equal(resultado.ligado, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM energia_configuracoes WHERE sala = ?").get(sala).n, antes);
  salasService.aplicarComando(sala, "desligar", undefined, { usuario: { usuario: "teste", isAdmin: true }, origem: "manual" });
});

test("um ano sintético de resumos é reduzido à janela de 45 dias", () => {
  const sala = "A-106";
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  db.prepare("DELETE FROM energia_resumos_diarios WHERE sala = ?").run(sala);
  const inserir = db.prepare(`INSERT INTO energia_resumos_diarios (sala, data, segundosObservados, segundosLigado, segundosCargaInverter)
    VALUES (?, date(?, ?), 86400, 3600, 2340)`);
  for (let dia = 0; dia < 365; dia += 1) inserir.run(sala, hoje, `-${dia} days`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM energia_resumos_diarios WHERE sala = ?").get(sala).n, 365);
  retencaoService.executarLimpezaRetencao();
  const restantes = db.prepare("SELECT COUNT(*) n FROM energia_resumos_diarios WHERE sala = ?").get(sala).n;
  assert.ok(restantes <= 46, `restaram ${restantes} resumos`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM salas WHERE sala = ?").get(sala).n, 1);
});
