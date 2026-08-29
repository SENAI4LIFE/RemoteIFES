const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const RAIZ_SERVIDOR = path.join(__dirname, "..", "..", "remoteifes-server");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-e2e-"));

process.env.REMOTEIFES_DB_PATH = path.join(TMP, "e2e.db");
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.BACKUP_AUTOMATICO = "false";
process.env.SENHA_ADMIN_INICIAL = "";

const PORT = Number(process.env.E2E_API_PORT || 8791);

const app = require(path.join(RAIZ_SERVIDOR, "src", "app"));
const db = require(path.join(RAIZ_SERVIDOR, "src", "config", "database"));
const statusHub = require(path.join(RAIZ_SERVIDOR, "src", "services", "statusHub"));
const deviceHub = require(path.join(RAIZ_SERVIDOR, "src", "services", "deviceHub"));
const usuariosService = require(path.join(RAIZ_SERVIDOR, "src", "services", "usuariosService"));
const salasService = require(path.join(RAIZ_SERVIDOR, "src", "services", "salasService"));
const notificacoesService = require(path.join(RAIZ_SERVIDOR, "src", "services", "notificacoesService"));

const { iniciarFakeEsp32 } = require("./fake-esp32");

const SALA_COM_DISPOSITIVO = "A-108";
const MAC_DISPOSITIVO = "AA:BB:CC:E2:E2:01";

function semantear(fn) {
  try {
    fn();
  } catch (erro) {
    if (!/já existe/.test(erro.message)) throw erro;
  }
}

function popularUsuariosDeTeste() {
  const sup = { nivel: 3 };
  semantear(() =>
    usuariosService.criar(
      { usuario: "e2e_user", senha: "e2e-user-pass-123", nome: "Usuário E2E", podeControlar: true },
      sup
    )
  );
  semantear(() =>
    usuariosService.criar(
      { usuario: "e2e_readonly", senha: "e2e-readonly-123", nome: "Usuário Somente Leitura", podeControlar: false },
      sup
    )
  );
  semantear(() =>
    usuariosService.criar(
      { usuario: "e2e_admin", senha: "e2e-admin-pass-123", nome: "Admin E2E", isAdmin: true },
      sup
    )
  );
  semantear(() =>
    usuariosService.criar(
      { usuario: "e2e_password_target", senha: "e2e-password-old-123", nome: "Alvo de Senha E2E", podeControlar: true },
      sup
    )
  );
}

function prepararSalaComDispositivo() {
  try {
    salasService.cadastrarMac(SALA_COM_DISPOSITIVO, MAC_DISPOSITIVO);
  } catch (erro) {
    if (!/não corresponde|já está cadastrado/.test(erro.message)) throw erro;
  }
  salasService.definirProtocoloIR(SALA_COM_DISPOSITIVO, 1);
}

popularUsuariosDeTeste();
prepararSalaComDispositivo();
try {
  notificacoesService.criarEspOffline("A-201a", "Sala de Reunião E2E");
} catch (e) {}

const server = http.createServer(app);
statusHub.iniciar(server);
deviceHub.iniciar(server);

app.post("/__e2e/fechar-status", (req, res) => {
  statusHub.fecharConexoes();
  res.json({ ok: true });
});

app.post("/__e2e/resetar-dispositivo", (req, res) => {
  db.prepare("UPDATE salas SET ligado = 0, turboAtivo = 0 WHERE sala = ?").run(SALA_COM_DISPOSITIVO);
  if (fake) fake.resetar();
  res.json({ ok: true });
});

app.post("/__e2e/encerrar", (req, res) => {
  res.json({ ok: true });
  setImmediate(encerrar);
});

let fake = null;

server.listen(PORT, "127.0.0.1", () => {
  fake = iniciarFakeEsp32({
    url: `ws://127.0.0.1:${PORT}`,
    sala: SALA_COM_DISPOSITIVO,
    mac: MAC_DISPOSITIVO,
  });
  console.log(`[e2e-api] pronto em http://127.0.0.1:${PORT} (db ${process.env.REMOTEIFES_DB_PATH})`);
});

function encerrar() {
  try {
    if (fake) fake.parar();
  } catch {}
  try {
    statusHub.encerrar();
  } catch {}
  try {
    deviceHub.encerrar();
  } catch {}
  server.close(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
