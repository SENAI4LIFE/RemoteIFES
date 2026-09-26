const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

// server.js as a real child process, on a throwaway data directory and a free loopback port.
//
// For what an in-process server cannot show: a restart that reloads persisted state, the process's
// own resource use, and startup as production runs it. Never touches a real installation: the data
// directory is created here and removed by encerrar().

const RAIZ_SERVIDOR = path.join(__dirname, "..", "..");
const SENHA_PADRAO = "servidor-isolado-senha-temporaria";

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function iniciarServidorIsolado({ env = {}, senha = SENHA_PADRAO, limiteMs = 40_000 } = {}) {
  const porta = await portaLivre();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-isolado-"));
  const base = `http://127.0.0.1:${porta}`;
  const ambiente = {
    ...process.env,
    PORTA: String(porta),
    BIND_ADDR: "127.0.0.1",
    NODE_ENV: "development",
    SERVIR_FRONTEND: "false",
    REMOTEIFES_DATA_DIR: dir,
    SENHA_ADMIN_INICIAL: senha,
    BACKUP_AUTOMATICO: "false",
    ...env,
  };
  delete ambiente.REMOTEIFES_DB_PATH;
  delete ambiente.REMOTEIFES_FIRMWARE_DIR;

  const servidor = { porta, base, dir, filho: null, saida: "", token: null, partidas: 0 };

  servidor.subir = async () => {
    const filho = spawn(process.execPath, ["server.js"], { cwd: RAIZ_SERVIDOR, env: ambiente, stdio: ["ignore", "pipe", "pipe"] });
    servidor.filho = filho;
    servidor.partidas += 1;
    const guardar = (d) => {
      servidor.saida = (servidor.saida + d.toString()).slice(-20_000);
    };
    filho.stdout.on("data", guardar);
    filho.stderr.on("data", guardar);
    filho.fim = new Promise((resolve) => filho.once("exit", (codigo, sinal) => resolve({ codigo, sinal })));
    const limite = Date.now() + limiteMs;
    for (;;) {
      if (filho.exitCode !== null) throw new Error(`o servidor saiu (${filho.exitCode}) antes de responder:\n${servidor.saida.slice(-2000)}`);
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok && (await r.json()).ok === true) break;
      } catch {}
      if (Date.now() > limite) throw new Error(`o servidor não respondeu em /health:\n${servidor.saida.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    servidor.token = null;
    return servidor;
  };

  /** Authenticated API call as the superadministrator (logs in on first use after each start). */
  servidor.api = async (metodo, rota, corpo) => {
    if (!servidor.token) {
      const login = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usuario: "superadmin", senha }),
      });
      const dados = await login.json().catch(() => ({}));
      if (!dados.token) throw new Error(`login no servidor isolado falhou (${login.status})`);
      servidor.token = dados.token;
    }
    const inicio = process.hrtime.bigint();
    const resposta = await fetch(`${base}${rota}`, {
      method: metodo,
      headers: { "content-type": "application/json", authorization: `Bearer ${servidor.token}` },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const dados = await resposta.json().catch(() => null);
    return { status: resposta.status, corpo: dados, ms: Number(process.hrtime.bigint() - inicio) / 1e6 };
  };

  /** Stops the process. SIGTERM is a graceful stop; SIGKILL is a crash. */
  servidor.parar = async (sinal = "SIGTERM") => {
    const filho = servidor.filho;
    if (!filho || filho.exitCode !== null || filho.signalCode) return;
    filho.kill(sinal);
    const parou = await Promise.race([filho.fim, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    if (!parou) {
      filho.kill("SIGKILL");
      await filho.fim;
    }
  };

  servidor.reiniciar = async (sinal = "SIGTERM") => {
    await servidor.parar(sinal);
    return servidor.subir();
  };

  servidor.encerrar = async () => {
    await servidor.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await servidor.subir();
  } catch (erro) {
    await servidor.encerrar().catch(() => {});
    throw erro;
  }
  return servidor;
}

module.exports = { iniciarServidorIsolado, portaLivre, RAIZ_SERVIDOR };
