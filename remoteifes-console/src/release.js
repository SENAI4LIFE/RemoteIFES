const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Raiz de confiança das atualizações do console.
//
// O que é verificado, nesta ordem, **antes** de qualquer escrita no diretório ativo:
//   1. assinatura Ed25519 do manifesto por uma chave confiável;
//   2. validade do manifesto (`expiraEm`), contra replay e congelamento de versão;
//   3. existência de um artefato para este alvo (SO + arquitetura do runtime);
//   4. política de versão (mínimo para atualizar, e sem downgrade pela rede);
//   5. SHA-256 e tamanho do arquivo realmente gravado.
//
// Um SHA-256 vindo da mesma origem não confiável do artefato não prova nada: ele só ganha
// valor **depois** que a assinatura do manifesto confere. Por isso o digest nunca é conferido
// isoladamente.
//
// CHAVE DE PUBLICAÇÃO: a chave privada correspondente não existe neste repositório. Enquanto
// nenhuma chave de produção for provisionada, `CHAVE_PUBLICA_OFICIAL` fica nula e a atualização
// por release se declara **não configurada** em vez de aceitar qualquer manifesto. Configurar é
// publicar a chave pública aqui (ou em CONSOLE_CHAVE_RELEASE para ambientes de teste) e assinar
// com `empacotar/assinar-manifesto.js`.

const ESQUEMA_SUPORTADO = 1;

// Chave pública Ed25519 em base64 (SPKI DER). Nula até haver chave de produção publicada.
const CHAVE_PUBLICA_OFICIAL = null;

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_ARQUIVO = /^[A-Za-z0-9._-]{1,120}$/;

function chaveDeBase64(base64) {
  return crypto.createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
}

/** Chaves aceitas: a embutida, a de ambiente (teste) e as rotacionadas já autenticadas. */
function chavesConfiaveis() {
  const chaves = [];
  const adicionar = (base64, origem) => {
    if (!base64) return;
    try {
      chaves.push({ chave: chaveDeBase64(base64), base64, origem });
    } catch {}
  };
  adicionar(CHAVE_PUBLICA_OFICIAL, "embutida");
  adicionar(process.env.CONSOLE_CHAVE_RELEASE, "ambiente");
  const rotacionadas = estado.lerJson(path.join(config.DIR_ESTADO, "chaves-release.json"), { chaves: [] });
  for (const item of rotacionadas.chaves || []) adicionar(item.publica, `rotacionada em ${item.aceitaEm}`);
  return chaves;
}

function confianciaConfigurada() {
  return chavesConfiaveis().length > 0;
}

function compararVersoes(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Verifica assinatura e forma do manifesto. Recebe os **bytes exatos** do arquivo, porque a
 * assinatura cobre bytes, não um objeto reserializado.
 */
function verificarManifesto(bytesManifesto, assinatura, { agora = new Date() } = {}) {
  const chaves = chavesConfiaveis();
  if (!chaves.length) {
    return {
      ok: false,
      motivo:
        "a atualização por release não está configurada: nenhuma chave pública de publicação foi provisionada neste console. " +
        "Sem raiz de confiança, nenhum artefato é aceito.",
      naoConfigurado: true,
    };
  }
  if (!Buffer.isBuffer(bytesManifesto) || !bytesManifesto.length) return { ok: false, motivo: "manifesto vazio" };

  let assinaturaBin;
  try {
    assinaturaBin = Buffer.from(String(assinatura).trim(), "base64");
  } catch {
    return { ok: false, motivo: "assinatura ilegível" };
  }
  if (assinaturaBin.length !== 64) return { ok: false, motivo: "assinatura Ed25519 tem tamanho inesperado" };

  const usada = chaves.find((c) => {
    try {
      return crypto.verify(null, bytesManifesto, c.chave, assinaturaBin);
    } catch {
      return false;
    }
  });
  if (!usada) return { ok: false, motivo: "a assinatura do manifesto não confere com nenhuma chave confiável" };

  let manifesto;
  try {
    manifesto = JSON.parse(bytesManifesto.toString("utf8"));
  } catch {
    return { ok: false, motivo: "manifesto não é JSON válido" };
  }

  if (manifesto.esquema !== ESQUEMA_SUPORTADO) {
    return { ok: false, motivo: `esquema de manifesto ${manifesto.esquema} não é suportado por esta versão do console` };
  }
  if (!RE_VERSAO.test(String(manifesto.versao || ""))) return { ok: false, motivo: "versão do manifesto inválida" };
  if (!manifesto.expiraEm || Number.isNaN(Date.parse(manifesto.expiraEm))) {
    return { ok: false, motivo: "manifesto sem validade declarada" };
  }
  // Validade fecha replay e congelamento: um manifesto antigo reapresentado não passa.
  if (Date.parse(manifesto.expiraEm) < agora.getTime()) {
    return { ok: false, motivo: `manifesto expirado em ${manifesto.expiraEm}; obtenha a publicação atual` };
  }
  if (!Array.isArray(manifesto.artefatos) || !manifesto.artefatos.length) {
    return { ok: false, motivo: "manifesto sem artefatos" };
  }
  for (const artefato of manifesto.artefatos) {
    if (!RE_ARQUIVO.test(String(artefato.arquivo || ""))) return { ok: false, motivo: "nome de artefato inválido no manifesto" };
    if (!RE_SHA256.test(String(artefato.sha256 || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem SHA-256 válido` };
    if (!Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0) return { ok: false, motivo: `artefato ${artefato.arquivo} sem tamanho válido` };
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(String(artefato.alvo || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem alvo válido` };
  }

  return { ok: true, manifesto, chaveUsada: usada.origem };
}

/**
 * Aceita a chave sucessora declarada dentro de um manifesto já autenticado. Como ela vem
 * assinada pela chave atual, a rotação não abre nova superfície.
 */
function registrarRotacao(manifesto) {
  const proxima = manifesto && manifesto.proximaChave;
  if (!proxima || typeof proxima.publica !== "string") return { rotacionada: false };
  try {
    chaveDeBase64(proxima.publica);
  } catch {
    return { rotacionada: false, motivo: "chave sucessora ilegível" };
  }
  const arquivo = path.join(config.DIR_ESTADO, "chaves-release.json");
  const atual = estado.lerJson(arquivo, { chaves: [] });
  if ((atual.chaves || []).some((c) => c.publica === proxima.publica)) return { rotacionada: false, jaConhecida: true };
  atual.chaves = [...(atual.chaves || []), { publica: proxima.publica, aceitaEm: new Date().toISOString(), viaVersao: manifesto.versao }].slice(-5);
  estado.gravarJson(arquivo, atual, 0o600);
  estado.auditar("release-chave-rotacionada", { viaVersao: manifesto.versao });
  return { rotacionada: true };
}

/** Alvo deste console: SO + arquitetura do runtime, que é quem vai executar o código. */
function alvoAtual() {
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  return `${so}-${process.arch}`;
}

function escolherArtefato(manifesto, alvo = alvoAtual()) {
  const artefato = manifesto.artefatos.find((a) => a.alvo === alvo);
  if (!artefato) {
    return {
      ok: false,
      motivo:
        `esta publicação não traz artefato para ${alvo}. Alvos disponíveis: ${manifesto.artefatos.map((a) => a.alvo).join(", ")}. ` +
        "Instalar um artefato de outra arquitetura deixaria o console sem subir.",
    };
  }
  return { ok: true, artefato };
}

/**
 * Política de versão. Downgrade pela rede é recusado: voltar atrás usa a cópia local já
 * verificada, por ação explícita de reversão.
 */
function politicaDeVersao(manifesto, versaoInstalada) {
  if (compararVersoes(manifesto.versao, versaoInstalada) === 0) {
    return { ok: false, motivo: `a versão ${manifesto.versao} já é a instalada.`, jaInstalada: true };
  }
  if (compararVersoes(manifesto.versao, versaoInstalada) < 0) {
    return {
      ok: false,
      motivo:
        `${manifesto.versao} é anterior à instalada (${versaoInstalada}). Atualização não faz downgrade; ` +
        "para voltar, use a reversão, que usa a cópia local já verificada.",
    };
  }
  const minimo = manifesto.minimoParaAtualizar;
  if (minimo && RE_VERSAO.test(minimo) && compararVersoes(versaoInstalada, minimo) < 0) {
    return {
      ok: false,
      motivo:
        `esta publicação exige console ${minimo} ou mais novo, e o instalado é ${versaoInstalada}. ` +
        "Atualize primeiro para uma versão intermediária.",
    };
  }
  return { ok: true };
}

/** Confere o arquivo realmente gravado contra o manifesto autenticado. */
/**
 * Confere um artefato contra o manifesto assinado e **devolve os bytes conferidos**.
 *
 * Devolver o conteúdo não é conveniência: é o que fecha a janela entre verificar e instalar.
 * Antes, o digest era calculado numa leitura e a extração fazia outra leitura do mesmo caminho —
 * quem pudesse trocar o arquivo entre as duas instalaria conteúdo que nunca passou pela
 * verificação. No caminho online o arquivo está numa área nossa, mas no caminho offline ele é um
 * caminho que o operador informou (um /tmp compartilhado, um pendrive montado), e ali a troca é
 * plausível. Verificando e extraindo o MESMO buffer, não existe segunda leitura para atacar.
 */
function conferirArtefato(caminho, artefato) {
  let conteudo;
  try {
    conteudo = fs.readFileSync(caminho);
  } catch {
    return { ok: false, motivo: "o arquivo baixado não existe" };
  }
  if (conteudo.length !== artefato.bytes) {
    return { ok: false, motivo: `tamanho divergente: ${conteudo.length} bytes lidos, ${artefato.bytes} declarados no manifesto` };
  }
  const digest = crypto.createHash("sha256").update(conteudo).digest("hex");
  if (digest !== artefato.sha256) {
    return { ok: false, motivo: `SHA-256 divergente: ${digest} calculado, ${artefato.sha256} declarado no manifesto` };
  }
  return { ok: true, sha256: digest, bytes: conteudo.length, conteudo };
}

module.exports = {
  ESQUEMA_SUPORTADO,
  CHAVE_PUBLICA_OFICIAL,
  chavesConfiaveis,
  confianciaConfigurada,
  verificarManifesto,
  registrarRotacao,
  alvoAtual,
  escolherArtefato,
  politicaDeVersao,
  conferirArtefato,
  compararVersoes,
};
