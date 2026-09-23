const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

module.exports = { publicarContrato, limparContrato, segredoAtual, versaoDoConsole, protecaoDoContrato };
