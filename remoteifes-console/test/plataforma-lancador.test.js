const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ajuda = require("./ajuda");

// Adaptadores de plataforma, modelo de capacidades e proteção do lançador contra phishing local.

// --- Adaptadores --------------------------------------------------------------------------

test("cada plataforma tem adaptador e o contrato é o mesmo", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const seletor = require(path.join(ajuda.RAIZ, "src", "plataforma", "index.js"));

  const exigidos = [
    "estadoDoServico", "controlarServico", "estadoDoWatchdog", "controlarWatchdog",
    "lerRegistros", "reiniciarHost", "reiniciarConsole", "memoria", "disco", "relogio",
    "portasEmEscuta", "pacotesPendentes", "abrirNavegador", "protegerArquivo",
    "permissaoRestrita", "diretoriosPadrao", "encerrarArvore", "opcoesDeGrupo",
    "registrarInicializacao", "removerInicializacao", "estadoDaInicializacao",
    "classificarArquitetura", "runtimeAtual", "ferramentas",
  ];
  for (const alvo of ["linux", "win32", "darwin"]) {
    process.env.CONSOLE_PLATAFORMA = alvo;
    const adaptador = seletor.escolher();
    for (const fn of exigidos) {
      assert.equal(typeof adaptador[fn], "function", `${alvo} não implementa ${fn}`);
    }
    assert.ok(adaptador.nome && adaptador.rotulo, `${alvo} sem identificação`);
  }
  delete process.env.CONSOLE_PLATAFORMA;
});

test("capacidades indisponíveis têm causa distinta, não um booleano", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const base = require(path.join(ajuda.RAIZ, "src", "plataforma", "base.js"));

  const estados = new Set(Object.values(base.ESTADO));
  assert.ok(estados.has("nao-aplicavel"));
  assert.ok(estados.has("nao-instalado"));
  assert.ok(estados.has("sem-permissao"));
  assert.ok(estados.has("nao-suportado"));

  // O watchdog não existe fora do Linux: isso é "não aplicável", não "indisponível".
  process.env.CONSOLE_PLATAFORMA = "win32";
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const w = await windows.estadoDoWatchdog();
  assert.equal(w.estado, base.ESTADO.NAO_APLICAVEL);
  assert.match(w.motivo, /não existe no Windows/);

  const macos = require(path.join(ajuda.RAIZ, "src", "plataforma", "macos.js"));
  const m = await macos.estadoDoWatchdog();
  assert.equal(m.estado, base.ESTADO.NAO_APLICAVEL);
  delete process.env.CONSOLE_PLATAFORMA;
});

test("a arquitetura distingue hardware, kernel, userland e runtime", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma", "index.js"));

  const a = await plataforma.classificarArquitetura();
  assert.equal(a.runtime, process.arch, "o runtime é quem decide o artefato");
  assert.ok("kernel" in a && "userland" in a && "hardware" in a, "as quatro camadas são separadas");
  assert.match(a.alvoDeArtefato, new RegExp(process.arch));
  assert.match(a.observacao, /Raspberry Pi 3/);
  // A ressalva de ARMv7 só aparece quando o userland/runtime é de 32 bits.
  if (a.armv7) assert.match(a.ressalva, /2027-04-30/);
  else assert.equal(a.ressalva, null);
});

test("o runtime mínimo é conferido contra o exigido pelo RemoteIFES", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma", "index.js"));

  const r = plataforma.runtimeAtual();
  assert.equal(r.minimoExigido, "22.13.0");
  assert.equal(r.executavel, process.execPath);
  assert.equal(typeof r.atende, "boolean");
});

test("os diretórios seguem a convenção de cada sistema, não um dotfolder para todos", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const linux = require(path.join(ajuda.RAIZ, "src", "plataforma", "linux.js")).diretoriosPadrao({ escopo: "sistema" });
  assert.equal(linux.raizInstalacao, "/opt/remoteifes-console");
  assert.equal(linux.estado, "/var/lib/remoteifes-console");

  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js")).diretoriosPadrao({ escopo: "sistema" });
  assert.match(windows.raizInstalacao, /Program Files/);
  assert.match(windows.estado, /ProgramData/);
  assert.match(windows.atalhos, /Start Menu/);

  const macos = require(path.join(ajuda.RAIZ, "src", "plataforma", "macos.js")).diretoriosPadrao({ escopo: "sistema" });
  assert.match(macos.raizInstalacao, /\/Applications\//);
  assert.match(macos.estado, /Application Support/);
});

test("o plist do LaunchAgent é sob demanda, sem RunAtLoad", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const macos = require(path.join(ajuda.RAIZ, "src", "plataforma", "macos.js"));

  const plist = macos.plistDoAgente({ comando: "/usr/bin/node", argumentos: ["/opt/x/console-bootstrap.js"], logs: "/tmp/logs" });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /br\.edu\.ifes\.remoteifes\.console/);
  assert.match(plist, /ProcessType<\/key>\s*<string>Background/);
});

test("o Windows encerra a árvore por taskkill, e não por grupo POSIX", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const linux = require(path.join(ajuda.RAIZ, "src", "plataforma", "linux.js"));

  assert.notEqual(windows.encerrarArvore, linux.encerrarArvore, "o Windows precisa de implementação própria");
  assert.equal(windows.opcoesDeGrupo().windowsHide, true);
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"), "utf8");
  assert.match(fonte, /taskkill/, "matar só o pai deixaria netos vivos no Windows");
  assert.match(fonte, /icacls/, "proteção de arquivo no Windows é ACL, não modo POSIX");
});

test("a tarefa agendada do Windows recebe o script, e o caminho com espaço sobrevive", async (t) => {
  // Dois defeitos moravam aqui. O primeiro: `argumentos` era descartado, então a tarefa era
  // criada com sucesso chamando `node.exe` sem script nenhum — nada abria e nada reclamava. O
  // segundo: o comando ia dentro de um script de PowerShell, com aspas escapadas na mão, e o
  // alvo real é um caminho com espaço ("...\RemoteIFES Console\console-bootstrap.js").
  //
  // O teste olha o argv entregue ao schtasks, não o resultado: criar tarefa de verdade exige
  // privilégio que um runner pode não ter, e pular a verificação nesse caso não provaria nada.
  const amb = ajuda.ambiente();
  const processos = require(path.join(ajuda.RAIZ, "src", "processos.js"));
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const original = processos.executar;
  const chamadas = [];
  processos.executar = (exe, args) => {
    chamadas.push({ exe, args });
    return Promise.resolve({ ok: true, codigo: 0, saida: "", erro: null });
  };
  t.after(() => {
    processos.executar = original;
    amb.restaurar();
  });

  const raiz = "C:\\Users\\op\\AppData\\Local\\Programs\\RemoteIFES Console";
  const r = await windows.registrarInicializacao({
    comando: "C:\\Program Files\\nodejs\\node.exe",
    argumentos: [`${raiz}\\console-bootstrap.js`],
    escopo: "usuario",
  });
  assert.equal(r.disponivel, true, r.motivo);

  const criacao = chamadas.find((c) => c.args.includes("/Create"));
  assert.ok(criacao, "a criação precisa ir para o schtasks");
  assert.equal(criacao.exe, "schtasks.exe", "o schtasks é chamado direto, sem PowerShell em volta");

  const alvo = criacao.args[criacao.args.indexOf("/TR") + 1];
  assert.ok(alvo.includes("console-bootstrap.js"), `a tarefa precisa apontar para o bootstrap; recebeu: ${alvo}`);
  assert.ok(alvo.includes(raiz), "o caminho da instalação precisa chegar inteiro");
  assert.equal(alvo, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\op\\AppData\\Local\\Programs\\RemoteIFES Console\\console-bootstrap.js"');

  // O nome da tarefa vai como argumento próprio: sem aspas embutidas para o shell desfazer.
  assert.equal(criacao.args[criacao.args.indexOf("/TN") + 1], "RemoteIFES Console");
  assert.ok(!criacao.args.includes("/RU"), "escopo de usuário não pede execução como SYSTEM");

  const comoSistema = await windows.registrarInicializacao({
    comando: "node.exe",
    argumentos: ["x.js"],
    escopo: "sistema",
  });
  assert.equal(comoSistema.disponivel, true);
  const criacaoSistema = chamadas.filter((c) => c.args.includes("/Create")).at(-1);
  assert.deepEqual(criacaoSistema.args.slice(-2), ["/RU", "SYSTEM"]);
});

test("remover uma inicialização que não existe é sucesso, não falha", async (t) => {
  const amb = ajuda.ambiente();
  const processos = require(path.join(ajuda.RAIZ, "src", "processos.js"));
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const original = processos.executar;
  processos.executar = () => Promise.resolve({ ok: false, codigo: 1, saida: "ERROR: The system cannot find the file specified.", erro: null });
  t.after(() => {
    processos.executar = original;
    amb.restaurar();
  });

  // Desinstalar dá o resultado pedido: não haver tarefa É não haver tarefa. Tratar isso como
  // erro faria a desinstalação parecer quebrada toda vez que fosse repetida.
  const r = await windows.removerInicializacao();
  assert.equal(r.disponivel, true);
  assert.match(r.mecanismo, /não havia tarefa/);
});

test("no Windows o disco é medido sem abrir processo nenhum", async (t) => {
  // O adaptador do Windows chamava o PowerShell uma vez por caminho. A prontidão mede dois
  // caminhos antes de cada operação, e só isso levava a avaliação a mais de 15 s num runner de
  // dois núcleos — o operador esperando por uma tela de confirmação.
  //
  // O teste olha o adaptador do Windows diretamente, e por isso vale rodando em qualquer
  // sistema: a medição dele é a herdada do adaptador base, que usa `fs.statfsSync`.
  const amb = ajuda.ambiente();
  const processos = require(path.join(ajuda.RAIZ, "src", "processos.js"));
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const original = processos.executar;
  let abriuProcesso = false;
  processos.executar = (...args) => {
    abriuProcesso = true;
    return original(...args);
  };
  t.after(() => {
    processos.executar = original;
    amb.restaurar();
  });

  const r = await windows.disco([ajuda.RAIZ, require("os").tmpdir()]);
  assert.equal(abriuProcesso, false, "a medição de disco do Windows não pode abrir processo");
  assert.equal(r.length, 2);
  for (const d of r) {
    assert.equal(d.suportado, true, d.motivo);
    assert.ok(d.totalBytes > 0, "o total precisa ser um número real");
    assert.ok(d.livreBytes >= 0 && d.livreBytes <= d.totalBytes);
    assert.ok(d.usoPercentual >= 0 && d.usoPercentual <= 100);
  }
});

test("cada sistema mede o disco e diz qual dispositivo mediu", async (t) => {
  // Linux e macOS mantêm o `df`: ele nomeia o dispositivo e o ponto de montagem reais, que o
  // statfs não dá. Num Pi com /var em outro dispositivo, essa distinção é a diferença entre
  // medir o disco certo e o errado antes de um backup.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma"));

  const r = await plataforma.disco([ajuda.RAIZ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].suportado, true, r[0].motivo);
  assert.ok(r[0].totalBytes > 0);
  assert.ok(r[0].montagem, "a medição precisa dizer onde mediu");
});

test("no Windows a proteção de arquivo não é afirmada por modo POSIX", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  const alvo = path.join(amb.estadoDir, "protegido.json");
  fs.writeFileSync(alvo, "{}");
  const r = windows.permissaoRestrita(alvo);
  // Onde icacls existe, a resposta é verificável; onde não existe, ela diz que não é verificável
  // em vez de devolver um "restrito" falso.
  assert.ok(r.verificavel === true || r.verificavel === false);
  if (r.verificavel) assert.equal(typeof r.restrito, "boolean");
  else assert.equal(r.restrito, null);
});

// --- Identidade do listener ---------------------------------------------------------------

test("o backend publica um contrato de identidade protegido", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  const identidade = require(path.join(ajuda.RAIZ, "src", "identidade.js"));

  identidade.publicarContrato({ porta: s.porta, modo: "teste" });
  const contrato = JSON.parse(fs.readFileSync(path.join(amb.estadoDir, "endereco.json"), "utf8"));
  assert.equal(contrato.porta, s.porta);
  assert.equal(contrato.pid, process.pid);
  assert.ok(contrato.segredo && contrato.segredo.length >= 32);

  const protecao = identidade.protecaoDoContrato();
  assert.equal(protecao.presente, true);
  if (protecao.verificavel) assert.equal(protecao.restrito, true, "o contrato não pode ser legível por outros");
});

test("a prova de identidade confere e não revela o segredo", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  const identidade = require(path.join(ajuda.RAIZ, "src", "identidade.js"));
  identidade.publicarContrato({ porta: s.porta, modo: "teste" });
  const contrato = JSON.parse(fs.readFileSync(path.join(amb.estadoDir, "endereco.json"), "utf8"));

  const desafio = crypto.randomBytes(32).toString("base64url");
  const r = await ajuda.pedir(s.porta, `/api/identidade?desafio=${encodeURIComponent(desafio)}`);
  assert.equal(r.status, 200);
  const esperado = crypto.createHmac("sha256", Buffer.from(contrato.segredo, "base64url")).update(desafio).digest("base64url");
  assert.equal(r.json.prova, esperado);
  assert.ok(!r.texto.includes(contrato.segredo), "o segredo nunca vai na resposta");

  // Desafio diferente, prova diferente: não há resposta fixa reutilizável.
  const outro = await ajuda.pedir(s.porta, `/api/identidade?desafio=${encodeURIComponent(crypto.randomBytes(32).toString("base64url"))}`);
  assert.notEqual(outro.json.prova, r.json.prova);
});

test("desafio malformado é recusado", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  require(path.join(ajuda.RAIZ, "src", "identidade.js")).publicarContrato({ porta: s.porta, modo: "teste" });

  for (const desafio of ["", "curto", "x".repeat(500), "com espaço", "../../etc"]) {
    const r = await ajuda.pedir(s.porta, `/api/identidade?desafio=${encodeURIComponent(desafio)}`);
    assert.equal(r.status, 400, `deveria recusar ${JSON.stringify(desafio.slice(0, 12))}`);
  }
});

test("o lançador recusa abrir o navegador num impostor que tomou a porta", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  // Impostor: responde /api/identidade com uma prova qualquer, como faria uma página falsa.
  const impostor = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ prova: "prova-inventada-pelo-impostor", versao: "9.9.9" }));
  });
  await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
  const porta = impostor.address().port;
  t.after(() => new Promise((r) => impostor.close(() => r())));

  // Contrato legítimo, com um segredo que o impostor não conhece.
  fs.writeFileSync(
    path.join(amb.estadoDir, "endereco.json"),
    JSON.stringify({ porta, pid: process.pid, segredo: crypto.randomBytes(32).toString("base64url"), versao: "1.0.0" })
  );

  const r = await launcher.verificarIdentidade(launcher.lerContrato());
  assert.equal(r.ok, false);
  assert.equal(r.impostor, true);
  assert.match(r.motivo, /NÃO é este console/);

  const garantia = await launcher.garantirBackend();
  assert.equal(garantia.ok, false);
  assert.equal(garantia.impostor, true, "o lançador não pode subir outro backend nem abrir o navegador");
});

test("o lançador abre o console real depois de verificar a identidade", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  require(path.join(ajuda.RAIZ, "src", "identidade.js")).publicarContrato({ porta: s.porta, modo: "teste" });
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  const r = await launcher.garantirBackend();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.jaEstava, true, "não sobe um segundo backend quando já há um válido");
  assert.equal(launcher.urlDoConsole(r.contrato), `http://127.0.0.1:${s.porta}/`);
});

test("o lançador só abre endereços HTTP(S) validados", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  for (const ruim of ["file:///etc/passwd", "javascript:alert(1)", "não-é-url", "data:text/html,<script>"]) {
    const r = await launcher.abrir(ruim);
    assert.equal(r.ok, false, `deveria recusar ${ruim}`);
  }
});

test("a URL da aplicação sai da configuração real, não de uma porta fixa", (t) => {
  const checkout = ajuda.dirTemporario("console-url-");
  fs.mkdirSync(path.join(checkout, "remoteifes-server"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(checkout, "remoteifes-server", ".env"), "PORTA=9090\nCORS_ORIGIN=https://remoteifes.ifes.edu.br\n");
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  assert.equal(launcher.urlDaAplicacao(), "https://remoteifes.ifes.edu.br", "atrás de proxy, o endereço é o domínio");

  fs.writeFileSync(path.join(checkout, "remoteifes-server", ".env"), "PORTA=9090\n");
  const amb2 = ajuda.ambiente({ checkout });
  const launcher2 = require(path.join(ajuda.RAIZ, "launcher.js"));
  assert.equal(launcher2.urlDaAplicacao(), "http://127.0.0.1:9090/", "sem domínio, usa a porta configurada — não 8080 fixo");
  amb2.restaurar();
});

test("o status do lançador separa console, aplicação e versão do programa", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  const s = await launcher.coletarStatus();
  assert.ok("console" in s && "aplicacao" in s && "atualizacaoDoConsole" in s);
  assert.equal(s.console.noAr, false);
  assert.ok(s.aplicacao.url.startsWith("http"));
  assert.ok(s.plataforma);
});

// --- Saída por ociosidade -------------------------------------------------------------------

test("a saída por ociosidade fica desarmada quando ninguém sabe religar o console", async (t) => {
  const amb = ajuda.ambiente({ ociosidadeS: 1 });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  // Sem socket do systemd e sem lançador, sair deixaria o operador sem console.
  const semReativacao = amb.servidor.armarSaidaPorOciosidade(s.servidor, () => {}, { reativavel: false });
  assert.equal(semReativacao, null, "não arma quando não há como reativar");

  const comReativacao = amb.servidor.armarSaidaPorOciosidade(s.servidor, () => {}, { reativavel: true });
  assert.ok(comReativacao, "arma quando o lançador ou o socket podem religar");
  clearInterval(comReativacao);
});

// --- sc.exe em Windows localizado -------------------------------------------------------------

// Saídas reais de `sc.exe`, en-US e pt-BR. O `sc.exe` traduz os RÓTULOS; o que não muda é a
// ordem dos campos e o código numérico no início do valor.
const SC_QUERY_EN = [
  "SERVICE_NAME: RemoteIFES",
  "        TYPE               : 10  WIN32_OWN_PROCESS",
  "        STATE              : 4  RUNNING",
  "                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)",
  "        WIN32_EXIT_CODE    : 0  (0x0)",
  "        SERVICE_EXIT_CODE  : 0  (0x0)",
  "        CHECKPOINT         : 0x0",
  "        WAIT_HINT          : 0x0",
  "",
].join("\r\n");

const SC_QUERY_PT = [
  "NOME_DO_SERVIÇO: RemoteIFES",
  "        TIPO                : 10  WIN32_OWN_PROCESS",
  "        ESTADO              : 4  RUNNING",
  "                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)",
  "        CÓDIGO_DE_SAÍDA_WIN32    : 0  (0x0)",
  "        CÓDIGO_DE_SAÍDA_DO_SERVIÇO  : 0  (0x0)",
  "        PONTO_DE_VERIFICAÇÃO       : 0x0",
  "        SUGESTÃO_DE_ESPERA         : 0x0",
  "",
].join("\r\n");

const SC_QUERY_PT_PARADO = SC_QUERY_PT.replace("ESTADO              : 4  RUNNING", "ESTADO              : 1  STOPPED");

const SC_QC_PT = [
  "NOME_DO_SERVIÇO: RemoteIFES",
  "        TIPO                : 10  WIN32_OWN_PROCESS",
  "        TIPO_DE_INÍCIO      : 2   AUTO_START",
  "        CONTROLE_DE_ERRO    : 1   NORMAL",
  "        NOME_DO_CAMINHO_BINÁRIO: C:\\nodejs\\node.exe servidor.js",
  "",
].join("\r\n");

const SC_QC_PT_MANUAL = SC_QC_PT.replace("TIPO_DE_INÍCIO      : 2   AUTO_START", "TIPO_DE_INÍCIO      : 3   DEMAND_START");

test("o estado do serviço é lido por código, não pelo rótulo em inglês", (t) => {
  // Num Windows em português o `sc.exe` imprime ESTADO em vez de STATE. Procurar pelo nome
  // inglês fazia um serviço em execução ser reportado como parado, e start/stop esperava até o
  // prazo e devolvia falha — num host que é justamente o alvo provável deste projeto.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_EN), 4, "en-US: em execução");
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT), 4, "pt-BR: em execução");
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT_PARADO), 1, "pt-BR: parado");

  // O tipo (10) nunca pode ser confundido com um estado.
  assert.notEqual(windows.codigoDeEstadoSc(SC_QUERY_PT), 10);
});

test("o tipo de início é lido por código, e não exige o rótulo AUTO_START", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  assert.equal(windows.inicioAutomaticoSc(SC_QC_PT).automatico, true, "2 = automático, em qualquer idioma");
  assert.equal(windows.inicioAutomaticoSc(SC_QC_PT_MANUAL).automatico, false, "3 = manual");
  assert.match(windows.inicioAutomaticoSc(SC_QC_PT).rotulo || "", /AUTO_START/);
});

test("estados de transição são distinguidos de parado e em execução", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  // 2 = START_PENDING, 3 = STOP_PENDING. Tratá-los como 1 ou 4 faria a espera pela transição
  // concluir cedo e relatar sucesso sobre um serviço que ainda estava mudando de estado.
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT.replace("4  RUNNING", "2  START_PENDING")), 2);
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT.replace("4  RUNNING", "3  STOP_PENDING")), 3);
});

test("com a porta já reservada, o lançador conecta em vez de disputar o endereço", async (t) => {
  // Estado normal de um Linux com ativação por socket depois da saída por ociosidade: o contrato
  // foi apagado, mas o systemd continua dono da porta. Subir um backend TCP ali recebe
  // EADDRINUSE, e o lançador reportaria falha exatamente no estado que o desenho pretende.
  // Uma conexão basta para ativar o serviço; então o contrato novo aparece.
  const amb = ajuda.ambiente();
  const crypto = require("crypto");

  // Faz o papel do socket do systemd: detém a porta e, na primeira conexão, publica o contrato
  // como o console faria ao subir.
  const segredo = crypto.randomBytes(32).toString("base64url");
  let conexoes = 0;
  const detentor = require("http").createServer((req, res) => {
    conexoes += 1;
    if (conexoes === 1) {
      const fsl = require("fs");
      fsl.writeFileSync(
        require(path.join(ajuda.RAIZ, "src", "config")).ARQUIVO_ENDERECO,
        `${JSON.stringify({ porta: detentor.address().port, pid: process.pid, modo: "socket-systemd", versao: "1.0.0", segredo })}\n`
      );
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const desafio = url.searchParams.get("desafio");
    if (url.pathname === "/api/identidade" && desafio) {
      const prova = crypto.createHmac("sha256", Buffer.from(segredo, "base64url")).update(desafio).digest("base64url");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ prova, versao: "1.0.0" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => detentor.listen(0, "127.0.0.1", r));
  const porta = detentor.address().port;
  t.after(async () => {
    await new Promise((r) => detentor.close(() => r()));
    amb.restaurar();
  });

  // O lançador precisa ver essa porta como a sua.
  const amb2 = ajuda.ambiente({ estadoDir: amb.estadoDir, porta });
  t.after(() => amb2.restaurar());
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));

  // Sem contrato no início: é o estado após a saída por ociosidade.
  const arquivoContrato = require(path.join(ajuda.RAIZ, "src", "config")).ARQUIVO_ENDERECO;
  try {
    require("fs").rmSync(arquivoContrato, { force: true });
  } catch {}

  const r = await lancador.garantirBackend();
  assert.equal(r.ok, true, `o lançador deve compor com o socket, não disputar a porta: ${r.motivo}`);
  assert.ok(conexoes >= 1, "precisa ter havido uma conexão para ativar o serviço");
  assert.equal(r.contrato.porta, porta);
});

test("porta ocupada por um impostor não é aceita só porque respondeu", async (t) => {
  // Conectar ativa o serviço, mas não prova identidade: se quem atende não souber o segredo, o
  // lançador tem de recusar em vez de tratar a porta ocupada como console no ar.
  const amb = ajuda.ambiente();
  const intruso = require("http").createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ prova: "prova-errada" }));
  });
  await new Promise((r) => intruso.listen(0, "127.0.0.1", r));
  const porta = intruso.address().port;
  t.after(async () => {
    await new Promise((r) => intruso.close(() => r()));
    amb.restaurar();
  });

  const amb2 = ajuda.ambiente({ estadoDir: amb.estadoDir, porta, env: { CONSOLE_LANCADOR_ESPERA_MS: "1500" } });
  t.after(() => amb2.restaurar());
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));
  try {
    require("fs").rmSync(require(path.join(ajuda.RAIZ, "src", "config")).ARQUIVO_ENDERECO, { force: true });
  } catch {}

  const r = await lancador.garantirBackend();
  assert.equal(r.ok, false, "sem identidade publicada, a porta ocupada não vira sucesso");
  assert.match(r.motivo, /não publicou identidade|ocupada/);
});
