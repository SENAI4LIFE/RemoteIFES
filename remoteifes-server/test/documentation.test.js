const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const service = require("../src/services/documentationService");
const commands = require("../src/services/documentation/commands");
const README = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
const WEB = path.join(__dirname, "..", "..", "remoteifes-web");

function carregarManualPublico() {
  const contexto = vm.createContext({});
  for (const arquivo of [
    "js/manual-content.js",
    "js/manual/common-start.js",
    "js/manual/common-rooms.js",
    "js/manual/common-account.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, arquivo), "utf8"), contexto, { filename: arquivo });
  }
  return vm.runInContext("ManualContent", contexto);
}

test("documentation inherits content without delivering higher topics to lower roles", () => {
  const usuario = service.para({ usuario: "u", isAdmin: false, nivel: 1 });
  const admin = service.para({ usuario: "a", isAdmin: true, nivel: 2 });
  const superadmin = service.para({ usuario: "s", isAdmin: true, nivel: 3 });

  assert.deepEqual(usuario, { secoes: [], ajuda: {} });
  assert.ok(admin.secoes.length > 0);
  assert.ok(admin.secoes.every((secao) => secao.papel === "admin"));
  assert.ok(superadmin.secoes.length > admin.secoes.length);
  assert.deepEqual(
    superadmin.secoes.slice(0, admin.secoes.length).map((s) => s.id),
    admin.secoes.map((s) => s.id)
  );
  assert.ok(superadmin.secoes.some((secao) => secao.id === "operacao-admin"));
  assert.ok(!admin.secoes.some((secao) => secao.id === "operacao-admin"));
});

test("the privileged catalog has stable IDs, categories and valid references", () => {
  assert.equal(service.validar(), true);
  const todas = [...service._adminSections, ...service._superSections];
  assert.equal(new Set(todas.map((s) => s.id)).size, todas.length);
  todas.forEach((secao) => {
    assert.match(secao.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(secao.categoria);
    assert.ok(secao.corpo.length > 0);
  });
});

test("the public catalog covers the common functions and contains no broken links", () => {
  const manual = carregarManualPublico();
  const ids = new Set(manual.secoes.map((s) => s.id));
  for (const id of [
    "inicio", "navegacao", "inicio-acoes", "papeis", "selecao-sala", "estados-sala",
    "controlador", "controle-acesso-sala", "conta-sessao", "conexao", "relatos",
    "pwa-mobile", "acessibilidade", "solucao-problemas",
  ]) assert.ok(ids.has(id), `tópico público ausente: ${id}`);
  assert.equal(ids.size, manual.secoes.length);
  manual.secoes.forEach((secao) => {
    assert.ok(manual.categorias[secao.categoria], `categoria ausente em ${secao.id}`);
    for (const bloco of secao.corpo) {
      if (bloco.t === "links") {
        bloco.itens.forEach((link) => assert.ok(ids.has(link.id), `link quebrado em ${secao.id}: ${link.id}`));
      }
    }
  });
});

// The README is the single owner of terminal commands: installation, the procedures the Console
// deliberately does not run and the emergency recovery reference. The privileged manual does not
// repeat those tutorials; it points to the Console path.
test("critical commands keep a single canonical form in the README", () => {
  const grupos = [
    "instalacao", "iniciar", "backupCriar", "backupRestaurar", "deployAtualizar", "deployReverter", "release", "firmwareOta",
    "credenciaisConsultar", "credenciaisEmitir", "credenciaisDerrubar", "recuperacaoConta", "carga",
    "androidVersao", "androidRede", "androidPublicacao", "testes", "gitSincronizar", "gitRecriar",
    "consoleInstalar", "consoleAcesso", "consoleReparo",
  ];
  for (const grupo of grupos) {
    for (const comando of commands[grupo]) {
      assert.ok(README.includes(comando), `${grupo}: comando ausente ou divergente no README: ${comando}`);
    }
  }
});

test("the manual describes the AP only as a provisioning portal, without a permanent AP or energy estimate", () => {
  const manual = carregarManualPublico();
  const tudo = JSON.stringify([...manual.secoes, ...service._adminSections, ...service._superSections]);
  for (const obsoleto of [/rede aberta/i, /ponto de acesso aberto/i, /AP de recuperação/i, /portal de recuperação/i, /AP permanente/i, /fica no ar o tempo todo/i, /energia estimada/i, /kWh/i, /BTU/i]) {
    assert.ok(!obsoleto.test(tudo), `texto obsoleto ainda presente no manual: ${obsoleto}`);
  }
  for (const obsoleto of [/## Energia Estimada/, /energia_resumos_diarios/, /rede aberta `RemoteIFES-Setup`/, /ponto de acesso aberto `RemoteIFES-Setup`/, /permanentemente no ar/, /permanentemente ativa/, /acessar interface do ESP32" continua/, /status\.html/]) {
    assert.ok(!obsoleto.test(README), `texto obsoleto ainda presente no README: ${obsoleto}`);
  }
  assert.ok(/criada apenas no modo AP de provisionamento/.test(README), "o README precisa dizer que o RemoteIFES-Setup só existe durante o provisionamento");
  assert.ok(/encerra o AP e não serve frontend local durante a operação normal/.test(README), "o README precisa deixar claro que o frontend local é desligado após o setup");
  assert.ok(/clique curto no switch físico/.test(README), "o README precisa documentar o clique no switch para reabrir o portal");
  assert.ok(/Exigir senha na rede de configuração dos ESP32/.test(README), "o README precisa documentar a opção global");
  const superadmin = JSON.stringify(service._superSections);
  assert.ok(/RemoteIFES-Setup/.test(superadmin) && /Exigir senha na rede de configuração dos ESP32/.test(superadmin));
  assert.ok(/credencial do dispositivo no servidor/.test(superadmin), "a autenticação no servidor continua documentada à parte");
});

test("manual and README document IR Protocols, the board-bound cloner, the physical switch and Auto-ON", () => {
  const manual = carregarManualPublico();
  const publico = JSON.stringify(manual.secoes);
  const superadmin = JSON.stringify(service._superSections);
  const admin = JSON.stringify(service._adminSections);

  assert.ok(service._superSections.some((secao) => secao.id === "protocolos-ir" && secao.verNoApp === "/admin/protocolos"));
  assert.ok(!admin.includes("\"id\":\"protocolos-ir\""), "a seção de Protocolos IR é exclusiva do Superadministrador");
  for (const trecho of ["Administração &gt; Dispositivos &gt; Protocolos IR", "clonador", "failsafe OFF", "GPIO 26", "GPIO 27", "5 s", "40 ms", "pull-up interno"]) {
    assert.ok(superadmin.toLowerCase().includes(trecho.toLowerCase()), `manual do Superadministrador sem: ${trecho}`);
  }
  assert.match(superadmin, /MAC e a credencial/);
  assert.match(superadmin, /Auto-ON/);
  assert.match(publico, /Auto-ON/);
  for (const antigo of ["Com o aparelho ligado, use <strong>Turbo</strong>", "<strong>Turbo</strong>: só pode ser alterado com o aparelho ligado."]) {
    assert.ok(!publico.includes(antigo), `o manual público ainda descreve o Turbo sem Auto-ON: ${antigo}`);
  }

  for (const trecho of [
    "Administração > Dispositivos > Protocolos IR",
    "### Administração > Dispositivos > Protocolos IR",
    "### Switch físico e buzzer",
    "| Auto-ON | **ativado** |",
    "`protocolos_ir`",
    "GPIO 26",
    "GPIO 27",
    "`failsafe_raw_set`",
    "`failsafe_raw_clear`",
    "um clonador oficial ativo por vez",
    "ir-protocols.spec.js",
    "auto-on.spec.js",
    "firmware-contract.test.js",
  ]) {
    assert.ok(README.includes(trecho), `README sem: ${trecho}`);
  }
  const platformio = fs.readFileSync(path.join(__dirname, "..", "..", "remoteifes-esp32", "platformio.ini"), "utf8");
  const versaoFirmware = platformio.match(/-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/)[1];
  assert.ok(README.includes(`atualmente \`${versaoFirmware}\``), `README precisa citar a versão do firmware compilada (${versaoFirmware})`);
});

test("restricted procedures stay out of the Administrator set", () => {
  const admin = JSON.stringify(service._adminSections);
  for (const trecho of ["deploy.sh", "npm run restore", "python3 clear.py", "REMOTEIFES_ANDROID_KEYSTORE", "instalacao/instalar.js", "console-helper.sh"]) {
    assert.ok(!admin.includes(trecho), `admin recebeu procedimento restrito: ${trecho}`);
  }
  const superadmin = JSON.stringify(service._superSections);
  for (const trecho of ["python3 clear.py", "REMOTEIFES_ANDROID_KEYSTORE"]) {
    assert.ok(superadmin.includes(trecho), `Superadministrador não recebeu: ${trecho}`);
  }
});

test("routine host procedures point to the Console instead of repeating the tutorial", () => {
  const infra = service._superSections.filter((secao) => secao.categoria === "super_infra");
  const porId = Object.fromEntries(infra.map((secao) => [secao.id, JSON.stringify(secao)]));

  // Service, backup/restore, deploy/rollback and account recovery moved to the Console: the manual
  // states where they live and their impact, and does not repeat the command line.
  for (const id of ["servico-systemd", "backup-restauracao", "implantacao-rollback", "recuperacao-superadmin"]) {
    assert.ok(porId[id], `seção ausente: ${id}`);
    assert.match(porId[id], /Console de Opera/, `${id} precisa apontar para o console`);
  }
  for (const id of ["servico-systemd", "backup-restauracao", "implantacao-rollback"]) {
    assert.ok(!/systemctl restart remoteifes\.service/.test(porId[id]), `${id} ainda repete o comando de serviço`);
    assert.ok(!/bash deploy\.sh/.test(porId[id]), `${id} ainda repete o comando de deploy`);
    assert.ok(!/npm run backup/.test(porId[id]), `${id} ainda repete o comando de backup`);
  }

  // What still runs from a terminal remains documented with commands.
  assert.match(porId["servidor-rede"], /lan-setup\.sh/);
  assert.match(porId["release-servidor"], /release\.sh/);
  assert.match(porId["instalacao-servidor"], /install-service\.sh/);
});

test("the Console has its own section with access, boundary and repair", () => {
  const console = service._superSections.find((secao) => secao.id === "console-operacoes");
  assert.ok(console, "a seção do console precisa existir no conjunto Superadministrador");
  assert.equal(console.papel, "superadmin");
  const texto = JSON.stringify(console);

  assert.match(texto, /instalacao\/instalar\.js/, "precisa dizer como instalar");
  assert.match(texto, /ssh -L 8099/, "precisa explicar o túnel SSH");
  assert.match(texto, /não é o do Pi/, "precisa avisar que o localhost do operador não é o do Pi");
  assert.match(texto, /fora do checkout/, "precisa explicar por que roda fora do checkout");
  assert.match(texto, /Terminal Expert/, "precisa citar o terminal como capacidade à parte");

  // The Console must not be presented as the owner of building operation.
  const admin = JSON.stringify(service._adminSections);
  assert.ok(!/Console de Opera\S* &gt; .*Salas/.test(texto), "o console não opera salas");
  assert.ok(!admin.includes("Console de Opera"), "o manual de Administrador não precisa do console");
});

test("the README keeps a single emergency recovery reference", () => {
  assert.match(README, /^## Recuperação de emergência por terminal$/m, "a seção precisa existir");
  assert.match(README, /^## Console de Operações$/m, "o README documenta o acesso ao console");

  // A single section holds the emergency commands: look for competing headings.
  const cabecalhos = [...README.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]);
  const emergencias = cabecalhos.filter((t) => /recupera(ção|cao) de emerg/i.test(t));
  assert.equal(emergencias.length, 1, `esperava uma seção de emergência, achei: ${emergencias.join(" | ")}`);

  const inicio = README.indexOf("## Recuperação de emergência por terminal");
  const fimSecao = README.indexOf("## Hospedagem em Raspberry Pi", inicio);
  const secao = README.slice(inicio, fimSecao);
  for (const comando of [
    "sudo systemctl restart remoteifes.service",
    "npm run health",
    "npm run backup",
    "npm run restore",
    "bash deploy.sh",
    "bash rollback.sh",
    "npm run reset-admin",
    "instalacao/instalar.js",
  ]) {
    assert.ok(secao.includes(comando), `a recuperação de emergência precisa conter: ${comando}`);
  }
  assert.match(secao, /sem console e sem login/, "precisa dizer que funciona sem console e sem aplicação");
});

test("manual and README describe the current grouped Administration", () => {
  const manual = carregarManualPublico();
  const documentacao = JSON.stringify([...manual.secoes, ...service._adminSections, ...service._superSections]);

  for (const caminho of [
    "Administração &gt; Dispositivos &gt; Cadastro",
    "Administração &gt; Dispositivos &gt; Firmware / OTA",
    "Administração &gt; Dispositivos &gt; Alertas",
    "Administração &gt; Gestão &gt; Usuários",
    "Administração &gt; Gestão &gt; Usuários &gt; Proprietários de sala",
    "Administração &gt; Sistema &gt; Logs",
    "Administração &gt; Sistema &gt; Logs &gt; Sessões",
    "Administração &gt; Sistema &gt; Logs &gt; Dispositivos",
    "Administração &gt; Sistema &gt; Logs &gt; Auditoria",
    "Administração &gt; Sistema &gt; Status",
    "Administração &gt; Sistema &gt; Status &gt; Usuários ativos",
    "Administração &gt; Sistema &gt; Status &gt; Mapa",
    "Administração &gt; Sistema &gt; Status &gt; Sistema",
    "Administração &gt; Sistema &gt; Configurações",
  ]) {
    assert.ok(documentacao.includes(caminho), `caminho ausente no manual: ${caminho}`);
  }

  for (const obsoleto of [
    /Administração &gt; ESP32/,
    /Administração &gt; Notificações de dispositivos/,
    /Administração &gt; Auditoria</,
    /Administração &gt; Monitoramento/,
    /Administração &gt; Configurações</,
    /Administração &gt; Relatos de problemas</,
    /Administração &gt; Sistema &gt; Sessões/,
    /Administração &gt; Sistema &gt; Auditoria/,
    /Administração &gt; Sistema &gt; Acessos ESP32/,
    /Administração &gt; Gestão &gt; Sessões/,
    /Administração &gt; Gestão &gt; Ativos/,
    /Administração &gt; Gestão &gt; Mapa/,
    /Administração &gt; Gestão &gt; Proprietários de sala/,
    /Administração &gt; Dispositivos &gt; Histórico/,
    /Administração &gt; Dispositivos &gt; Notificações/,
    /Saúde do sistema/,
    /Admin &gt; ESP32/,
  ]) {
    assert.ok(!obsoleto.test(documentacao), `navegação obsoleta ainda no manual: ${obsoleto}`);
  }

  for (const caminho of [
    "Administração > Dispositivos > Cadastro",
    "Administração > Dispositivos > Firmware / OTA",
    "Administração > Dispositivos > Alertas",
    "Administração > Gestão > Usuários > Proprietários de sala",
    "Administração > Sistema > Logs > Comandos",
    "Administração > Sistema > Logs > Acessos",
    "Administração > Sistema > Logs > Dispositivos",
    "Administração > Sistema > Logs > Sessões",
    "Administração > Sistema > Logs > Auditoria",
    "Administração > Sistema > Status > Usuários ativos",
    "Administração > Sistema > Status > Sistema",
    "Administração > Sistema > Configurações",
  ]) {
    assert.ok(README.includes(caminho), `caminho ausente no README: ${caminho}`);
  }

  for (const obsoleto of [
    /`Admin > /,
    /Admin > ESP32/,
    /ESP32 \/ MACs/,
    /Notificações de dispositivos`/,
    /Administração > Monitoramento >/,
    /Administração > Sistema > Sessões/,
    /Administração > Sistema > Auditoria`/,
    /Administração > Sistema > Acessos ESP32/,
    /Administração > Gestão > Sessões/,
    /Administração > Gestão > Ativos/,
    /Administração > Gestão > Mapa/,
    /Administração > Gestão > Proprietários de sala/,
    /Administração > Dispositivos > Histórico/,
    /Administração > Dispositivos > Notificações/,
    /Saúde do sistema/,
    /\*\*Monitoramento\*\* \| /,
  ]) {
    assert.ok(!obsoleto.test(README), `navegação obsoleta ainda no README: ${obsoleto}`);
  }

  for (const grupo of ["Gestão", "Dispositivos", "Sistema"]) {
    assert.ok(documentacao.includes(grupo), `grupo ausente no manual: ${grupo}`);
    assert.ok(README.includes(`**${grupo}**`), `grupo ausente na tabela do README: ${grupo}`);
  }
});

test("the documentation presents Logs and Status as inner tabs, without standalone functions", () => {
  const manual = carregarManualPublico();
  const documentacao = JSON.stringify([...manual.secoes, ...service._adminSections, ...service._superSections]);

  assert.match(documentacao, /Sistema &gt; Logs/);
  assert.match(documentacao, /Sistema &gt; Status/);
  assert.match(documentacao, /aba <strong>Acessos<\/strong>/);
  assert.match(documentacao, /aba <strong>Dispositivos<\/strong>/);
  assert.ok(!/Acessos ESP32/.test(documentacao), "Acessos ESP32 não pode mais aparecer como função da Administração");

  const secaoLogs = service._adminSections.find((secao) => secao.id === "logs-dispositivos");
  const abasLogs = secaoLogs.corpo.find((bloco) => bloco.t === "tabela").linhas.map(([aba]) => aba);
  assert.deepEqual(abasLogs, ["Comandos", "Acessos", "Dispositivos", "Sessões", "Auditoria (Superadministrador)"]);

  const visaoGeral = service._adminSections.find((secao) => secao.id === "administracao");
  const tabelaAbas = visaoGeral.corpo.filter((bloco) => bloco.t === "tabela")[1].linhas;
  assert.deepEqual(tabelaAbas, [
    ["Gestão > Usuários", "Contas · Proprietários de sala"],
    ["Sistema > Logs", "Comandos · Acessos · Dispositivos · Sessões · Auditoria"],
    ["Sistema > Status", "Usuários ativos · Mapa · Sistema"],
  ]);

  assert.match(README, /Logs > Acessos/);
  assert.match(README, /#\/admin\/logs\/sessoes/);
  assert.match(README, /#\/admin\/usuarios\/proprietarios/);
  assert.match(README, /#\/admin\/acessos/);
});

test("the manual explains immediate ESP32 registration and the difference between registered and online", () => {
  const cadastro = service._superSections.find((secao) => secao.id === "esp32-cadastro");
  const texto = JSON.stringify(cadastro);
  assert.match(texto, /sem recarregar a página/);
  assert.match(texto, /segunda sessão autorizada/);
  assert.match(texto, /Cadastrado<\/strong> e <strong>conectado\/online/);
  assert.match(texto, /costuma aparecer offline/);
  assert.match(README, /sem recarregar a página nem reabrir a aba/);
});
