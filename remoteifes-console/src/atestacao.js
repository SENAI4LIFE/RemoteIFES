const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const estado = require("./estado");
const release = require("./release");

// Proveniência dos releases do console: atestações de artefato do GitHub, sem chave.
//
// Um release é confiável porque o GitHub Actions, rodando o workflow de publicação dedicado deste
// repositório para uma etiqueta de release, atestou os seus bytes exatos. Não existe chave de
// assinatura do RemoteIFES em lugar nenhum: o token OIDC de curta duração do workflow é trocado por
// um certificado do Sigstore (Fulcio) válido por dez minutos, a assinatura fica registrada no log
// público de transparência (Rekor), e o pacote da atestação leva o certificado, a entrada do log e
// a declaração in-toto assinada.
//
// O que é conferido, nesta ordem, antes de qualquer artefato ser gravado:
//   1. o pacote é bem formado e traz um envelope DSSE com uma declaração in-toto;
//   2. a criptografia, pelo @sigstore/verify contra a raiz de confiança do Sigstore: cadeia do
//      certificado até o Fulcio no momento da assinatura, transparência de certificados, inclusão
//      no log de transparência e a assinatura do envelope. Nada disso é implementado aqui;
//   3. a identidade, SÓ pelo CERTIFICADO: emissor, repositório e dono (por nome e por identificador
//      numérico, para que um repositório renomeado ou recriado não herde a confiança), o workflow
//      de publicação na etiqueta do release, o gatilho push, um executor hospedado pelo GitHub e o
//      ambiente de publicação;
//   4. a declaração: proveniência SLSA, cujos sujeitos incluem o digest exato do manifesto e cada
//      artefato que o manifesto lista, com o digest que o manifesto declara;
//   5. o manifesto: a sua versão é a etiqueta do certificado e o seu commit é o commit que o
//      certificado diz ter sido construído.
// O predicado da declaração é assinado, mas composto dentro da execução do workflow, então nunca
// decide a identidade; só se exige que concorde com o certificado.

const IDENTIDADE_OFICIAL = Object.freeze({
  emissor: "https://token.actions.githubusercontent.com",
  repositorio: "https://github.com/SENAI4LIFE/RemoteIFES",
  repositorioId: "1313157228",
  dono: "https://github.com/SENAI4LIFE",
  donoId: "211847016",
  workflow: ".github/workflows/console-release.yml",
  gatilho: "push",
  executor: "github-hosted",
  ambiente: "console-release",
});

const TIPO_PAYLOAD = "application/vnd.in-toto+json";
const TIPO_DECLARACAO = "https://in-toto.io/Statement/v1";
const TIPO_PREDICADO = "https://slsa.dev/provenance/v1";

// Nomes dos arquivos do release. O manifesto descreve o release; o pacote atesta o manifesto e
// todos os artefatos de uma vez.
const ARQUIVO_MANIFESTO = "manifesto.json";
const ARQUIVO_ATESTACAO = "atestacao.sigstore.json";

const LIMITE_ATESTACAO = 2 * 1024 * 1024;
const MAX_SUJEITOS = 500;

// Extensões do certificado do Fulcio
// (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md).
const OID = Object.freeze({
  emissor: "1.3.6.1.4.1.57264.1.8",
  assinante: "1.3.6.1.4.1.57264.1.9",
  executor: "1.3.6.1.4.1.57264.1.11",
  repositorio: "1.3.6.1.4.1.57264.1.12",
  commit: "1.3.6.1.4.1.57264.1.13",
  ref: "1.3.6.1.4.1.57264.1.14",
  repositorioId: "1.3.6.1.4.1.57264.1.15",
  dono: "1.3.6.1.4.1.57264.1.16",
  donoId: "1.3.6.1.4.1.57264.1.17",
  configuracao: "1.3.6.1.4.1.57264.1.18",
  configuracaoCommit: "1.3.6.1.4.1.57264.1.19",
  gatilho: "1.3.6.1.4.1.57264.1.20",
  execucao: "1.3.6.1.4.1.57264.1.21",
  ambiente: "1.3.6.1.4.1.57264.1.23",
});

// Repositório TUF público do Sigstore, que distribui a raiz de confiança (chaves do Fulcio, do
// Rekor, do CT e de carimbo de tempo). O prazo vale por requisição e não há nova tentativa: uma
// atualização que falha significa só "agora não", e a próxima consulta tenta de novo.
const ESPELHO_TUF = "https://tuf-repo-cdn.sigstore.dev";
const TEMPO_TUF_MS = 10_000;

function dirSigstore() {
  return path.join(config.DIR_ESTADO, "sigstore");
}

// A raiz que a última atualização bem-sucedida produziu, guardada fora do cache do próprio cliente
// TUF para que o caminho offline nunca dependa de como aquela biblioteca organiza os arquivos.
function arquivoRaizVerificada() {
  return path.join(dirSigstore(), "trusted_root.json");
}

function refDaVersao(versao) {
  return `refs/tags/console-v${versao}`;
}

function assinanteDaVersao(versao, identidade = IDENTIDADE_OFICIAL) {
  return `${identidade.repositorio}/${identidade.workflow}@${refDaVersao(versao)}`;
}

function recusa(motivo, codigo) {
  return { ok: false, motivo, codigo };
}

// --- Raiz de confiança -------------------------------------------------------------------------

let atualizacaoEmCurso = null;

/**
 * A raiz de confiança do Sigstore.
 *
 * `rede: true` a atualiza por TUF: metadados assinados pelas chaves-raiz do Sigstore, conferidos
 * contra a raiz embutida no @sigstore/tuf e depois contra cada rotação desde então. É assim que uma
 * chave que o Sigstore aposentou deixa de ser confiável aqui. O cache TUF e a raiz resultante ficam
 * no diretório de estado (cerca de 60 KB; os arquivos são sobrescritos, versões não se acumulam).
 *
 * `rede: false` nunca toca a rede: a última raiz que uma atualização verificou, ou então a embutida
 * no @sigstore/tuf. Serve à importação offline, onde nenhuma atualização é possível; o que ela não
 * tem como saber é uma chave que o Sigstore revogou depois daquela cópia.
 *
 * Atualizações concorrentes neste processo compartilham uma única requisição.
 */
async function raizDeConfianca({ rede = false } = {}) {
  const { TrustedRoot } = require("@sigstore/protobuf-specs");
  if (rede) {
    if (!atualizacaoEmCurso) {
      const { getTrustedRoot } = require("@sigstore/tuf");
      atualizacaoEmCurso = getTrustedRoot({
        cachePath: path.join(dirSigstore(), "tuf"),
        mirrorURL: modulo.ESPELHO_TUF,
        timeout: modulo.TEMPO_TUF_MS,
        retry: false,
      })
        .then((raiz) => {
          try {
            estado.gravarJson(arquivoRaizVerificada(), TrustedRoot.toJSON(raiz), 0o600);
          } catch {
            // Sem a cópia, a importação offline só perde uma raiz mais recente.
          }
          return raiz;
        })
        .finally(() => {
          atualizacaoEmCurso = null;
        });
    }
    return { raiz: await atualizacaoEmCurso, origem: "tuf" };
  }

  try {
    return { raiz: TrustedRoot.fromJSON(JSON.parse(fs.readFileSync(arquivoRaizVerificada(), "utf8"))), origem: "cache" };
  } catch {
    // Ausente ou ilegível: a cópia embutida está sempre lá.
  }
  const sementes = require("@sigstore/tuf/seeds.json");
  const semente = sementes[ESPELHO_TUF] && sementes[ESPELHO_TUF].targets && sementes[ESPELHO_TUF].targets["trusted_root.json"];
  if (!semente) throw new Error("a raiz de confiança do Sigstore embutida não foi encontrada");
  return { raiz: TrustedRoot.fromJSON(JSON.parse(Buffer.from(semente, "base64").toString("utf8"))), origem: "embutida" };
}

// --- Identidade do certificado ---------------------------------------------------------------

/**
 * Valor de uma extensão v2 do Fulcio: uma UTF8String DER. Qualquer outra coisa (outra tag, um
 * tamanho que não fecha o valor, bytes sobrando) é ilegível e conta como ausente.
 */
function textoDer(valor) {
  const b = Buffer.from(valor || []);
  if (b.length < 2 || b[0] !== 0x0c) return null;
  let tamanho = b[1];
  let inicio = 2;
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    if (bytes < 1 || bytes > 2 || b.length < 2 + bytes) return null;
    tamanho = b.readUIntBE(2, bytes);
    inicio = 2 + bytes;
  }
  if (inicio + tamanho !== b.length) return null;
  return b.subarray(inicio).toString("utf8");
}

/**
 * A identidade que o certificado declara, a partir do assinante que o @sigstore/verify devolveu.
 * `certificado` é o DER da folha, lido de novo pelo próprio leitor X.509 do Node como segunda
 * opinião sobre o SAN.
 */
function identidadeDoCertificado(assinante, certificado) {
  const identidade = assinante && assinante.identity;
  if (!identidade) return null;
  const valores = {};
  const vistas = new Set();
  for (const par of identidade.oids || []) {
    const id = par && par.oid && Array.isArray(par.oid.id) ? par.oid.id.join(".") : null;
    if (!id) continue;
    // O X.509 proíbe repetir uma extensão; um certificado que repete é ambíguo.
    if (vistas.has(id)) return { duplicada: id };
    vistas.add(id);
    valores[id] = par.value;
  }
  const campos = {};
  for (const [nome, oid] of Object.entries(OID)) campos[nome] = oid in valores ? textoDer(valores[oid]) : null;

  let sanNode = null;
  try {
    sanNode = new crypto.X509Certificate(certificado).subjectAltName || null;
  } catch {}
  return {
    ...campos,
    san: identidade.subjectAlternativeName || null,
    sanNode,
    emissorDeclarado: identidade.extensions ? identidade.extensions.issuer || null : null,
  };
}

/**
 * A política de identidade. Toda comparação é exata: nada de padrão, nada de prefixo.
 */
function conferirIdentidade(id, { versao, commit }, oficial = IDENTIDADE_OFICIAL) {
  if (!id) return recusa("a atestação não traz a identidade de quem a emitiu", "identidade");
  if (id.duplicada) return recusa(`o certificado da atestação repete a extensão ${id.duplicada}`, "identidade");

  const assinante = assinanteDaVersao(versao, oficial);
  const ref = refDaVersao(versao);
  const regras = [
    ["emissor", oficial.emissor, "não foi emitida pelo GitHub Actions"],
    ["emissorDeclarado", oficial.emissor, "não foi emitida pelo GitHub Actions"],
    ["repositorio", oficial.repositorio, "é de outro repositório"],
    ["repositorioId", oficial.repositorioId, "é de outro repositório (identificador diferente)"],
    ["dono", oficial.dono, "é de outro dono"],
    ["donoId", oficial.donoId, "é de outro dono (identificador diferente)"],
    ["san", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["assinante", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["configuracao", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["ref", ref, "é de outra etiqueta"],
    ["gatilho", oficial.gatilho, "não veio da publicação de uma etiqueta"],
    ["executor", oficial.executor, "não foi feita num executor hospedado pelo GitHub"],
    ["ambiente", oficial.ambiente, "não foi feita no ambiente de publicação"],
    ["commit", commit, "é de outro commit"],
    ["configuracaoCommit", commit, "usou um workflow de outro commit"],
  ];
  for (const [campo, esperado, frase] of regras) {
    if (id[campo] !== esperado) {
      const obtido = id[campo] === null || id[campo] === undefined ? "ausente" : id[campo];
      return recusa(`a atestação ${frase} (${obtido}; esperado ${esperado})`, "identidade");
    }
  }
  if (id.sanNode !== `URI:${assinante}`) {
    return recusa("o certificado da atestação declara mais de um nome, ou outro nome", "identidade");
  }
  return { ok: true };
}

// --- Declaração --------------------------------------------------------------------------------

function lerDeclaracao(bundle) {
  const envelope = bundle.content && bundle.content.$case === "dsseEnvelope" ? bundle.content.dsseEnvelope : null;
  if (!envelope) return recusa("a atestação não é um envelope DSSE", "declaracao");
  if (envelope.payloadType !== TIPO_PAYLOAD) return recusa(`a atestação traz ${envelope.payloadType}, não uma declaração in-toto`, "declaracao");
  let declaracao;
  try {
    declaracao = JSON.parse(Buffer.from(envelope.payload).toString("utf8"));
  } catch {
    return recusa("a declaração da atestação não é JSON", "declaracao");
  }
  if (!declaracao || declaracao._type !== TIPO_DECLARACAO) return recusa("a atestação não traz uma declaração in-toto v1", "declaracao");
  if (declaracao.predicateType !== TIPO_PREDICADO) {
    return recusa(`a atestação é do tipo ${declaracao.predicateType}, não proveniência SLSA`, "declaracao");
  }
  if (!Array.isArray(declaracao.subject) || !declaracao.subject.length || declaracao.subject.length > MAX_SUJEITOS) {
    return recusa("a atestação não lista os arquivos que cobre", "declaracao");
  }
  const sujeitos = new Map();
  for (const s of declaracao.subject) {
    const sha = s && s.digest && s.digest.sha256;
    if (!s || typeof s.name !== "string" || !/^[0-9a-f]{64}$/.test(String(sha || ""))) {
      return recusa("a atestação lista um arquivo sem nome ou sem SHA-256", "declaracao");
    }
    // Um nome com dois digests faria a resposta depender da ordem.
    if (sujeitos.has(s.name) && sujeitos.get(s.name) !== sha) return recusa(`a atestação lista ${s.name} duas vezes`, "declaracao");
    sujeitos.set(s.name, sha);
  }
  return { ok: true, declaracao, sujeitos };
}

/**
 * O predicado é assinado, mas os seus valores são compostos pela execução do workflow. Ele precisa
 * concordar com o certificado; nunca o substitui.
 */
function conferirPredicado(declaracao, { versao, commit }, oficial = IDENTIDADE_OFICIAL) {
  const definicao = declaracao.predicate && declaracao.predicate.buildDefinition;
  const workflow = definicao && definicao.externalParameters && definicao.externalParameters.workflow;
  const dependencias = definicao && Array.isArray(definicao.resolvedDependencies) ? definicao.resolvedDependencies : [];
  const coincide =
    workflow &&
    workflow.repository === oficial.repositorio &&
    workflow.path === oficial.workflow &&
    workflow.ref === refDaVersao(versao) &&
    dependencias.some((d) => d && d.digest && d.digest.gitCommit === commit);
  return coincide ? { ok: true } : recusa("a descrição do build na atestação não confere com o certificado", "declaracao");
}

// --- Verificação -------------------------------------------------------------------------------

/**
 * Lê e verifica criptograficamente um pacote. Devolve a identidade e a declaração; a política é
 * aplicada por quem chama, que sabe o que o release alega ser.
 */
function verificarAssinatura(bytesAtestacao, raiz) {
  if (!Buffer.isBuffer(bytesAtestacao) || !bytesAtestacao.length) return recusa("a atestação está vazia", "malformada");
  if (bytesAtestacao.length > LIMITE_ATESTACAO) return recusa("a atestação é grande demais", "malformada");
  const { bundleFromJSON } = require("@sigstore/bundle");
  const { Verifier, toSignedEntity, toTrustMaterial } = require("@sigstore/verify");

  let bundle;
  try {
    bundle = bundleFromJSON(JSON.parse(bytesAtestacao.toString("utf8")));
  } catch {
    return recusa("a atestação está malformada", "malformada");
  }
  // Só um certificado do Fulcio carrega identidade. Um pacote assinado só por uma chave, sem
  // certificado, não tem nenhuma, e a raiz de confiança não lista chave assim de qualquer forma.
  const material = bundle.verificationMaterial && bundle.verificationMaterial.content;
  if (!material || material.$case !== "certificate") return recusa("a atestação não traz um certificado de identidade", "malformada");

  let assinante;
  try {
    const verificador = new Verifier(toTrustMaterial(raiz), { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 });
    assinante = verificador.verify(toSignedEntity(bundle));
  } catch (erro) {
    return recusa(`a atestação não confere criptograficamente (${(erro && erro.code) || "erro"})`, "criptografia");
  }
  // Só agora o conteúdo do envelope é autêntico o bastante para ser lido.
  const declaracao = lerDeclaracao(bundle);
  if (!declaracao.ok) return declaracao;
  return {
    ok: true,
    identidade: identidadeDoCertificado(assinante, Buffer.from(material.certificate.rawBytes)),
    declaracao: declaracao.declaracao,
    sujeitos: declaracao.sujeitos,
  };
}

/**
 * Verifica um release: bytes do manifesto mais o pacote da atestação. Devolve o manifesto só quando
 * a cadeia inteira se sustenta; nada do release é confiável antes disso.
 */
function verificarPublicacao({ manifesto: bytesManifesto, atestacao: bytesAtestacao, raiz }) {
  if (!Buffer.isBuffer(bytesManifesto) || !bytesManifesto.length) return recusa("manifesto vazio", "manifesto");

  const assinatura = verificarAssinatura(bytesAtestacao, raiz);
  if (!assinatura.ok) return assinatura;

  // O manifesto só é confiável como os bytes exatos que o workflow atestou.
  const shaManifesto = crypto.createHash("sha256").update(bytesManifesto).digest("hex");
  if (assinatura.sujeitos.get(ARQUIVO_MANIFESTO) !== shaManifesto) {
    return recusa("o manifesto não é o arquivo que a atestação cobre", "sujeito");
  }
  let manifesto;
  try {
    manifesto = JSON.parse(bytesManifesto.toString("utf8"));
  } catch {
    return recusa("manifesto não é JSON válido", "manifesto");
  }
  const estrutura = release.validarEstrutura(manifesto);
  if (!estrutura.ok) return { ...estrutura, codigo: "manifesto" };

  const alegado = { versao: manifesto.versao, commit: manifesto.commit };
  const identidade = conferirIdentidade(assinatura.identidade, alegado);
  if (!identidade.ok) return identidade;
  const predicado = conferirPredicado(assinatura.declaracao, alegado);
  if (!predicado.ok) return predicado;

  // Todo artefato que o manifesto lista está atestado com o digest que ele declara, não só o que
  // este console vai baixar: um manifesto que descreve bytes não atestados é recusado inteiro.
  for (const artefato of manifesto.artefatos) {
    if (assinatura.sujeitos.get(artefato.arquivo) !== artefato.sha256) {
      return recusa(`o artefato ${artefato.arquivo} não está coberto pela atestação com o digest do manifesto`, "sujeito");
    }
  }

  return {
    ok: true,
    manifesto,
    identidade: {
      assinante: assinatura.identidade.assinante,
      ref: assinatura.identidade.ref,
      commit: assinatura.identidade.commit,
      execucao: assinatura.identidade.execucao,
    },
  };
}

const modulo = {
  IDENTIDADE_OFICIAL,
  TIPO_PREDICADO,
  ARQUIVO_MANIFESTO,
  ARQUIVO_ATESTACAO,
  ESPELHO_TUF,
  TEMPO_TUF_MS,
  OID,
  refDaVersao,
  assinanteDaVersao,
  raizDeConfianca,
  textoDer,
  conferirIdentidade,
  verificarAssinatura,
  verificarPublicacao,
};
module.exports = modulo;
