const crypto = require("crypto");
const fs = require("fs");

// Manifesto de release, alvo e política de versão das atualizações do console.
//
// O manifesto é o que um release diz de si: versão, commit e um payload por alvo. Ele só é
// confiável depois que src/atestacao.js provou que é exatamente o arquivo que o GitHub Actions
// atestou para a etiqueta daquela versão. Então, nesta ordem e antes de qualquer escrita no
// diretório ativo:
//   1. existência de um artefato para este alvo (SO + arquitetura do runtime);
//   2. política de versão (mínimo para atualizar, e sem downgrade pela rede);
//   3. SHA-256 e tamanho do arquivo realmente gravado, contra o manifesto atestado.
//
// Um SHA-256 vindo da mesma origem não confiável do artefato não prova nada por si só: ele só tem
// valor porque o manifesto que o declara é atestado, e a atestação lista o mesmo digest. Por isso
// o digest nunca é conferido isoladamente.

const ESQUEMA_SUPORTADO = 1;

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_COMMIT = /^[0-9a-f]{40}$/;
const RE_ALVO = /^[a-z0-9]+-[a-z0-9]+$/;

function compararVersoes(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** Nome do payload de uma versão para um alvo. Fixo, para que um nome não aponte outro alvo. */
function nomeDoPayload(versao, alvo) {
  return `remoteifes-console-${versao}-${alvo}.tar.gz`;
}

/**
 * Forma de um manifesto. Compartilhada pelo console e pela construção, para que um manifesto que a
 * publicação produz seja um que o console aceita.
 */
function validarEstrutura(manifesto) {
  if (manifesto.esquema !== ESQUEMA_SUPORTADO) {
    return { ok: false, motivo: `esquema de manifesto ${manifesto.esquema} não é suportado por esta versão do console` };
  }
  if (!RE_VERSAO.test(String(manifesto.versao || ""))) return { ok: false, motivo: "versão do manifesto inválida" };
  // O commit liga o manifesto ao certificado: a atestação diz qual commit foi construído.
  if (!RE_COMMIT.test(String(manifesto.commit || ""))) return { ok: false, motivo: "manifesto sem o commit construído" };
  if (!Array.isArray(manifesto.artefatos) || !manifesto.artefatos.length) {
    return { ok: false, motivo: "manifesto sem artefatos" };
  }
  for (const artefato of manifesto.artefatos) {
    if (!RE_ALVO.test(String(artefato.alvo || ""))) return { ok: false, motivo: "artefato sem alvo válido no manifesto" };
    if (artefato.arquivo !== nomeDoPayload(manifesto.versao, artefato.alvo)) {
      return { ok: false, motivo: `o artefato de ${artefato.alvo} deveria se chamar ${nomeDoPayload(manifesto.versao, artefato.alvo)}` };
    }
    if (!RE_SHA256.test(String(artefato.sha256 || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem SHA-256 válido` };
    if (!Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0) return { ok: false, motivo: `artefato ${artefato.arquivo} sem tamanho válido` };
  }
  return { ok: true };
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
  // Um mínimo presente mas malformado desligava o portão de compatibilidade em silêncio: a
  // condição exigia que ele fosse válido para valer. Recusar é a leitura certa — o publicador
  // declarou um requisito e ele não pôde ser avaliado.
  if (minimo !== null && minimo !== undefined && !RE_VERSAO.test(String(minimo))) {
    return {
      ok: false,
      motivo: `o manifesto declara minimoParaAtualizar inválido (${JSON.stringify(minimo)}); atualização recusada por não ser possível avaliar a compatibilidade.`,
    };
  }
  if (minimo && compararVersoes(versaoInstalada, minimo) < 0) {
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
 * Confere um artefato contra o manifesto atestado e **devolve os bytes conferidos**.
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
  nomeDoPayload,
  validarEstrutura,
  alvoAtual,
  escolherArtefato,
  politicaDeVersao,
  conferirArtefato,
  compararVersoes,
};
