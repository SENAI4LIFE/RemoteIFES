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

function novaSala(sala) {
  db.prepare(
    `INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)`
  ).run(sala, sala);
  return salasService.buscar(sala);
}

test("limites efetivos usam cada substituição de sala de forma independente", () => {
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

test("comandos de temperatura respeitam os limites efetivos da sala", () => {
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

test("turbo exige booleano e preserva o estado configurado", () => {
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
test("achado #12 — admin comum não consegue excluir outro admin", () => {
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
    /apenas o administrador principal/,
    "um admin comum não pode remover outro admin"
  );
  assert.ok(usuariosService.buscarPorId(admin2.id), "a conta alvo deve continuar existindo após a tentativa bloqueada");
});

test("achado #12 — superadmin ainda consegue excluir um admin normalmente", () => {
  const admin = usuariosService.criar(
    { usuario: "teste-admin3-12", senha: "senhaSegura123", nome: "Admin Três", isAdmin: true },
    { nivel: 3 }
  );

  usuariosService.remover(admin.id, { id: 999999, nivel: usuariosService.NIVEL_SUPERADMIN });
  assert.equal(usuariosService.buscarPorId(admin.id), undefined, "o superadmin deve conseguir remover o admin");
});

test("achado #14 — remover um usuário que já fez login não falha por FOREIGN KEY (sessoes)", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-usuario-14", senha: "senhaSegura123", nome: "Usuário Com Sessão", podeControlar: true },
    { nivel: 3 }
  );
  tokenService.gerarToken(usuario.id);
  tokenService.gerarToken(usuario.id);

  assert.doesNotThrow(() => usuariosService.remover(usuario.id, { id: 999999, nivel: usuariosService.NIVEL_SUPERADMIN }));
  assert.equal(usuariosService.buscarPorId(usuario.id), undefined, "o usuário deve ter sido removido");
  const sessoesRestantes = db.prepare(`SELECT COUNT(*) AS total FROM sessoes WHERE usuarioId = ?`).get(usuario.id);
  assert.equal(sessoesRestantes.total, 0, "as sessões do usuário removido não devem sobrar órfãs");
});

test("achado #16 — o token de sessão não é armazenado em texto puro no banco", () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-usuario-16", senha: "senhaSegura123", nome: "Usuário Token", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);

  const linha = db.prepare(`SELECT token FROM sessoes WHERE usuarioId = ? ORDER BY id DESC LIMIT 1`).get(usuario.id);
  assert.notEqual(linha.token, token, "o valor gravado não pode ser o token em texto puro");
  assert.equal(linha.token.length, 64, "o valor gravado deve ser o hash sha256 (64 hex) do token");

  const validado = tokenService.validarToken(token);
  assert.ok(validado, "validarToken deve continuar aceitando o token original em texto puro");
  assert.equal(validado.id, usuario.id);

  tokenService.removerToken(token);
  assert.equal(tokenService.validarToken(token), null, "após logout, o token não deve mais validar");
});
