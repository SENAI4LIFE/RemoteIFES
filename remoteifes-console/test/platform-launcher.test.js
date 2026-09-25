const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ajuda = require("./helpers");

// Platform adapters, capability model and launcher protection against local phishing.

// --- Adapters --------------------------------------------------------------------------

test("every platform has an adapter and the contract is the same", (t) => {
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
      assert.equal(typeof adaptador[fn], "function", `${alvo} does not implement ${fn}`);
    }
    assert.ok(adaptador.nome && adaptador.rotulo, `${alvo} without identification`);
  }
  delete process.env.CONSOLE_PLATAFORMA;
});

test("unavailable capabilities have distinct causes, not a boolean", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const base = require(path.join(ajuda.RAIZ, "src", "plataforma", "base.js"));

  const estados = new Set(Object.values(base.ESTADO));
  assert.ok(estados.has("nao-aplicavel"));
  assert.ok(estados.has("nao-instalado"));
  assert.ok(estados.has("sem-permissao"));
  assert.ok(estados.has("nao-suportado"));

  // The watchdog does not exist outside Linux: that is "not applicable", not "unavailable".
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

test("the architecture distinguishes hardware, kernel, userland and runtime", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma", "index.js"));

  const a = await plataforma.classificarArquitetura();
  assert.equal(a.runtime, process.arch, "the runtime decides the artifact");
  assert.ok("kernel" in a && "userland" in a && "hardware" in a, "the four layers are separate");
  assert.match(a.alvoDeArtefato, new RegExp(process.arch));
  assert.match(a.observacao, /Raspberry Pi 3/);
  // The ARMv7 caveat appears only when the userland/runtime is 32-bit.
  if (a.armv7) assert.match(a.ressalva, /2027-04-30/);
  else assert.equal(a.ressalva, null);
});

test("the minimum runtime is checked against what RemoteIFES requires", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma", "index.js"));

  const r = plataforma.runtimeAtual();
  assert.equal(r.minimoExigido, "22.13.0");
  assert.equal(r.executavel, process.execPath);
  assert.equal(typeof r.atende, "boolean");
});

test("directories follow each system's convention, not a dotfolder for all", (t) => {
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

test("the LaunchAgent plist is on demand, without RunAtLoad", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const macos = require(path.join(ajuda.RAIZ, "src", "plataforma", "macos.js"));

  const plist = macos.plistDoAgente({ comando: "/usr/bin/node", argumentos: ["/opt/x/console-bootstrap.js"], logs: "/tmp/logs" });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /br\.edu\.ifes\.remoteifes\.console/);
  assert.match(plist, /ProcessType<\/key>\s*<string>Background/);
});

test("Windows ends the tree with taskkill, not a POSIX group", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const linux = require(path.join(ajuda.RAIZ, "src", "plataforma", "linux.js"));

  assert.notEqual(windows.encerrarArvore, linux.encerrarArvore, "Windows needs its own implementation");
  assert.equal(windows.opcoesDeGrupo().windowsHide, true);
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"), "utf8");
  assert.match(fonte, /taskkill/, "killing only the parent would leave grandchildren alive on Windows");
  assert.match(fonte, /icacls/, "file protection on Windows is an ACL, not a POSIX mode");
});

test("the Windows scheduled task receives the script, and the path with a space survives", async (t) => {
  // `argumentos` must reach the task (otherwise it runs `node.exe` without a script), and the
  // command must not go through a PowerShell script with hand-escaped quotes, since the real target
  // is a path with a space ("...\RemoteIFES Console\console-bootstrap.js").
  //
  // The test inspects the argv handed to schtasks, not the result: creating a real task requires
  // privilege a runner may not have, and skipping the check in that case would prove nothing.
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
  assert.ok(criacao, "creation must go to schtasks");
  assert.equal(criacao.exe, "schtasks.exe", "schtasks is called directly, without PowerShell around it");

  const alvo = criacao.args[criacao.args.indexOf("/TR") + 1];
  assert.ok(alvo.includes("console-bootstrap.js"), `the task must point to the bootstrap; got: ${alvo}`);
  assert.ok(alvo.includes(raiz), "the installation path must arrive whole");
  assert.equal(alvo, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\op\\AppData\\Local\\Programs\\RemoteIFES Console\\console-bootstrap.js"');

  // The task name goes as its own argument: no embedded quotes for a shell to undo.
  assert.equal(criacao.args[criacao.args.indexOf("/TN") + 1], "RemoteIFES Console");
  assert.ok(!criacao.args.includes("/RU"), "user scope does not ask to run as SYSTEM");

  const comoSistema = await windows.registrarInicializacao({
    comando: "node.exe",
    argumentos: ["x.js"],
    escopo: "sistema",
  });
  assert.equal(comoSistema.disponivel, true);
  const criacaoSistema = chamadas.filter((c) => c.args.includes("/Create")).at(-1);
  assert.deepEqual(criacaoSistema.args.slice(-2), ["/RU", "SYSTEM"]);
});

test("removing a startup entry that does not exist is success, not failure", async (t) => {
  const amb = ajuda.ambiente();
  const processos = require(path.join(ajuda.RAIZ, "src", "processos.js"));
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));
  const original = processos.executar;
  processos.executar = () => Promise.resolve({ ok: false, codigo: 1, saida: "ERROR: The system cannot find the file specified.", erro: null });
  t.after(() => {
    processos.executar = original;
    amb.restaurar();
  });

  // Uninstall yields the requested result: no task IS no task. Treating that as an error would make
  // every repeated uninstall look broken.
  const r = await windows.removerInicializacao();
  assert.equal(r.disponivel, true);
  assert.match(r.mecanismo, /não havia tarefa/);
});

test("on Windows disk space is measured without starting any process", async (t) => {
  // Readiness measures two paths before every operation, so disk measurement must not start a
  // process per path on Windows.
  //
  // The test inspects the Windows adapter directly and is therefore valid on any system: its
  // measurement is inherited from the base adapter, which uses `fs.statfsSync`.
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
  assert.equal(abriuProcesso, false, "Windows disk measurement must not start a process");
  assert.equal(r.length, 2);
  for (const d of r) {
    assert.equal(d.suportado, true, d.motivo);
    assert.ok(d.totalBytes > 0, "the total must be a real number");
    assert.ok(d.livreBytes >= 0 && d.livreBytes <= d.totalBytes);
    assert.ok(d.usoPercentual >= 0 && d.usoPercentual <= 100);
  }
});

test("each system measures disk space and states which device it measured", async (t) => {
  // Linux and macOS keep `df`: it names the real device and mount point, which statfs does not. On
  // a Pi with /var on another device, that is the difference between measuring the right and the
  // wrong disk before a backup.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma"));

  const r = await plataforma.disco([ajuda.RAIZ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].suportado, true, r[0].motivo);
  assert.ok(r[0].totalBytes > 0);
  assert.ok(r[0].montagem, "the measurement must say where it measured");
});

test("on Windows file protection is not claimed through a POSIX mode", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  const alvo = path.join(amb.estadoDir, "protegido.json");
  fs.writeFileSync(alvo, "{}");
  const r = windows.permissaoRestrita(alvo);
  // Where icacls exists the answer is verifiable; where it does not, it says it is not verifiable
  // instead of returning a false "restricted".
  assert.ok(r.verificavel === true || r.verificavel === false);
  if (r.verificavel) assert.equal(typeof r.restrito, "boolean");
  else assert.equal(r.restrito, null);
});

// --- Listener identity ---------------------------------------------------------------

test("the backend publishes a protected identity contract", async (t) => {
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
  if (protecao.verificavel) assert.equal(protecao.restrito, true, "the contract must not be readable by others");
});

test("the identity proof verifies and does not reveal the secret", async (t) => {
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
  assert.ok(!r.texto.includes(contrato.segredo), "the secret never goes in the response");

  // Different challenge, different proof: there is no reusable fixed answer.
  const outro = await ajuda.pedir(s.porta, `/api/identidade?desafio=${encodeURIComponent(crypto.randomBytes(32).toString("base64url"))}`);
  assert.notEqual(outro.json.prova, r.json.prova);
});

test("a malformed challenge is refused", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  require(path.join(ajuda.RAIZ, "src", "identidade.js")).publicarContrato({ porta: s.porta, modo: "teste" });

  for (const desafio of ["", "curto", "x".repeat(500), "com espaço", "../../etc"]) {
    const r = await ajuda.pedir(s.porta, `/api/identidade?desafio=${encodeURIComponent(desafio)}`);
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(desafio.slice(0, 12))}`);
  }
});

test("the launcher refuses to open the browser on an impostor that took the port", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  // Impostor: answers /api/identidade with an arbitrary proof, as a fake page would.
  const impostor = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ prova: "prova-inventada-pelo-impostor", versao: "9.9.9" }));
  });
  await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
  const porta = impostor.address().port;
  t.after(() => new Promise((r) => impostor.close(() => r())));

  // Legitimate contract, with a secret the impostor does not know.
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
  assert.equal(garantia.impostor, true, "the launcher must not start another backend or open the browser");
});

test("the launcher opens the real Console after verifying identity", async (t) => {
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
  assert.equal(r.jaEstava, true, "does not start a second backend when a valid one exists");
  assert.equal(launcher.urlDoConsole(r.contrato), `http://127.0.0.1:${s.porta}/`);
});

test("the launcher opens only validated HTTP(S) addresses", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  for (const ruim of ["file:///etc/passwd", "javascript:alert(1)", "não-é-url", "data:text/html,<script>"]) {
    const r = await launcher.abrir(ruim);
    assert.equal(r.ok, false, `should refuse ${ruim}`);
  }
});

test("the application URL comes from the real configuration, not a fixed port", (t) => {
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

  assert.equal(launcher.urlDaAplicacao(), "https://remoteifes.ifes.edu.br", "behind a proxy, the address is the domain");

  fs.writeFileSync(path.join(checkout, "remoteifes-server", ".env"), "PORTA=9090\n");
  const amb2 = ajuda.ambiente({ checkout });
  const launcher2 = require(path.join(ajuda.RAIZ, "launcher.js"));
  assert.equal(launcher2.urlDaAplicacao(), "http://127.0.0.1:9090/", "without a domain, uses the configured port, not a fixed 8080");
  amb2.restaurar();
});

test("the launcher status separates Console, application and program version", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const launcher = require(path.join(ajuda.RAIZ, "launcher.js"));

  const s = await launcher.coletarStatus();
  assert.ok("console" in s && "aplicacao" in s && "atualizacaoDoConsole" in s);
  assert.equal(s.console.noAr, false);
  assert.ok(s.aplicacao.url.startsWith("http"));
  assert.ok(s.plataforma);
});

// --- Idle exit -------------------------------------------------------------------

test("idle exit is disarmed when nothing can restart the Console", async (t) => {
  const amb = ajuda.ambiente({ ociosidadeS: 1 });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  // Without the systemd socket and without the launcher, exiting would leave the operator without a
  // Console.
  const semReativacao = amb.servidor.armarSaidaPorOciosidade(s.servidor, () => {}, { reativavel: false });
  assert.equal(semReativacao, null, "does not arm when nothing can reactivate");

  const comReativacao = amb.servidor.armarSaidaPorOciosidade(s.servidor, () => {}, { reativavel: true });
  assert.ok(comReativacao, "arms when the launcher or the socket can restart it");
  clearInterval(comReativacao);
});

// --- sc.exe on localized Windows -------------------------------------------------------------

// Real `sc.exe` output, en-US and pt-BR. `sc.exe` translates LABELS; what does not change is the
// field order and the numeric code at the start of the value.
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

test("the service state is read by code, not by the English label", (t) => {
  // On Portuguese Windows `sc.exe` prints ESTADO instead of STATE. Looking up the English name
  // would report a running service as stopped, and start/stop would wait out the deadline and fail.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_EN), 4, "en-US: running");
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT), 4, "pt-BR: running");
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT_PARADO), 1, "pt-BR: parado");

  // The type (10) must never be confused with a state.
  assert.notEqual(windows.codigoDeEstadoSc(SC_QUERY_PT), 10);
});

test("the start type is read by code and does not require the AUTO_START label", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  assert.equal(windows.inicioAutomaticoSc(SC_QC_PT).automatico, true, "2 = automatic, in any language");
  assert.equal(windows.inicioAutomaticoSc(SC_QC_PT_MANUAL).automatico, false, "3 = manual");
  assert.match(windows.inicioAutomaticoSc(SC_QC_PT).rotulo || "", /AUTO_START/);
});

test("transition states are distinguished from stopped and running", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const windows = require(path.join(ajuda.RAIZ, "src", "plataforma", "windows.js"));

  // 2 = START_PENDING, 3 = STOP_PENDING. Treating them as 1 or 4 would end the transition wait
  // early and report success over a service still changing state.
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT.replace("4  RUNNING", "2  START_PENDING")), 2);
  assert.equal(windows.codigoDeEstadoSc(SC_QUERY_PT.replace("4  RUNNING", "3  STOP_PENDING")), 3);
});

test("with the port already reserved, the launcher connects instead of competing for the address", async (t) => {
  // Normal Linux state with socket activation after an idle exit: the contract was removed, but
  // systemd still owns the port. Starting a TCP backend there gets EADDRINUSE. One connection is
  // enough to activate the service; then the new contract appears.
  const amb = ajuda.ambiente();
  const crypto = require("crypto");

  // Plays the systemd socket: holds the port and, on the first connection, publishes the contract
  // as the Console would on startup.
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

  // The launcher must see this port as its own.
  const amb2 = ajuda.ambiente({ estadoDir: amb.estadoDir, porta });
  t.after(() => amb2.restaurar());
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));

  // No contract at the start: the state after an idle exit.
  const arquivoContrato = require(path.join(ajuda.RAIZ, "src", "config")).ARQUIVO_ENDERECO;
  try {
    require("fs").rmSync(arquivoContrato, { force: true });
  } catch {}

  const r = await lancador.garantirBackend();
  assert.equal(r.ok, true, `the launcher must compose with the socket, not compete for the port: ${r.motivo}`);
  assert.ok(conexoes >= 1, "there must have been a connection to activate the service");
  assert.equal(r.contrato.porta, porta);
});

test("a port held by an impostor is not accepted just because it answered", async (t) => {
  // Connecting activates the service but does not prove identity: if whoever answers does not know
  // the secret, the launcher must refuse instead of treating the occupied port as a running
  // Console.
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
  assert.equal(r.ok, false, "without a published identity, the occupied port does not become success");
  assert.match(r.motivo, /não publicou identidade|ocupada/);
});
