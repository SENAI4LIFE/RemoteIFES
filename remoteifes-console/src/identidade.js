const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const config = require("./config");
const estado = require("./estado");
const plataforma = require("./plataforma");

// Contrato de identidade entre o backend e o lançador.
//
// O problema que isto resolve: qualquer processo local pode ocupar 127.0.0.1:8099 antes do
// console e servir uma tela de login idêntica. Um lançador que apenas abrisse o navegador na
// porta esperada entregaria a senha do operador a quem chegou primeiro.
//
// A prova não é o conteúdo do arquivo (isso seria só "quem lê o arquivo"), e sim um HMAC sobre
// um desafio aleatório escolhido pelo lançador a cada verificação. O segredo fica apenas no
// arquivo protegido de estado; o impostor não o lê e por isso não produz a resposta. Nada disso
// aparece em URL, argumento de processo ou atalho.

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
 * Publica o contrato do processo em execução: porta, pid e o segredo de verificação.
 * O arquivo é recriado a cada partida — um contrato antigo nunca valida um processo novo.
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
  // No Windows o modo POSIX não restringe ninguém; a proteção real é a ACL.
  plataforma.protegerArquivo(config.ARQUIVO_ENDERECO);
  return { porta, pid: process.pid };
}

function limparContrato() {
  segredoEmMemoria = null;
  try {
    const atual = estado.lerJson(config.ARQUIVO_ENDERECO, null);
    // Só remove se o contrato for deste processo: outro console pode ter assumido no intervalo.
    if (atual && atual.pid === process.pid) fs.rmSync(config.ARQUIVO_ENDERECO, { force: true });
  } catch {}
}

/**
 * Estado da proteção do contrato, para o painel. Um arquivo de identidade legível por outros
 * é um problema real: quem o lê consegue se passar pelo console para o lançador.
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
 * Lê o contrato publicado pelo console em execução. Só devolve algo que sirva para verificar:
 * sem porta inteira e sem segredo não há prova possível.
 *
 * O caminho é parametrizável porque o desinstalador recebe o diretório de estado por argumento
 * e roda de uma cópia temporária: ali `config` já foi carregado apontando para o padrão da
 * plataforma, e ler o contrato errado faria o desinstalador concluir que não há console no ar.
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
 * Prova que quem responde na porta do contrato é ESTE console, por desafio/resposta HMAC sobre
 * um segredo que só o processo em execução conhece.
 *
 * Vive aqui, e não no lançador, porque há dois consumidores com a mesma pergunta e consequências
 * opostas se ela for respondida errado: o lançador decide se abre o navegador (e entregaria a
 * senha do operador a um impostor), e o desinstalador decide se encerra um processo (e mataria
 * um processo alheio que só calhou de estar naquela porta). Uma implementação só.
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
