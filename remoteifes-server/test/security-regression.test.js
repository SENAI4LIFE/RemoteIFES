process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.DEVICE_TOKEN = process.env.DEVICE_TOKEN || "test-only-device-token";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
require("../src/db/schema").criarSchema();
require("../src/db/seed").popularBanco();

const salasService = require("../src/services/salasService");
const presetsService = require("../src/services/presetsService");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

function novaSala(sala) {
  db.prepare(
    `INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)`
  ).run(sala, sala);
  return salasService.buscar(sala);
}

test("achado #13 — dispositivo não consegue sobrescrever o preset padrão global por nome", () => {
  const padraoAntes = presetsService.presetPadrao();

  const atacante = novaSala("teste-sala-atacante-13a");
  const resultado = presetsService.sincronizarPresetDaSala({
    presetIdAtual: atacante.presetId || null,
    nome: "Padrão",
    funcoes: [{ chave: "temperatura", rotulo: "temperatura", tipo: "numero", opcoes: { min: -50, max: 200 } }],
  });
  salasService.definirPreset("teste-sala-atacante-13a", resultado.id);

  const padraoDepois = presetsService.presetPadrao();
  assert.equal(padraoDepois.id, padraoAntes.id, "o preset padrão original deve continuar sendo o mesmo registro");
  assert.deepEqual(
    padraoDepois.funcoes,
    padraoAntes.funcoes,
    "as funções do preset padrão não podem ser alteradas por um dispositivo de outra sala"
  );
  assert.notEqual(resultado.id, padraoAntes.id, "o dispositivo atacante deve receber um preset próprio, não o padrão");
});

test("achado #13 — dispositivo não consegue sobrescrever o preset de outra sala por colisão de nome", () => {
  const vitima = novaSala("teste-sala-vitima-13b");
  const infoPresetVitima = db
    .prepare(`INSERT INTO presets (nome, padrao) VALUES ('Preset Vitima 13b', 0)`)
    .run();
  const presetVitimaId = Number(infoPresetVitima.lastInsertRowid);
  db.prepare(
    `INSERT INTO preset_funcoes (presetId, chave, rotulo, tipo, opcoes, ordem) VALUES (?, 'temperatura', 'Temperatura', 'numero', ?, 0)`
  ).run(presetVitimaId, JSON.stringify({ min: 18, max: 28 }));
  salasService.definirPreset("teste-sala-vitima-13b", presetVitimaId);

  const atacante = novaSala("teste-sala-atacante-13b");
  presetsService.sincronizarPresetDaSala({
    presetIdAtual: atacante.presetId || null,
    nome: "Preset Vitima 13b",
    funcoes: [{ chave: "temperatura", rotulo: "hax", tipo: "numero", opcoes: { min: -99, max: 999 } }],
  });

  const presetVitimaDepois = presetsService.buscarPorId(presetVitimaId);
  const funcaoTemperatura = presetVitimaDepois.funcoes.find((f) => f.chave === "temperatura");
  assert.equal(funcaoTemperatura.opcoes.min, 18);
  assert.equal(funcaoTemperatura.opcoes.max, 28);
});

test("achado #13 — atualização legítima do próprio preset continua funcionando in-place", () => {
  const sala = novaSala("teste-sala-legitima-13c");
  const criado = presetsService.sincronizarPresetDaSala({
    presetIdAtual: sala.presetId || null,
    nome: "Preset legítimo 13c",
    funcoes: [{ chave: "luz", rotulo: "Luz", tipo: "booleano" }],
  });
  salasService.definirPreset("teste-sala-legitima-13c", criado.id);

  const atualizado = presetsService.sincronizarPresetDaSala({
    presetIdAtual: criado.id,
    nome: "Preset legítimo 13c",
    funcoes: [{ chave: "luz", rotulo: "Luz regulável", tipo: "numero", opcoes: { min: 0, max: 100 } }],
  });

  assert.equal(atualizado.id, criado.id, "deve reaproveitar o mesmo preset (in-place), não duplicar");
  const funcaoLuz = atualizado.funcoes.find((f) => f.chave === "luz");
  assert.equal(funcaoLuz.tipo, "numero");
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
