const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const config = require("./config");
const estado = require("./estado");
const plataforma = require("./plataforma");

// Identity contract between the backend and the launcher.
//
// The problem it solves: any local process can take 127.0.0.1:8099 before the Console and serve an
// identical login page. A launcher that simply opened the browser on the expected port would hand
// the operator's password to whoever arrived first.
//
// The proof is not the file content (that would only mean "whoever reads the file") but an HMAC
// over a random challenge chosen by the launcher on every check. The secret stays only in the
// protected state file; the impostor cannot read it and therefore cannot produce the answer. None
// of it appears in a URL, process argument or shortcut.

let segredoEmMemoria = null;

function versaoDoConsole() {
  try {
    return require(path.join(config.RAIZ_CONSOLE, "package.json")).version;
  } catch {
    return null;
  }
}

function segredoAtual() {
  return segredoEmMemoria;
}

/**
 * Publishes the running process's contract: port, pid and verification secret. The file is
 * recreated on every start: an old contract never validates a new process.
 */
function publicarContrato({ porta, modo }) {
  estado.garantirDiretorio();
  segredoEmMemoria = crypto.randomBytes(32).toString("base64url");
  const contrato = {
    porta,
    pid: process.pid,
    modo,
    versao: versaoDoConsole(),
    iniciadoEm: new Date().toISOString(),
    segredo: segredoEmMemoria,
  };
  estado.gravarJson(config.ARQUIVO_ENDERECO, contrato, 0o600);
  // On Windows the POSIX mode restricts nobody; the real protection is the ACL.
  plataforma.protegerArquivo(config.ARQUIVO_ENDERECO);
  return { porta, pid: process.pid };
}

function limparContrato() {
  segredoEmMemoria = null;
  try {
    const atual = estado.lerJson(config.ARQUIVO_ENDERECO, null);
    // Removes only if the contract belongs to this process: another Console may have taken over
    // meanwhile.
    if (atual && atual.pid === process.pid) fs.rmSync(config.ARQUIVO_ENDERECO, { force: true });
  } catch {}
}

/**
 * Contract protection status, for the panel. An identity file readable by others is a real problem:
 * whoever reads it can impersonate the Console to the launcher.
 */
function protecaoDoContrato() {
  if (!fs.existsSync(config.ARQUIVO_ENDERECO)) return { presente: false };
  const permissao = plataforma.permissaoRestrita(config.ARQUIVO_ENDERECO);
  return {
    presente: true,
    caminho: config.ARQUIVO_ENDERECO,
    restrito: permissao.restrito,
    verificavel: permissao.verificavel,
    mecanismo: permissao.mecanismo || (process.platform === "win32" ? "ACL" : "modo POSIX"),
    motivo: permissao.motivo || null,
  };
}

/**
 * Reads the contract published by the running Console. Returns only something usable for
 * verification: without an integer port and a secret no proof is possible.
 *
 * The path is a parameter because the uninstaller receives the state directory as an argument and
 * runs from a temporary copy: there `config` was already loaded pointing at the platform default,
 * and reading the wrong contract would make the uninstaller conclude no Console is running.
 */
function lerContrato(arquivo = config.ARQUIVO_ENDERECO) {
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    if (!bruto || typeof bruto !== "object") return null;
    if (!Number.isInteger(bruto.porta) || !bruto.segredo) return null;
    return bruto;
  } catch {
    return null;
  }
}

function pedirProva(porta, desafio, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: porta,
        path: `/api/identidade?desafio=${encodeURIComponent(desafio)}`,
        method: "GET",
        headers: { Host: `127.0.0.1:${porta}` },
        timeout: timeoutMs,
      },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          texto += d;
        });
        res.on("end", () => {
          try {
            resolve({ ok: res.statusCode === 200, json: JSON.parse(texto) });
          } catch {
            resolve({ ok: false, erro: "resposta ilegível" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: "tempo esgotado" });
    });
    req.on("error", (erro) => resolve({ ok: false, erro: erro.code || erro.message }));
    req.end();
  });
}

/**
 * Proves that whoever answers on the contract port is THIS Console, by HMAC challenge/response over
 * a secret only the running process knows.
 *
 * It lives here, not in the launcher, because two consumers ask the same question with opposite
 * consequences if it is answered wrong: the launcher decides whether to open the browser (and would
 * hand the operator's password to an impostor), and the uninstaller decides whether to stop a
 * process (and would kill an unrelated process that happened to hold that port). One implementation
 * only.
 */
async function verificarIdentidade(contrato, { timeoutMs = 4000 } = {}) {
  const desafio = crypto.randomBytes(32).toString("base64url");
  const r = await pedirProva(contrato.porta, desafio, timeoutMs);
  if (!r.ok || !r.json || typeof r.json.prova !== "string") {
    return { ok: false, motivo: r.erro || `o processo na porta ${contrato.porta} não respondeu à verificação de identidade` };
  }
  const esperado = crypto.createHmac("sha256", Buffer.from(contrato.segredo, "base64url")).update(desafio).digest("base64url");
  const a = Buffer.from(r.json.prova, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      impostor: true,
      motivo:
        `algo está escutando em 127.0.0.1:${contrato.porta}, mas NÃO é este console: a prova de identidade não confere. ` +
        "Não abra o navegador nesse endereço e investigue qual processo tomou a porta.",
    };
  }
  return { ok: true, versao: r.json.versao || null };
}

module.exports = {
  publicarContrato,
  limparContrato,
  segredoAtual,
  versaoDoConsole,
  protecaoDoContrato,
  lerContrato,
  verificarIdentidade,
};
