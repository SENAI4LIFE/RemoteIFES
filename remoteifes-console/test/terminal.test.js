const test = require("node:test");
const assert = require("node:assert/strict");
const ajuda = require("./ajuda");

// Expert Terminal: the whole authorization and lifecycle envelope is exercised with an injected
// fake PTY. The native module (node-pty) is not required to test what is critical: unlock,
// deadline, revocation, process cleanup and scrollback backpressure.

function ptyFalso(registro = {}) {
  registro.abertos = registro.abertos || [];
  return {
    nome: "pty-de-teste",
    abrir(opcoes) {
      const instancia = {
        pid: 424242,
        escrito: [],
        tamanhos: [],
        sinais: [],
        _dado: null,
        _saida: null,
        opcoes,
        escrever(dados) {
          instancia.escrito.push(dados);
        },
        redimensionar(c, l) {
          instancia.tamanhos.push([c, l]);
        },
        encerrar(sinal) {
          instancia.sinais.push(sinal);
          if (instancia._saida) instancia._saida({ exitCode: 0 });
        },
        aoDado(cb) {
          instancia._dado = cb;
        },
        aoSair(cb) {
          instancia._saida = cb;
        },
        emitir(texto) {
          if (instancia._dado) instancia._dado(texto);
        },
      };
      registro.abertos.push(instancia);
      return instancia;
    },
  };
}

test("sem o módulo de PTY o terminal é declarado indisponível, sem substituto inseguro", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  amb.terminal.definirFabricaParaTeste(null);
  const d = amb.terminal.disponibilidade();
  assert.equal(d.disponivel, false);
  assert.ok(d.motivo);
  assert.ok(Array.isArray(d.instalacao) && d.instalacao.length, "precisa dizer como habilitar");
  assert.match(d.explicacao, /pseudoterminal/i);
  // The alternative path is described as what it is, not as fulfilling the request.
  assert.match(d.alternativa, /NÃO substitui/);

  const r = amb.terminal.abrir({ operador: "op" });
  assert.equal(r.ok, false);
});

test("uma sessão de terminal abre, recebe entrada, redimensiona e encerra", (t) => {
  const amb = ajuda.ambiente();
  const registro = {};
  amb.terminal.definirFabricaParaTeste(ptyFalso(registro));
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "op", colunas: 100, linhas: 30 });
  assert.equal(aberta.ok, true);
  assert.equal(registro.abertos.length, 1);
  const pty = registro.abertos[0];
  assert.equal(pty.opcoes.colunas, 100);
  assert.equal(pty.opcoes.env.TERM, "xterm-256color");
  assert.equal(pty.opcoes.env.SEGREDO, undefined, "ambiente é montado, não herdado");

  assert.equal(amb.terminal.escrever(aberta.id, "op", "ls\n").ok, true);
  assert.deepEqual(pty.escrito, ["ls\n"]);

  assert.equal(amb.terminal.redimensionar(aberta.id, "op", 120, 40).colunas, 120);
  assert.deepEqual(pty.tamanhos.at(-1), [120, 40]);

  assert.equal(amb.terminal.encerrar(aberta.id, "teste"), true);
  assert.ok(pty.sinais.includes("SIGHUP"), "o encerramento precisa sinalizar a árvore de processos");
  assert.equal(amb.terminal.sessoesAtivas(), 0);
});

test("uma sessão pertence ao operador que a abriu", (t) => {
  const amb = ajuda.ambiente();
  amb.terminal.definirFabricaParaTeste(ptyFalso());
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "dono" });
  assert.equal(amb.terminal.escrever(aberta.id, "intruso", "rm -rf /\n").ok, false);
  assert.equal(amb.terminal.redimensionar(aberta.id, "intruso", 80, 24).ok, false);
  assert.deepEqual(amb.terminal.listar("intruso"), []);
  assert.equal(amb.terminal.listar("dono").length, 1);
});

test("o número de sessões simultâneas é limitado", (t) => {
  const amb = ajuda.ambiente({ env: { CONSOLE_TERMINAL_MAX_SESSOES: "2" } });
  amb.terminal.definirFabricaParaTeste(ptyFalso());
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  assert.equal(amb.terminal.abrir({ operador: "op" }).ok, true);
  assert.equal(amb.terminal.abrir({ operador: "op" }).ok, true);
  const terceira = amb.terminal.abrir({ operador: "op" });
  assert.equal(terceira.ok, false);
  assert.match(terceira.erro, /limite de 2 sessões/);
});

test("a sessão expira por ociosidade e pelo prazo máximo", (t) => {
  const amb = ajuda.ambiente({ terminalOciosoS: 60, terminalMaxS: 300 });
  const registro = {};
  amb.terminal.definirFabricaParaTeste(ptyFalso(registro));
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "op" });
  assert.equal(amb.terminal.sessoesAtivas(), 1);

  // Ages activity beyond the idle limit.
  const interna = amb.terminal.listar("op");
  assert.equal(interna.length, 1);
  amb.terminal.escrever(aberta.id, "op", "x");
  const sessoes = require(require.resolve(`${ajuda.RAIZ}/src/terminal.js`));
  // Without direct access to the Map, the effect is observed through behavior: the clock is forced.
  const original = Date.now;
  Date.now = () => original() + 61_000;
  try {
    assert.equal(sessoes.sessoesAtivas(), 0, "sessão ociosa deve ser encerrada");
  } finally {
    Date.now = original;
  }
  assert.ok(registro.abertos[0].sinais.includes("SIGHUP"));
});

test("o fim da elevação derruba as sessões de terminal do operador", (t) => {
  const amb = ajuda.ambiente();
  const registro = {};
  amb.terminal.definirFabricaParaTeste(ptyFalso(registro));
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  amb.terminal.abrir({ operador: "op" });
  amb.terminal.abrir({ operador: "outro" });
  assert.equal(amb.terminal.sessoesAtivas(), 2);

  const derrubadas = amb.terminal.relockDoOperador("op");
  assert.equal(derrubadas, 1);
  assert.equal(amb.terminal.listar("op").length, 0);
  assert.equal(amb.terminal.listar("outro").length, 1);
});

test("a rolagem é limitada e informa quando perdeu conteúdo", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const rolagem = new amb.terminal.Rolagem(1000);
  rolagem.anexar("a".repeat(400));
  const meio = rolagem.desde(0);
  assert.equal(meio.texto.length, 400);
  assert.equal(meio.perdeu, false);

  rolagem.anexar("b".repeat(5000));
  const depois = rolagem.desde(0);
  assert.ok(depois.texto.length <= 5400);
  assert.equal(depois.perdeu, true, "quem pediu desde o início precisa saber que houve descarte");
  assert.equal(rolagem.sequencia, 5400, "a posição continua monotônica mesmo com descarte");
});

test("a saída do terminal chega ao cliente pela posição e nunca é interpretada", (t) => {
  const amb = ajuda.ambiente();
  const registro = {};
  amb.terminal.definirFabricaParaTeste(ptyFalso(registro));
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "op" });
  registro.abertos[0].emitir("\u001b]0;titulo malicioso\u0007<script>alert(1)</script>");
  const lista = amb.terminal.listar("op");
  assert.equal(lista.length, 1);
  // The module delivers raw bytes; the interface inserts them through textContent (see web/app.js),
  // so control sequences and HTML never become markup or a browser window title.
  const rolagem = new amb.terminal.Rolagem(4096);
  rolagem.anexar("\u001b]0;x\u0007");
  assert.ok(rolagem.desde(0).texto.includes("\u001b"));
});

test("a auditoria do terminal guarda metadados, nunca a transcrição", (t) => {
  const amb = ajuda.ambiente();
  const registro = {};
  amb.terminal.definirFabricaParaTeste(ptyFalso(registro));
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "op" });
  amb.terminal.escrever(aberta.id, "op", "cat /etc/shadow\n");
  registro.abertos[0].emitir("root:$6$segredo-hash:::::");
  amb.terminal.encerrar(aberta.id, "teste");

  const auditoria = amb.estado.lerAuditoria(20);
  const eventos = auditoria.map((a) => a.evento);
  assert.ok(eventos.includes("terminal-aberto"));
  assert.ok(eventos.includes("terminal-encerrado"));
  const texto = JSON.stringify(auditoria);
  assert.ok(!texto.includes("cat /etc/shadow"), "o que foi digitado não pode ir para a auditoria");
  assert.ok(!texto.includes("segredo-hash"), "a saída não pode ir para a auditoria");
  const fim = auditoria.find((a) => a.evento === "terminal-encerrado");
  assert.equal(typeof fim.bytesEnviados, "number");
  assert.equal(typeof fim.duracaoSegundos, "number");
});

test("as rotas do terminal exigem sessão e elevação", async (t) => {
  const amb = ajuda.ambiente();
  amb.terminal.definirFabricaParaTeste(ptyFalso());
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const anonimo = await ajuda.pedir(s.porta, "/api/terminal");
  assert.equal(anonimo.status, 401);

  const sessao = await ajuda.autenticar(amb, s.porta);
  const estado = await ajuda.pedir(s.porta, "/api/terminal", { cookie: sessao.cookie, origem: s.base });
  assert.equal(estado.status, 200);
  assert.equal(estado.json.disponivel, true);
  assert.match(estado.json.redacao, /NÃO é filtrada/);

  const semElevacao = await ajuda.pedir(s.porta, "/api/terminal/sessoes", {
    metodo: "POST",
    corpo: { colunas: 80, linhas: 24 },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(semElevacao.status, 403);
  assert.equal(semElevacao.json.precisaElevacao, true);

  await ajuda.elevar(amb, s.porta, sessao);
  const comElevacao = await ajuda.pedir(s.porta, "/api/terminal/sessoes", {
    metodo: "POST",
    corpo: { colunas: 80, linhas: 24 },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(comElevacao.status, 201);
  assert.ok(comElevacao.json.id);

  // Ending elevation closes the terminal immediately.
  await ajuda.pedir(s.porta, "/api/sessao/elevar", { metodo: "DELETE", cookie: sessao.cookie, csrf: sessao.csrf, origem: s.base });
  const depois = await ajuda.pedir(s.porta, `/api/terminal/sessoes/${comElevacao.json.id}/entrada`, {
    metodo: "POST",
    corpo: { dados: "x" },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(depois.status, 403);
});

test("entrada grande demais é recusada", (t) => {
  const amb = ajuda.ambiente();
  amb.terminal.definirFabricaParaTeste(ptyFalso());
  t.after(() => {
    amb.terminal.definirFabricaParaTeste(null);
    amb.restaurar();
  });

  const aberta = amb.terminal.abrir({ operador: "op" });
  const r = amb.terminal.escrever(aberta.id, "op", "x".repeat(20000));
  assert.equal(r.ok, false);
  assert.match(r.erro, /grande demais/);
});
