const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const estado = require("./estado");
const auth = require("./auth");
const coleta = require("./coleta");
const acoes = require("./acoes");
const execucao = require("./execucao");
const repositorio = require("./repositorio");
const prontidao = require("./prontidao");
const rede = require("./rede");
const mobile = require("./mobile");
const terminal = require("./terminal");
const identidade = require("./identidade");
const plataforma = require("./plataforma");

// Console HTTP server. No framework: routing here is small and explicit, and a framework would add
// a dependency, RAM and surface on a 1 GiB host with no real gain.

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// `frame-ancestors 'none'` and `form-action 'none'` close framing and outbound POST; `connect-src
// 'self'` keeps the page from talking to another origin. Nothing inline: the Console's scripts and
// styles are separate files.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

const METODOS_SEGUROS = new Set(["GET", "HEAD"]);

let ultimaAtividade = Date.now();
let requisicoesAbertas = 0;
const fluxosAbertos = new Set();

function marcarAtividade() {
  ultimaAtividade = Date.now();
}

// --- Utilidades de resposta ----------------------------------------------------------------

function cabecalhosBase(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  res.setHeader("Cache-Control", "no-store");
  // The Console never owns a service worker; this prevents an SW registered on this origin by
  // mistake from taking over navigations.
  res.setHeader("Service-Worker-Allowed", "");
}

function responderJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  cabecalhosBase(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(texto) });
  res.end(texto);
}

function responderErro(res, status, erro, extra = {}) {
  responderJson(res, status, { ok: false, erro, ...extra });
}

// --- Origin validation -------------------------------------------------------------------

// Port actually listening. With socket activation systemd opens the port, so the configuration
// value cannot validate Host: the process must ask the socket.
let portaEfetiva = null;

function definirPortaEfetiva(porta) {
  portaEfetiva = Number(porta) || null;
}

function hostsAceitos() {
  if (config.HOSTS_ACEITOS.length) return config.HOSTS_ACEITOS;
  const porta = portaEfetiva || config.PORTA;
  return [`127.0.0.1:${porta}`, `localhost:${porta}`, `[::1]:${porta}`];
}

/**
 * Exact Host. Closes DNS rebinding: an attacker-controlled name resolving to 127.0.0.1 arrives with
 * another Host and is refused before any logic.
 */
function hostValido(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return hostsAceitos().includes(host);
}

/**
 * Exact Origin for mutating methods. Works together with the SameSite=Strict cookie and the CSRF
 * token header; CORS alone protects nothing here, because the attacker's browser does not need to
 * read the response, and the side effect is what must be prevented.
 */
function origemValida(req) {
  const origin = req.headers.origin;
  if (!origin) {
    // Without Origin only safe requests pass; a fetch from another page always sends Origin.
    return METODOS_SEGUROS.has(req.method);
  }
  const host = String(req.headers.host || "").toLowerCase();
  const esquema = config.ATRAS_DE_TLS ? "https" : "http";
  return origin.toLowerCase() === `${esquema}://${host}`;
}

// --- Cookies ----------------------------------------------------------------------------------

function lerCookies(req) {
  const bruto = req.headers.cookie;
  const saida = {};
  if (!bruto) return saida;
  for (const parte of bruto.split(";")) {
    const idx = parte.indexOf("=");
    if (idx < 0) continue;
    saida[parte.slice(0, idx).trim()] = decodeURIComponent(parte.slice(idx + 1).trim());
  }
  return saida;
}

function definirCookieSessao(res, token) {
  const atributos = [
    `${auth.COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${config.SESSAO_MAX_S}`,
  ];
  if (config.ATRAS_DE_TLS) atributos.push("Secure");
  res.setHeader("Set-Cookie", atributos.join("; "));
}

function limparCookieSessao(res) {
  const atributos = [`${auth.COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (config.ATRAS_DE_TLS) atributos.push("Secure");
  // Clear-Site-Data removes what the origin stored in the browser on logout.
  res.setHeader("Clear-Site-Data", '"cache", "storage"');
  res.setHeader("Set-Cookie", atributos.join("; "));
}

// --- Corpo ------------------------------------------------------------------------------------

function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on("data", (d) => {
      total += d.length;
      if (total > limite) {
        reject(Object.assign(new Error("corpo grande demais"), { status: 413 }));
        req.destroy();
        return;
      }
      pedacos.push(d);
    });
    req.on("end", () => {
      const texto = Buffer.concat(pedacos).toString("utf8");
      if (!texto) return resolve({});
      const tipo = String(req.headers["content-type"] || "");
      if (!tipo.startsWith("application/json")) {
        // An unexpected type is usually a cross-site submission disguised as a form.
        return reject(Object.assign(new Error("content-type precisa ser application/json"), { status: 415 }));
      }
      try {
        const valor = JSON.parse(texto);
        resolve(valor && typeof valor === "object" ? valor : {});
      } catch {
        reject(Object.assign(new Error("JSON inválido"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// --- Static files
// ---------------------------------------------------------------------------------

function servirEstatico(req, res, url) {
  const relativo = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  let arquivo;
  try {
    arquivo = require("./processos").caminhoContidoEm(config.DIR_WEB_CONSOLE, relativo);
  } catch {
    return responderErro(res, 404, "não encontrado");
  }
  let info;
  try {
    info = fs.statSync(arquivo);
    if (!info.isFile()) throw new Error("não é arquivo");
  } catch {
    return responderErro(res, 404, "não encontrado");
  }
  const tipo = TIPOS[path.extname(arquivo).toLowerCase()];
  if (!tipo) return responderErro(res, 404, "não encontrado");
  cabecalhosBase(res);
  res.writeHead(200, { "Content-Type": tipo, "Content-Length": info.size });
  fs.createReadStream(arquivo).pipe(res);
}

// --- Session ------------------------------------------------------------------------------------

function sessaoDaRequisicao(req) {
  const cookies = lerCookies(req);
  return auth.validarSessao(cookies[auth.COOKIE]);
}

function exigirSessao(req, res) {
  const sessao = sessaoDaRequisicao(req);
  if (!sessao) {
    responderErro(res, 401, "não autenticado");
    return null;
  }
  return sessao;
}

function csrfValido(req, sessao) {
  const enviado = req.headers["x-console-csrf"];
  if (!enviado || typeof enviado !== "string") return false;
  const a = Buffer.from(enviado, "utf8");
  const b = Buffer.from(sessao.csrf, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exigirElevacao(res, sessao) {
  if (!sessao.elevada) {
    responderErro(res, 403, "esta operação exige reautenticação", { precisaElevacao: true });
    return false;
  }
  return true;
}

// --- Rotas -------------------------------------------------------------------------------------

async function rotear(req, res, url, params) {
  const metodo = req.method;
  const caminho = url;

  // Listener identity proof. Sessionless on purpose: the launcher cannot log in and needs to know,
  // BEFORE opening the browser, whether whoever answers on the port is this Console. The answer is
  // HMAC(secret, challenge) with a secret that exists only in the protected state file; a process
  // that took the port cannot produce it, and the caller learns nothing about the secret.
  //
  // It is **GET** on purpose. The launcher is not a browser and sends no `Origin`; requiring Origin
  // on a POST would block it, and exempting one route from the origin rule would weaken CSRF
  // defense for all. Since the route changes nothing and does not reveal the secret, a safe method
  // is correct and the origin rule stays intact.
  if (caminho === "/api/identidade" && metodo === "GET") {
    const desafio = String(params.get("desafio") || "");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(desafio)) return responderErro(res, 400, "desafio inválido");
    const segredo = identidade.segredoAtual();
    if (!segredo) return responderErro(res, 503, "identidade do console ainda não provisionada");
    return responderJson(res, 200, {
      prova: crypto.createHmac("sha256", Buffer.from(segredo, "base64url")).update(desafio).digest("base64url"),
      versao: identidade.versaoDoConsole(),
    });
  }

  // Bootstrap: only while there is no operator yet. The installation secret is shown once by the
  // installer and kept in a file only the Console user reads.
  if (caminho === "/api/bootstrap" && metodo === "POST") {
    if (auth.existeOperador()) return responderErro(res, 409, "o console já tem um operador");
    const corpo = await lerCorpo(req);
    const arquivoSegredo = path.join(config.DIR_ESTADO, "bootstrap-token");
    let esperado = null;
    try {
      esperado = fs.readFileSync(arquivoSegredo, "utf8").trim();
    } catch {}
    if (!esperado) return responderErro(res, 409, "nenhum segredo de instalação disponível; reinstale com `node instalacao/instalar.js` para gerar um");
    if (String(corpo.segredo || "") !== esperado) {
      estado.auditar("bootstrap-recusado", {});
      return responderErro(res, 403, "segredo de instalação incorreto");
    }
    try {
      auth.criarOperador(String(corpo.nome || ""), String(corpo.senha || ""));
    } catch (erro) {
      return responderErro(res, 400, erro.message);
    }
    fs.rmSync(arquivoSegredo, { force: true });
    return responderJson(res, 201, { ok: true });
  }

  if (caminho === "/api/sessao" && metodo === "POST") {
    const corpo = await lerCorpo(req);
    const nome = String(corpo.nome || "");
    const chave = `login:${nome}`;
    const espera = auth.bloqueado(chave);
    if (espera > 0) {
      return responderJson(res, 429, { ok: false, erro: `muitas tentativas; tente novamente em ${espera}s` });
    }
    const operador = auth.autenticar(nome, String(corpo.senha || ""));
    if (!operador) {
      auth.registrarFalha(chave);
      estado.auditar("login-falhou", { nome });
      return responderErro(res, 401, "usuário ou senha incorretos");
    }
    auth.limparTentativas(chave);
    const { token, csrf } = auth.criarSessao(operador.nome, { origem: req.socket.remoteAddress });
    definirCookieSessao(res, token);
    return responderJson(res, 200, { ok: true, operador: operador.nome, csrf, trocaObrigatoria: operador.trocaObrigatoria });
  }

  if (caminho === "/api/sessao" && metodo === "GET") {
    const sessao = sessaoDaRequisicao(req);
    if (!sessao) return responderJson(res, 200, { autenticado: false, precisaBootstrap: !auth.existeOperador() });
    return responderJson(res, 200, {
      autenticado: true,
      operador: sessao.operador,
      csrf: sessao.csrf,
      elevada: sessao.elevada,
      restanteElevacaoS: sessao.restanteElevacaoS,
      expiraEm: new Date(sessao.expiraEm).toISOString(),
    });
  }

  const sessao = exigirSessao(req, res);
  if (!sessao) return undefined;

  if (!METODOS_SEGUROS.has(metodo) && !csrfValido(req, sessao)) {
    estado.auditar("csrf-recusado", { operador: sessao.operador, caminho });
    return responderErro(res, 403, "token de verificação ausente ou inválido");
  }

  if (caminho === "/api/sessao" && metodo === "DELETE") {
    const cookies = lerCookies(req);
    terminal.encerrarSessoesDoOperador(sessao.operador);
    auth.revogarSessao(cookies[auth.COOKIE]);
    limparCookieSessao(res);
    return responderJson(res, 200, { ok: true });
  }

  if (caminho === "/api/sessao/elevar" && metodo === "POST") {
    const corpo = await lerCorpo(req);
    const chave = `elevar:${sessao.operador}`;
    const espera = auth.bloqueado(chave);
    if (espera > 0) return responderJson(res, 429, { ok: false, erro: `muitas tentativas; tente novamente em ${espera}s` });
    const cookies = lerCookies(req);
    const resultado = auth.elevar(cookies[auth.COOKIE], String(corpo.senha || ""));
    if (!resultado.ok) {
      auth.registrarFalha(chave);
      return responderErro(res, 401, resultado.erro);
    }
    auth.limparTentativas(chave);
    return responderJson(res, 200, resultado);
  }

  if (caminho === "/api/sessao/elevar" && metodo === "DELETE") {
    const cookies = lerCookies(req);
    terminal.relockDoOperador(sessao.operador);
    auth.encerrarElevacao(cookies[auth.COOKIE]);
    return responderJson(res, 200, { ok: true });
  }

  if (caminho === "/api/sessao/senha" && metodo === "POST") {
    const corpo = await lerCorpo(req);
    try {
      auth.trocarSenha(sessao.operador, String(corpo.atual || ""), String(corpo.nova || ""));
    } catch (erro) {
      return responderErro(res, 400, erro.message);
    }
    limparCookieSessao(res);
    return responderJson(res, 200, { ok: true, reautenticar: true });
  }

  // --- Observation -----------------------------------------------------------------------------

  if (caminho === "/api/painel" && metodo === "GET") {
    marcarAtividade();
    const completo = params.get("completo") === "1";
    const painel = await coleta.painel({ completo });
    return responderJson(res, 200, {
      ...painel,
      trabalhoAtivo: execucao.trabalhoAtivo(),
      sessoesConsole: auth.sessoesAtivas().length,
    });
  }

  if (caminho === "/api/host" && metodo === "GET") {
    const saude = await coleta.consultarSaude();
    return responderJson(res, 200, {
      host: await coleta.coletarHost({ completo: true }),
      // Reading database content is allowed only with the application running: with it stopped,
      // opening SQLite would create -shm/-wal in the data directory from a process that should only
      // observe.
      banco: coleta.espiarBanco({ permitirLeitura: saude.respondeu }),
      prontidaoAplicacao: await prontidao.consultarProntidaoDaAplicacao(),
    });
  }

  // Installed program: **not** the same subject as /api/atualizacao, which is about the deployed
  // RemoteIFES commit. This is the Console version, the platform and where things live.
  if (caminho === "/api/programa" && metodo === "GET") {
    const atualizador = require("./atualizador");
    const consultarRede = params.get("rede") === "1";
    const [capacidades, situacaoConsole] = await Promise.all([
      plataforma.capacidades(),
      atualizador.situacao({ consultarRede }),
    ]);
    const registro = estado.lerJson(path.join(config.RAIZ_INSTALACAO, "estado-instalacao.json"), {});
    const contrato = estado.lerJson(config.ARQUIVO_ENDERECO, {});
    const padroes = plataforma.diretoriosPadrao(registro.escopo ? { escopo: registro.escopo } : {});
    return responderJson(res, 200, {
      console: situacaoConsole,
      plataforma: capacidades,
      instalacao: {
        raiz: config.RAIZ_INSTALACAO,
        payloadEmExecucao: config.RAIZ_CONSOLE,
        estado: config.DIR_ESTADO,
        checkout: config.DIR_CHECKOUT,
        escopo: registro.escopo || null,
        padroesDaPlataforma: { raizInstalacao: padroes.raizInstalacao, estado: padroes.estado, logs: padroes.logs },
        modoDeExecucao: contrato.modo || null,
        protecaoDoContrato: identidade.protecaoDoContrato(),
      },
      aplicacao: { url: config.urlDaAplicacao() },
    });
  }

  if (caminho === "/api/atualizacao" && metodo === "GET") {
    return responderJson(res, 200, await repositorio.situacaoDeAtualizacao({ consultarRede: false }));
  }

  if (caminho === "/api/atualizacao/verificar" && metodo === "POST") {
    const situacao = await repositorio.situacaoDeAtualizacao({ consultarRede: true });
    estado.auditar("atualizacao-verificada", { operador: sessao.operador, remoto: situacao.remoto ? situacao.remoto.commit : null });
    return responderJson(res, 200, situacao);
  }

  if (caminho === "/api/atualizacao/buscar" && metodo === "POST") {
    // git fetch brings the objects so the target can be reviewed and deployed. Fetch only; it does
    // not touch the checkout or the local branch.
    const r = await repositorio.git(["fetch", "--tags", "--prune", "origin"], { timeoutMs: 180_000 });
    estado.auditar("objetos-buscados", { operador: sessao.operador, ok: r.ok });
    if (!r.ok) {
      const falha = repositorio.classificarFalhaDeRede(`${r.saida} ${r.erro || ""}`);
      return responderErro(res, 502, falha.mensagem, { detalhe: (r.saida || "").slice(0, 400) });
    }
    return responderJson(res, 200, { ok: true, situacao: await repositorio.situacaoDeAtualizacao({ consultarRede: true }) });
  }

  if (caminho === "/api/atualizacao/mudancas" && metodo === "GET") {
    const de = params.get("de");
    const para = params.get("para");
    return responderJson(res, 200, await repositorio.resumoDeMudancas(de, para));
  }

  if (caminho === "/api/backups" && metodo === "GET") {
    return responderJson(res, 200, {
      ...coleta.listarBackups(),
      bancoQuarentenado: coleta.quarentenaDoBanco(),
      escopo:
        "Os backups contêm apenas o banco SQLite (inclusive credenciais de dispositivo). " +
        "Não incluem .env, firmware, APKs, material TLS, identidade do console nem configuração do host.",
    });
  }

  if (caminho === "/api/logs" && metodo === "GET") {
    const resultado = await coleta.lerJournal({
      unidade: params.get("unidade") || "aplicacao",
      linhas: params.get("linhas") || 200,
      prioridade: params.get("prioridade"),
    });
    return responderJson(res, 200, resultado);
  }

  if (caminho === "/api/auditoria" && metodo === "GET") {
    return responderJson(res, 200, { itens: estado.lerAuditoria(Math.min(Number(params.get("limite")) || 100, 500)) });
  }

  if (caminho === "/api/rede" && metodo === "GET") {
    return responderJson(res, 200, await rede.diagnostico({ alvo: params.get("alvo") }));
  }

  if (caminho === "/api/mobile" && metodo === "GET") {
    return responderJson(res, 200, await mobile.situacao());
  }

  if (caminho === "/api/mobile/ci" && metodo === "GET") {
    return responderJson(res, 200, await mobile.estadoCI());
  }

  // --- Actions -----------------------------------------------------------------------------------

  if (caminho === "/api/acoes" && metodo === "GET") {
    return responderJson(res, 200, { acoes: acoes.listar() });
  }

  const preparar = /^\/api\/acoes\/([a-z0-9.-]+)\/preparar$/.exec(caminho);
  if (preparar && metodo === "POST") {
    const corpo = await lerCorpo(req);
    try {
      const { acao, argumentos, impedimento, prontidao: pront } = await acoes.preparar(preparar[1], corpo.argumentos);
      return responderJson(res, 200, {
        ok: true,
        acao: {
          id: acao.id,
          rotulo: acao.rotulo,
          proposito: acao.proposito,
          impacto: acao.impacto,
          exigeElevacao: !!acao.exigeElevacao,
          confirmacao: acao.confirmacao || null,
        },
        // Secrets never come back: the argument echo omits secret-type fields.
        argumentos: Object.fromEntries(
          Object.entries(argumentos).filter(([k]) => !acao.esquema || !acao.esquema[k] || acao.esquema[k].tipo !== "segredo")
        ),
        impedimento,
        prontidao: pront,
        elevada: sessao.elevada,
      });
    } catch (erro) {
      return responderErro(res, 400, erro.message);
    }
  }

  const executar = /^\/api\/acoes\/([a-z0-9.-]+)\/executar$/.exec(caminho);
  if (executar && metodo === "POST") {
    const corpo = await lerCorpo(req);
    const acao = acoes.obter(executar[1]);
    if (!acao) return responderErro(res, 404, "ação desconhecida");
    if (acao.exigeElevacao && !exigirElevacao(res, sessao)) return undefined;
    if (acao.confirmacao && String(corpo.confirmacao || "").trim().toLowerCase() !== acao.confirmacao) {
      return responderErro(res, 400, `digite "${acao.confirmacao}" para confirmar esta operação`);
    }
    try {
      const resultado = await acoes.executar(executar[1], corpo.argumentos, {
        operador: sessao.operador,
        forcarAvisos: corpo.aceitarAvisos === true,
      });
      return responderJson(res, 202, { ok: true, ...resultado });
    } catch (erro) {
      const status = erro.codigo === "ocupado" ? 409 : erro.codigo === "bloqueado" || erro.codigo === "avisos" ? 412 : 400;
      return responderJson(res, status, { ok: false, erro: erro.message, codigo: erro.codigo || null, prontidao: erro.prontidao || null });
    }
  }

  // --- Trabalhos --------------------------------------------------------------------------------

  if (caminho === "/api/trabalhos" && metodo === "GET") {
    return responderJson(res, 200, { trabalhos: execucao.listar(Math.min(Number(params.get("limite")) || 20, 50)) });
  }

  const trabalho = /^\/api\/trabalhos\/([A-Za-z0-9-]+)$/.exec(caminho);
  if (trabalho && metodo === "GET") {
    const registro = execucao.obter(trabalho[1]);
    if (!registro) return responderErro(res, 404, "trabalho não encontrado");
    return responderJson(res, 200, registro);
  }

  const saida = /^\/api\/trabalhos\/([A-Za-z0-9-]+)\/saida$/.exec(caminho);
  if (saida && metodo === "GET") {
    const registro = execucao.obter(saida[1]);
    if (!registro) return responderErro(res, 404, "trabalho não encontrado");
    const desde = Math.max(0, Number(params.get("desde")) || 0);
    return responderJson(res, 200, { ...execucao.lerSaida(saida[1], { desdeByte: desde }), estado: registro.estado });
  }

  const cancelar = /^\/api\/trabalhos\/([A-Za-z0-9-]+)\/cancelar$/.exec(caminho);
  if (cancelar && metodo === "POST") {
    if (!exigirElevacao(res, sessao)) return undefined;
    const resultado = execucao.cancelar(cancelar[1], sessao.operador);
    return responderJson(res, resultado.ok ? 200 : 409, resultado);
  }

  const eventos = /^\/api\/trabalhos\/([A-Za-z0-9-]+)\/eventos$/.exec(caminho);
  if (eventos && metodo === "GET") {
    return fluxoDeEventos(req, res, eventos[1]);
  }

  // --- Terminal ----------------------------------------------------------------------------------

  if (caminho.startsWith("/api/terminal")) {
    return terminal.rotear({ req, res, caminho, metodo, params, sessao, lerCorpo, responderJson, responderErro, exigirElevacao });
  }

  return responderErro(res, 404, "rota não encontrada");
}

// --- SSE ----------------------------------------------------------------------------------------

function fluxoDeEventos(req, res, id) {
  const registro = execucao.obter(id);
  if (!registro) return responderErro(res, 404, "trabalho não encontrado");

  cabecalhosBase(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const fluxo = { res, ativo: true };
  fluxosAbertos.add(fluxo);

  let posicao = 0;
  const enviar = (evento, dados) => {
    if (!fluxo.ativo) return;
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };

  const empurrar = () => {
    const pedaco = execucao.lerSaida(id, { desdeByte: posicao });
    if (pedaco.texto) {
      posicao = pedaco.tamanho;
      enviar("saida", { texto: pedaco.texto, posicao });
    }
    const atual = execucao.obter(id);
    if (atual && atual.estado !== "executando") {
      enviar("fim", atual);
      encerrar();
    }
  };

  const aoSair = ({ id: idEvento }) => {
    if (idEvento === id) empurrar();
  };
  const aoFim = ({ id: idEvento }) => {
    if (idEvento === id) empurrar();
  };

  execucao.eventos.on("saida", aoSair);
  execucao.eventos.on("fim", aoFim);

  // Slow reinforcement poll: covers a process started by another Console instance (output in the
  // file, no in-memory event).
  const relogio = setInterval(empurrar, 2000);
  const batida = setInterval(() => fluxo.ativo && res.write(": batida\n\n"), 25_000);

  function encerrar() {
    if (!fluxo.ativo) return;
    fluxo.ativo = false;
    clearInterval(relogio);
    clearInterval(batida);
    execucao.eventos.off("saida", aoSair);
    execucao.eventos.off("fim", aoFim);
    fluxosAbertos.delete(fluxo);
    try {
      res.end();
    } catch {}
  }

  req.on("close", encerrar);
  empurrar();
  return undefined;
}

// --- Servidor -----------------------------------------------------------------------------------

function criarServidor() {
  const servidor = http.createServer(async (req, res) => {
    requisicoesAbertas += 1;
    marcarAtividade();
    try {
      if (!hostValido(req)) {
        // 421 is the correct answer for "this server does not serve that Host".
        return responderErro(res, 421, "host não reconhecido por este console");
      }
      if (!origemValida(req)) {
        estado.auditar("origem-recusada", { origem: req.headers.origin || null, caminho: req.url });
        return responderErro(res, 403, "origem não permitida");
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const caminho = url.pathname.replace(/\/{2,}/g, "/");

      if (!caminho.startsWith("/api/")) {
        if (!METODOS_SEGUROS.has(req.method)) return responderErro(res, 405, "método não permitido");
        return servirEstatico(req, res, caminho);
      }
      await rotear(req, res, caminho, url.searchParams);
    } catch (erro) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      const status = erro && erro.status ? erro.status : 500;
      if (status >= 500) estado.auditar("erro-interno", { caminho: req.url, mensagem: erro && erro.message });
      responderErro(res, status, status >= 500 ? "erro interno do console" : erro.message);
    } finally {
      requisicoesAbertas -= 1;
      marcarAtividade();
    }
  });

  servidor.on("listening", () => {
    const endereco = servidor.address();
    if (endereco && typeof endereco === "object" && endereco.port) definirPortaEfetiva(endereco.port);
  });

  servidor.headersTimeout = 20_000;
  servidor.requestTimeout = 300_000;
  servidor.keepAliveTimeout = 15_000;
  return servidor;
}

/**
 * Idle exit. Only meaningful with socket activation: systemd holds the socket and reopens the
 * service on the next connection, so staying resident would be idle RAM on a 1 GiB host.
 */
function armarSaidaPorOciosidade(servidor, aoSair, { reativavel = false } = {}) {
  if (!config.OCIOSIDADE_S) return null;
  // Idle exit is safe only when something can restart it: the systemd socket or the launcher. In a
  // standalone `node console.js`, exiting would leave the operator without a Console and without
  // warning.
  if (!reativavel) return null;
  const relogio = setInterval(() => {
    const ocioso = Date.now() - ultimaAtividade > config.OCIOSIDADE_S * 1000;
    const ocupado =
      requisicoesAbertas > 0 ||
      fluxosAbertos.size > 0 ||
      execucao.temTrabalhoNaMemoria() ||
      terminal.sessoesAtivas() > 0 ||
      auth.sessoesAtivas().length > 0;
    if (ocioso && !ocupado) {
      clearInterval(relogio);
      estado.auditar("console-saiu-por-ociosidade", { segundos: config.OCIOSIDADE_S });
      servidor.close(() => aoSair());
      setTimeout(() => aoSair(), 3000).unref();
    }
  }, 30_000);
  if (typeof relogio.unref === "function") relogio.unref();
  return relogio;
}

module.exports = { criarServidor, armarSaidaPorOciosidade, hostsAceitos, definirPortaEfetiva, marcarAtividade };
