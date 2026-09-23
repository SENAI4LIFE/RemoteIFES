const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const config = require("./config");
const estado = require("./estado");

// Cliente GitHub mínimo para o ciclo mobile/CI.
//
// Princípios:
//  - permissões mínimas: o token precisa apenas de `actions:read` e, para disparar,
//    `actions:write` no repositório permitido. Nada de `repo` completo nem `workflow`;
//  - alvo fechado: dono/repositório e nomes de workflow vêm de lista fixa neste módulo,
//    nunca da requisição;
//  - o segredo nunca volta por API, nunca vai para log e nunca entra em URL;
//  - limite de taxa respeitado e exposto; atualização é sob demanda, não em polling.
//
// A versão de API é fixada em `X-GitHub-Api-Version`. O disparo é correlacionado ao run
// realmente criado — nunca "o run mais recente", que numa CI movimentada pode ser de outra
// pessoa. Se a resposta do disparo já traz o id (comportamento documentado atualmente), ele é
// usado; se vier vazia (204), a correlação usa janela de tempo mais identidade do workflow.

const API = process.env.CONSOLE_GITHUB_API || "https://api.github.com";
const VERSAO_API = "2022-11-28";
const REPOSITORIO_PERMITIDO = { dono: "SENAI4LIFE", repo: "RemoteIFES" };
const WORKFLOWS_PERMITIDOS = Object.freeze({
  ci: "ci.yml",
  android: "android.yml",
  ios: "ios.yml",
  pages: "pages.yml",
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
 * Estado do segredo, sem jamais devolvê-lo. Só presença, formato plausível e quando foi gravado.
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
    // Repetir: o valor não é devolvido por nenhuma rota.
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

function resumirRun(run) {
  return {
    id: run.id,
    nome: run.name,
    workflow: run.path ? run.path.replace(/^\.github\/workflows\//, "") : null,
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
  const arquivo = workflow ? WORKFLOWS_PERMITIDOS[workflow] : null;
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
 * Dispara um workflow e devolve o run correlacionado.
 *
 * A resposta do disparo pode trazer o id (comportamento documentado hoje) ou vir vazia. Os dois
 * casos são tratados: com id, ele é confirmado; sem id, a busca é limitada à janela iniciada
 * pouco antes do disparo, ao workflow pedido e ao ramo — e, se mais de um candidato aparecer, o
 * resultado é declarado **ambíguo** em vez de escolher "o mais recente", que pode ser de outra pessoa.
 */
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
  const resposta = await pedir(`${base()}/actions/workflows/${arquivo}/dispatches`, {
    metodo: "POST",
    corpo: { ref: ramo, inputs: entradasLimpas },
  });
  if (!resposta.ok) return resposta;

  estado.auditar("workflow-disparado", { workflow: arquivo, ramo, entradas: Object.keys(entradasLimpas) });

  const idDireto = resposta.dados && (resposta.dados.id || (resposta.dados.run && resposta.dados.run.id));
  if (Number.isInteger(idDireto)) {
    const confirmado = await obterRun(idDireto);
    if (confirmado.ok) return { ok: true, correlacao: "id devolvido pelo disparo", run: confirmado.run };
    return { ok: true, correlacao: "id devolvido pelo disparo (ainda não consultável)", run: { id: idDireto } };
  }

  // Sem id na resposta: correlaciona por janela + workflow + ramo + evento.
  for (let tentativa = 0; tentativa < 6; tentativa += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const lista = await pedir(
      `${base()}/actions/workflows/${arquivo}/runs?${new URLSearchParams({ branch: ramo, event: "workflow_dispatch", per_page: "10", created: `>=${marcoAnterior}` })}`
    );
    if (!lista.ok) continue;
    const candidatos = (lista.dados.workflow_runs || []).filter((r) => Date.parse(r.created_at) >= Date.parse(marcoAnterior));
    if (candidatos.length === 1) return { ok: true, correlacao: "janela de tempo e identidade do workflow", run: resumirRun(candidatos[0]) };
    if (candidatos.length > 1) {
      return {
        ok: true,
        ambiguo: true,
        correlacao: "vários disparos na mesma janela",
        erro:
          "o disparo foi aceito, mas há mais de uma execução compatível na janela: não é possível afirmar qual é a sua. " +
          "Confira na aba Actions do repositório.",
        candidatos: candidatos.map(resumirRun),
      };
    }
  }
  return {
    ok: true,
    indeterminado: true,
    erro:
      "o disparo foi aceito pelo GitHub, mas nenhuma execução apareceu na janela esperada. " +
      "Isso pode ser atraso da fila ou um filtro de caminho do workflow que não casou. Verifique em Actions.",
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
 * Baixa um artefato para um arquivo local, com limite de tamanho, número fixo de
 * redirecionamentos e cálculo do SHA-256 do que foi realmente gravado.
 *
 * Importante: a extração **não** acontece aqui. Um zip de CI é conteúdo não confiável e a
 * extração segura (travessia, symlink, zip bomb) é um problema à parte; o console entrega o
 * arquivo e o digest para conferência humana ou para uma máquina com SDK.
 */
async function baixarArtefato(runId, artefatoId, destino) {
  if (!Number.isInteger(artefatoId) || artefatoId <= 0) return { ok: false, erro: "id de artefato inválido" };
  const lista = await listarArtefatos(runId);
  if (!lista.ok) return lista;
  const meta = lista.artefatos.find((a) => a.id === artefatoId);
  if (!meta) return { ok: false, erro: "artefato não pertence a esta execução" };
  if (meta.expirado) return { ok: false, erro: `o artefato expirou em ${meta.expiraEm} e não pode mais ser baixado` };
  if (meta.bytes > LIMITE_ARTEFATO) {
    return { ok: false, erro: `artefato de ${(meta.bytes / 1048576).toFixed(0)} MiB passa do limite de ${LIMITE_ARTEFATO / 1048576} MiB` };
  }

  // A API responde com redirecionamento para um armazenamento assinado. O seguimento é feito
  // pelo próprio downloader, com número máximo de saltos e sem aceitar destino não seguro.
  const alvo = `${API}${base()}/actions/artifacts/${artefatoId}/zip`;
  return baixarParaArquivo(alvo, destino, meta, 0);
}

const MAX_SALTOS = 3;

function baixarParaArquivo(url, destino, meta, saltos = 0) {
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, erro: "endereço de download inválido" });
  }
  // Fora de teste, só https: um redirecionamento para http rebaixaria o transporte.
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
          ...(segredo ? { Authorization: `Bearer ${segredo}` } : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const proximo = new URL(res.headers.location, alvo).toString();
          return resolve(baixarParaArquivo(proximo, destino, meta, saltos + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, erro: `download respondeu HTTP ${res.statusCode}` });
        }
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        const hash = crypto.createHash("sha256");
        const fluxo = fs.createWriteStream(destino, { mode: 0o600 });
        let bytes = 0;
        let abortado = false;
        res.on("data", (d) => {
          bytes += d.length;
          if (bytes > LIMITE_ARTEFATO) {
            abortado = true;
            req.destroy();
            fluxo.destroy();
            fs.rmSync(destino, { force: true });
            resolve({ ok: false, erro: "download passou do limite de tamanho e foi interrompido" });
            return;
          }
          hash.update(d);
        });
        res.pipe(fluxo);
        fluxo.on("finish", () => {
          if (abortado) return;
          resolve({
            ok: true,
            arquivo: destino,
            bytes,
            sha256: hash.digest("hex"),
            tamanhoDeclarado: meta ? meta.bytes : null,
            tamanhoConfere: meta ? bytes === meta.bytes : null,
            digestDeclarado: meta ? meta.digest : null,
          });
        });
        fluxo.on("error", (erro) => resolve({ ok: false, erro: erro.message }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: "tempo esgotado no download" });
    });
    req.on("error", (erro) => resolve({ ok: false, erro: erro.code || erro.message }));
    req.end();
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
};
