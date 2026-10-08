const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const config = require("./config");
const estado = require("./estado");

// Minimal GitHub client for the mobile/CI cycle.
//
// Principles:
//  - least privilege: the token needs only `actions:read` and, to dispatch, `actions:write` on the
//    allowed repository. No full `repo` and no `workflow`;
//  - closed target: owner/repository and workflow names come from a fixed list in this module,
//    never from the request;
//  - the secret never returns through the API, never goes to a log and never enters a URL;
//  - rate limit respected and exposed; refresh is on demand, not polling.
//
// The API version is pinned in `X-GitHub-Api-Version`. A dispatch is tied to a run only by the id
// the dispatch answer carries (`return_run_details`), never by timing, which on a busy CI may point
// at someone else's run.

const API = process.env.CONSOLE_GITHUB_API || "https://api.github.com";
const VERSAO_API = "2022-11-28";
const REPOSITORIO_PERMITIDO = { dono: "SENAI4LIFE", repo: "RemoteIFES" };
const WORKFLOWS_PERMITIDOS = Object.freeze({
  ci: "ci.yml",
  android: "android.yml",
  ios: "ios.yml",
  pages: "pages.yml",
});
// Listed and followed, never dispatched: a Console release starts only from a pushed tag.
const WORKFLOWS_SOMENTE_LEITURA = Object.freeze({
  console: "console-release.yml",
});
const LIMITE_CORPO = 2 * 1024 * 1024;
const LIMITE_ARTEFATO = 200 * 1024 * 1024;

function lerSegredos() {
  return estado.lerJson(config.ARQUIVO_SEGREDOS, {});
}

function token() {
  const valor = lerSegredos().githubToken;
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

/**
 * Secret status, without ever returning it. Only presence, plausible format and when it was stored.
 */
function estadoDoToken() {
  const segredos = lerSegredos();
  const valor = segredos.githubToken;
  if (!valor) return { presente: false };
  return {
    presente: true,
    formato: /^gh[pousr]_/.test(valor) ? "token clássico/fine-grained do GitHub" : "formato não reconhecido",
    tamanho: valor.length,
    gravadoEm: segredos.githubTokenEm || null,
    // Again: the value is not returned by any route.
    observacao: "O valor não é exposto por API, log, auditoria nem diagnóstico.",
  };
}

function gravarToken(valor) {
  const segredos = lerSegredos();
  if (valor === null) {
    delete segredos.githubToken;
    delete segredos.githubTokenEm;
  } else {
    if (typeof valor !== "string" || valor.trim().length < 20 || valor.length > 500) {
      throw new Error("token com formato implausível");
    }
    if (/\s/.test(valor.trim())) throw new Error("token não pode conter espaços");
    segredos.githubToken = valor.trim();
    segredos.githubTokenEm = new Date().toISOString();
  }
  estado.gravarJson(config.ARQUIVO_SEGREDOS, segredos, 0o600);
  estado.auditar(valor === null ? "github-token-removido" : "github-token-gravado", {});
}

function pedir(caminho, { metodo = "GET", corpo = null, timeoutMs = 20_000, aceitarRedirecionamento = false } = {}) {
  const url = new URL(caminho.startsWith("http") ? caminho : `${API}${caminho}`);
  const segredo = token();
  const cabecalhos = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": VERSAO_API,
    "User-Agent": "remoteifes-console",
  };
  if (segredo) cabecalhos.Authorization = `Bearer ${segredo}`;
  if (corpo) cabecalhos["Content-Type"] = "application/json";

  const transporte = url.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    const req = transporte.request(
      { protocol: url.protocol, host: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: metodo, headers: cabecalhos, timeout: timeoutMs },
      (res) => {
        if (!aceitarRedirecionamento && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return resolve({ ok: false, status: res.statusCode, redirecionamento: res.headers.location || null, erro: "redirecionamento inesperado" });
        }
        let texto = "";
        let bytes = 0;
        res.setEncoding("utf8");
        res.on("data", (d) => {
          bytes += Buffer.byteLength(d);
          if (bytes > LIMITE_CORPO) {
            req.destroy();
            return;
          }
          texto += d;
        });
        res.on("end", () => {
          const limite = {
            restante: res.headers["x-ratelimit-remaining"] ? Number(res.headers["x-ratelimit-remaining"]) : null,
            reiniciaEm: res.headers["x-ratelimit-reset"] ? new Date(Number(res.headers["x-ratelimit-reset"]) * 1000).toISOString() : null,
          };
          let json = null;
          try {
            json = texto ? JSON.parse(texto) : null;
          } catch {}
          if (res.statusCode === 403 && limite.restante === 0) {
            return resolve({ ok: false, status: 403, limite, erro: `limite de requisições do GitHub atingido; volta em ${limite.reiniciaEm}` });
          }
          if (res.statusCode === 401) return resolve({ ok: false, status: 401, limite, erro: "credencial do GitHub inválida ou expirada" });
          if (res.statusCode === 403) return resolve({ ok: false, status: 403, limite, erro: "credencial sem permissão para esta operação" });
          if (res.statusCode === 404) return resolve({ ok: false, status: 404, limite, erro: "não encontrado (repositório, workflow ou permissão insuficiente)" });
          if (res.statusCode >= 400) {
            return resolve({ ok: false, status: res.statusCode, limite, erro: (json && json.message) || `HTTP ${res.statusCode}` });
          }
          resolve({ ok: true, status: res.statusCode, dados: json, limite, cabecalhos: res.headers });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: `tempo esgotado em ${Math.round(timeoutMs / 1000)}s`, status: null });
    });
    req.on("error", (erro) => resolve({ ok: false, erro: erro.code || erro.message, status: null }));
    if (corpo) req.end(JSON.stringify(corpo));
    else req.end();
  });
}

function base() {
  return `/repos/${REPOSITORIO_PERMITIDO.dono}/${REPOSITORIO_PERMITIDO.repo}`;
}

function arquivoDoWorkflow(run) {
  return run && run.path ? String(run.path).replace(/^\.github\/workflows\//, "").split("@")[0] : null;
}

function chaveDoWorkflow(arquivo) {
  const todos = { ...WORKFLOWS_PERMITIDOS, ...WORKFLOWS_SOMENTE_LEITURA };
  return Object.keys(todos).find((chave) => todos[chave] === arquivo) || null;
}

function resumirRun(run) {
  const arquivo = arquivoDoWorkflow(run);
  return {
    id: run.id,
    nome: run.name,
    workflow: arquivo,
    chave: chaveDoWorkflow(arquivo),
    titulo: run.display_title || null,
    iniciadoEm: run.run_started_at || null,
    status: run.status,
    conclusao: run.conclusion,
    commit: run.head_sha,
    ramo: run.head_branch,
    numero: run.run_number,
    tentativa: run.run_attempt,
    criadoEm: run.created_at,
    atualizadoEm: run.updated_at,
    url: run.html_url,
    evento: run.event,
  };
}

async function listarRuns({ workflow = null, limite = 10, ramo = null } = {}) {
  if (!token()) return { ok: false, erro: "nenhuma credencial do GitHub configurada", semCredencial: true };
  const arquivo = workflow ? WORKFLOWS_PERMITIDOS[workflow] || WORKFLOWS_SOMENTE_LEITURA[workflow] : null;
  if (workflow && !arquivo) return { ok: false, erro: "workflow não permitido" };
  const n = Math.max(1, Math.min(Number(limite) || 10, 30));
  const parametros = new URLSearchParams({ per_page: String(n) });
  if (ramo) parametros.set("branch", ramo);
  const caminho = arquivo ? `${base()}/actions/workflows/${arquivo}/runs?${parametros}` : `${base()}/actions/runs?${parametros}`;
  const r = await pedir(caminho);
  if (!r.ok) return r;
  return { ok: true, limite: r.limite, runs: (r.dados.workflow_runs || []).map(resumirRun) };
}

async function obterRun(id) {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, erro: "id de execução inválido" };
  const r = await pedir(`${base()}/actions/runs/${id}`);
  if (!r.ok) return r;
  return { ok: true, limite: r.limite, run: resumirRun(r.dados) };
}

/**
 * A run id comes from the browser; acting on it is allowed only for runs of the workflows this
 * module lists, so the credential cannot be pointed at any other automation of the repository.
 */
async function obterRunAdministrado(id, { paraAlterar = false } = {}) {
  if (!token()) return { ok: false, erro: "nenhuma credencial do GitHub configurada", semCredencial: true };
  const r = await obterRun(id);
  if (!r.ok) return r;
  if (!r.run.chave) return { ok: false, status: 403, erro: "esta execução pertence a um workflow que o console não administra" };
  if (paraAlterar && !WORKFLOWS_PERMITIDOS[r.run.chave]) {
    return { ok: false, status: 403, erro: "o console só acompanha este workflow; ele não pode ser repetido nem cancelado daqui" };
  }
  return r;
}

function resumirJob(job) {
  return {
    id: job.id,
    nome: job.name,
    status: job.status,
    conclusao: job.conclusion,
    iniciadoEm: job.started_at,
    concluidoEm: job.completed_at,
    url: job.html_url,
    etapas: (job.steps || []).map((s) => ({ numero: s.number, nome: s.name, status: s.status, conclusao: s.conclusion })),
  };
}

async function detalharRun(id) {
  const r = await obterRunAdministrado(id);
  if (!r.ok) return r;
  const [jobs, artefatos] = await Promise.all([
    pedir(`${base()}/actions/runs/${id}/jobs?${new URLSearchParams({ per_page: "100", filter: "latest" })}`),
    listarArtefatos(id),
  ]);
  return {
    ok: true,
    limite: (jobs.ok && jobs.limite) || r.limite,
    run: r.run,
    jobs: jobs.ok ? (jobs.dados.jobs || []).map(resumirJob) : [],
    erroJobs: jobs.ok ? null : jobs.erro,
    artefatos: artefatos.ok ? artefatos.artefatos : [],
    erroArtefatos: artefatos.ok ? null : artefatos.erro,
  };
}

const CONCLUSOES_REPETIVEIS = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

async function reexecutarRun(id, { soFalhas = true } = {}) {
  const r = await obterRunAdministrado(id, { paraAlterar: true });
  if (!r.ok) return r;
  if (r.run.status !== "completed") return { ok: false, erro: "a execução ainda não terminou; só uma execução concluída pode ser repetida" };
  if (soFalhas && !CONCLUSOES_REPETIVEIS.has(r.run.conclusao)) {
    return { ok: false, erro: "a execução não tem jobs com falha para repetir; use repetir tudo" };
  }
  const resposta = await pedir(`${base()}/actions/runs/${id}/${soFalhas ? "rerun-failed-jobs" : "rerun"}`, { metodo: "POST", corpo: {} });
  if (!resposta.ok) return resposta;
  estado.auditar("workflow-reexecutado", { run: id, workflow: r.run.workflow, soFalhas });
  return { ok: true, run: r.run };
}

async function cancelarRun(id) {
  const r = await obterRunAdministrado(id, { paraAlterar: true });
  if (!r.ok) return r;
  if (r.run.status === "completed") return { ok: false, erro: "a execução já terminou" };
  const resposta = await pedir(`${base()}/actions/runs/${id}/cancel`, { metodo: "POST" });
  if (!resposta.ok) return resposta;
  estado.auditar("workflow-cancelado", { run: id, workflow: r.run.workflow });
  return { ok: true, run: r.run };
}

/**
 * Proves the stored credential reaches the allowed repository and reads its Actions. A fine-grained
 * token does not disclose its permissions, so write access is only known when a dispatch is tried.
 */
async function conferirToken() {
  if (!token()) return { ok: false, erro: "nenhuma credencial do GitHub configurada", semCredencial: true };
  const repositorio = await pedir(base());
  if (!repositorio.ok) return { ok: false, status: repositorio.status, erro: repositorio.erro, limite: repositorio.limite || null };
  const actions = await pedir(`${base()}/actions/workflows?per_page=1`);
  const escopos = repositorio.cabecalhos["x-oauth-scopes"];
  return {
    ok: actions.ok,
    repositorio: repositorio.dados && repositorio.dados.full_name,
    leituraDeActions: actions.ok,
    escopos: typeof escopos === "string" ? escopos.split(",").map((s) => s.trim()).filter(Boolean) : null,
    limite: actions.limite || repositorio.limite || null,
    erro: actions.ok ? null : actions.erro,
    observacao:
      "Um token fine-grained não revela as próprias permissões: a de escrita em Actions, que dispara, " +
      "repete e cancela execuções, só é confirmada na primeira operação.",
  };
}

async function dispararWorkflow(workflow, { ramo = "main", entradas = {} } = {}) {
  const arquivo = WORKFLOWS_PERMITIDOS[workflow];
  if (!arquivo) return { ok: false, erro: "workflow não permitido" };
  if (!token()) return { ok: false, erro: "nenhuma credencial do GitHub configurada", semCredencial: true };
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(String(ramo))) return { ok: false, erro: "ramo inválido" };
  const entradasLimpas = {};
  for (const [chave, valor] of Object.entries(entradas || {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(chave)) return { ok: false, erro: `entrada inválida: ${chave}` };
    if (typeof valor === "boolean") entradasLimpas[chave] = valor;
    else if (typeof valor === "string" && valor.length <= 200) entradasLimpas[chave] = valor;
    else return { ok: false, erro: `valor inválido para a entrada ${chave}` };
  }

  const marcoAnterior = new Date(Date.now() - 60_000).toISOString();
  const consultarJanela = () =>
    pedir(`${base()}/actions/workflows/${arquivo}/runs?${new URLSearchParams({ branch: ramo, event: "workflow_dispatch", per_page: "30", created: `>=${marcoAnterior}` })}`);
  const antes = await consultarJanela();
  const existentes = antes.ok ? new Set((antes.dados.workflow_runs || []).map((r) => r.id)) : new Set();
  const disparar = (comDetalhes) =>
    pedir(`${base()}/actions/workflows/${arquivo}/dispatches`, {
      metodo: "POST",
      corpo: comDetalhes ? { ref: ramo, inputs: entradasLimpas, return_run_details: true } : { ref: ramo, inputs: entradasLimpas },
    });
  let resposta = await disparar(true);
  // A 422 is a rejected request, never a queued run, so retrying without the optional field cannot
  // dispatch twice.
  if (!resposta.ok && resposta.status === 422 && /return_run_details/i.test(String(resposta.erro))) resposta = await disparar(false);
  if (!resposta.ok) return resposta;

  estado.auditar("workflow-disparado", { workflow: arquivo, ramo, entradas: Object.keys(entradasLimpas) });

  const idDireto = resposta.dados && (resposta.dados.workflow_run_id || resposta.dados.id || (resposta.dados.run && resposta.dados.run.id));
  if (Number.isInteger(idDireto)) {
    const confirmado = await obterRun(idDireto);
    if (confirmado.ok) return { ok: true, correlacao: "id devolvido pelo disparo", run: confirmado.run };
    return { ok: true, correlacao: "id devolvido pelo disparo (ainda não consultável)", run: { id: idDireto } };
  }

  // Without an id, timing cannot prove which run is this dispatch's: another dispatch may land in the
  // same window. The new runs are listed for the operator, never assigned.
  let candidatos = [];
  for (let tentativa = 0; tentativa < 4 && !candidatos.length; tentativa += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const lista = await consultarJanela();
    if (lista.ok) candidatos = (lista.dados.workflow_runs || []).filter((r) => !existentes.has(r.id)).map(resumirRun);
  }
  return {
    ok: true,
    indeterminado: true,
    candidatos,
    erro: candidatos.length
      ? "o disparo foi aceito, mas o GitHub não informou qual execução ele criou; confira as execuções novas na lista antes de agir sobre uma delas."
      : "o disparo foi aceito pelo GitHub, mas nenhuma execução nova apareceu ainda. Pode ser atraso da fila; atualize a lista em instantes.",
  };
}

async function listarArtefatos(runId) {
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, erro: "id de execução inválido" };
  const r = await pedir(`${base()}/actions/runs/${runId}/artifacts?per_page=30`);
  if (!r.ok) return r;
  return {
    ok: true,
    limite: r.limite,
    artefatos: (r.dados.artifacts || []).map((a) => ({
      id: a.id,
      nome: a.name,
      bytes: a.size_in_bytes,
      expirado: !!a.expired,
      expiraEm: a.expires_at,
      criadoEm: a.created_at,
      digest: a.digest || null,
    })),
  };
}

/**
 * Downloads an artifact to a local file, with a size limit, a fixed number of redirects and the
 * SHA-256 of what was actually written.
 *
 * Extraction does **not** happen here. A CI zip is untrusted content and safe extraction
 * (traversal, symlink, zip bomb) is a separate problem; the Console delivers the file and the
 * digest for human verification or for a machine with the SDK.
 */
async function metaDoArtefato(runId, artefatoId) {
  if (!Number.isInteger(artefatoId) || artefatoId <= 0) return { ok: false, erro: "id de artefato inválido" };
  const lista = await listarArtefatos(runId);
  if (!lista.ok) return lista;
  const meta = lista.artefatos.find((a) => a.id === artefatoId);
  if (!meta) return { ok: false, status: 404, erro: "artefato não pertence a esta execução" };
  if (meta.expirado) return { ok: false, status: 410, erro: `o artefato expirou em ${meta.expiraEm} e não pode mais ser baixado` };
  if (meta.bytes > LIMITE_ARTEFATO) {
    return { ok: false, status: 413, erro: `artefato de ${(meta.bytes / 1048576).toFixed(0)} MiB passa do limite de ${LIMITE_ARTEFATO / 1048576} MiB` };
  }
  return { ok: true, meta };
}

function urlDoZip(artefatoId) {
  return `${API}${base()}/actions/artifacts/${artefatoId}/zip`;
}

async function baixarArtefato(runId, artefatoId, destino) {
  const r = await metaDoArtefato(runId, artefatoId);
  if (!r.ok) return r;
  return baixarParaArquivo(urlDoZip(artefatoId), destino, r.meta);
}

/**
 * Opens an artifact of a run the Console administers as a stream for the operator's browser. Nothing
 * is written to the host's disk; the caller pipes `resposta` and enforces LIMITE_ARTEFATO.
 */
async function abrirArtefato(runId, artefatoId) {
  const run = await obterRunAdministrado(runId);
  if (!run.ok) return run;
  const r = await metaDoArtefato(runId, artefatoId);
  if (!r.ok) return r;
  const aberto = await abrirFluxo(urlDoZip(artefatoId));
  if (!aberto.ok) return aberto;
  return { ok: true, meta: r.meta, resposta: aberto.res, encerrar: () => aberto.req.destroy() };
}

const MAX_SALTOS = 3;

function mesmoHostDaApi(alvo) {
  try {
    return alvo.host === new URL(API).host;
  } catch {
    return false;
  }
}

/**
 * GETs a download URL and follows redirects itself: a fixed number of hops, https only outside
 * tests. Resolves with the 200 response still unread.
 */
function abrirFluxo(url, saltos = 0) {
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, erro: "endereço de download inválido" });
  }
  // Outside tests, https only: a redirect to http would downgrade the transport.
  if (alvo.protocol !== "https:" && !process.env.CONSOLE_GITHUB_API) {
    return Promise.resolve({ ok: false, erro: "redirecionamento para destino não seguro" });
  }
  if (saltos > MAX_SALTOS) {
    return Promise.resolve({ ok: false, erro: `mais de ${MAX_SALTOS} redirecionamentos no download` });
  }
  const transporte = alvo.protocol === "http:" ? http : https;
  const segredo = token();
  return new Promise((resolve) => {
    const req = transporte.request(
      {
        protocol: alvo.protocol,
        host: alvo.hostname,
        port: alvo.port || undefined,
        path: `${alvo.pathname}${alvo.search}`,
        method: "GET",
        headers: {
          "User-Agent": "remoteifes-console",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": VERSAO_API,
          // The credential only goes with the API host itself. The API redirects to signed storage
          // on another domain, and sending the token along would hand it to a host that does not
          // need it and may log it.
          ...(segredo && mesmoHostDaApi(alvo) ? { Authorization: `Bearer ${segredo}` } : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const proximo = new URL(res.headers.location, alvo).toString();
          return resolve(abrirFluxo(proximo, saltos + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, erro: `download respondeu HTTP ${res.statusCode}` });
        }
        resolve({ ok: true, res, req });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("tempo esgotado no download"));
      resolve({ ok: false, erro: "tempo esgotado no download" });
    });
    req.on("error", (erro) => resolve({ ok: false, erro: erro.code || erro.message }));
    req.end();
  });
}

async function baixarParaArquivo(url, destino, meta) {
  const aberto = await abrirFluxo(url);
  if (!aberto.ok) return aberto;
  const { res, req } = aberto;
  return new Promise((resolveUmaVez) => {
    let resolvido = false;
    const resolve = (valor) => {
      if (resolvido) return;
      resolvido = true;
      resolveUmaVez(valor);
    };
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const hash = crypto.createHash("sha256");
    const fluxo = fs.createWriteStream(destino, { mode: 0o600 });
    let bytes = 0;
    let abortado = false;
    const abortar = (erro) => {
      if (abortado) return;
      abortado = true;
      req.destroy();
      fluxo.destroy();
      fs.rmSync(destino, { force: true });
      resolve({ ok: false, erro });
    };
    res.on("data", (d) => {
      bytes += d.length;
      if (bytes > LIMITE_ARTEFATO) return abortar("download passou do limite de tamanho e foi interrompido");
      hash.update(d);
    });
    res.on("error", (erro) => abortar(erro.message || "download interrompido"));
    res.on("close", () => {
      if (!res.complete) abortar("download interrompido antes do fim");
    });
    res.pipe(fluxo);
    fluxo.on("finish", () => {
      if (abortado) return;
      const sha256 = hash.digest("hex");
      const tamanhoConfere = meta ? bytes === meta.bytes : null;
      // The CI artifact digest comes from the same origin as the artifact: checking both proves
      // transport integrity, not authenticity. A mismatch is still a failure and is reported as
      // one, not as an informational field the caller could ignore. Authenticity of executable
      // artifacts is the release updater's responsibility, through the release attestation.
      if (tamanhoConfere === false) {
        fs.rmSync(destino, { force: true });
        return resolve({
          ok: false,
          erro: `tamanho divergente: ${bytes} bytes recebidos, ${meta.bytes} declarados pela API`,
        });
      }
      resolve({
        ok: true,
        arquivo: destino,
        bytes,
        sha256,
        tamanhoDeclarado: meta ? meta.bytes : null,
        tamanhoConfere,
        digestDeclarado: meta ? meta.digest : null,
        ressalvaDeConfianca:
          "integridade de transporte apenas: o digest vem da mesma origem que o artefato. " +
          "Não use este caminho como transporte de atualização executável.",
      });
    });
    fluxo.on("error", (erro) => abortar(erro.message));
  });
}

module.exports = {
  REPOSITORIO_PERMITIDO,
  WORKFLOWS_PERMITIDOS,
  estadoDoToken,
  gravarToken,
  temToken: () => !!token(),
  listarRuns,
  obterRun,
  dispararWorkflow,
  listarArtefatos,
  baixarArtefato,
  abrirArtefato,
  detalharRun,
  reexecutarRun,
  cancelarRun,
  conferirToken,
  WORKFLOWS_SOMENTE_LEITURA,
  LIMITE_ARTEFATO,
};
