const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

// Estado persistente do console: poucos arquivos JSON pequenos, gravados de forma atômica e
// só quando algo realmente muda. Num Pi com cartão SD, escrita por requisição é custo puro;
// por isso nada aqui é chamado em leitura de status.

function garantirDiretorio(dir = config.DIR_ESTADO, modo = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode: modo });
}

function lerJson(arquivo, padrao) {
  try {
    const texto = fs.readFileSync(arquivo, "utf8");
    const valor = JSON.parse(texto);
    return valor === null || typeof valor !== "object" ? padrao : valor;
  } catch {
    return padrao;
  }
}

function gravarJson(arquivo, valor, modo = 0o600) {
  garantirDiretorio(path.dirname(arquivo));
  const temporario = `${arquivo}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(temporario, "wx", modo);
    fs.writeFileSync(fd, `${JSON.stringify(valor, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporario, arquivo);
    fsyncDiretorio(path.dirname(arquivo));
  } catch (erro) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    fs.rmSync(temporario, { force: true });
    throw erro;
  }
}

function fsyncDiretorio(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Diretórios não são sincronizáveis em todo sistema de arquivos (e nunca no Windows);
    // a troca por rename já é atômica, o fsync é reforço.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// Registro de auditoria: uma linha JSON por evento, com rotação simples por tamanho. Nunca
// recebe segredo, senha, token nem transcrição de terminal — só metadado do que foi feito.
const AUDITORIA_MAX_BYTES = 512 * 1024;
const CAMPOS_PROIBIDOS = /(senha|password|token|secret|segredo|keystore|passphrase|authorization)/i;

function higienizarDetalhe(detalhe) {
  if (!detalhe || typeof detalhe !== "object") return {};
  const limpo = {};
  for (const [chave, valor] of Object.entries(detalhe)) {
    if (CAMPOS_PROIBIDOS.test(chave)) {
      limpo[chave] = "[omitido]";
      continue;
    }
    if (valor === null || ["string", "number", "boolean"].includes(typeof valor)) {
      limpo[chave] = typeof valor === "string" && valor.length > 400 ? `${valor.slice(0, 400)}…` : valor;
    } else if (Array.isArray(valor)) {
      limpo[chave] = valor.slice(0, 20).map((v) => (typeof v === "string" ? v.slice(0, 200) : v));
    } else {
      limpo[chave] = higienizarDetalhe(valor);
    }
  }
  return limpo;
}

function auditar(evento, detalhe = {}) {
  const linha = JSON.stringify({ em: new Date().toISOString(), evento, ...higienizarDetalhe(detalhe) });
  try {
    garantirDiretorio();
    let tamanho = 0;
    try {
      tamanho = fs.statSync(config.ARQUIVO_AUDITORIA).size;
    } catch {}
    if (tamanho > AUDITORIA_MAX_BYTES) {
      fs.renameSync(config.ARQUIVO_AUDITORIA, `${config.ARQUIVO_AUDITORIA}.1`);
    }
    fs.appendFileSync(config.ARQUIVO_AUDITORIA, `${linha}\n`, { mode: 0o600 });
  } catch {
    // Auditoria nunca pode derrubar a operação que a originou.
  }
}

function lerAuditoria(limite = 100) {
  let texto = "";
  try {
    texto = fs.readFileSync(config.ARQUIVO_AUDITORIA, "utf8");
  } catch {
    return [];
  }
  const linhas = texto.split("\n").filter(Boolean);
  return linhas
    .slice(-limite)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { garantirDiretorio, lerJson, gravarJson, fsyncDiretorio, auditar, lerAuditoria, higienizarDetalhe };
