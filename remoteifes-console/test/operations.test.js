const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ajuda = require("./helpers");

// Managed execution: path containment, argument validation, maintenance lock shared with the CLI,
// job lifecycle and outcome reconciliation.

function checkoutFalso(opcoes = {}) {
  const raiz = ajuda.dirTemporario("console-checkout-");
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "src", "config"), { recursive: true });
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(raiz, "remoteifes-server", ".env"), `PORTA=${opcoes.porta || 8188}\n`);
  return raiz;
}

// --- Path containment ---------------------------------------------------------------

test("caminhoContidoEm blocks traversal, absolute paths and NUL bytes", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const raiz = ajuda.dirTemporario("console-raiz-");
  fs.writeFileSync(path.join(raiz, "ok.db"), "x");

  assert.ok(amb.processos.caminhoContidoEm(raiz, "ok.db").endsWith("ok.db"));

  for (const ruim of ["../fora.db", "sub/../../fora.db", "..\\fora.db", "a\u0000b"]) {
    assert.throws(() => amb.processos.caminhoContidoEm(raiz, ruim), /inválido|travessia|fora/i, `deveria recusar ${JSON.stringify(ruim)}`);
  }
  assert.throws(() => amb.processos.caminhoContidoEm(raiz, path.join(os.tmpdir(), "x.db")), /absoluto/);
  fs.rmSync(raiz, { recursive: true, force: true });
});

test("caminhoContidoEm blocks a symlink pointing outside the folder", { skip: process.platform === "win32" ? "symlink exige privilégio no Windows" : false }, (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const raiz = ajuda.dirTemporario("console-raiz-");
  const fora = ajuda.dirTemporario("console-fora-");
  fs.writeFileSync(path.join(fora, "segredo.db"), "conteudo");
  fs.symlinkSync(path.join(fora, "segredo.db"), path.join(raiz, "link.db"));

  assert.throws(() => amb.processos.caminhoContidoEm(raiz, "link.db"), /link/i);
  fs.rmSync(raiz, { recursive: true, force: true });
  fs.rmSync(fora, { recursive: true, force: true });
});

test("the environment given to processes is built, not inherited", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  process.env.SEGREDO_QUE_NAO_DEVE_VAZAR = "valor";
  const env = amb.processos.ambienteLimpo();
  assert.equal(env.SEGREDO_QUE_NAO_DEVE_VAZAR, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "o git não pode pedir credencial interativamente");
  assert.ok(env.PATH);
  delete process.env.SEGREDO_QUE_NAO_DEVE_VAZAR;

  assert.throws(() => amb.processos.ambienteLimpo({ "minuscula-invalida": "x" }), /inválida/);
});

test("the privileged helper accepts only listed verbs", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const r = await amb.processos.chamarAuxiliar("rm-rf-tudo", ["/"]);
  assert.equal(r.ok, false);
  assert.match(r.erro, /verbo não permitido/);

  // Valid verb, but no privilege in this environment: the refusal is for unavailability, and the
  // Console says so instead of pretending it ran.
  const v = await amb.processos.chamarAuxiliar("servico-estado");
  assert.equal(v.ok, false);
  assert.ok(v.indisponivel);
});

test("bounded output keeps the start and end and marks what was left out", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const saida = new amb.processos.SaidaLimitada(200);
  saida.escrever("INICIO".padEnd(100, "a"));
  saida.escrever("x".repeat(5000));
  saida.escrever("y".repeat(50) + "FIM");
  const texto = saida.texto();
  assert.ok(texto.startsWith("INICIO"));
  assert.ok(texto.endsWith("FIM"));
  assert.match(texto, /bytes omitidos no meio/);
  assert.ok(texto.length < 1000);
});

// --- Action argument validation ------------------------------------------------------

test("action arguments are validated by schema, not by escaping", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const restaurar = amb.acoes.obter("backup.restaurar");

  for (const ruim of [
    "../../etc/passwd",
    "remoteifes-20260101-010101-abcdef.db; rm -rf /",
    "remoteifes-20260101-010101-abcdef.db && curl evil",
    "$(whoami).db",
    "`id`.db",
    "remoteifes-20260101-010101-abcdef.db\nrm -rf /",
    "/etc/shadow",
  ]) {
    assert.throws(() => amb.acoes.validarArgumentos(restaurar, { backup: ruim }), /valor inválido|obrigatório/, `deveria recusar ${JSON.stringify(ruim)}`);
  }
  const ok = amb.acoes.validarArgumentos(restaurar, { backup: "remoteifes-20260101-010101-abcdef.db" });
  assert.equal(ok.backup, "remoteifes-20260101-010101-abcdef.db");

  assert.throws(() => amb.acoes.validarArgumentos(restaurar, { backup: "remoteifes-20260101-010101-abcdef.db", extra: "x" }), /não reconhecido/);
  assert.throws(() => amb.acoes.validarArgumentos(restaurar, {}), /obrigatório/);

  const aplicar = amb.acoes.obter("atualizacao.aplicar");
  assert.throws(() => amb.acoes.validarArgumentos(aplicar, { commit: "origin/main; reboot" }), /valor inválido/);
  assert.throws(() => amb.acoes.validarArgumentos(aplicar, { commit: "zz" }), /valor inválido/);
  assert.equal(amb.acoes.validarArgumentos(aplicar, { commit: "a".repeat(40) }).commit, "a".repeat(40));

  assert.throws(() => amb.acoes.validarArgumentos(aplicar, { commit: "a".repeat(40), offline: "sim" }), /booleano/);
});

test("no action accepts a command line", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  for (const acao of amb.acoes.listar()) {
    for (const [nome, regra] of Object.entries(acao.esquema || {})) {
      assert.ok(
        !/comando|cmd|shell|script|args|argv/i.test(nome),
        `a ação ${acao.id} expõe um argumento livre de comando: ${nome}`
      );
      assert.ok(["texto", "booleano", "segredo"].includes(regra.tipo), `tipo inesperado em ${acao.id}.${nome}`);
    }
  }
});

test("the documentation command catalog is not an executable registry", (t) => {
  // commands.js has placeholders, pipelines and multi-line examples. This test prevents anyone from
  // ever feeding the action registry with it.
  const commands = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "src", "services", "documentation", "commands"));
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const idsDeAcao = new Set(amb.acoes.listar().map((a) => a.id));
  for (const [grupo, lista] of Object.entries(commands)) {
    assert.ok(!idsDeAcao.has(grupo), `o grupo de documentação "${grupo}" não pode ser um id de ação`);
    assert.ok(Array.isArray(lista));
  }
  const todos = Object.values(commands).flat().join("\n");
  assert.match(todos, /<[a-z]+>/, "o catálogo tem espaços reservados — prova de que é texto, não ação");
});

// --- Maintenance lock ----------------------------------------------------------------------

test("the Console lock uses the same file and format as the CLI", (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trava = amb.trava.adquirir({ acao: "teste", trabalhoId: "t1", operador: "op" });
  const arquivo = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  assert.ok(fs.existsSync(arquivo));
  const conteudo = fs.readFileSync(arquivo, "utf8").trim();
  assert.match(conteudo, /^\d+ \d{4}-\d{2}-\d{2}T/, "formato '<pid> <data>' é o que deploy.sh espera");
  assert.equal(Number(conteudo.split(/\s+/)[0]), process.pid);

  const situacao = amb.trava.situacao();
  assert.equal(situacao.ocupada, true);
  assert.equal(situacao.origem, "console");
  assert.equal(situacao.acao, "teste");

  trava.liberar();
  assert.ok(!fs.existsSync(arquivo));
  assert.equal(amb.trava.situacao().ocupada, false);
});

test("a live lock is never overridden, however old", (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const arquivo = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  // Live process (this one) and very old mtime: the scripts would treat this as leftover by age.
  fs.writeFileSync(arquivo, `${process.pid} 2020-01-01T00:00:00Z\n`);
  const antigo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(arquivo, antigo, antigo);

  const situacao = amb.trava.situacao();
  assert.equal(situacao.ocupada, true, "PID vivo significa operação viva, independente da idade");
  assert.ok(situacao.idadeSegundos > amb.trava.IDADE_RESIDUO_MS / 1000);

  assert.throws(() => amb.trava.adquirir({ acao: "outra", trabalhoId: "t2", operador: "op" }), /andamento/);
  const remocao = amb.trava.removerResiduo("op");
  assert.equal(remocao.ok, false, "não se remove a trava de um processo vivo");
  assert.match(remocao.erro, /ainda está em execução/);
});

test("a dead process's lock is reconciled and taken over", (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const arquivo = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  // Very high PID, unlikely to exist.
  fs.writeFileSync(arquivo, "4194303 2026-01-01T00:00:00Z\n");

  const situacao = amb.trava.situacao();
  assert.equal(situacao.ocupada, false);
  assert.equal(situacao.residuo, true);

  const trava = amb.trava.adquirir({ acao: "teste", trabalhoId: "t1", operador: "op" });
  const auditoria = amb.estado.lerAuditoria(20);
  assert.ok(auditoria.some((a) => a.evento === "trava-residual-reconciliada"), "a reconciliação precisa ficar registrada");
  trava.liberar();
});

// --- Motor de trabalhos ---------------------------------------------------------------------------

function esperarFim(execucao, id, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error("trabalho não terminou a tempo")), timeoutMs);
    const checar = () => {
      const t = execucao.obter(id);
      if (t && t.estado !== execucao.ESTADOS.EXECUTANDO) {
        clearTimeout(limite);
        clearInterval(relogio);
        resolve(t);
      }
    };
    const relogio = setInterval(checar, 100);
    checar();
  });
}

test("a job writes output to a file and records the outcome", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trabalho = amb.execucao.iniciar({
    acao: "teste.eco",
    rotulo: "Eco de teste",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "console.log('linha um'); console.error('linha dois'); process.exit(0)"],
    cwd: checkout,
    exigeTrava: false,
    timeoutMs: 15_000,
  });

  const fim = await esperarFim(amb.execucao, trabalho.id);
  assert.equal(fim.estado, amb.execucao.ESTADOS.CONCLUIDO);
  const saida = amb.execucao.lerSaida(trabalho.id);
  assert.match(saida.texto, /linha um/);
  assert.match(saida.texto, /linha dois/);
  assert.ok(fs.existsSync(amb.execucao.caminhoSaida(trabalho.id)), "a saída sobrevive fora da requisição HTTP");
});

test("a failing job is recorded as a failure, with the exit code", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trabalho = amb.execucao.iniciar({
    acao: "teste.falha",
    rotulo: "Falha de teste",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "console.error('deu ruim'); process.exit(3)"],
    cwd: checkout,
    exigeTrava: false,
  });
  const fim = await esperarFim(amb.execucao, trabalho.id);
  assert.equal(fim.estado, amb.execucao.ESTADOS.FALHOU);
  assert.equal(fim.codigo, 3);
  assert.match(fim.erro, /código de saída 3/);
});

test("a job whose effect is not confirmed becomes unknown, not success", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trabalho = amb.execucao.iniciar({
    acao: "teste.naoconfirma",
    rotulo: "Sem confirmação",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "process.exit(0)"],
    cwd: checkout,
    exigeTrava: false,
    verificar: async () => ({ ok: false, resumo: "o serviço não confirmou a versão esperada" }),
  });
  const fim = await esperarFim(amb.execucao, trabalho.id);
  assert.equal(fim.estado, amb.execucao.ESTADOS.DESCONHECIDO, "saída 0 não é prova de efeito");
  assert.match(fim.erro, /não confirmou/);
});

test("reconciliation marks as unknown a job whose process disappeared", (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  // Simulates what the Console would find after crashing in the middle of an operation.
  const arquivo = path.join(amb.estadoDir, "trabalhos.json");
  fs.writeFileSync(
    arquivo,
    JSON.stringify({
      trabalhos: [
        { id: "20260101000000-aaaaaaaa", acao: "atualizacao.aplicar", rotulo: "Atualizar", estado: "executando", iniciadoEm: new Date().toISOString(), pid: 4194303 },
      ],
    })
  );
  const quantos = amb.execucao.reconciliar();
  assert.equal(quantos, 1);
  const t1 = amb.execucao.obter("20260101000000-aaaaaaaa");
  assert.equal(t1.estado, amb.execucao.ESTADOS.DESCONHECIDO);
  assert.match(t1.erro, /não pôde ser comprovado/);
});

test("reconciliation keeps a surviving process as in progress", (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const arquivo = path.join(amb.estadoDir, "trabalhos.json");
  fs.writeFileSync(
    arquivo,
    JSON.stringify({
      trabalhos: [{ id: "20260101000000-bbbbbbbb", acao: "backup.criar", rotulo: "Backup", estado: "executando", iniciadoEm: new Date().toISOString(), pid: process.pid }],
    })
  );
  const quantos = amb.execucao.reconciliar();
  assert.equal(quantos, 0);
  assert.equal(amb.execucao.obter("20260101000000-bbbbbbbb").estado, "executando");
});

test("an operation past the point of no return refuses cancellation", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trabalho = amb.execucao.iniciar({
    acao: "teste.irreversivel",
    rotulo: "Fase irreversível",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "console.log('PONTO'); setTimeout(()=>process.exit(0), 4000)"],
    cwd: checkout,
    exigeTrava: false,
    faseIrreversivel: (texto) => texto.includes("PONTO"),
  });

  await new Promise((r) => setTimeout(r, 1200));
  const durante = amb.execucao.obter(trabalho.id);
  assert.equal(durante.irreversivel, true);
  const cancelamento = amb.execucao.cancelar(trabalho.id, "op");
  assert.equal(cancelamento.ok, false);
  assert.match(cancelamento.erro, /ponto em que podia ser desfeita/);
  await esperarFim(amb.execucao, trabalho.id);
});

test("two operations do not run at the same time", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const primeiro = amb.execucao.iniciar({
    acao: "teste.longo",
    rotulo: "Longo",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "setTimeout(()=>process.exit(0), 3000)"],
    cwd: checkout,
    exigeTrava: false,
  });
  assert.throws(
    () =>
      amb.execucao.iniciar({
        acao: "teste.outro",
        rotulo: "Outro",
        operador: "op",
        executavel: process.execPath,
        argumentos: ["-e", "process.exit(0)"],
        cwd: checkout,
        exigeTrava: false,
      }),
    /já existe uma operação em andamento/
  );
  await esperarFim(amb.execucao, primeiro.id);
});

test("job history is bounded and old outputs are pruned", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout, env: { CONSOLE_JOB_HISTORICO_MAX: "3" } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  for (let i = 0; i < 5; i += 1) {
    const j = amb.execucao.iniciar({
      acao: "teste.curto",
      rotulo: `Curto ${i}`,
      operador: "op",
      executavel: process.execPath,
      argumentos: ["-e", "process.exit(0)"],
      cwd: checkout,
      exigeTrava: false,
    });
    await esperarFim(amb.execucao, j.id);
  }
  const lista = amb.execucao.listar(50);
  assert.equal(lista.length, 3, "o histórico respeita o limite configurado");
  const saidas = fs.readdirSync(path.join(amb.estadoDir, "saidas"));
  assert.ok(saidas.length <= 3, `saídas órfãs devem ser podadas (encontradas ${saidas.length})`);
});
