process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const agendamentos = require("../src/services/agendamentosService");
const configuracoesService = require("../src/services/configuracoesService");
const { dataAtualBrasiliaISO } = require("../src/utils/tempo");

let server;
let baseUrl;
let tokenSuper;

async function chamar(path, { method = "GET", token, body, bruto } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || bruto !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${baseUrl}${path}`, { method, headers, body: bruto !== undefined ? bruto : body !== undefined ? JSON.stringify(body) : undefined });
  const texto = await resp.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  return { status: resp.status, corpo };
}

async function login(usuario, senha) {
  return chamar("/login", { method: "POST", body: { usuario, senha } });
}

function auditoriaDe(id) {
  return db.prepare("SELECT tipo, camposAlterados FROM auditoria_eventos WHERE alvoTipo = 'usuario' AND alvoId = ? ORDER BY id").all(String(id));
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenSuper = (await login("superadmin", "admin")).corpo.token;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test("a body above the limit receives 413 on any JSON route without an internal error; malformed JSON is still 400", async () => {
  const grande = JSON.stringify({ usuario: "x".repeat(200 * 1024), senha: "y" });
  const login = await chamar("/login", { method: "POST", bruto: grande });
  assert.equal(login.status, 413);
  assert.deepEqual(login.corpo, { ok: false, erro: "corpo da requisição muito grande" });

  const comando = await chamar("/comando", { method: "POST", token: tokenSuper, bruto: JSON.stringify({ sala: "A-108", cmd: "ligar", lixo: "z".repeat(200 * 1024) }) });
  assert.equal(comando.status, 413);
  assert.equal(comando.corpo.ok, false);

  const malformado = await chamar("/login", { method: "POST", bruto: "{ isto não é json" });
  assert.equal(malformado.status, 400);
  assert.equal(malformado.corpo.erro, "corpo da requisição inválido");
});

test("a corrupt compressed body or an undecodable path parameter is a 400, not an internal error", async () => {
  const erros = [];
  const original = console.error;
  console.error = (...partes) => erros.push(partes.join(" "));
  try {
    for (const codificacao of ["gzip", "deflate"]) {
      const resp = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Encoding": codificacao },
        body: "isto não está comprimido",
      });
      assert.equal(resp.status, 400, codificacao);
      assert.deepEqual(await resp.json(), { ok: false, erro: "requisição inválida" });
    }
    const parametro = await chamar("/salas/%ZZ/proprietario/acesso");
    assert.equal(parametro.status, 400);
    assert.deepEqual(parametro.corpo, { ok: false, erro: "requisição inválida" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros.filter((linha) => linha.includes("erro-nao-tratado")), []);
});

test("GET /agendamentos requires a scalar sala: array, repeated key and object receive 400", async () => {
  for (const consulta of ["sala[]=x", "sala=x&sala=y", "sala[a]=b"]) {
    const resp = await chamar(`/agendamentos?${consulta}`, { token: tokenSuper });
    assert.equal(resp.status, 400, consulta);
    assert.deepEqual(resp.corpo, { ok: false, erro: "sala inválida" });
  }
  assert.equal((await chamar("/agendamentos?sala=A-108", { token: tokenSuper })).status, 200);
  assert.equal((await chamar("/agendamentos", { token: tokenSuper })).status, 200);
});

test("PATCH /agendamentos/:id accepts only a boolean ativo", async () => {
  const superadmin = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
  const ag = agendamentos.criar({ sala: "A-109", usuarioId: superadmin.id, data: dataAtualBrasiliaISO(), horaInicio: "08:00", horaFim: "09:00", temperatura: 24, modo: "reserva" });
  const desativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0);

  for (const valor of ["false", "true", 0, 1, null, "sim"]) {
    const resp = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0, `${JSON.stringify(valor)} must not reactivate by coercion`);
  }
  assert.equal((await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: {} })).status, 400);

  const reativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 1);
});

test("disabling an account with ativo=false revokes the session immediately; ambiguous representations are refused; re-enabling restores access", async () => {
  const conta = usuariosService.criar({ usuario: "norm-ativo", senha: "senhaSegura123", nome: "Normalização", podeControlar: true }, { nivel: 3 });
  const sessao = (await login("norm-ativo", "senhaSegura123")).corpo.token;
  assert.equal((await chamar("/me", { token: sessao })).status, 200);

  for (const valor of ["false", 0, "0", "não", null]) {
    const resp = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(usuariosService.buscarPorId(conta.id).ativo, 1, `${JSON.stringify(valor)} does not change the account`);
    assert.equal((await chamar("/me", { token: sessao })).status, 200, "and does not touch the session");
  }
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { podeControlar: 1 } })).status, 400);
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { isAdmin: "true" } })).status, 400);

  const noop = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(noop.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 200, "confirming the current value revokes nothing");

  const desativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(desativar.corpo.usuario.ativo, false);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "the old token is refused immediately");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 401, "an inactive account does not log in");

  const reativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "reactivating does not revive the revoked session");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 200, "but allows logging in again");
});

test("the permissions audit lists exactly the fields that changed", async () => {
  const conta = usuariosService.criar({ usuario: "norm-audit", senha: "senhaSegura123", nome: "Auditoria", podeControlar: true }, { nivel: 3 });
  const patch = (body) => chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body });

  assert.equal((await patch({})).status, 200);
  assert.equal((await patch({ ativo: true, podeControlar: true })).status, 200);
  assert.deepEqual(auditoriaDe(conta.id).filter((e) => e.tipo === "conta_permissoes_alteradas"), [], "without an effective change there is no event");

  assert.equal((await patch({ podeControlar: false })).status, 200);
  assert.equal((await patch({ ativo: false })).status, 200);
  assert.equal((await patch({ ativo: true, podeControlar: true })).status, 200);
  assert.equal((await patch({ isAdmin: true })).status, 200);
  assert.equal((await patch({ isAdmin: false, podeControlar: false, ativo: false })).status, 200);
  assert.deepEqual(
    auditoriaDe(conta.id).filter((e) => e.tipo === "conta_permissoes_alteradas").map((e) => e.camposAlterados),
    ["podeControlar", "ativo", "podeControlar,ativo", "nivel", "nivel,podeControlar,ativo"]
  );
});

test("granting access or ownership to a nonexistent user answers with its own message, not the SQLite error", async () => {
  for (const rota of ["/admin/salas/A-108/acesso/999999", "/admin/salas/A-108/donos/999999"]) {
    const resp = await chamar(rota, { method: "POST", token: tokenSuper });
    assert.equal(resp.status, 400, rota);
    assert.equal(resp.corpo.erro, "usuário não encontrado", rota);
    assert.ok(!JSON.stringify(resp.corpo).includes("constraint"), rota);
  }
});

test("the list of detected ESP32 boards is capped to the most recent, keeping the one that just announced itself", async () => {
  const salasService = require("../src/services/salasService");
  db.prepare("DELETE FROM esp_detectados").run();
  for (let i = 0; i < 130; i += 1) {
    const mac = `02:00:00:00:${String(Math.floor(i / 256)).padStart(2, "0")}:${String(i % 256).padStart(2, "0")}`.toUpperCase();
    db.prepare("INSERT INTO esp_detectados (mac, ip, ultimaDeteccao) VALUES (?, '10.0.0.1', datetime('now', ?))").run(mac, `-${200 - i} minutes`);
  }
  salasService.identificarDispositivo("02:00:00:00:00:00", "10.0.0.2");
  const lista = await chamar("/admin/esp32/detectados", { token: tokenSuper });
  assert.equal(lista.status, 200);
  assert.equal(lista.corpo.length, 100);
  assert.equal(lista.corpo[0].mac, "02:00:00:00:00:00", "the identity that just announced itself comes first");
});

test("unauthenticated discovery keeps a bounded number of unbound announcements and never evicts a board bound to a room", () => {
  const salasService = require("../src/services/salasService");
  db.prepare("DELETE FROM esp_detectados").run();
  const macVinculado = "0A:00:00:00:00:01";
  db.prepare("UPDATE salas SET mac = ? WHERE sala = 'A-110'").run(macVinculado);
  try {
    db.prepare("INSERT INTO esp_detectados (mac, ip, sala, ultimaDeteccao) VALUES (?, '10.0.0.9', 'A-110', datetime('now', '-20 days'))").run(macVinculado);
    let ultimo;
    for (let i = 0; i < 620; i += 1) {
      ultimo = `06:00:00:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}`.toUpperCase();
      salasService.identificarDispositivo(ultimo, "10.0.0.2");
    }
    const naoVinculados = db.prepare("SELECT COUNT(*) n FROM esp_detectados d LEFT JOIN salas s ON s.mac = d.mac WHERE s.mac IS NULL").get().n;
    assert.equal(naoVinculados, 500);
    assert.ok(db.prepare("SELECT 1 FROM esp_detectados WHERE mac = ?").get(macVinculado), "the bound board's row stays");
    assert.ok(db.prepare("SELECT 1 FROM esp_detectados WHERE mac = ?").get(ultimo), "the newest announcement stays");
    assert.equal(db.prepare("SELECT 1 FROM esp_detectados WHERE mac = '06:00:00:00:00:00'").get(), undefined, "the oldest are evicted first");
  } finally {
    db.prepare("UPDATE salas SET mac = NULL WHERE sala = 'A-110'").run();
    db.prepare("DELETE FROM esp_detectados").run();
  }
});

test("the retention cycle trims a discovery table that was already above the cap, as an upgraded database may be", () => {
  const retencao = require("../src/services/retencaoService");
  db.prepare("DELETE FROM esp_detectados").run();
  const inserir = db.prepare("INSERT INTO esp_detectados (mac, ip, ultimaDeteccao) VALUES (?, '10.0.0.1', datetime('now', ?))");
  for (let i = 0; i < 700; i += 1) {
    inserir.run(`0C:00:00:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}`.toUpperCase(), `-${700 - i} minutes`);
  }
  try {
    const resumo = retencao.executarLimpezaRetencao();
    assert.equal(resumo.esp_detectados_excedente, 200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM esp_detectados").get().n, 500);
    assert.ok(db.prepare("SELECT 1 FROM esp_detectados WHERE mac = '0C:00:00:00:02:BB'").get(), "the newest stay");
  } finally {
    db.prepare("DELETE FROM esp_detectados").run();
  }
});

test("over the device WebSocket, an access record keeps only a reported IP literal and a bounded userAgent", () => {
  const deviceHub = require("../src/services/deviceHub");
  const entrada = { ip: "10.0.0.5" };
  deviceHub.processarMensagem("A-111", entrada, { tipo: "acesso", ip: "z".repeat(60 * 1024), userAgent: "u".repeat(10_000) }, null);
  deviceHub.processarMensagem("A-111", entrada, { tipo: "acesso", ip: "10.20.30.41" }, null);
  const [comLixo, valido] = db.prepare("SELECT ip, userAgent FROM esp_acessos WHERE sala = 'A-111' ORDER BY id DESC LIMIT 2").all().reverse();
  assert.equal(comLixo.ip, "10.0.0.5", "an oversized value falls back to the connection's address");
  assert.equal(comLixo.userAgent.length, 500);
  assert.equal(valido.ip, "10.20.30.41");
});

test("a device-reported address is stored only when it is an IP literal; userAgent is bounded on the HTTP route too", async () => {
  const identificar = (mac, ip) => chamar("/dispositivo/identificar", { method: "POST", body: { mac, ip } });
  assert.equal((await identificar("0E:00:00:00:00:01", "x".repeat(60 * 1024))).status, 202);
  assert.equal((await identificar("0E:00:00:00:00:02", "10.20.30.40")).status, 202);
  assert.equal((await identificar("0E:00:00:00:00:03", "fe80::1")).status, 202);
  assert.equal((await identificar("0E:00:00:00:00:04", "servidor.example")).status, 202);
  const ipDe = (mac) => db.prepare("SELECT ip FROM esp_detectados WHERE mac = ?").get(mac).ip;
  assert.match(ipDe("0E:00:00:00:00:01"), /127\.0\.0\.1$/, "an oversized value falls back to the socket's address");
  assert.equal(ipDe("0E:00:00:00:00:02"), "10.20.30.40");
  assert.equal(ipDe("0E:00:00:00:00:03"), "fe80::1");
  assert.match(ipDe("0E:00:00:00:00:04"), /127\.0\.0\.1$/, "a host name is not an address");

  const mac = "0E:00:00:00:00:10";
  db.prepare("UPDATE salas SET mac = ? WHERE sala = 'A-111'").run(mac);
  try {
    const heartbeat = await chamar("/dispositivo/heartbeat", { method: "POST", body: { sala: "A-111", mac, ligado: false, ip: "y".repeat(10_000) } });
    assert.equal(heartbeat.status, 200);
    assert.match(db.prepare("SELECT ipEsp32 FROM salas WHERE sala = 'A-111'").get().ipEsp32, /127\.0\.0\.1$/);

    const acesso = await chamar("/dispositivo/acesso", { method: "POST", body: { sala: "A-111", mac, ip: "z".repeat(10_000), userAgent: "u".repeat(10_000) } });
    assert.equal(acesso.status, 200);
    const linha = db.prepare("SELECT ip, userAgent FROM esp_acessos WHERE sala = 'A-111' ORDER BY id DESC LIMIT 1").get();
    assert.match(linha.ip, /127\.0\.0\.1$/);
    assert.equal(linha.userAgent.length, 500);
  } finally {
    db.prepare("UPDATE salas SET mac = NULL WHERE sala = 'A-111'").run();
    db.prepare("DELETE FROM esp_detectados").run();
  }
});

test("a command answer carries the board's MAC and address only for the superadministrator", async () => {
  db.prepare("UPDATE salas SET mac = 'AA:BB:CC:DD:EE:01', ipEsp32 = '10.0.0.51' WHERE sala = 'A-107'").run();
  try {
    usuariosService.criar({ usuario: "norm-cmd-usuario", senha: "senhaSegura123", nome: "Comando", podeControlar: true }, { nivel: 3 });
    usuariosService.criar({ usuario: "norm-cmd-admin", senha: "senhaSegura123", nome: "Admin", podeControlar: true, isAdmin: true }, { nivel: 3 });
    for (const conta of ["norm-cmd-usuario", "norm-cmd-admin"]) {
      const token = (await login(conta, "senhaSegura123")).corpo.token;
      const resp = await chamar("/comando", { method: "POST", token, body: { sala: "A-107", cmd: "ligar" } });
      assert.equal(resp.status, 200, conta);
      assert.equal(resp.corpo.sala.ligado, 1);
      assert.equal("canalComandos" in resp.corpo.sala, true);
      assert.equal("mac" in resp.corpo.sala, false, conta);
      assert.equal("ipEsp32" in resp.corpo.sala, false, conta);
    }
    const resp = await chamar("/comando", { method: "POST", token: tokenSuper, body: { sala: "A-107", cmd: "desligar" } });
    assert.equal(resp.corpo.sala.mac, "AA:BB:CC:DD:EE:01");
    assert.equal(resp.corpo.sala.ipEsp32, "10.0.0.51");
  } finally {
    db.prepare("UPDATE salas SET mac = NULL, ipEsp32 = NULL WHERE sala = 'A-107'").run();
  }
});

test("flags that grant or restrict access accept only real booleans", async () => {
  for (const campo of ["isAdmin", "podeControlar"]) {
    const resp = await chamar("/admin/usuarios", { method: "POST", token: tokenSuper, body: { usuario: `norm-flag-${campo}`, senha: "senhaSegura123", nome: "Flag", [campo]: "false" } });
    assert.equal(resp.status, 400, campo);
    assert.equal(usuariosService.buscarPorUsuario(`norm-flag-${campo}`), undefined);
  }
  for (const campo of ["modoManutencao", "autoLigar", "espCredenciaisObrigatorias", "espApExigirCredencial"]) {
    const antes = configuracoesService.obter()[campo];
    const resp = await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { [campo]: "false" } });
    assert.equal(resp.status, 400, campo);
    assert.equal(configuracoesService.obter()[campo], antes, campo);
  }
  const restrito = await chamar("/admin/salas/A-105/acesso-restrito", { method: "PATCH", token: tokenSuper, body: { restrito: "false" } });
  assert.equal(restrito.status, 400);
  assert.equal(db.prepare("SELECT acessoRestrito FROM salas WHERE sala = 'A-105'").get().acessoRestrito, 0);
  assert.equal((await chamar("/admin/salas/A-105/acesso-restrito", { method: "PATCH", token: tokenSuper, body: { restrito: false } })).status, 200);
});

test("idle timeouts are bounded so a save cannot end every session within seconds", async () => {
  for (const valor of [0.05, 0.4, true, [5], 1e12, 10081]) {
    const resp = await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { timeoutInatividadeAdminMinutos: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
  }
  assert.equal((await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { popupAvisoSegundos: 5 } })).status, 400);
  assert.equal((await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { limiarOnlineMinutos: 0.5 } })).status, 400);
  assert.equal(configuracoesService.obter().timeoutInatividadeAdminMinutos, 720);
  assert.equal((await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { timeoutInatividadeMinutos: 1 } })).status, 200);
  assert.equal((await chamar("/admin/configuracoes", { method: "PATCH", token: tokenSuper, body: { timeoutInatividadeMinutos: 60 } })).status, 200);
});

test("an administrator cannot remove their own account", async () => {
  const conta = usuariosService.criar({ usuario: "norm-auto-remocao", senha: "senhaSegura123", nome: "Auto", podeControlar: true, isAdmin: true }, { nivel: 3 });
  const token = (await login("norm-auto-remocao", "senhaSegura123")).corpo.token;
  const resp = await chamar(`/admin/usuarios/${conta.id}`, { method: "DELETE", token });
  assert.equal(resp.status, 400);
  assert.ok(usuariosService.buscarPorId(conta.id));
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "DELETE", token: tokenSuper })).status, 200);
});

test("a login that differs from an existing one only in letter case is refused", async () => {
  const original = usuariosService.criar({ usuario: "norm-caixa", senha: "senhaSegura123", nome: "Caixa" }, { nivel: 3 });
  const outro = usuariosService.criar({ usuario: "norm-outro", senha: "senhaSegura123", nome: "Outro" }, { nivel: 3 });
  const criar = await chamar("/admin/usuarios", { method: "POST", token: tokenSuper, body: { usuario: "Norm-Caixa", senha: "senhaSegura123", nome: "Imitação" } });
  assert.equal(criar.status, 400);
  const renomear = await chamar(`/admin/usuarios/${outro.id}/login`, { method: "PATCH", token: tokenSuper, body: { novoLogin: "NORM-CAIXA" } });
  assert.equal(renomear.status, 400);
  const propria = await chamar(`/admin/usuarios/${original.id}/login`, { method: "PATCH", token: tokenSuper, body: { novoLogin: "Norm-Caixa" } });
  assert.equal(propria.status, 200);
  assert.equal(usuariosService.buscarPorId(original.id).usuario, "Norm-Caixa");
});

test("the command log keeps only the validated value, never an arbitrary client payload", async () => {
  const grande = "x".repeat(90 * 1024);
  for (const cmd of ["ligar", "desligar"]) {
    const resp = await chamar("/comando", { method: "POST", token: tokenSuper, body: { sala: "A-104", cmd, valor: grande } });
    assert.equal(resp.status, 200, cmd);
  }
  assert.equal((await chamar("/comando", { method: "POST", token: tokenSuper, body: { sala: "A-104", cmd: "temperatura", valor: "24" } })).status, 200);
  assert.equal((await chamar("/comando", { method: "POST", token: tokenSuper, body: { sala: "A-104", cmd: "turbo", valor: true } })).status, 200);
  const valores = db.prepare("SELECT cmd, valor FROM comandos_log WHERE sala = 'A-104' AND origem = 'manual' ORDER BY id").all().map((l) => `${l.cmd}=${l.valor}`);
  assert.deepEqual(valores, ["ligar=null", "desligar=null", "ligar=automatico", "temperatura=24", "turbo=true"]);
});
