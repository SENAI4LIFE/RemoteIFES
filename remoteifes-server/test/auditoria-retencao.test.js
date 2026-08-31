process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const auditoriaService = require("../src/services/auditoriaService");
const configuracoesService = require("../src/services/configuracoesService");
const retencaoService = require("../src/services/retencaoService");
const monitoramentoService = require("../src/services/monitoramentoService");

let server;
let baseUrl;
let tokenSuper;
let tokenAdmin;
let tokenUsuario;

async function requisitar(caminho, { token, method = "GET", body } = {}) {
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
  const resp = await requisitar("/login", { method: "POST", body: { usuario, senha } });
  return (await resp.json()).token;
}

test.before(async () => {
  usuariosService.criar({ usuario: "audit-admin", senha: "SenhaAdmin123", nome: "Admin audit", isAdmin: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "audit-user", senha: "SenhaUser123", nome: "User audit" }, { nivel: 3 });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenSuper = await login("superadmin", "admin");
  tokenAdmin = await login("audit-admin", "SenhaAdmin123");
  tokenUsuario = await login("audit-user", "SenhaUser123");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("auditoria e conectividade são exclusivas do superadministrador", async () => {
  for (const caminho of ["/admin/auditoria", "/admin/auditoria/tipos", "/admin/auditoria/conectividade"]) {
    assert.equal((await requisitar(caminho)).status, 401);
    assert.equal((await requisitar(caminho, { token: tokenUsuario })).status, 403);
    assert.equal((await requisitar(caminho, { token: tokenAdmin })).status, 403);
    assert.equal((await requisitar(caminho, { token: tokenSuper })).status, 200);
  }
});

test("criação, renomeação, mudança de papel, senha e exclusão geram histórico sem segredos", async () => {
  const segredoSenha = "NaoPodeAparecer-987";
  const criadaResp = await requisitar("/admin/usuarios", {
    token: tokenSuper,
    method: "POST",
    body: { usuario: "audit-target", nome: "Alvo", senha: segredoSenha, podeControlar: true },
  });
  assert.equal(criadaResp.status, 200);
  const criada = (await criadaResp.json()).usuario;
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}/nome`, { token: tokenSuper, method: "PATCH", body: { novoNome: "Alvo Novo" } })).status, 200);
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}/login`, { token: tokenSuper, method: "PATCH", body: { novoLogin: "audit-target-new" } })).status, 200);
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}`, { token: tokenSuper, method: "PATCH", body: { nivel: 2 } })).status, 200);
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}/senha`, { token: tokenSuper, method: "PATCH", body: { novaSenha: "OutroSegredo-654" } })).status, 200);
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}`, { token: tokenSuper, method: "PATCH", body: { nivel: 1 } })).status, 200);
  assert.equal((await requisitar(`/admin/usuarios/${criada.id}`, { token: tokenSuper, method: "DELETE" })).status, 200);

  const eventos = db.prepare("SELECT * FROM auditoria_eventos WHERE alvoId = ? ORDER BY id").all(String(criada.id));
  const tipos = new Set(eventos.map((e) => e.tipo));
  assert.ok(tipos.has("conta_criada"));
  assert.ok(tipos.has("conta_login_alterado"));
  assert.ok(tipos.has("conta_permissoes_alteradas"));
  assert.ok(tipos.has("conta_senha_redefinida"));
  assert.ok(tipos.has("conta_excluida"));
  const bruto = JSON.stringify(auditoriaService.listar({ limite: 100 }));
  assert.ok(!bruto.includes(segredoSenha));
  assert.ok(!bruto.includes("OutroSegredo-654"));
  assert.ok(!bruto.includes("Bearer "));
  assert.ok(!bruto.includes("segredoHash"));
});

test("paginação e filtros têm limite de consulta", async () => {
  for (let i = 0; i < 31; i += 1) {
    auditoriaService.registrar({ tipo: "evento_paginado", ator: { id: 1, usuario: "ator-pagina" }, alvoTipo: "teste", alvoId: i, alvoRotulo: `alvo-${i}`, descricao: `Evento ${i}` });
  }
  const primeira = auditoriaService.listar({ tipo: "evento_paginado", pagina: 1, limite: 10 });
  const quarta = auditoriaService.listar({ tipo: "evento_paginado", pagina: 4, limite: 10 });
  assert.equal(primeira.itens.length, 10);
  assert.equal(primeira.total, 31);
  assert.equal(primeira.paginas, 4);
  assert.equal(quarta.itens.length, 1);
  assert.throws(() => auditoriaService.listar({ limite: 101 }), /limite invalido/);
  assert.equal((await requisitar("/admin/auditoria?limite=101", { token: tokenSuper })).status, 400);
});

test("indisponibilidade fecha na reconexão e suprime offline duplicado", () => {
  const sala = "AUD-CONNECT";
  assert.equal(auditoriaService.registrarOffline(sala, "2026-08-30T14:32:10Z"), true);
  assert.equal(auditoriaService.registrarOffline(sala, "2026-08-30T14:33:10Z"), false);
  const fechado = auditoriaService.registrarOnline(sala, "2026-08-30T14:37:42Z");
  assert.equal(fechado.duracaoSegundos, 332);
  assert.equal(auditoriaService.registrarOnline(sala, "2026-08-30T14:38:00Z"), null);
  const lista = auditoriaService.listarConectividade({ sala, data: "2026-08-30" });
  assert.equal(lista.total, 1);
  assert.equal(lista.itens[0].onlineEm, "2026-08-30 14:37:42");
});

test("retenção padrão é 7 dias, configurável e preserva dados permanentes", () => {
  assert.equal(configuracoesService.obter().retencaoAuditoriaDias, 7);
  const adminId = db.prepare("SELECT id FROM usuarios WHERE usuario = 'superadmin'").get().id;
  db.prepare("INSERT INTO auditoria_eventos (tipo, descricao, criadoEm) VALUES ('antigo', 'antigo', datetime('now', '-8 days'))").run();
  db.prepare("INSERT INTO auditoria_eventos (tipo, descricao, criadoEm) VALUES ('recente', 'recente', datetime('now', '-6 days'))").run();
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES ('OLD-ESP', datetime('now', '-8 days'), datetime('now', '-8 days'), 10)").run();
  db.prepare("INSERT INTO relatos (usuarioId, titulo, descricao, status, criadoEm, atualizadoEm) VALUES (?, 'relato permanente audit', 'não apagar', 'aberto', datetime('now', '-400 days'), datetime('now', '-400 days'))").run(adminId);
  retencaoService.executarLimpezaRetencao();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'antigo'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'recente'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM esp_indisponibilidades WHERE sala = 'OLD-ESP'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM relatos WHERE titulo = 'relato permanente audit'").get().n, 1);

  configuracoesService.validarEAtualizar({ retencaoAuditoriaDias: 3 }, { nivel: 3 });
  retencaoService.executarLimpezaRetencao();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'recente'").get().n, 0);
  assert.throws(() => configuracoesService.validarEAtualizar({ retencaoAuditoriaDias: 0 }, { nivel: 3 }), /entre 1 e 365/);
  assert.throws(() => configuracoesService.validarEAtualizar({ retencaoAuditoriaDias: 366 }, { nivel: 3 }), /entre 1 e 365/);
});

test("simulação de meses fica limitada por retenção e teto de linhas", () => {
  configuracoesService.validarEAtualizar({ retencaoAuditoriaDias: 7 }, { nivel: 3 });
  const inserir = db.prepare("INSERT INTO auditoria_eventos (tipo, descricao, criadoEm) VALUES ('simulacao_meses', 'evento sintetico', datetime('now', ?))");
  db.exec("BEGIN");
  try {
    for (let dia = 0; dia < 180; dia += 1) {
      for (let i = 0; i < 400; i += 1) inserir.run(`-${dia} days`);
    }
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'simulacao_meses'").get().n, 72000);
  retencaoService.executarLimpezaRetencao();
  const restantes = db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'simulacao_meses'").get().n;
  const total = db.prepare("SELECT COUNT(*) n FROM auditoria_eventos").get().n;
  assert.ok(restantes <= 3200, `restaram ${restantes} eventos sintéticos`);
  assert.ok(total <= retencaoService.LIMITES_LINHAS.auditoria_eventos);
});

test("limiares de armazenamento distinguem alerta e condição crítica", () => {
  const gb = 1024 ** 3;
  assert.deepEqual(monitoramentoService.avaliarEspaco(100 * gb, 20 * gb), { livrePercent: 20, alerta: false, critico: false });
  assert.deepEqual(monitoramentoService.avaliarEspaco(100 * gb, 8 * gb), { livrePercent: 8, alerta: true, critico: false });
  assert.deepEqual(monitoramentoService.avaliarEspaco(100 * gb, 4 * gb), { livrePercent: 4, alerta: true, critico: true });
  assert.equal(monitoramentoService.avaliarEspaco(10 * gb, 400 * 1024 ** 2).critico, true);
});

test("banco novo usa vacuum incremental e limites leves de WAL", () => {
  assert.equal(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 2);
  assert.equal(db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint, 1000);
  assert.equal(db.prepare("PRAGMA journal_size_limit").get().journal_size_limit, 16 * 1024 * 1024);
});
