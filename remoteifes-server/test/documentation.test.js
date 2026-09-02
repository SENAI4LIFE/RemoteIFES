const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const service = require("../src/services/documentationService");
const commands = require("../src/services/documentation/commands");
const README = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");
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

test("documentação herda conteúdo sem entregar tópicos superiores a papéis inferiores", () => {
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

test("catálogo privilegiado tem IDs estáveis, categorias e referências válidas", () => {
  assert.equal(service.validar(), true);
  const todas = [...service._adminSections, ...service._superSections];
  assert.equal(new Set(todas.map((s) => s.id)).size, todas.length);
  todas.forEach((secao) => {
    assert.match(secao.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(secao.categoria);
    assert.ok(secao.corpo.length > 0);
  });
});

test("catálogo público cobre as funções comuns e não contém links quebrados", () => {
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

test("comandos críticos duplicados continuam iguais ao README", () => {
  const grupos = [
    "instalacao", "backup", "deploy", "firmwareOta", "credenciais",
    "recuperacaoConta", "carga", "androidVersao", "androidRede", "androidPublicacao", "testes", "git",
  ];
  for (const grupo of grupos) {
    for (const comando of commands[grupo]) {
      assert.ok(README.includes(comando), `${grupo}: comando ausente ou divergente no README: ${comando}`);
    }
  }
});

test("o manual não descreve mais o AP como temporário nem a estimativa de energia", () => {
  const manual = carregarManualPublico();
  const tudo = JSON.stringify([...manual.secoes, ...service._adminSections, ...service._superSections]);
  for (const obsoleto of [/rede aberta/i, /ponto de acesso aberto/i, /AP de recuperação/i, /portal de recuperação/i, /energia estimada/i, /kWh/i, /BTU/i]) {
    assert.ok(!obsoleto.test(tudo), `texto obsoleto ainda presente no manual: ${obsoleto}`);
  }
  for (const obsoleto of [/## Energia Estimada/, /energia_resumos_diarios/, /rede aberta `RemoteIFES-Setup`/, /ponto de acesso aberto `RemoteIFES-Setup`/]) {
    assert.ok(!obsoleto.test(README), `texto obsoleto ainda presente no README: ${obsoleto}`);
  }
  assert.ok(/permanentemente no ar/.test(README), "o README precisa dizer que o RemoteIFES-Setup fica ativo na operação normal");
  assert.ok(/Exigir senha na rede de configuração dos ESP32/.test(README), "o README precisa documentar a nova opção global");
  const superadmin = JSON.stringify(service._superSections);
  assert.ok(/RemoteIFES-Setup/.test(superadmin) && /Exigir senha na rede de configuração dos ESP32/.test(superadmin));
  assert.ok(/credencial do dispositivo no servidor/.test(superadmin), "a autenticação no servidor continua documentada à parte");
});

test("procedimentos de host aparecem só no conjunto Superadministrador", () => {
  const serializar = (secoes) => JSON.stringify(secoes);
  const admin = serializar(service._adminSections);
  const superadmin = serializar(service._superSections);
  for (const trecho of ["deploy.sh", "npm run restore", "python3 clear.py", "REMOTEIFES_ANDROID_KEYSTORE"]) {
    assert.ok(!admin.includes(trecho), `admin recebeu procedimento restrito: ${trecho}`);
    assert.ok(superadmin.includes(trecho), `Superadministrador não recebeu: ${trecho}`);
  }
});
