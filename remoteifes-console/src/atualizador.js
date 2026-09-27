const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const zlib = require("zlib");
const { pipeline, finished } = require("stream");
const config = require("./config");
const estado = require("./estado");
const release = require("./release");
const atestacao = require("./atestacao");
const plataforma = require("./plataforma");

// Updater of the installed Console.
//
// Model: **side-by-side versioned payloads with a stable bootstrap layer**.
//
//   <raiz>/console-bootstrap.js      stable layer, installed by the package, never rewritten
//   <raiz>/estado-instalacao.json    active version pointer + transaction in progress
//   <raiz>/versoes/2.0.0/            immutable payload
//   <raiz>/versoes/2.1.0/
//   <raiz>/descargas/                staging area
//
// Consequences that justify the complexity:
//   - the `.deb` (or installer) owns only the stable layer; later updates never overwrite files
//     registered by the package manager, so it never becomes inconsistent;
//   - rollback is a pointer swap, not a reinstall;
//   - on Windows there is no need to replace an executable in use.
//
// The pointer swap is the only irreversible step, and it is a `rename`: atomic enough that a power
// loss leaves either the old or the new version, never something in between.

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const LIMITE_ARTEFATO = 120 * 1024 * 1024;
// ABSOLUTE ceilings, independent of what the manifest declares.
//
// The manifest is attested, but attested is not the same as correct: a publishing mistake can
// declare an absurd size, and the Console runs on a 1 GiB Raspberry Pi. Compressed and decompressed sizes
// have their own ceilings, and the file count limits a small archive that expands into millions of
// entries.
const LIMITE_DESCOMPRIMIDO = 400 * 1024 * 1024;
const LIMITE_ARQUIVOS_PAYLOAD = 5000;

// Hard deadlines for whole transfers, redirects included (see baixar). The manifest and the
// attestation are small; the artifact gets the time a slow campus link needs.
const PRAZOS = { consultaMs: 30_000, artefatoMs: 15 * 60 * 1000 };

function raizInstalacao() {
  return config.RAIZ_INSTALACAO;
}

function arquivoEstado() {
  return path.join(raizInstalacao(), "estado-instalacao.json");
}

function dirVersoes() {
  return path.join(raizInstalacao(), "versoes");
}

function dirDescargas() {
  return path.join(raizInstalacao(), "descargas");
}

/**
 * Exclusive lock for version operations on the installation root.
 *
 * Update, offline import and rollback change the same pointer and the same `versoes/`. Without
 * exclusion, two concurrent operations could install v2 and v3 at once and one could prune the
 * version the other is about to activate, leaving the pointer at a missing directory and the
 * Console unable to start. The single `transacao` field would also be overwritten.
 *
 * `wx` fails if the file exists, so creation itself proves exclusivity. A lock left by a dead
 * process is recovered: otherwise a crash mid-update would lock the installation forever.
 */
function arquivoTrava() {
  return path.join(raizInstalacao(), "operacao-em-andamento.json");
}

function processoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    return erro && erro.code === "EPERM";
  }
}

function adquirirTrava(operacao, tentativa = 0) {
  const arquivo = arquivoTrava();
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  try {
    const fd = fs.openSync(arquivo, "wx", 0o644);
    fs.writeFileSync(fd, `${JSON.stringify({ operacao, pid: process.pid, em: new Date().toISOString() })}\n`);
    fs.closeSync(fd);
    return { ok: true };
  } catch (erro) {
    if (erro.code !== "EEXIST") return { ok: false, motivo: `não foi possível criar a trava de operação: ${erro.message}` };
  }

  const dono = estado.lerJson(arquivo, {});
  if (processoVivo(dono.pid)) {
    return {
      ok: false,
      motivo:
        `outra operação de versão está em andamento (${dono.operacao || "desconhecida"}, pid ${dono.pid}, desde ` +
        `${dono.em || "?"}). Espere que ela termine.`,
    };
  }
  if (tentativa >= 3) return { ok: false, motivo: "não foi possível resolver a trava de operação; tente de novo" };

  // Orphan lock recovery by RENAME, not by removal.
  //
  // Remove-and-recreate races: two processes can see the same dead owner, the first recreates the
  // lock and the second removes that live lock and creates its own. Rename is atomic and only one
  // of them can move that path, so whoever moves it has the right to recreate. The other fails the
  // rename, re-reads and finds a live owner.
  const aposentada = `${arquivo}.orfa-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(arquivo, aposentada);
  } catch {
    // Someone got there first: re-read instead of assuming anything.
    return adquirirTrava(operacao, tentativa + 1);
  }
  const confirmado = estado.lerJson(aposentada, {});
  fs.rmSync(aposentada, { force: true });
  estado.auditar("trava-de-operacao-residual", { operacao: confirmado.operacao || null, pid: confirmado.pid || null });
  return adquirirTrava(operacao, tentativa + 1);
}

/**
 * Is a version operation in progress by a live process?
 */
function operacaoEmAndamento() {
  const dono = estado.lerJson(arquivoTrava(), null);
  return dono && processoVivo(dono.pid) && dono.pid !== process.pid ? dono : null;
}

function liberarTrava() {
  try {
    const dono = estado.lerJson(arquivoTrava(), {});
    if (dono.pid === process.pid) fs.rmSync(arquivoTrava(), { force: true });
  } catch {}
}

function lerEstadoInstalacao() {
  return estado.lerJson(arquivoEstado(), { versaoAtiva: null, versaoAnterior: null, transacao: null, atualizadoEm: null });
}

/**
 * Writes the installation record **merging** with what is already there.
 *
 * The record holds more than the pointer: scope, state directory, logs and port, written by the
 * installer. Replacing the whole object on each update or rollback would erase those fields, and
 * the installation would look for state in the platform default on the next start.
 */
function gravarEstadoInstalacao(valor) {
  const atual = lerEstadoInstalacao();
  estado.gravarJson(arquivoEstado(), { ...atual, ...valor }, 0o644);
}

/**
 * Versions present on disk, plus the active pointer.
 */
function versoesInstaladas() {
  const info = lerEstadoInstalacao();
  let presentes = [];
  try {
    presentes = fs
      .readdirSync(dirVersoes(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && RE_VERSAO.test(e.name))
      .map((e) => e.name)
      .sort(release.compararVersoes);
  } catch {}
  return {
    ativa: info.versaoAtiva,
    anterior: info.versaoAnterior && presentes.includes(info.versaoAnterior) ? info.versaoAnterior : null,
    presentes,
    transacaoPendente: info.transacao || null,
    gerenciadoLadoALado: presentes.length > 0,
    ativacaoPendente: info.ativacao && !info.ativacao.confirmada ? info.ativacao : null,
    reversaoAutomatica: info.reversaoAutomatica || null,
  };
}

/**
 * Version running in this process (the payload the Console was loaded from).
 */
function versaoEmExecucao() {
  try {
    return require(path.join(config.RAIZ_CONSOLE, "package.json")).version;
  } catch {
    return null;
  }
}

/**
 * The version a publication must be newer than: the running one or, when the pointer already
 * names a newer one waiting for the next start, that one. Comparing with the running version alone
 * would let an older publication move the pointer back while a restart is pending.
 */
function versaoDeReferencia() {
  const emExecucao = versaoEmExecucao();
  const ativa = lerEstadoInstalacao().versaoAtiva;
  if (ativa && RE_VERSAO.test(String(ativa)) && (!emExecucao || release.compararVersoes(ativa, emExecucao) > 0)) return ativa;
  return emExecucao;
}

// --- Discovery ------------------------------------------------------------------------------

// Transport failures that mean "the publication cannot be reached now", as opposed to an origin
// that answered. On a campus without Internet they are the normal state: the check is deferred and
// reported as its own result, never as a fault of the Console or of RemoteIFES. TLS failures are
// here too: a captive portal or an intercepting proxy is also "no usable Internet".
const CODIGOS_DE_REDE = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN",
  "EHOSTUNREACH", "EHOSTDOWN", "EPIPE", "ECONNABORTED", "EPROTO", "ERR_STREAM_PREMATURE_CLOSE",
]);

function falhaDeRede(erro) {
  const codigo = (erro && erro.code) || "";
  return CODIGOS_DE_REDE.has(codigo) || /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/.test(codigo);
}

/**
 * GET with a hard deadline for the WHOLE transfer, redirects included.
 *
 * A socket timeout alone does not bound a request: a peer that sends one byte now and then, or a
 * name lookup that hangs, would keep it open for as long as they like. `prazoMs` closes that.
 * Returns the body as a Buffer (the manifest is attested as bytes) or writes it to `destino`,
 * which is removed on any failure: a partial download never stays behind looking like a file.
 * `rede: true` marks the failures that mean "try again later".
 */
function baixar(url, { destino = null, limiteBytes = LIMITE_ARTEFATO, prazoMs = 60_000, saltos = 0, inicio = Date.now() } = {}) {
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, erro: "endereço inválido" });
  }
  // Public releases: no credential is sent, on any hop. A redirect to storage must never carry an
  // authorization header along.
  const transporte = alvo.protocol === "http:" ? http : https;
  if (alvo.protocol !== "https:" && !process.env.CONSOLE_RELEASE_BASE) {
    return Promise.resolve({ ok: false, erro: "download só é aceito por HTTPS" });
  }
  if (saltos > 3) return Promise.resolve({ ok: false, erro: "mais de 3 redirecionamentos" });
  const restante = prazoMs - (Date.now() - inicio);
  if (restante <= 0) return Promise.resolve({ ok: false, erro: "tempo esgotado", rede: true });

  return new Promise((resolve) => {
    let concluido = false;
    let prazo = null;
    // Never throws: on Windows a file still open by the write stream cannot be removed yet, and the
    // stream's own end tries again (aoTerminar).
    const removerParcial = () => {
      if (!destino) return;
      try {
        fs.rmSync(destino, { force: true });
      } catch {}
    };
    const concluir = (resultado) => {
      if (concluido) return;
      concluido = true;
      clearTimeout(prazo);
      if (!resultado.ok) removerParcial();
      resolve(resultado);
    };

    const req = transporte.request(
      {
        protocol: alvo.protocol,
        host: alvo.hostname,
        port: alvo.port || undefined,
        path: `${alvo.pathname}${alvo.search}`,
        method: "GET",
        headers: { "User-Agent": "remoteifes-console", Accept: "*/*" },
        timeout: Math.min(restante, 30_000),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const proximo = new URL(res.headers.location, alvo).toString();
          clearTimeout(prazo);
          concluido = true;
          return resolve(baixar(proximo, { destino, limiteBytes, prazoMs, saltos: saltos + 1, inicio }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          // 404 is an answer ("nothing published there"); any other status is an origin, proxy or
          // storage that cannot serve the file now.
          return concluir({ ok: false, erro: `HTTP ${res.statusCode}`, status: res.statusCode, rede: res.statusCode !== 404 });
        }
        let bytes = 0;
        let excedeu = false;
        const partes = [];
        res.on("data", (d) => {
          bytes += d.length;
          if (bytes > limiteBytes) {
            excedeu = true;
            res.destroy();
            return;
          }
          if (!destino) partes.push(d);
        });
        const aoTerminar = (erro) => {
          // Already decided (the deadline): the stream is closed now, so the partial file can go.
          if (concluido) {
            if (erro || !res.complete) removerParcial();
            return undefined;
          }
          if (excedeu) return concluir({ ok: false, erro: destino ? "download passou do limite de tamanho" : "resposta grande demais" });
          // `complete` is false when the connection closed before the body the server announced.
          if (erro || !res.complete) {
            return concluir({ ok: false, erro: erro && erro.code ? erro.code : "transferência incompleta", rede: true });
          }
          return concluir(destino ? { ok: true, arquivo: destino, bytes } : { ok: true, conteudo: Buffer.concat(partes), bytes });
        };
        if (destino) {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          pipeline(res, fs.createWriteStream(destino, { mode: 0o600 }), aoTerminar);
        } else {
          finished(res, aoTerminar);
        }
      }
    );
    prazo = setTimeout(() => {
      req.destroy();
      concluir({ ok: false, erro: "tempo esgotado", rede: true });
    }, restante);
    req.on("timeout", () => {
      req.destroy();
      concluir({ ok: false, erro: "tempo esgotado", rede: true });
    });
    req.on("error", (erro) => concluir({ ok: false, erro: erro.code || erro.message, rede: falhaDeRede(erro) }));
    req.end();
  });
}

function baseDeRelease() {
  return (
    process.env.CONSOLE_RELEASE_BASE ||
    "https://github.com/SENAI4LIFE/RemoteIFES/releases/latest/download"
  );
}

function arquivoObservacao() {
  return path.join(config.DIR_ESTADO, "observacao-release.json");
}

/**
 * Fetches and verifies the current publication: manifest, attestation bundle and a fresh Sigstore
 * trusted root, then src/atestacao.js. Keeps the last SUCCESSFUL observation with its time, apart
 * from whatever the latest attempt found, so the interface shows old data as old instead of as
 * current, and a network failure does not erase what was known.
 *
 * Failures come in three kinds, and only one of them is alarming:
 *   semPublicacao  the origin answered that nothing is published there;
 *   semRede        the publication or Sigstore could not be reached now (normal without Internet);
 *   recusado       something was published and it does not prove where it came from.
 */
async function verificarPublicacao() {
  const anterior = estado.lerJson(arquivoObservacao(), null);
  const base = baseDeRelease();
  const inacessivel = (o, erro) => ({
    ok: false,
    semRede: true,
    motivo: `${o} não está acessível agora (${erro}); o console segue funcionando e tenta de novo mais tarde`,
    ultimaObservacao: anterior,
  });

  const manifestoResp = await baixar(`${base}/${atestacao.ARQUIVO_MANIFESTO}`, { limiteBytes: 2 * 1024 * 1024, prazoMs: PRAZOS.consultaMs });
  if (!manifestoResp.ok && manifestoResp.status === 404) {
    return { ok: false, semPublicacao: true, motivo: `nenhuma publicação do console em ${base}`, ultimaObservacao: anterior };
  }
  if (!manifestoResp.ok) return manifestoResp.rede ? inacessivel("a publicação", manifestoResp.erro) : recusarPublicacao(manifestoResp.erro);

  const atestacaoResp = await baixar(`${base}/${atestacao.ARQUIVO_ATESTACAO}`, { limiteBytes: 2 * 1024 * 1024, prazoMs: PRAZOS.consultaMs });
  if (!atestacaoResp.ok && atestacaoResp.status === 404) {
    return recusarPublicacao("a publicação não traz a atestação de proveniência");
  }
  if (!atestacaoResp.ok) return atestacaoResp.rede ? inacessivel("a atestação", atestacaoResp.erro) : recusarPublicacao(atestacaoResp.erro);

  let raiz;
  try {
    ({ raiz } = await atestacao.raizDeConfianca({ rede: true }));
  } catch (erro) {
    return inacessivel("a raiz de confiança do Sigstore", (erro && (erro.code || erro.message)) || "erro");
  }

  const verificacao = atestacao.verificarPublicacao({ manifesto: manifestoResp.conteudo, atestacao: atestacaoResp.conteudo, raiz });
  if (!verificacao.ok) return recusarPublicacao(verificacao.motivo);

  const observacao = {
    observadoEm: new Date().toISOString(),
    versao: verificacao.manifesto.versao,
    canal: verificacao.manifesto.canal || "estavel",
    notas: verificacao.manifesto.notas || null,
    commit: verificacao.manifesto.commit,
    alvos: verificacao.manifesto.artefatos.map((a) => a.alvo),
    execucao: verificacao.identidade.execucao || null,
  };
  estado.gravarJson(arquivoObservacao(), observacao, 0o600);
  return { ok: true, ...observacao, manifesto: verificacao.manifesto };
}

function recusarPublicacao(motivo) {
  return { ok: false, recusado: true, motivo: `publicação recusada: ${motivo}. Nada foi instalado.` };
}

/**
 * The pointer names one version and the process loaded another.
 *
 * This happens when the pointer swap succeeds but the new payload does not start: the bootstrap
 * falls back to the previous version (the safety net working) and only reports it on stderr. Under
 * a systemd unit that goes to the journal; behind a Windows shortcut opened by wscript it appears
 * nowhere. The silent result is the worst one: the update reports success, the Console works again,
 * and the operator believes they run code that is not running.
 *
 * Applies only to a managed side-by-side installation: a run from source has no pointer to diverge
 * from.
 */
function divergenciaDeVersao(instaladas, emExecucao, info = {}) {
  if (!instaladas.gerenciadoLadoALado || !instaladas.ativa || !emExecucao) return null;
  if (instaladas.ativa === emExecucao) return null;

  // A pending restart is NOT divergence.
  //
  // A process that started before the pointer moved is legitimately still the previous version:
  // right after an update, and until the next start after an automatic update, which never
  // restarts a Console in use. Alarming here would say the version "did not start" at the exact
  // moment everything is correct, and a warning that fires on the normal path is one operators
  // learn to ignore. A process that started AFTER the swap and still runs the previous version is
  // the bootstrap's fallback, and that is reported below.
  const inicioDoProcesso = Date.now() - process.uptime() * 1000;
  const trocadaDepoisDoInicio =
    info.transacao &&
    info.transacao.etapa === "concluida" &&
    info.transacao.versao === instaladas.ativa &&
    Date.parse(info.atualizadoEm || info.transacao.em || 0) >= inicioDoProcesso - 2000;
  if (trocadaDepoisDoInicio && emExecucao === instaladas.anterior) {
    return {
      registrada: instaladas.ativa,
      emExecucao,
      reinicioPendente: true,
      motivo:
        `a versão ${instaladas.ativa} já está instalada e verificada, e este processo ainda é o ${emExecucao}. ` +
        "Ela passa a valer quando o console reiniciar: sozinho, depois de ficar ocioso, ou ao fechar e reabrir.",
    };
  }

  return {
    registrada: instaladas.ativa,
    emExecucao,
    motivo:
      `o ponteiro aponta para ${instaladas.ativa}, mas o console em execução é ${emExecucao}. ` +
      "A versão apontada não subiu e o bootstrap caiu para uma utilizável. Reinstale ou reverta: " +
      "até lá, o programa em uso NÃO é o que a versão ativa indica.",
  };
}

/**
 * Status for the interface: installed, available, target, readiness and caveats.
 */
async function situacao({ consultarRede = false } = {}) {
  const instaladas = versoesInstaladas();
  const emExecucao = versaoEmExecucao();
  const observacao = estado.lerJson(arquivoObservacao(), null);
  const idadeS = observacao ? Math.round((Date.now() - Date.parse(observacao.observadoEm)) / 1000) : null;

  // `consultarRede` is the operator's explicit "check now". Everything else here reads local files:
  // opening the page never reaches GitHub or Sigstore.
  let consulta = null;
  if (consultarRede) consulta = await verificarPublicacao();

  const alvo = release.alvoAtual();
  const disponivel = consulta && consulta.ok ? consulta.versao : observacao ? observacao.versao : null;
  const referencia = versaoDeReferencia();
  const politica = disponivel && referencia ? release.politicaDeVersao({ versao: disponivel }, referencia) : null;

  return {
    versaoEmExecucao: emExecucao,
    versaoAtivaRegistrada: instaladas.ativa,
    divergenciaDeVersao: divergenciaDeVersao(instaladas, emExecucao, lerEstadoInstalacao()),
    versaoAnterior: instaladas.anterior,
    versoesPresentes: instaladas.presentes,
    gerenciadoLadoALado: instaladas.gerenciadoLadoALado,
    transacaoPendente: instaladas.transacaoPendente,
    ativacaoPendente: instaladas.ativacaoPendente,
    reversaoAutomatica: instaladas.reversaoAutomatica,
    alvo,
    ultimaObservacao: observacao
      ? {
          ...observacao,
          idadeSegundos: idadeS,
          recente: idadeS !== null && idadeS < 3600,
          ressalva: idadeS !== null && idadeS >= 3600 ? "esta observação é antiga; a publicação pode ter mudado desde então" : null,
        }
      : null,
    consultaAgora: consulta && !consulta.ok ? consulta : null,
    verificacaoAutomatica: require("./verificacao-automatica").resumo(),
    disponivel,
    podeAtualizar: !!(politica && politica.ok),
    motivoNaoAtualizar: politica && !politica.ok ? politica.motivo : null,
    observacaoDeDistribuicao:
      "Esta é a versão do **programa console**, independente do commit do RemoteIFES implantado e das versões de " +
      "servidor, PWA e aplicativo.",
  };
}

/**
 * Validation used by the action before confirmation.
 */
async function validarAlvo(versao) {
  if (!RE_VERSAO.test(String(versao || ""))) return "versão alvo inválida";
  const instaladas = versoesInstaladas();
  if (!instaladas.gerenciadoLadoALado) {
    return (
      "esta instalação não usa o layout de versões lado a lado, então a troca de ponteiro não se aplica. " +
      "Reinstale com o instalador desta versão para migrar o layout."
    );
  }
  return null;
}

// --- Safe extraction ---------------------------------------------------------------------------

/**
 * Extracts a `.tar.gz` without the system `tar` (missing on some Windows) and without accepting
 * paths that escape the destination. Supports only regular files and directories: symlinks,
 * hardlinks and devices are **refused**, because an artifact is remote content.
 */
function extrairTarGz(arquivoOuConteudo, destino) {
  // Accepts a Buffer so installation extracts exactly the bytes that went through the digest,
  // without re-reading the path (a re-read would reopen the window between verification and
  // installation). `maxOutputLength` stops expansion inside gunzip itself: without it a small,
  // highly compressed artifact exhausts host memory before any content check.
  let bruto;
  try {
    bruto = zlib.gunzipSync(Buffer.isBuffer(arquivoOuConteudo) ? arquivoOuConteudo : fs.readFileSync(arquivoOuConteudo), {
      maxOutputLength: LIMITE_DESCOMPRIMIDO,
    });
  } catch (erro) {
    if (erro && (erro.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(erro.message || ""))) {
      throw new Error(`o artefato expande além do limite de ${LIMITE_DESCOMPRIMIDO / 1048576} MiB; extração recusada`);
    }
    throw erro;
  }
  const raizReal = path.resolve(destino);
  fs.mkdirSync(raizReal, { recursive: true });

  let posicao = 0;
  let arquivos = 0;
  let entradas = 0;
  let prefixoLongo = null;

  while (posicao + 512 <= bruto.length) {
    const cabecalho = bruto.subarray(posicao, posicao + 512);
    if (cabecalho.every((b) => b === 0)) break;

    const lerTexto = (inicio, tamanho) => cabecalho.subarray(inicio, inicio + tamanho).toString("utf8").replace(/\0.*$/, "").trim();
    let nome = prefixoLongo || lerTexto(0, 100);
    prefixoLongo = null;
    const modo = parseInt(lerTexto(100, 8) || "0", 8) || 0o644;
    const tamanho = parseInt(lerTexto(124, 12) || "0", 8) || 0;
    const tipo = String.fromCharCode(cabecalho[156]) || "0";
    const prefixo = lerTexto(345, 155);
    if (prefixo) nome = `${prefixo}/${nome}`;

    const blocos = Math.ceil(tamanho / 512);
    const conteudo = bruto.subarray(posicao + 512, posicao + 512 + tamanho);
    posicao += 512 + blocos * 512;

    if (tipo === "L") {
      // GNU long name: the next item's name comes in this record's body.
      prefixoLongo = conteudo.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (tipo === "x" || tipo === "g") continue; // metadados pax
    if (tipo === "1" || tipo === "2") {
      throw new Error(`artefato contém link (${nome}); extração recusada`);
    }
    if (tipo === "3" || tipo === "4" || tipo === "6") {
      throw new Error(`artefato contém arquivo especial (${nome}); extração recusada`);
    }
    if (!nome || nome === "./") continue;

    const limpo = nome.replace(/^\.\//, "");
    if (path.isAbsolute(limpo) || limpo.split(/[\\/]/).some((p) => p === "..")) {
      throw new Error(`artefato contém caminho que escapa do destino: ${nome}`);
    }
    const alvo = path.resolve(raizReal, limpo);
    if (alvo !== raizReal && !alvo.startsWith(raizReal + path.sep)) {
      throw new Error(`artefato contém caminho fora do destino: ${nome}`);
    }

    // The ceiling counts ALL entries, not only files: a tar of directories only would pass the
    // limit and still exhaust inodes.
    entradas += 1;
    if (entradas > LIMITE_ARQUIVOS_PAYLOAD) {
      throw new Error(`o artefato tem mais de ${LIMITE_ARQUIVOS_PAYLOAD} entradas; extração recusada`);
    }

    if (tipo === "5") {
      fs.mkdirSync(alvo, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
    // Preserves only the executable bit; no setuid/setgid from an artifact.
    if (process.platform !== "win32") fs.chmodSync(alvo, modo & 0o755);
    arquivos += 1;
  }
  if (!arquivos) throw new Error("o artefato não continha arquivos");
  return { arquivos };
}

// --- Update transaction ------------------------------------------------------------------------

function limparDescargas() {
  try {
    fs.rmSync(dirDescargas(), { recursive: true, force: true });
  } catch {}
}

/**
 * Reconciles an interrupted transaction. Called at Console start: if power failed between staging
 * and the pointer swap, what remains is garbage in `descargas/` or an incomplete version directory,
 * never a half installation, because the swap is a rename.
 */
/**
 * Removes extraction staging directories (`versoes/<v>.parcial-<aleatorio>`).
 *
 * Never touches `.substituido-*`: during a payload replacement that directory is the only copy of
 * the previous version, and deleting it would turn an interrupted reinstall into a lost version.
 */
function limparParciais(versao) {
  try {
    const prefixo = versao ? `${String(versao)}.parcial-` : null;
    for (const nome of fs.readdirSync(dirVersoes())) {
      const ehParcial = /^\d+\.\d+\.\d+\.parcial-[0-9a-f]+$/.test(nome) || (prefixo && nome.startsWith(prefixo));
      if (ehParcial) fs.rmSync(path.join(dirVersoes(), nome), { recursive: true, force: true });
    }
  } catch {}
}

function reconciliar() {
  // A live operation is changing versoes/ right now: reconciling here would delete its staging.
  // This happens when a second Console starts during an update.
  const emAndamento = operacaoEmAndamento();
  if (emAndamento) {
    return { reconciliado: false, adiado: true, motivo: `operação ${emAndamento.operacao || "de versão"} em andamento (pid ${emAndamento.pid})` };
  }

  // Partial directories are ALWAYS swept, not only when a transaction is incomplete: staging can be
  // left by a lost record, an already completed transaction or an installer repair.
  // `.substituido-*` stays untouched.
  limparParciais(null);

  const info = lerEstadoInstalacao();
  if (!info.transacao) return { reconciliado: false };

  const t = info.transacao;
  const destino = path.join(dirVersoes(), String(t.versao || ""));
  const completa = t.etapa === "concluida";
  if (!completa) {
    try {
      fs.rmSync(destino, { recursive: true, force: true });
    } catch {}
    limparParciais(t.versao);
    limparDescargas();
    estado.auditar("atualizacao-console-reconciliada", { versao: t.versao, etapa: t.etapa });
  }
  info.transacao = null;
  gravarEstadoInstalacao(info);
  return { reconciliado: true, etapaInterrompida: completa ? null : t.etapa, versao: t.versao };
}

function registrarTransacao(versao, etapa) {
  const info = lerEstadoInstalacao();
  info.transacao = { versao, etapa, em: new Date().toISOString() };
  gravarEstadoInstalacao(info);
}

/**
 * Installs an **already verified** artifact (manifest attestation and digest checked) and swaps
 * the active version pointer.
 *
 * Kept separate because there are two legitimate sources for the same artifact: the release
 * downloaded over the network and the file carried by hand to a host without Internet. What must
 * not differ between them is exactly this part: extraction refused for escaping paths, contents
 * checked, internal version matching the requested one, and only then the rename.
 */
async function instalarArtefatoVerificado({ versaoAlvo, conteudo, alvo, origem, reiniciar = true, log = () => {} }) {
  const destino = path.join(dirVersoes(), versaoAlvo);
  const abortar = (etapa, erro) => {
    limparDescargas();
    registrarTransacao(versaoAlvo, etapa);
    reconciliar();
    return { ok: false, erro };
  };

  log("Instalando lado a lado...");
  registrarTransacao(versaoAlvo, "instalando");
  const parcial = `${destino}.parcial-${crypto.randomBytes(3).toString("hex")}`;
  try {
    extrairTarGz(conteudo, parcial);
  } catch (erro) {
    fs.rmSync(parcial, { recursive: true, force: true });
    return abortar("falhou-extracao", `extração recusada: ${erro.message}`);
  }

  // The payload must contain what the bootstrap will load, otherwise the swap would leave the
  // Console unable to start.
  for (const exigido of ["console.js", "package.json", path.join("src", "servidor.js")]) {
    if (!fs.existsSync(path.join(parcial, exigido))) {
      fs.rmSync(parcial, { recursive: true, force: true });
      return abortar("falhou-conteudo", `o artefato não contém ${exigido}; instalação abortada antes de trocar a versão ativa.`);
    }
  }
  const pacoteNovo = JSON.parse(fs.readFileSync(path.join(parcial, "package.json"), "utf8"));
  if (pacoteNovo.version !== versaoAlvo) {
    fs.rmSync(parcial, { recursive: true, force: true });
    return abortar("falhou-identidade", `o artefato declara versão ${pacoteNovo.version}, não ${versaoAlvo}.`);
  }

  fs.mkdirSync(dirVersoes(), { recursive: true });
  fs.renameSync(parcial, destino);
  limparDescargas();

  log("Trocando a versão ativa...");
  registrarTransacao(versaoAlvo, "trocando");
  const info = lerEstadoInstalacao();
  const anterior = info.versaoAtiva || versaoEmExecucao();
  // Activation is confirmed by the new version itself once it stays up (src/ativacao.js); until
  // then the stable bootstrap counts its starts and reverts to `anterior` after repeated failures.
  // A payload without that module cannot confirm, so it gets no pending activation.
  const podeConfirmar = fs.existsSync(path.join(destino, "src", "ativacao.js"));
  gravarEstadoInstalacao({
    versaoAtiva: versaoAlvo,
    versaoAnterior: anterior && anterior !== versaoAlvo ? anterior : info.versaoAnterior,
    transacao: { versao: versaoAlvo, etapa: "concluida", em: new Date().toISOString() },
    atualizadoEm: new Date().toISOString(),
    ativacao:
      podeConfirmar && anterior && anterior !== versaoAlvo
        ? { versao: versaoAlvo, anterior, partidas: 0, confirmada: false, desde: new Date().toISOString() }
        : null,
    reversaoAutomatica: null,
  });

  // The running payload is never pruned, whatever the pointer says.
  podarVersoes({ manter: [versaoAlvo, anterior, versaoEmExecucao()].filter(Boolean) });
  estado.auditar("atualizacao-console-aplicada", { de: anterior, para: versaoAlvo, alvo, origem });

  log(`Versão ativa agora é ${versaoAlvo} (anterior: ${anterior || "nenhuma"}).`);
  if (!reiniciar) {
    log("A versão nova passa a valer no próximo início do console.");
    return {
      ok: true,
      versao: versaoAlvo,
      anterior,
      reinicio: "no próximo início",
      resumo: `console ${versaoAlvo} instalado; passa a valer no próximo início, e ${anterior || "a anterior"} fica guardada para reversão`,
    };
  }
  log("Reiniciando o console para carregar a nova versão...");
  const reinicio = await plataforma.reiniciarConsole();
  return {
    ok: true,
    versao: versaoAlvo,
    anterior,
    reinicio: reinicio.disponivel ? "solicitado" : reinicio.motivo,
    resumo: `console ${versaoAlvo} ativo; a versão ${anterior || "anterior"} fica guardada para reversão`,
  };
}

/**
 * Installs a published version and swaps the pointer. Writes to the active directory only after
 * attestation, version policy and digest check out.
 */
async function atualizar(versaoAlvo, { log = () => {} } = {}) {
  const impedimento = await validarAlvo(versaoAlvo);
  if (impedimento) return { ok: false, erro: impedimento };

  const trava = adquirirTrava(`atualizar ${versaoAlvo}`);
  if (!trava.ok) return { ok: false, erro: trava.motivo };
  try {
    return await atualizarComTrava(versaoAlvo, { log });
  } finally {
    liberarTrava();
  }
}

async function atualizarComTrava(versaoAlvo, { log = () => {}, publicacao: jaVerificada = null, reiniciar = true, origem = "release" } = {}) {
  const referencia = versaoDeReferencia();

  // `jaVerificada` is a publication verificarPublicacao returned moments ago under this same lock
  // (the automatic check); every other caller verifies here.
  log("Verificando a publicação e a atestação de proveniência...");
  const publicacao = jaVerificada || (await verificarPublicacao());
  if (!publicacao.ok) return { ok: false, erro: publicacao.motivo, semRede: !!publicacao.semRede };
  if (publicacao.versao !== versaoAlvo) {
    // The target was fixed at confirmation: a publication appearing afterwards does not get in by
    // itself.
    return {
      ok: false,
      erro: `a publicação atual é ${publicacao.versao}, e a operação foi confirmada para ${versaoAlvo}. Reveja e confirme de novo.`,
    };
  }

  const politica = release.politicaDeVersao(publicacao.manifesto, referencia);
  if (!politica.ok) return { ok: false, erro: politica.motivo };

  const escolha = release.escolherArtefato(publicacao.manifesto);
  if (!escolha.ok) return { ok: false, erro: escolha.motivo };
  const artefato = escolha.artefato;
  log(`Alvo ${artefato.alvo}, artefato ${artefato.arquivo} (${(artefato.bytes / 1048576).toFixed(1)} MiB).`);

  const destino = path.join(dirVersoes(), versaoAlvo);
  if (fs.existsSync(destino)) {
    return { ok: false, erro: `a versão ${versaoAlvo} já está presente em ${destino}; remova-a antes de reinstalar.` };
  }

  registrarTransacao(versaoAlvo, "baixando");
  const staging = path.join(dirDescargas(), `${versaoAlvo}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(staging, { recursive: true });
  const arquivoLocal = path.join(staging, artefato.arquivo);

  log("Baixando o artefato...");
  // The download ceiling is the SMALLER of the declared and the absolute: a manifest declaring 100
  // GiB cannot raise the Console's limit.
  const tetoDownload = Math.min(Math.max(artefato.bytes + 4096, 1024), LIMITE_ARTEFATO);
  const download = await baixar(`${baseDeRelease()}/${artefato.arquivo}`, {
    destino: arquivoLocal,
    limiteBytes: tetoDownload,
    prazoMs: PRAZOS.artefatoMs,
  });
  if (!download.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-download");
    reconciliar();
    return { ok: false, erro: `download falhou: ${download.erro}`, semRede: !!download.rede };
  }

  log("Verificando o SHA-256 contra o manifesto atestado...");
  const conferencia = release.conferirArtefato(arquivoLocal, artefato, { limiteBytes: LIMITE_ARTEFATO });
  if (!conferencia.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-verificacao");
    reconciliar();
    estado.auditar("atualizacao-console-digest-divergente", { versao: versaoAlvo, motivo: conferencia.motivo });
    return { ok: false, erro: conferencia.motivo };
  }
  log(`SHA-256 confere (${conferencia.sha256.slice(0, 16)}…).`);

  return instalarArtefatoVerificado({ versaoAlvo, conteudo: conferencia.conteudo, alvo: artefato.alvo, origem, reiniciar, log });
}

/**
 * The automatic check: discovers, verifies and installs a newer publication, and returns what
 * happened as a result the scheduler (src/verificacao-automatica.js) can pace itself by.
 *
 * It never restarts the Console: the new version is activated side by side and loads at the next
 * start, so an operator in the middle of something is never cut off. It does nothing, and touches
 * no network, while the layout is not side by side (a run from source), while a restart is already
 * pending, or while another version operation holds the lock.
 */
async function atualizarAutomaticamente({ log = () => {} } = {}) {
  const instaladas = versoesInstaladas();
  if (!instaladas.gerenciadoLadoALado) return { tipo: "fora-do-escopo", motivo: "execução a partir do código-fonte" };
  const emExecucao = versaoEmExecucao();
  if (instaladas.ativa && emExecucao && instaladas.ativa !== emExecucao) {
    return { tipo: "reinicio-pendente", motivo: `a versão ${instaladas.ativa} espera o próximo início` };
  }
  const trava = adquirirTrava("verificação automática");
  if (!trava.ok) return { tipo: "ocupado", motivo: trava.motivo };
  try {
    const publicacao = await verificarPublicacao();
    if (!publicacao.ok) {
      const tipo = publicacao.semRede ? "sem-rede" : publicacao.semPublicacao ? "sem-publicacao" : "recusado";
      return { tipo, motivo: publicacao.motivo };
    }
    const politica = release.politicaDeVersao(publicacao.manifesto, versaoDeReferencia());
    if (!politica.ok) return { tipo: "em-dia", versao: publicacao.versao, motivo: politica.motivo };

    const r = await atualizarComTrava(publicacao.versao, { log, publicacao, reiniciar: false, origem: "automatica" });
    if (r.ok) return { tipo: "atualizado", versao: r.versao, motivo: r.resumo };
    return { tipo: r.semRede ? "sem-rede" : "recusado", motivo: r.erro };
  } finally {
    liberarTrava();
  }
}

/**
 * Rollback: swaps the pointer to the previous version, already installed and verified. No network.
 */
async function reverter({ log = () => {} } = {}) {
  const trava = adquirirTrava("reverter");
  if (!trava.ok) return { ok: false, erro: trava.motivo };
  try {
    return await reverterComTrava({ log });
  } finally {
    liberarTrava();
  }
}

async function reverterComTrava({ log = () => {} } = {}) {
  const instaladas = versoesInstaladas();
  if (!instaladas.anterior) return { ok: false, erro: "não há versão anterior instalada para a qual voltar." };
  const destino = path.join(dirVersoes(), instaladas.anterior);
  if (!fs.existsSync(path.join(destino, "console.js"))) {
    return { ok: false, erro: `a versão anterior (${instaladas.anterior}) não está íntegra em ${destino}.` };
  }
  log(`Voltando para ${instaladas.anterior}...`);
  gravarEstadoInstalacao({
    versaoAtiva: instaladas.anterior,
    versaoAnterior: instaladas.ativa,
    transacao: { versao: instaladas.anterior, etapa: "concluida", em: new Date().toISOString() },
    atualizadoEm: new Date().toISOString(),
    // Going back to a version that already ran is not a pending activation.
    ativacao: null,
  });
  estado.auditar("atualizacao-console-revertida", { de: instaladas.ativa, para: instaladas.anterior });
  const reinicio = await plataforma.reiniciarConsole();
  return { ok: true, versao: instaladas.anterior, reinicio: reinicio.disponivel ? "solicitado" : reinicio.motivo };
}

/**
 * Keeps only the active and the previous version on disk.
 */
function podarVersoes({ manter = [] } = {}) {
  const preservar = new Set(manter);
  let presentes = [];
  try {
    presentes = fs.readdirSync(dirVersoes(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const removidas = [];
  for (const nome of presentes) {
    if (preservar.has(nome)) continue;
    try {
      fs.rmSync(path.join(dirVersoes(), nome), { recursive: true, force: true });
      removidas.push(nome);
    } catch {}
  }
  return removidas;
}

/**
 * Offline import: the same verification, from files carried to a host without Internet.
 *
 * Takes the release as published (a directory with manifesto.json, atestacao.sigstore.json and the
 * payloads) or the three files named one by one. Nothing here touches the network: the Sigstore
 * trusted root is the last one a refresh verified on this host, or the one the installed Console
 * carries.
 */
async function importarOffline({ diretorio = null, manifesto = null, atestacao: arquivoAtestacao = null, artefato = null, log = () => {} }) {
  if (diretorio) {
    manifesto = path.join(diretorio, atestacao.ARQUIVO_MANIFESTO);
    arquivoAtestacao = path.join(diretorio, atestacao.ARQUIVO_ATESTACAO);
  }
  if (!manifesto || !arquivoAtestacao || !fs.existsSync(manifesto) || !fs.existsSync(arquivoAtestacao)) {
    return { ok: false, erro: `informe a pasta do release ou ${atestacao.ARQUIVO_MANIFESTO}, ${atestacao.ARQUIVO_ATESTACAO} e o artefato` };
  }
  if (!diretorio && (!artefato || !fs.existsSync(artefato))) return { ok: false, erro: "o artefato informado não existe" };
  const trava = adquirirTrava("importar offline");
  if (!trava.ok) return { ok: false, erro: trava.motivo };
  try {
    return await importarOfflineComTrava({ diretorio, manifesto, arquivoAtestacao, artefato, log });
  } finally {
    liberarTrava();
  }
}

function lerPequeno(caminho, limite) {
  const info = fs.statSync(caminho);
  if (info.size > limite) throw new Error(`${path.basename(caminho)} tem ${info.size} bytes, acima do esperado`);
  return fs.readFileSync(caminho);
}

async function importarOfflineComTrava({ diretorio, manifesto, arquivoAtestacao, artefato, log = () => {} }) {
  let bytesManifesto;
  let bytesAtestacao;
  let raiz;
  try {
    bytesManifesto = lerPequeno(manifesto, 2 * 1024 * 1024);
    bytesAtestacao = lerPequeno(arquivoAtestacao, 2 * 1024 * 1024);
    ({ raiz } = await atestacao.raizDeConfianca({ rede: false }));
  } catch (erro) {
    return { ok: false, erro: erro.message };
  }
  const verificacao = atestacao.verificarPublicacao({ manifesto: bytesManifesto, atestacao: bytesAtestacao, raiz });
  if (!verificacao.ok) return { ok: false, erro: recusarPublicacao(verificacao.motivo).motivo };

  const escolha = release.escolherArtefato(verificacao.manifesto);
  if (!escolha.ok) return { ok: false, erro: escolha.motivo };
  const caminhoArtefato = diretorio ? path.join(diretorio, escolha.artefato.arquivo) : artefato;
  if (path.basename(caminhoArtefato) !== escolha.artefato.arquivo) {
    return { ok: false, erro: `o arquivo informado não é o artefato deste alvo (esperado ${escolha.artefato.arquivo}).` };
  }
  const conferencia = release.conferirArtefato(caminhoArtefato, escolha.artefato, { limiteBytes: LIMITE_ARTEFATO });
  if (!conferencia.ok) return { ok: false, erro: conferencia.motivo };

  const versaoAlvo = verificacao.manifesto.versao;
  const politica = release.politicaDeVersao(verificacao.manifesto, versaoDeReferencia());
  if (!politica.ok) return { ok: false, erro: politica.motivo };

  const instaladas = versoesInstaladas();
  if (!instaladas.gerenciadoLadoALado) {
    return {
      ok: false,
      erro:
        "esta instalação não usa o layout de versões lado a lado, então a troca de ponteiro não se aplica. " +
        "Reinstale com o instalador desta versão para migrar o layout.",
    };
  }
  if (fs.existsSync(path.join(dirVersoes(), versaoAlvo))) {
    return { ok: false, erro: `a versão ${versaoAlvo} já está presente; remova-a antes de reinstalar.` };
  }

  log(`Atestação de proveniência e artefato verificados (${verificacao.identidade.ref}, SHA-256 ${conferencia.sha256.slice(0, 16)}…).`);
  estado.auditar("atualizacao-console-offline", { versao: versaoAlvo, alvo: escolha.artefato.alvo, commit: verificacao.manifesto.commit });
  return instalarArtefatoVerificado({
    versaoAlvo,
    conteudo: conferencia.conteudo,
    alvo: escolha.artefato.alvo,
    origem: "arquivo-local",
    log,
  });
}

module.exports = {
  PRAZOS,
  raizInstalacao,
  versoesInstaladas,
  versaoEmExecucao,
  lerEstadoInstalacao,
  gravarEstadoInstalacao,
  verificarPublicacao,
  situacao,
  validarAlvo,
  atualizar,
  atualizarAutomaticamente,
  reverter,
  reconciliar,
  podarVersoes,
  extrairTarGz,
  importarOffline,
  adquirirTrava,
  liberarTrava,
  operacaoEmAndamento,
  baixar,
  falhaDeRede,
};
