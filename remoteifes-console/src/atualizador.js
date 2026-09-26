const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const zlib = require("zlib");
const config = require("./config");
const estado = require("./estado");
const release = require("./release");
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
// The manifest is signed, but signed is not the same as correct: a publishing mistake can declare
// an absurd size, and the Console runs on a 1 GiB Raspberry Pi. Compressed and decompressed sizes
// have their own ceilings, and the file count limits a small archive that expands into millions of
// entries.
const LIMITE_DESCOMPRIMIDO = 400 * 1024 * 1024;
const LIMITE_ARQUIVOS_PAYLOAD = 5000;

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

// --- Discovery ------------------------------------------------------------------------------

function baixar(url, { destino = null, limiteBytes = LIMITE_ARTEFATO, saltos = 0, timeoutMs = 120_000 } = {}) {
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

  return new Promise((resolve) => {
    const req = transporte.request(
      {
        protocol: alvo.protocol,
        host: alvo.hostname,
        port: alvo.port || undefined,
        path: `${alvo.pathname}${alvo.search}`,
        method: "GET",
        headers: { "User-Agent": "remoteifes-console", Accept: "*/*" },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const proximo = new URL(res.headers.location, alvo).toString();
          return resolve(baixar(proximo, { destino, limiteBytes, saltos: saltos + 1, timeoutMs }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, erro: `HTTP ${res.statusCode}`, status: res.statusCode });
        }
        let bytes = 0;
        if (destino) {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          const fluxo = fs.createWriteStream(destino, { mode: 0o600 });
          let abortado = false;
          res.on("data", (d) => {
            bytes += d.length;
            if (bytes > limiteBytes) {
              abortado = true;
              req.destroy();
              fluxo.destroy();
              fs.rmSync(destino, { force: true });
              resolve({ ok: false, erro: "download passou do limite de tamanho" });
            }
          });
          res.pipe(fluxo);
          fluxo.on("finish", () => {
            if (!abortado) resolve({ ok: true, arquivo: destino, bytes });
          });
          fluxo.on("error", (erro) => resolve({ ok: false, erro: erro.message }));
          return;
        }
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          bytes += Buffer.byteLength(d);
          if (bytes > 2 * 1024 * 1024) {
            req.destroy();
            return resolve({ ok: false, erro: "resposta grande demais" });
          }
          texto += d;
        });
        res.on("end", () => resolve({ ok: true, texto, bytes }));
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
 * Queries the current publication. Keeps the last observation with its time, so the interface shows
 * old data as old instead of as current.
 */
async function verificarPublicacao({ forcar = false } = {}) {
  if (!release.confianciaConfigurada()) {
    return {
      ok: false,
      naoConfigurado: true,
      motivo:
        "a atualização por release não está configurada neste console: nenhuma chave pública de publicação foi " +
        "provisionada. O console continua funcionando; a atualização é feita reinstalando o pacote.",
    };
  }

  const anterior = estado.lerJson(arquivoObservacao(), null);
  if (!forcar && anterior && Date.now() - Date.parse(anterior.observadoEm) < 15 * 60 * 1000) {
    return { ok: true, ...anterior, doCache: true };
  }

  const base = baseDeRelease();
  const manifestoResp = await baixar(`${base}/manifesto.json`, { timeoutMs: 30_000 });
  if (!manifestoResp.ok && manifestoResp.status === 404) {
    // The origin answered: there is simply no signed Console publication there yet.
    return { ok: false, motivo: `nenhuma publicação do console em ${base}`, semPublicacao: true, ultimaObservacao: anterior };
  }
  if (!manifestoResp.ok) {
    return { ok: false, motivo: `não foi possível obter o manifesto (${manifestoResp.erro})`, offline: true, ultimaObservacao: anterior };
  }
  const assinaturaResp = await baixar(`${base}/manifesto.json.sig`, { timeoutMs: 30_000 });
  if (!assinaturaResp.ok) {
    return { ok: false, motivo: `não foi possível obter a assinatura (${assinaturaResp.erro})`, ultimaObservacao: anterior };
  }

  const verificacao = release.verificarManifesto(Buffer.from(manifestoResp.texto, "utf8"), assinaturaResp.texto);
  if (!verificacao.ok) {
    estado.auditar("release-manifesto-recusado", { motivo: verificacao.motivo });
    return { ok: false, motivo: verificacao.motivo, recusado: true };
  }
  release.registrarRotacao(verificacao);

  const observacao = {
    observadoEm: new Date().toISOString(),
    versao: verificacao.manifesto.versao,
    canal: verificacao.manifesto.canal || "estavel",
    notas: verificacao.manifesto.notas || null,
    alvos: verificacao.manifesto.artefatos.map((a) => a.alvo),
    expiraEm: verificacao.manifesto.expiraEm,
    chaveUsada: verificacao.chaveUsada,
    idChave: verificacao.idChave,
  };
  estado.gravarJson(arquivoObservacao(), observacao, 0o600);
  return { ok: true, ...observacao, manifesto: verificacao.manifesto };
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
  // Between the pointer swap and the restart, the running process is legitimately the previous
  // version. Alarming here would say the version "did not start" at the exact moment everything is
  // correct, and a warning that fires on the normal path is one operators learn to ignore.
  const concluidaAgora =
    info.transacao &&
    info.transacao.etapa === "concluida" &&
    info.transacao.versao === instaladas.ativa &&
    Date.parse(info.atualizadoEm || info.transacao.em || 0) > Date.now() - 10 * 60 * 1000;
  if (concluidaAgora && emExecucao === instaladas.anterior) {
    return {
      registrada: instaladas.ativa,
      emExecucao,
      reinicioPendente: true,
      motivo:
        `a versão ${instaladas.ativa} foi ativada e este processo ainda é o ${emExecucao}: o reinício está ` +
        "pendente. Feche e reabra o console para carregar a versão nova.",
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

  let consulta = null;
  if (consultarRede) consulta = await verificarPublicacao({ forcar: true });

  const alvo = release.alvoAtual();
  const chaves = release.chavesConfiaveis();
  const disponivel = consulta && consulta.ok ? consulta.versao : observacao ? observacao.versao : null;
  const politica = disponivel && emExecucao ? release.politicaDeVersao({ versao: disponivel }, emExecucao) : null;

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
    confiancaConfigurada: chaves.length > 0,
    chavesDePublicacao: chaves.map((c) => ({ id: c.id, origem: c.origem })),
    ultimaObservacao: observacao
      ? {
          ...observacao,
          idadeSegundos: idadeS,
          recente: idadeS !== null && idadeS < 3600,
          ressalva: idadeS !== null && idadeS >= 3600 ? "esta observação é antiga; a publicação pode ter mudado desde então" : null,
        }
      : null,
    consultaAgora: consulta && !consulta.ok ? consulta : null,
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
  if (!release.confianciaConfigurada()) {
    return (
      "a atualização por release não está configurada neste console (sem chave pública de publicação). " +
      "Atualize reinstalando o pacote da plataforma."
    );
  }
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
 * Installs an **already verified** artifact (manifest signature and digest checked) and swaps the
 * active version pointer.
 *
 * Kept separate because there are two legitimate sources for the same artifact: the release
 * downloaded over the network and the file carried by hand to a host without Internet. What must
 * not differ between them is exactly this part: extraction refused for escaping paths, contents
 * checked, internal version matching the requested one, and only then the rename.
 */
async function instalarArtefatoVerificado({ versaoAlvo, conteudo, alvo, origem, log = () => {} }) {
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

  podarVersoes({ manter: [versaoAlvo, anterior].filter(Boolean) });
  estado.auditar("atualizacao-console-aplicada", { de: anterior, para: versaoAlvo, alvo, origem });

  log(`Versão ativa agora é ${versaoAlvo} (anterior: ${anterior || "nenhuma"}).`);
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
 * signature, version policy and digest check out.
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

async function atualizarComTrava(versaoAlvo, { log = () => {} } = {}) {
  const raiz = raizInstalacao();
  const instaladas = versoesInstaladas();
  const emExecucao = versaoEmExecucao();

  log("Verificando a publicação...");
  const publicacao = await verificarPublicacao({ forcar: true });
  if (!publicacao.ok) return { ok: false, erro: publicacao.motivo };
  if (publicacao.versao !== versaoAlvo) {
    // The target was fixed at confirmation: a publication appearing afterwards does not get in by
    // itself.
    return {
      ok: false,
      erro: `a publicação atual é ${publicacao.versao}, e a operação foi confirmada para ${versaoAlvo}. Reveja e confirme de novo.`,
    };
  }

  const politica = release.politicaDeVersao(publicacao.manifesto, emExecucao);
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
  const download = await baixar(`${baseDeRelease()}/${artefato.arquivo}`, { destino: arquivoLocal, limiteBytes: tetoDownload });
  if (!download.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-download");
    reconciliar();
    return { ok: false, erro: `download falhou: ${download.erro}` };
  }

  log("Verificando integridade contra o manifesto assinado...");
  const conferencia = release.conferirArtefato(arquivoLocal, artefato, { limiteBytes: LIMITE_ARTEFATO });
  if (!conferencia.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-verificacao");
    reconciliar();
    estado.auditar("atualizacao-console-digest-divergente", { versao: versaoAlvo, motivo: conferencia.motivo });
    return { ok: false, erro: conferencia.motivo };
  }
  log(`SHA-256 confere (${conferencia.sha256.slice(0, 16)}…).`);

  return instalarArtefatoVerificado({ versaoAlvo, conteudo: conferencia.conteudo, alvo: artefato.alvo, origem: "release", log });
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
 * Offline import: the same verification path, from local files.
 */
async function importarOffline({ manifesto, assinatura, artefato, log = () => {} }) {
  if (!fs.existsSync(manifesto) || !fs.existsSync(assinatura) || !fs.existsSync(artefato)) {
    return { ok: false, erro: "informe manifesto, assinatura e artefato existentes" };
  }
  const trava = adquirirTrava("importar offline");
  if (!trava.ok) return { ok: false, erro: trava.motivo };
  try {
    return await importarOfflineComTrava({ manifesto, assinatura, artefato, log });
  } finally {
    liberarTrava();
  }
}

async function importarOfflineComTrava({ manifesto, assinatura, artefato, log = () => {} }) {
  const verificacao = release.verificarManifesto(fs.readFileSync(manifesto), fs.readFileSync(assinatura, "utf8"));
  if (!verificacao.ok) return { ok: false, erro: verificacao.motivo };
  release.registrarRotacao(verificacao);

  const escolha = release.escolherArtefato(verificacao.manifesto);
  if (!escolha.ok) return { ok: false, erro: escolha.motivo };
  if (path.basename(artefato) !== escolha.artefato.arquivo) {
    return { ok: false, erro: `o arquivo informado não é o artefato deste alvo (esperado ${escolha.artefato.arquivo}).` };
  }
  const conferencia = release.conferirArtefato(artefato, escolha.artefato, { limiteBytes: LIMITE_ARTEFATO });
  if (!conferencia.ok) return { ok: false, erro: conferencia.motivo };

  const versaoAlvo = verificacao.manifesto.versao;
  const emExecucao = versaoEmExecucao();
  const politica = release.politicaDeVersao(verificacao.manifesto, emExecucao);
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

  log(`Manifesto e artefato verificados (SHA-256 ${conferencia.sha256.slice(0, 16)}…).`);
  estado.auditar("atualizacao-console-offline", { versao: versaoAlvo, alvo: escolha.artefato.alvo });
  return instalarArtefatoVerificado({
    versaoAlvo,
    conteudo: conferencia.conteudo,
    alvo: escolha.artefato.alvo,
    origem: "arquivo-local",
    log,
  });
}

module.exports = {
  raizInstalacao,
  versoesInstaladas,
  versaoEmExecucao,
  lerEstadoInstalacao,
  gravarEstadoInstalacao,
  verificarPublicacao,
  situacao,
  validarAlvo,
  atualizar,
  reverter,
  reconciliar,
  podarVersoes,
  extrairTarGz,
  importarOffline,
  adquirirTrava,
  liberarTrava,
  operacaoEmAndamento,
  baixar,
};
