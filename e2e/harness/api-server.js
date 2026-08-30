const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const RAIZ_SERVIDOR = path.join(__dirname, "..", "..", "remoteifes-server");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-e2e-"));

const RELEASE_DIR_E2E = path.join(TMP, "mobile-release");
const FONTE_RELEASE_REAL = path.join(RAIZ_SERVIDOR, "data", "releases", "mobile");

process.env.REMOTEIFES_DB_PATH = path.join(TMP, "e2e.db");
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.BACKUP_AUTOMATICO = "false";
process.env.SENHA_ADMIN_INICIAL = "";
process.env.MOBILE_APP_RELEASE_DIR = RELEASE_DIR_E2E;

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

function limparReleaseE2E() {
  if (!fs.existsSync(RELEASE_DIR_E2E)) return;
  for (const nome of fs.readdirSync(RELEASE_DIR_E2E)) {
    fs.rmSync(path.join(RELEASE_DIR_E2E, nome), { force: true });
  }
}

app.post("/__e2e/publicar-apk", (req, res) => {
  try {
    fs.mkdirSync(RELEASE_DIR_E2E, { recursive: true });
    limparReleaseE2E();
    const serverOrigin = `${req.protocol}://${req.get("host")}`;
    const metaReal = path.join(FONTE_RELEASE_REAL, "release.json");
    let meta;
    let bytes;
    let fonte;
    if (fs.existsSync(metaReal)) {
      const real = JSON.parse(fs.readFileSync(metaReal, "utf8"));
      bytes = fs.readFileSync(path.join(FONTE_RELEASE_REAL, path.basename(String(real.file || ""))));
      meta = { ...real, serverOrigin };
      meta.minSdk = 24;
      meta.targetSdk = 36;
      fonte = "artefato-real";
    } else {
      bytes = Buffer.from(`RemoteIFES APK de teste do harness E2E ${"-".repeat(4096)}`, "utf8");
      meta = {
        file: "RemoteIFES-1.0.0-10000.apk",
        version: "1.0.0",
        build: "10000",
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        certificateSha256: "e2e00000000000000000000000000000000000000000000000000000000e2e000",
        serverOrigin,
        artifactType: "release",
        signed: true,
        debuggable: false,
        minSdk: 24,
        targetSdk: 36,
        fonte: "harness-fixture",
      };
      fonte = "harness-fixture";
    }
    fs.writeFileSync(path.join(RELEASE_DIR_E2E, path.basename(meta.file)), bytes);
    fs.writeFileSync(path.join(RELEASE_DIR_E2E, "release.json"), JSON.stringify(meta, null, 2));
    res.json({
      ok: true,
      fonte,
      version: meta.version,
      build: meta.build,
      sha256: meta.sha256,
      certificateSha256: meta.certificateSha256,
      tamanhoBytes: bytes.length,
    });
  } catch (erro) {
    res.status(500).json({ ok: false, erro: erro.message });
  }
});

app.post("/__e2e/despublicar-apk", (req, res) => {
  try {
    limparReleaseE2E();
    res.json({ ok: true });
  } catch (erro) {
    res.status(500).json({ ok: false, erro: erro.message });
  }
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
