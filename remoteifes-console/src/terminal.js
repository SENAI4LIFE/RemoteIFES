const crypto = require("crypto");
const os = require("os");
const config = require("./config");
const estado = require("./estado");

// Terminal Expert: capacidade separada e de alto risco.
//
// ESTADO DESTA PASSAGEM
// ---------------------
// O envelope completo está implementado e testado: destravamento explícito, operador
// autenticado, reautenticação adicional, autorização de curta duração, estado destravado
// visível, relock automático, limites de sessão, ciclo de vida, revogação, limpeza da árvore
// de processos, contrapressão e auditoria sem transcrição.
//
// O que **não** está entregue é o PTY em si. Node não tem PTY nativo, e um terminal correto
// (tamanho de janela via ioctl TIOCSWINSZ, sinais, eco, job control) exige um módulo nativo —
// `node-pty` — que no Raspberry Pi precisa de compilador e cabeçalhos para armv7/aarch64. Não
// foi possível validar essa compilação no alvo nesta passagem, e as alternativas sem módulo
// nativo (por exemplo `script -qfc`) não permitem redimensionar a janela a partir do servidor:
// entregariam um terminal que parece funcionar e quebra em `vim`, `less`, `htop` e em qualquer
// programa que leia o tamanho da tela.
//
// Por isso a fábrica de PTY é injetável e detectada em tempo de execução. Sem o módulo, o
// terminal responde `disponivel: false` com o motivo exato e as instruções de instalação.
// **Nenhum substituto é oferecido**: não há caminho que mande texto livre para um `/exec`, e um
// link para SSH não é apresentado como se cumprisse o pedido de terminal.

const SESSOES = new Map();
const SCROLLBACK_MAX_BYTES = 128 * 1024;
const ENTRADA_MAX_BYTES = 8 * 1024;

let fabricaPty = null;
let motivoIndisponivel = null;

function detectarPty() {
  if (fabricaPty) return fabricaPty;
  if (motivoIndisponivel) return null;
  try {
    // Resolvido a partir da instalação do console, nunca do checkout.
    const nodePty = require("node-pty");
    fabricaPty = {
      nome: "node-pty",
      abrir({ shell, cwd, env, colunas, linhas }) {
        const proc = nodePty.spawn(shell, [], { name: "xterm-256color", cols: colunas, rows: linhas, cwd, env });
        return {
          pid: proc.pid,
          escrever: (dados) => proc.write(dados),
          redimensionar: (c, l) => proc.resize(c, l),
          encerrar: (sinal) => proc.kill(sinal),
          aoDado: (cb) => proc.onData(cb),
          aoSair: (cb) => proc.onExit(cb),
        };
      },
    };
    return fabricaPty;
  } catch (erro) {
    motivoIndisponivel = erro.code === "MODULE_NOT_FOUND" ? "módulo node-pty não instalado" : `node-pty não carregou: ${erro.message}`;
    return null;
  }
}

/** Injeção usada pelos testes: exercita todo o ciclo de vida sem módulo nativo. */
function definirFabricaParaTeste(fabrica) {
  fabricaPty = fabrica;
  motivoIndisponivel = fabrica ? null : "fábrica de PTY removida para teste";
}

/**
 * O que falta, em cada sistema, para o terminal existir — com o comando exato daquela
 * plataforma. Uma instrução de `apt-get` num Windows não é ajuda: é ruído que faz o operador
 * concluir que o recurso simplesmente não funciona.
 */
function comoInstalarPty() {
  const raiz = config.RAIZ_INSTALACAO;
  if (process.platform === "win32") {
    return {
      // node-pty no Windows usa ConPTY (Windows 10 1809+) e vem com binário pré-compilado para
      // x64; em arm64 costuma exigir as Build Tools.
      requisitos: "Windows 10 1809 ou mais novo (ConPTY). Em x64 o node-pty traz binário pronto; em arm64 exige Visual Studio Build Tools.",
      comandos: [`cd "${raiz}"`, "npm install node-pty --omit=dev", "Feche e reabra o console pelo lançador."],
    };
  }
  if (process.platform === "darwin") {
    return {
      requisitos: "Ferramentas de linha de comando do Xcode (`xcode-select --install`).",
      comandos: [`cd "${raiz}"`, "npm install node-pty --omit=dev", "Feche e reabra o console pelo lançador."],
    };
  }
  return {
    requisitos: "Compilador e cabeçalhos do Node. Num Raspberry Pi a compilação leva alguns minutos.",
    comandos: [
      "sudo apt-get install -y build-essential python3",
      `cd "${raiz}" && npm install node-pty --omit=dev`,
      "sudo systemctl restart remoteifes-console.service",
    ],
  };
}

function disponibilidade() {
  const fabrica = detectarPty();
  if (fabrica) {
    return { disponivel: true, implementacao: fabrica.nome, shell: shellPadrao() };
  }
  const instalacao = comoInstalarPty();
  return {
    disponivel: false,
    motivo: motivoIndisponivel || "PTY indisponível",
    plataforma: process.platform,
    explicacao:
      "O terminal precisa de um pseudoterminal real para que tamanho de janela, sinais e programas de tela " +
      "funcionem. Node não oferece PTY nativo e o console não embute substituto: um terminal aproximado " +
      "quebraria em vim, less e htop sem avisar.",
    requisitos: instalacao.requisitos,
    instalacao: instalacao.comandos,
    alternativa:
      process.platform === "win32"
        ? "Enquanto isso, o acesso de linha de comando continua sendo o PowerShell da máquina. Isso NÃO " +
          "substitui o terminal do console: não tem o destravamento, o prazo e a auditoria daqui."
        : "Enquanto isso, o acesso de shell continua sendo por SSH. Isso NÃO substitui o terminal do console: " +
          "é apenas o caminho que já existe, sem a integração de destravamento, prazo e auditoria daqui.",
  };
}

function shellPadrao() {
  if (process.platform === "win32") return process.env.ComSpec || "powershell.exe";
  return process.env.SHELL && /^\/[\w./-]+$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
}

// --- Buffer circular de rolagem ----------------------------------------------------------------

class Rolagem {
  constructor(limite) {
    this.limite = limite;
    this.pedacos = [];
    this.bytes = 0;
    this.descartados = 0;
    this.sequencia = 0;
  }

  anexar(texto) {
    const buf = Buffer.from(texto, "utf8");
    this.sequencia += buf.length;
    this.pedacos.push(buf);
    this.bytes += buf.length;
    while (this.bytes > this.limite && this.pedacos.length > 1) {
      const fora = this.pedacos.shift();
      this.bytes -= fora.length;
      this.descartados += fora.length;
    }
  }

  desde(posicao) {
    const inicio = Math.max(posicao, this.descartados);
    const total = Buffer.concat(this.pedacos);
    const deslocamento = Math.max(0, inicio - this.descartados);
    return { texto: total.subarray(deslocamento).toString("utf8"), posicao: this.sequencia, perdeu: inicio > posicao };
  }
}

// --- Sessões ---------------------------------------------------------------------------------

function limparExpiradas() {
  const agora = Date.now();
  for (const [id, sessao] of SESSOES) {
    const ociosa = agora - sessao.ultimaAtividade > config.TERMINAL_OCIOSO_S * 1000;
    const velha = agora - sessao.criadaEm > config.TERMINAL_MAX_S * 1000;
    if (ociosa || velha) {
      encerrar(id, ociosa ? "ociosidade" : "prazo máximo");
    }
  }
}

function encerrar(id, motivo) {
  const sessao = SESSOES.get(id);
  if (!sessao) return false;
  SESSOES.delete(id);
  try {
    sessao.pty.encerrar("SIGHUP");
  } catch {}
  // Um SIGKILL de reforço evita processo órfão quando o shell ignora SIGHUP.
  setTimeout(() => {
    try {
      sessao.pty.encerrar("SIGKILL");
    } catch {}
  }, 3000).unref();
  for (const ouvinte of sessao.ouvintes) {
    try {
      ouvinte.fim(motivo);
    } catch {}
  }
  sessao.ouvintes.clear();
  // Auditoria guarda metadado, nunca o que foi digitado ou exibido.
  estado.auditar("terminal-encerrado", {
    id: id.slice(0, 12),
    operador: sessao.operador,
    motivo,
    duracaoSegundos: Math.round((Date.now() - sessao.criadaEm) / 1000),
    bytesEnviados: sessao.bytesEntrada,
    bytesRecebidos: sessao.rolagem.sequencia,
  });
  return true;
}

function abrir({ operador, colunas = 80, linhas = 24 }) {
  limparExpiradas();
  const fabrica = detectarPty();
  if (!fabrica) return { ok: false, ...disponibilidade() };
  if (SESSOES.size >= config.TERMINAL_MAX_SESSOES) {
    return { ok: false, erro: `limite de ${config.TERMINAL_MAX_SESSOES} sessões de terminal simultâneas atingido` };
  }
  const c = Math.max(20, Math.min(Number(colunas) || 80, 500));
  const l = Math.max(5, Math.min(Number(linhas) || 24, 200));

  const id = crypto.randomBytes(18).toString("base64url");
  let pty;
  try {
    pty = fabrica.abrir({
      shell: shellPadrao(),
      cwd: config.DIR_CHECKOUT,
      // Ambiente enxuto e previsível. O shell roda com a identidade e os grupos do usuário do
      // serviço do console: o terminal não eleva por si só.
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || os.homedir(),
        USER: process.env.USER || "",
        LANG: process.env.LANG || "C.UTF-8",
        TERM: "xterm-256color",
        REMOTEIFES_CONSOLE: "1",
      },
      colunas: c,
      linhas: l,
    });
  } catch (erro) {
    return { ok: false, erro: `não foi possível abrir o PTY: ${erro.message}` };
  }

  const sessao = {
    id,
    operador,
    pty,
    criadaEm: Date.now(),
    ultimaAtividade: Date.now(),
    rolagem: new Rolagem(SCROLLBACK_MAX_BYTES),
    ouvintes: new Set(),
    bytesEntrada: 0,
    colunas: c,
    linhas: l,
    encerrada: false,
  };
  SESSOES.set(id, sessao);

  pty.aoDado((dados) => {
    sessao.rolagem.anexar(dados);
    sessao.ultimaAtividade = Date.now();
    for (const ouvinte of sessao.ouvintes) {
      try {
        ouvinte.dados();
      } catch {}
    }
  });
  pty.aoSair(() => {
    if (SESSOES.has(id)) encerrar(id, "shell encerrado");
  });

  estado.auditar("terminal-aberto", { id: id.slice(0, 12), operador, colunas: c, linhas: l, pid: pty.pid });
  return { ok: true, id, colunas: c, linhas: l, expiraEm: new Date(sessao.criadaEm + config.TERMINAL_MAX_S * 1000).toISOString() };
}

function obter(id, operador) {
  limparExpiradas();
  const sessao = SESSOES.get(id);
  if (!sessao) return null;
  // Uma sessão de terminal pertence ao operador que a abriu.
  if (sessao.operador !== operador) return null;
  return sessao;
}

function escrever(id, operador, dados) {
  const sessao = obter(id, operador);
  if (!sessao) return { ok: false, erro: "sessão de terminal não encontrada" };
  const texto = String(dados == null ? "" : dados);
  if (Buffer.byteLength(texto) > ENTRADA_MAX_BYTES) return { ok: false, erro: "entrada grande demais" };
  sessao.bytesEntrada += Buffer.byteLength(texto);
  sessao.ultimaAtividade = Date.now();
  try {
    sessao.pty.escrever(texto);
  } catch (erro) {
    return { ok: false, erro: erro.message };
  }
  return { ok: true };
}

function redimensionar(id, operador, colunas, linhas) {
  const sessao = obter(id, operador);
  if (!sessao) return { ok: false, erro: "sessão de terminal não encontrada" };
  const c = Math.max(20, Math.min(Number(colunas) || 80, 500));
  const l = Math.max(5, Math.min(Number(linhas) || 24, 200));
  sessao.colunas = c;
  sessao.linhas = l;
  sessao.ultimaAtividade = Date.now();
  try {
    sessao.pty.redimensionar(c, l);
  } catch (erro) {
    return { ok: false, erro: erro.message };
  }
  return { ok: true, colunas: c, linhas: l };
}

function encerrarSessoesDoOperador(operador) {
  let n = 0;
  for (const [id, sessao] of [...SESSOES]) {
    if (sessao.operador === operador) {
      encerrar(id, "sessão do console encerrada");
      n += 1;
    }
  }
  return n;
}

/** Fim da elevação derruba o terminal: a autorização que o abriu deixou de existir. */
function relockDoOperador(operador) {
  return encerrarSessoesDoOperador(operador);
}

function sessoesAtivas() {
  limparExpiradas();
  return SESSOES.size;
}

function listar(operador) {
  limparExpiradas();
  return [...SESSOES.values()]
    .filter((s) => s.operador === operador)
    .map((s) => ({
      id: s.id,
      criadaEm: new Date(s.criadaEm).toISOString(),
      ultimaAtividade: new Date(s.ultimaAtividade).toISOString(),
      colunas: s.colunas,
      linhas: s.linhas,
      expiraEm: new Date(s.criadaEm + config.TERMINAL_MAX_S * 1000).toISOString(),
    }));
}

// --- Rotas -------------------------------------------------------------------------------------

async function rotear({ req, res, caminho, metodo, params, sessao, lerCorpo, responderJson, responderErro, exigirElevacao }) {
  if (caminho === "/api/terminal" && metodo === "GET") {
    return responderJson(res, 200, {
      ...disponibilidade(),
      sessoes: listar(sessao.operador),
      limites: {
        maxSessoes: config.TERMINAL_MAX_SESSOES,
        ociosoSegundos: config.TERMINAL_OCIOSO_S,
        maximoSegundos: config.TERMINAL_MAX_S,
      },
      politica:
        "O shell roda com a identidade e os grupos do usuário do serviço do console, sem elevação automática. " +
        "Um operador autorizado que use sudo tem o alcance que o host lhe der — inclusive alterar o próprio console, " +
        "seus registros e o sistema. Software na mesma máquina não consegue se tornar imutável diante do root; " +
        "o que este desenho impede é acesso não autorizado e uso acidental.",
      redacao:
        "A saída do terminal NÃO é filtrada em busca de segredos: se o operador abrir um arquivo com credenciais, " +
        "elas aparecem na tela. A proteção de segredos do console vale para suas próprias APIs e registros, não para " +
        "o que um shell autorizado decide exibir.",
    });
  }

  if (caminho === "/api/terminal/sessoes" && metodo === "POST") {
    if (!exigirElevacao(res, sessao)) return undefined;
    const corpo = await lerCorpo(req);
    const resultado = abrir({ operador: sessao.operador, colunas: corpo.colunas, linhas: corpo.linhas });
    return responderJson(res, resultado.ok ? 201 : 409, resultado);
  }

  const comId = /^\/api\/terminal\/sessoes\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(caminho);
  if (comId) {
    const id = comId[1];
    const sub = comId[2] || "";

    if (sub === "" && metodo === "DELETE") {
      const existe = obter(id, sessao.operador);
      if (!existe) return responderErro(res, 404, "sessão de terminal não encontrada");
      encerrar(id, "encerrada pelo operador");
      return responderJson(res, 200, { ok: true });
    }

    // Toda interação exige elevação ainda válida: o relock derruba a sessão.
    if (!exigirElevacao(res, sessao)) return undefined;

    if (sub === "/entrada" && metodo === "POST") {
      const corpo = await lerCorpo(req, ENTRADA_MAX_BYTES + 1024);
      const resultado = escrever(id, sessao.operador, corpo.dados);
      return responderJson(res, resultado.ok ? 200 : 404, resultado);
    }

    if (sub === "/tamanho" && metodo === "POST") {
      const corpo = await lerCorpo(req);
      const resultado = redimensionar(id, sessao.operador, corpo.colunas, corpo.linhas);
      return responderJson(res, resultado.ok ? 200 : 404, resultado);
    }

    if (sub === "/saida" && metodo === "GET") {
      const alvo = obter(id, sessao.operador);
      if (!alvo) return responderErro(res, 404, "sessão de terminal não encontrada");
      const desde = Math.max(0, Number(params.get("desde")) || 0);
      const pedaco = alvo.rolagem.desde(desde);
      alvo.ultimaAtividade = Date.now();
      return responderJson(res, 200, { ...pedaco, colunas: alvo.colunas, linhas: alvo.linhas });
    }
  }

  return responderErro(res, 404, "rota de terminal não encontrada");
}

module.exports = {
  rotear,
  disponibilidade,
  abrir,
  escrever,
  redimensionar,
  encerrar,
  encerrarSessoesDoOperador,
  relockDoOperador,
  sessoesAtivas,
  listar,
  definirFabricaParaTeste,
  Rolagem,
};
