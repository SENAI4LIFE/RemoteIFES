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
const salas = require("../src/services/salasService");
const configuracoesService = require("../src/services/configuracoesService");

const SUPERADMIN = { id: 1, nivel: 3, usuario: "superadmin" };
const contexto = { usuario: { id: 1, usuario: "superadmin", isAdmin: true }, origem: "manual" };
let server;
let baseUrl;

function reiniciar(sala, { ligado = 0, turbo = 0, alvo = 24 } = {}) {
  db.prepare("UPDATE salas SET ligado = ?, turboAtivo = ?, temperaturaAlvo = ? WHERE sala = ?").run(ligado, turbo, alvo, sala);
}

function logs(sala) {
  return db.prepare("SELECT cmd, valor, origem FROM comandos_log WHERE sala = ? ORDER BY id").all(sala).map((l) => ({ ...l }));
}

test.before(async () => {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo, mac) VALUES (?, ?, ?, ?, 0, 24, 0, ?)")
    .run("AUTO-1", "Sala auto ON", "A", 1, "AA:BB:CC:DD:EE:A1");
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("Auto-ON vem ligado por padrão em instalações novas, sem nenhuma linha gravada", () => {
  assert.equal(configuracoesService.PADROES.autoLigar, true);
  assert.equal(db.prepare("SELECT 1 FROM configuracoes WHERE chave = 'autoLigar'").get(), undefined);
  assert.equal(configuracoesService.obter().autoLigar, true);
  assert.equal(configuracoesService.autoLigarAtivo(), true);
  assert.equal(salas.statusCompleto("AUTO-1", SUPERADMIN).autoLigar, true);
});

test("com Auto-ON, alterar a temperatura de um aparelho desligado o liga com o novo alvo e registra o acionamento", () => {
  reiniciar("AUTO-1");
  db.prepare("DELETE FROM comandos_log WHERE sala = 'AUTO-1'").run();
  const resultado = salas.aplicarComando("AUTO-1", "temperatura", 23, contexto);
  assert.equal(resultado.ligado, 1);
  assert.equal(resultado.temperaturaAlvo, 23);
  assert.deepEqual(logs("AUTO-1"), [
    { cmd: "ligar", valor: "automatico", origem: "manual" },
    { cmd: "temperatura", valor: "23", origem: "manual" },
  ]);

  db.prepare("DELETE FROM comandos_log WHERE sala = 'AUTO-1'").run();
  salas.aplicarComando("AUTO-1", "temperatura", 25, contexto);
  assert.deepEqual(logs("AUTO-1"), [{ cmd: "temperatura", valor: "25", origem: "manual" }], "com o aparelho já ligado não há acionamento automático");
});

test("com Auto-ON, ativar o Turbo em um aparelho desligado o liga; desativar o Turbo nunca liga", () => {
  reiniciar("AUTO-1");
  const ligado = salas.aplicarComando("AUTO-1", "turbo", true, contexto);
  assert.equal(ligado.ligado, 1);
  assert.equal(ligado.turboAtivo, 1);

  reiniciar("AUTO-1", { turbo: 1 });
  const desligado = salas.aplicarComando("AUTO-1", "turbo", false, contexto);
  assert.equal(desligado.ligado, 0, "turbo=false não pode ligar um aparelho desligado");
  assert.equal(desligado.turboAtivo, 0);

  reiniciar("AUTO-1");
  assert.equal(salas.aplicarComando("AUTO-1", "turbo", false, contexto).ligado, 0);
  assert.equal(salas.aplicarComando("AUTO-1", "desligar", undefined, contexto).ligado, 0);
});

test("com Auto-ON desativado, os ajustes são guardados sem ligar o aparelho e o estado IR reflete isso", () => {
  configuracoesService.validarEAtualizar({ autoLigar: false }, SUPERADMIN);
  assert.equal(configuracoesService.obter().autoLigar, false);
  assert.equal(salas.statusCompleto("AUTO-1", SUPERADMIN).autoLigar, false);

  reiniciar("AUTO-1");
  db.prepare("DELETE FROM comandos_log WHERE sala = 'AUTO-1'").run();
  const temperatura = salas.aplicarComando("AUTO-1", "temperatura", 23, contexto);
  assert.equal(temperatura.ligado, 0);
  assert.equal(temperatura.temperaturaAlvo, 23);
  assert.deepEqual(logs("AUTO-1"), [{ cmd: "temperatura", valor: "23", origem: "manual" }]);

  const turbo = salas.aplicarComando("AUTO-1", "turbo", true, contexto);
  assert.equal(turbo.ligado, 0, "sem Auto-ON o Turbo não liga implicitamente");
  assert.equal(turbo.turboAtivo, 1);
  db.prepare("UPDATE salas SET irProtocolo = 5 WHERE sala = 'AUTO-1'").run();
  assert.equal(salas.comandoEstadoIR(salas.buscar("AUTO-1")).power, false);
  assert.equal(salas.aplicarComando("AUTO-1", "turbo", false, contexto).ligado, 0);

  reiniciar("AUTO-1", { ligado: 1 });
  const aindaLigado = salas.aplicarComando("AUTO-1", "temperatura", 25, contexto);
  assert.equal(aindaLigado.ligado, 1, "um aparelho já ligado continua ligado");
  assert.equal(aindaLigado.temperaturaAlvo, 25);
});

test("a preferência persiste no banco e volta a valer após uma nova leitura, como em um reinício do servidor", () => {
  assert.equal(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autoLigar'").get().valor, "false");
  assert.equal(configuracoesService.obter().autoLigar, false);
  configuracoesService.validarEAtualizar({ autoLigar: true }, SUPERADMIN);
  assert.equal(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autoLigar'").get().valor, "true");
  assert.equal(configuracoesService.obter().autoLigar, true);
  reiniciar("AUTO-1");
  assert.equal(salas.aplicarComando("AUTO-1", "temperatura", 24, contexto).ligado, 1);
});

test("mudar Auto-ON avisa os painéis abertos para refletirem a opção sem recarregar", async () => {
  const bcrypt = require("bcryptjs");
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'").run(bcrypt.hashSync("senhaAutoOn123", 10));
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "superadmin", senha: "senhaAutoOn123" }),
  });
  const { token } = await login.json();

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, [token]);
  const recebidas = [];
  ws.on("message", (dados) => recebidas.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ tipo: "observar", sala: "AUTO-1" }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(recebidas.filter((m) => m.tipo === "status").at(-1).status.autoLigar, true);

  recebidas.length = 0;
  const resp = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ autoLigar: false }),
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).configuracoes.autoLigar, false);
  await new Promise((r) => setTimeout(r, 80));
  const status = recebidas.filter((m) => m.tipo === "status").at(-1);
  assert.ok(status, "o painel observando a sala recebe um novo status");
  assert.equal(status.status.autoLigar, false);
  ws.close();

  const auditoria = db.prepare("SELECT camposAlterados FROM auditoria_eventos WHERE tipo = 'configuracao_alterada' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditoria && auditoria.camposAlterados.split(",").includes("autoLigar"), "a mudança global é auditada como as demais configurações");

  const semMudanca = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ autoLigar: false }),
  });
  assert.equal(semMudanca.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos WHERE tipo = 'configuracao_alterada'").get().n, 1, "salvar o mesmo valor não gera auditoria repetida");
  configuracoesService.validarEAtualizar({ autoLigar: true }, SUPERADMIN);
});

test("somente o superadministrador altera o Auto-ON", async () => {
  assert.throws(() => configuracoesService.validarEAtualizar({ autoLigar: false }, { id: 2, nivel: 2 }), /superadministrador/);
  assert.equal(configuracoesService.obter().autoLigar, true);
  const usuariosService = require("../src/services/usuariosService");
  usuariosService.criar({ usuario: "adm-auto-on", senha: "senhaSegura123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "adm-auto-on", senha: "senhaSegura123" }),
  });
  const { token } = await login.json();
  const resp = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ autoLigar: false }),
  });
  assert.equal(resp.status, 403);
  assert.equal(configuracoesService.obter().autoLigar, true);
});
