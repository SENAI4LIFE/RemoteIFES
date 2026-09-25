process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
require("../src/db/schema").criarSchema();
require("../src/db/seed").popularBanco();

const salasService = require("../src/services/salasService");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");
const configuracoesService = require("../src/services/configuracoesService");

function novaSala(sala) {
  db.prepare(
    `INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)`
  ).run(sala, sala);
  return salasService.buscar(sala);
}

test("effective limits use each room override independently", () => {
  novaSala("teste-limites-independentes");
  salasService.definirLimitesTemperatura("teste-limites-independentes", { minima: 18, maxima: null });
  let sala = salasService.buscar("teste-limites-independentes");
  let limites = require("../src/services/configuracoesService").limitesEfetivosDaSala(sala);
  assert.deepEqual(limites, { minima: 18, maxima: 25 });

  salasService.definirLimitesTemperatura("teste-limites-independentes", { minima: null, maxima: 28 });
  sala = salasService.buscar("teste-limites-independentes");
  limites = require("../src/services/configuracoesService").limitesEfetivosDaSala(sala);
  assert.deepEqual(limites, { minima: 23, maxima: 28 });
});

test("temperature commands respect the room's effective limits", () => {
  novaSala("teste-limites-comando");
  salasService.definirLimitesTemperatura("teste-limites-comando", { minima: 18, maxima: 28 });

  assert.throws(
    () => salasService.aplicarComando("teste-limites-comando", "temperatura", 17, { usuario: { isAdmin: true }, origem: "manual" }),
    /entre 18 e 28/
  );
  assert.doesNotThrow(
    () => salasService.aplicarComando("teste-limites-comando", "temperatura", 28, { usuario: { isAdmin: true }, origem: "manual" })
  );
});

test("turbo requires a boolean and preserves the configured state", () => {
  novaSala("teste-turbo");
  const configuracoesService = require("../src/services/configuracoesService");
  configuracoesService.validarEAtualizar({ turboFuncaoExtra: "swing" }, { id: 1, nivel: 3 });
  salasService.aplicarComando("teste-turbo", "turbo", true, { usuario: { isAdmin: true }, origem: "manual" });
  assert.equal(salasService.buscar("teste-turbo").turboAtivo, 1);
  db.prepare(`UPDATE salas SET irProtocolo = 5 WHERE sala = ?`).run("teste-turbo");
  assert.equal(salasService.comandoEstadoIR(salasService.buscar("teste-turbo")).swing, true);
  assert.throws(
    () => salasService.aplicarComando("teste-turbo", "turbo", "false", { usuario: { isAdmin: true }, origem: "manual" }),
    /verdadeiro ou falso/
  );
});
test("finding #12: a regular admin cannot delete another admin", () => {
  const admin1 = usuariosService.criar(
    { usuario: "teste-admin1-12", senha: "senhaSegura123", nome: "Admin Um", isAdmin: true },
    { nivel: 3 }
  );
  const admin2 = usuariosService.criar(
    { usuario: "teste-admin2-12", senha: "senhaSegura123", nome: "Admin Dois", isAdmin: true },
    { nivel: 3 }
  );

  assert.throws(
    () => usuariosService.remover(admin2.id, { id: admin1.id, nivel: usuariosService.NIVEL_ADMIN }),
    /apenas o superadministrador/,
    "a regular admin cannot remove another admin"
  );
  assert.ok(usuariosService.buscarPorId(admin2.id), "the target account must still exist after the blocked attempt");
});

test("finding #12: a superadmin can still delete an admin normally", () => {
  const admin = usuariosService.criar(
    { usuario: "teste-admin3-12", senha: "senhaSegura123", nome: "Admin Três", isAdmin: true },
    { nivel: 3 }
  );

  usuariosService.remover(admin.id, { id: 999999, nivel: usuariosService.NIVEL_SUPERADMIN });
  assert.equal(usuariosService.buscarPorId(admin.id), undefined, "the superadmin must be able to remove the admin");
});

test("finding #14: removing a user who has logged in does not fail on FOREIGN KEY (sessoes)", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-usuario-14", senha: "senhaSegura123", nome: "Usuário Com Sessão", podeControlar: true },
    { nivel: 3 }
  );
  tokenService.gerarToken(usuario.id);
  tokenService.gerarToken(usuario.id);

  assert.doesNotThrow(() => usuariosService.remover(usuario.id, { id: 999999, nivel: usuariosService.NIVEL_SUPERADMIN }));
  assert.equal(usuariosService.buscarPorId(usuario.id), undefined, "the user must have been removed");
  const sessoesRestantes = db.prepare(`SELECT COUNT(*) AS total FROM sessoes WHERE usuarioId = ?`).get(usuario.id);
  assert.equal(sessoesRestantes.total, 0, "the removed user's sessions must not be left orphaned");
});

test("finding #16: the session token is not stored in plain text in the database", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-usuario-16", senha: "senhaSegura123", nome: "Usuário Token", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);

  const linha = db.prepare(`SELECT token FROM sessoes WHERE usuarioId = ? ORDER BY id DESC LIMIT 1`).get(usuario.id);
  assert.notEqual(linha.token, token, "the stored value must not be the plain-text token");
  assert.equal(linha.token.length, 64, "the stored value must be the token's sha256 hash (64 hex)");

  const validado = tokenService.validarToken(token);
  assert.ok(validado, "validarToken must still accept the original plain-text token");
  assert.equal(validado.id, usuario.id);

  tokenService.removerToken(token);
  assert.equal(tokenService.validarToken(token), null, "after logout, the token must no longer validate");
});

test("a session expires at the absolute limit even with recent use", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-sessao-absoluta", senha: "senhaSegura123", nome: "Sessao Absoluta", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);
  db.prepare(`UPDATE sessoes SET login = datetime('now', '-13 hours'), ultimoUso = datetime('now') WHERE usuarioId = ?`).run(usuario.id);
  assert.equal(tokenService.validarToken(token), null);
});

test("default deadlines are 60 minutes for users and 720 for admin and superadmin", () => {
  assert.equal(configuracoesService.timeoutEfetivoParaUsuario(false), 60);
  assert.equal(configuracoesService.timeoutEfetivoParaUsuario(true), 720);
  const usuario = usuariosService.criar(
    { usuario: "teste-timeout-user", senha: "senhaSegura123", nome: "Timeout User", podeControlar: true },
    { nivel: 3 }
  );
  const admin = usuariosService.criar(
    { usuario: "teste-timeout-admin", senha: "senhaSegura123", nome: "Timeout Admin", isAdmin: true },
    { nivel: 3 }
  );
  const tokenUsuario = tokenService.gerarToken(usuario.id);
  const tokenAdmin = tokenService.gerarToken(admin.id);
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-61 minutes') WHERE usuarioId = ?").run(usuario.id);
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-61 minutes') WHERE usuarioId = ?").run(admin.id);
  assert.equal(tokenService.validarToken(tokenUsuario, { atualizarUso: false }), null);
  assert.ok(tokenService.validarToken(tokenAdmin, { atualizarUso: false }));
});

test("authenticated use renews the deadline returned by the server", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-timeout-renova", senha: "senhaSegura123", nome: "Timeout Renova", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-30 minutes') WHERE usuarioId = ?").run(usuario.id);
  const antes = tokenService.validarToken(token, { atualizarUso: false });
  const depois = tokenService.validarToken(token);
  assert.ok(Date.parse(depois.sessaoExpiraEm) - Date.parse(antes.sessaoExpiraEm) > 25 * 60000);
});

test("legacy timeout configuration migrates without losing the administrative choice", () => {
  const gravar = db.prepare("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)");
  gravar.run("timeoutInatividadeMinutos", JSON.stringify(90));
  gravar.run("adminSujeitoTimeout", JSON.stringify(true));
  db.prepare("DELETE FROM configuracoes WHERE chave = 'timeoutInatividadeAdminMinutos'").run();
  assert.equal(configuracoesService.timeoutEfetivoParaUsuario(false), 90);
  assert.equal(configuracoesService.timeoutEfetivoParaUsuario(true), 90);
  db.prepare("DELETE FROM configuracoes WHERE chave IN ('timeoutInatividadeMinutos', 'adminSujeitoTimeout')").run();
});
