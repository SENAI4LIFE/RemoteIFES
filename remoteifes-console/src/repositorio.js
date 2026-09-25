const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");
const processos = require("./processos");
const coleta = require("./coleta");

// Repository observation. The central point is never to confuse five different things:
//
//   1. commit of the running process       -> /health (release.js captures it at start)
//   2. checkout HEAD + dirtiness            -> git in the working directory
//   3. local branch and its upstream        -> git
//   4. last observed origin/main            -> persisted memory, with observation time
//   5. last verified deployment             -> data/deploy.log and current-version
//
// An interrupted deploy, a manual `git pull` or a `deploy.sh --no-restart` leave (1) and (2)
// different. Showing "version" as a single number is the source of many mistakes.

const RE_COMMIT = /^[0-9a-f]{40}$/;

function git(args, opcoes = {}) {
  return processos.executar("git", args, {
    cwd: config.DIR_CHECKOUT,
    timeoutMs: opcoes.timeoutMs || 20_000,
    limiteBytes: opcoes.limiteBytes || 256 * 1024,
    env: opcoes.env || {},
  });
}

async function ehRepositorio() {
  const r = await git(["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.saida.trim() === "true";
}

/**
 * Local state: HEAD, branch, upstream, dirty files, depth, configured remote.
 * Entirely offline: no network call.
 */
async function estadoLocal() {
  if (!(await ehRepositorio())) {
    return { repositorio: false, motivo: `${config.DIR_CHECKOUT} não é um repositório git` };
  }
  const [head, ramo, upstream, sujo, naoRastreados, remoto, raso] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    git(["status", "--porcelain", "--untracked-files=no"]),
    git(["status", "--porcelain", "--untracked-files=all"]),
    git(["remote", "get-url", "origin"]),
    git(["rev-parse", "--is-shallow-repository"]),
  ]);

  const commit = head.ok ? head.saida.trim() : null;
  const modificados = sujo.ok ? sujo.saida.split("\n").filter(Boolean) : [];
  const todos = naoRastreados.ok ? naoRastreados.saida.split("\n").filter(Boolean) : [];
  const novos = todos.filter((l) => l.startsWith("??"));

  let descricao = null;
  if (commit) {
    const d = await git(["log", "-1", "--format=%h %s", commit]);
    if (d.ok) descricao = d.saida.trim();
  }

  return {
    repositorio: true,
    head: RE_COMMIT.test(commit || "") ? commit : null,
    descricaoHead: descricao,
    ramo: ramo.ok && ramo.saida.trim() ? ramo.saida.trim() : null,
    destacado: !(ramo.ok && ramo.saida.trim()),
    upstream: upstream.ok && upstream.saida.trim() ? upstream.saida.trim() : null,
    limpo: modificados.length === 0 && novos.length === 0,
    modificados: modificados.slice(0, 50),
    totalModificados: modificados.length,
    naoRastreados: novos.slice(0, 50).map((l) => l.slice(3)),
    totalNaoRastreados: novos.length,
    remotoOrigin: remoto.ok ? remoto.saida.trim() : null,
    raso: raso.ok && raso.saida.trim() === "true",
    diretorio: config.DIR_CHECKOUT,
  };
}

// --- Remote observation -----------------------------------------------------------------

function lerObservacao() {
  return estado.lerJson(config.ARQUIVO_OBSERVACAO_REMOTA, null);
}

function gravarObservacao(obs) {
  estado.gravarJson(config.ARQUIVO_OBSERVACAO_REMOTA, obs, 0o600);
}

function classificarFalhaDeRede(saida) {
  const texto = String(saida || "").toLowerCase();
  if (/could not resolve host|name or service not known|temporary failure in name resolution/.test(texto)) {
    return { classe: "offline", mensagem: "o host não resolveu o endereço de origin (sem DNS ou sem rede)" };
  }
  if (/connection timed out|operation timed out|failed to connect|network is unreachable|connection refused/.test(texto)) {
    return { classe: "offline", mensagem: "não foi possível conectar a origin (rede indisponível ou bloqueada)" };
  }
  if (/authentication failed|could not read username|permission denied|access denied|terminal prompts disabled|invalid username or password/.test(texto)) {
    return { classe: "autenticacao", mensagem: "origin exigiu credencial e nenhuma está disponível para este serviço" };
  }
  if (/repository not found|not found|does not appear to be a git repository/.test(texto)) {
    return { classe: "remoto-ausente", mensagem: "origin não foi encontrado no endereço configurado" };
  }
  return { classe: "erro", mensagem: "falha ao consultar origin" };
}

/**
 * Queries the remote without changing the checkout. Uses `git ls-remote`, which writes no refs or
 * objects: querying must not have side effects.
 */
async function consultarRemoto({ ref = "refs/heads/main", timeoutMs = 20_000 } = {}) {
  const local = await estadoLocal();
  if (!local.repositorio) return { ok: false, classe: "sem-repositorio", mensagem: local.motivo };
  if (!local.remotoOrigin) {
    return { ok: false, classe: "remoto-ausente", mensagem: "o remoto 'origin' não está configurado neste checkout" };
  }
  const r = await git(["ls-remote", "--exit-code", "origin", ref], { timeoutMs });
  if (!r.ok) {
    const falha = classificarFalhaDeRede(`${r.saida} ${r.erro || ""}`);
    if (r.codigo === 2) {
      return { ok: false, classe: "ref-ausente", mensagem: `origin não tem ${ref}`, url: local.remotoOrigin };
    }
    return { ...falha, ok: false, url: local.remotoOrigin, detalhe: (r.saida || r.erro || "").slice(0, 400) };
  }
  const m = /^([0-9a-f]{40})\s/.exec(r.saida.trim());
  if (!m) return { ok: false, classe: "erro", mensagem: "resposta inesperada de origin", url: local.remotoOrigin };

  const observacao = {
    commit: m[1],
    ref,
    url: local.remotoOrigin,
    observadoEm: new Date().toISOString(),
  };
  const anterior = lerObservacao();
  if (anterior && anterior.url && anterior.url !== observacao.url) {
    estado.auditar("remoto-alterado", { de: anterior.url, para: observacao.url });
    observacao.urlAnterior = anterior.url;
  }
  gravarObservacao(observacao);
  return { ok: true, ...observacao };
}

/**
 * Checkout position relative to the remote target, using only local objects. A remote commit the
 * checkout never fetched cannot be compared: this is stated, not guessed.
 */
async function compararCom(commitAlvo) {
  if (!RE_COMMIT.test(String(commitAlvo || ""))) return { conhecido: false, motivo: "commit alvo inválido" };
  const existe = await git(["cat-file", "-e", `${commitAlvo}^{commit}`]);
  if (!existe.ok) {
    return {
      conhecido: false,
      motivo: "este commit ainda não está no checkout; a comparação exige buscar os objetos de origin",
    };
  }
  const contagem = await git(["rev-list", "--left-right", "--count", `HEAD...${commitAlvo}`]);
  if (!contagem.ok) return { conhecido: false, motivo: "não foi possível comparar" };
  const [atras, frente] = contagem.saida.trim().split(/\s+/).map(Number);
  const local = await estadoLocal();
  const raso = local.raso;
  return {
    conhecido: true,
    commitsSoLocais: atras,
    commitsSoRemotos: frente,
    igual: atras === 0 && frente === 0,
    atrasado: atras === 0 && frente > 0,
    adiantado: atras > 0 && frente === 0,
    divergente: atras > 0 && frente > 0,
    historicoRaso: raso,
    ressalvaRaso: raso ? "o checkout é raso (shallow): a contagem pode não refletir todo o histórico" : null,
  };
}

// --- Change summary per component ------------------------------------------------------

const COMPONENTES = [
  { chave: "servidor", rotulo: "Servidor (API e banco)", teste: (f) => f.startsWith("remoteifes-server/") && !f.startsWith("remoteifes-server/test/") },
  { chave: "web", rotulo: "Frontend e PWA", teste: (f) => f.startsWith("remoteifes-web/") },
  { chave: "mobile", rotulo: "Aplicativo (Cordova)", teste: (f) => f.startsWith("remoteifes-cordova/") },
  { chave: "firmware", rotulo: "Firmware ESP32", teste: (f) => f.startsWith("remoteifes-esp32/") },
  { chave: "console", rotulo: "Console de Operações", teste: (f) => f.startsWith("remoteifes-console/") },
  { chave: "testes", rotulo: "Testes", teste: (f) => f.startsWith("e2e/") || f.includes("/test/") || f.endsWith(".test.js") || f.endsWith(".spec.js") },
  { chave: "ci", rotulo: "CI e automação", teste: (f) => f.startsWith(".github/") },
  { chave: "docs", rotulo: "Documentação", teste: (f) => f.endsWith(".md") || f.startsWith("docs/") },
];

function classificarArquivos(arquivos) {
  const grupos = new Map();
  for (const arquivo of arquivos) {
    const componente = COMPONENTES.find((c) => c.teste(arquivo)) || { chave: "outros", rotulo: "Outros" };
    if (!grupos.has(componente.chave)) grupos.set(componente.chave, { chave: componente.chave, rotulo: componente.rotulo, arquivos: 0, exemplos: [] });
    const grupo = grupos.get(componente.chave);
    grupo.arquivos += 1;
    if (grupo.exemplos.length < 5) grupo.exemplos.push(arquivo);
  }
  return [...grupos.values()].sort((a, b) => b.arquivos - a.arquivos);
}

/**
 * Bounded summary of what changes between the running version and the target.
 */
async function resumoDeMudancas(de, para, { maxCommits = 30 } = {}) {
  if (!RE_COMMIT.test(String(de || "")) || !RE_COMMIT.test(String(para || ""))) {
    return { disponivel: false, motivo: "commits inválidos" };
  }
  const existem = await Promise.all([git(["cat-file", "-e", `${de}^{commit}`]), git(["cat-file", "-e", `${para}^{commit}`])]);
  if (!existem.every((r) => r.ok)) {
    return { disponivel: false, motivo: "um dos commits não está no checkout; busque os objetos de origin antes de comparar" };
  }
  const [lista, arquivos] = await Promise.all([
    git(["log", "--no-merges", `--max-count=${maxCommits + 1}`, "--format=%H%x1f%an%x1f%aI%x1f%s", `${de}..${para}`]),
    git(["diff", "--name-only", de, para], { limiteBytes: 512 * 1024 }),
  ]);
  if (!lista.ok) return { disponivel: false, motivo: "não foi possível listar os commits" };

  const linhas = lista.saida.split("\n").filter(Boolean);
  const commits = linhas.slice(0, maxCommits).map((linha) => {
    const [hash, autor, data, assunto] = linha.split("\x1f");
    return { commit: hash, curto: (hash || "").slice(0, 8), autor, data, assunto: (assunto || "").slice(0, 200) };
  });
  const nomes = arquivos.ok ? arquivos.saida.split("\n").filter(Boolean) : [];
  return {
    disponivel: true,
    total: linhas.length > maxCommits ? `${maxCommits}+` : linhas.length,
    truncado: linhas.length > maxCommits,
    commits,
    arquivosAlterados: nomes.length,
    componentes: classificarArquivos(nomes),
  };
}

// --- Consolidated view -----------------------------------------------------------------------

async function situacaoDeAtualizacao({ consultarRede = false } = {}) {
  const [local, saude] = await Promise.all([estadoLocal(), coleta.consultarSaude()]);
  const registradas = coleta.versoesRegistradas();
  const historico = coleta.historicoDeploy(10);
  const ultimaVerificada = historico.find((h) => h.sucesso) || null;

  let observacao = lerObservacao();
  let consulta = null;
  if (consultarRede) {
    consulta = await consultarRemoto();
    if (consulta.ok) observacao = lerObservacao();
  }

  const idadeObservacaoS = observacao ? Math.round((Date.now() - Date.parse(observacao.observadoEm)) / 1000) : null;
  const comparacao = observacao ? await compararCom(observacao.commit) : null;

  // The running process is the only source of what is actually live. The checkout HEAD is not.
  const commitEmExecucao = saude.respondeu ? saude.commit : null;
  const divergenciaProcessoCheckout =
    commitEmExecucao && local.head && commitEmExecucao !== local.head
      ? {
          ha: true,
          explicacao:
            "o código no disco não é o que o processo carregou. Isso acontece após um deploy --no-restart, " +
            "um git pull manual ou uma atualização interrompida: reiniciar o serviço aplica o código do disco.",
        }
      : { ha: false };

  return {
    checkout: local,
    emExecucao: {
      commit: commitEmExecucao,
      confirmadoPeloProcesso: !!commitEmExecucao,
      motivoDesconhecido: saude.respondeu
        ? commitEmExecucao
          ? null
          : "o processo respondeu ao /health mas não informa commit: é uma versão anterior ao campo de commit"
        : `o /health não respondeu (${saude.erro || "sem resposta"}), então a versão em execução é desconhecida`,
      uptimeSegundos: saude.uptimeSegundos,
    },
    divergenciaProcessoCheckout,
    remoto: observacao
      ? {
          ...observacao,
          idadeSegundos: idadeObservacaoS,
          recente: idadeObservacaoS !== null && idadeObservacaoS < 3600,
          ressalva:
            idadeObservacaoS !== null && idadeObservacaoS >= 3600
              ? "esta observação é antiga; o conteúdo de origin pode ter mudado desde então"
              : null,
        }
      : null,
    consultaAgora: consulta && !consulta.ok ? consulta : null,
    comparacao,
    versoesRegistradas: registradas,
    ultimaImplantacaoVerificada: ultimaVerificada,
    historico,
    versoes: coleta.versoesDeclaradas(),
  };
}

module.exports = {
  git,
  ehRepositorio,
  estadoLocal,
  consultarRemoto,
  lerObservacao,
  compararCom,
  resumoDeMudancas,
  situacaoDeAtualizacao,
  classificarArquivos,
  classificarFalhaDeRede,
  COMPONENTES,
};
