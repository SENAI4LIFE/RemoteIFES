const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

function executar(corpo) {
  const script = `
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const assert = require("node:assert/strict");
    const { EventEmitter } = require("node:events");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-audit-"));
    process.env.REMOTEIFES_FIRMWARE_DIR = dir;
    process.env.REMOTEIFES_DB_PATH = ":memory:";
    process.env.NODE_ENV = "test";
    const eventos = new EventEmitter();
    const salas = new Map();
    const online = new Set();
    const versoes = new Map();
    const ofertas = [];
    function stub(nome, exports) {
      const id = require.resolve("../src/services/" + nome);
      require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    stub("salasService", { buscar: (s) => salas.get(s) });
    stub("esp32CredenciaisService", { estado: () => ({ provisionado: false }) });
    stub("notificacoesService", { criar() {} });
    stub("monitoramentoService", { registrar() {} });
    stub("deviceHub", {
      eventos,
      estadoPublico: (s) => ({ conectado: online.has(s), fwVersao: versoes.get(s), modo: "operation" }),
      dispositivoConectado: (s) => online.has(s),
      enviarComando: (s, m) => { ofertas.push({ sala: s, ...m }); return true; },
    });
    function sala(s) {
      salas.set(s, { sala: s, mac: "AA:BB:CC:00:00:" + String(salas.size + 1).padStart(2, "0") });
      online.add(s);
      versoes.set(s, "4.0.0");
    }
    let ota = require("../src/services/otaService");
    let rollout = require("../src/services/otaRolloutService");
    const bin = path.join(dir, "fake.bin");
    const bytes = Buffer.alloc(65536); bytes[0] = 0xe9; fs.writeFileSync(bin, bytes);
    ota.publicarFirmware({ origem: bin, versao: "4.1.0" });
    function validar(s) {
      ota.registrarResultado(s, { resultado: "ok" });
      versoes.set(s, "4.1.0");
      ota.aoReconectarDispositivo(s, "4.1.0");
    }
    function reiniciar() {
      eventos.removeAllListeners();
      for (const nome of ["otaService", "otaRolloutService"]) delete require.cache[require.resolve("../src/services/" + nome)];
      ota = require("../src/services/otaService");
      rollout = require("../src/services/otaRolloutService");
    }
    try { ${corpo} } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  `;
  const resultado = spawnSync(process.execPath, ["-e", script], { cwd: __dirname, encoding: "utf8", timeout: 10000 });
  assert.equal(resultado.status, 0, resultado.stderr || resultado.stdout);
}

test("falha no lote não preenche a vaga liberada e drena somente os já ofertados", () => executar(`
  ["a", "b", "c", "d", "fora"].forEach(sala);
  rollout.iniciar({ salas: ["a", "b", "c", "d"], tamanhoLote: 3 });
  validar("a");
  assert.deepEqual(ofertas.map(o => o.sala), ["a", "b", "c"]);
  ota.registrarResultado("b", { resultado: "erro", erro: "hash" });
  assert.deepEqual(ofertas.map(o => o.sala), ["a", "b", "c"]);
  validar("c");
  assert.equal(rollout.atual().estado, "interrompido");
  assert.equal(rollout.atual().dispositivos.find(d => d.sala === "d").estado, "pendente");
`));

test("OTA avulsa respeita seleção reservada e compartilha o limite global", () => executar(`
  ["a", "b", "fora", "extra"].forEach(sala);
  rollout.iniciar({ salas: ["a", "b"] });
  assert.throws(() => ota.ofertar("b"), /reservado/);
  ota.ofertar("fora");
  assert.throws(() => ota.ofertar("extra"), /limite/);
  validar("a");
  assert.equal(ota.vagasDisponiveis(), 0);
  validar("b");
  assert.equal(rollout.atual().estado, "concluido");
`));

for (const fase of ["ofertado", "baixando", "gravado", "reiniciando", "concluido", "falhou"]) {
  test("reinício preserva tentativa em " + fase + " sem segunda oferta", () => executar(`
    sala("a");
    rollout.iniciar({ salas: ["a"] });
    if (${JSON.stringify(fase)} === "baixando") ota.registrarProgresso("a", { recebido: 100 });
    if (["gravado", "reiniciando", "concluido"].includes(${JSON.stringify(fase)})) ota.registrarResultado("a", { resultado: "ok" });
    if (${JSON.stringify(fase)} === "reiniciando") ota.aoDesconectarDispositivo("a");
    if (${JSON.stringify(fase)} === "concluido") validar("a");
    if (${JSON.stringify(fase)} === "falhou") ota.registrarResultado("a", { resultado: "erro" });
    reiniciar(); rollout.tick();
    assert.equal(ofertas.length, 1);
    assert.equal(ota.estadoDaSala("a").fase, ${JSON.stringify(fase)});
  `));
}

for (const registro of ["ausente", "anterior"]) {
  test("intenção persistida sem oferta confirmada e registro " + registro + " nunca é repetida", () => executar(`
    sala("a"); rollout.iniciar({ salas: ["a"] });
    const r = rollout.atual(); r.dispositivos[0].ofertadoEm = null;
    fs.writeFileSync(rollout.ARQUIVO_ROLLOUT, JSON.stringify(r));
    if (${JSON.stringify(registro)} === "ausente") fs.writeFileSync(ota.ARQUIVO_ESTADOS, "{}");
    else {
      const e = ota.estadoDaSala("a"); e.tentativa = "tentativa-anterior"; e.fase = "concluido";
      fs.writeFileSync(ota.ARQUIVO_ESTADOS, JSON.stringify({ a: e }));
    }
    reiniciar(); rollout.tick();
    assert.equal(ofertas.length, 1);
    assert.equal(rollout.atual().dispositivos[0].estado, "indeterminado");
    assert.equal(rollout.atual().estado, "interrompido");
  `));
}

for (const alvo of ["rollout-ota.json.tmp", "estados-ota.json.tmp"]) {
  test("falha de persistência em " + alvo + " impede oferta", () => executar(`
    sala("a");
    const escrever = fs.writeFileSync;
    fs.writeFileSync = function(p, ...args) {
      if (String(p).endsWith(${JSON.stringify(alvo)})) throw new Error("falha de disco simulada");
      return escrever.call(this, p, ...args);
    };
    try { rollout.iniciar({ salas: ["a"] }); } catch (e) { assert.match(e.message, /persistir/); }
    assert.equal(ofertas.length, 0);
    fs.writeFileSync = escrever;
    reiniciar(); rollout.tick();
    assert.equal(ofertas.length, 0);
  `));
}

for (const mudanca of ["removido", "substituido"]) {
  test("dispositivo pendente " + mudanca + " não recebe oferta", () => executar(`
    ["a", "b"].forEach(sala);
    rollout.iniciar({ salas: ["a", "b"] }); rollout.pausar(); validar("a");
    if (${JSON.stringify(mudanca)} === "removido") salas.delete("b");
    else salas.get("b").mac = "AA:BB:CC:99:99:99";
    rollout.retomar();
    assert.deepEqual(ofertas.map(o => o.sala), ["a"]);
    assert.equal(rollout.atual().dispositivos[1].estado, "ignorado");
  `));
}

test("registro apagado em voo termina indeterminado sem travar cancelamento", () => executar(`
  sala("a"); rollout.iniciar({ salas: ["a"] }); rollout.cancelar();
  ota.limparEstado("a"); rollout.tick();
  assert.equal(rollout.atual().estado, "cancelado");
  assert.equal(rollout.atual().dispositivos[0].estado, "indeterminado");
`));

for (const versao of ["4.0.0", "3.0.0", null]) {
  test("versão inesperada " + versao + " não comprova rollback", () => executar(`
    sala("a"); rollout.iniciar({ salas: ["a"] });
    ota.registrarResultado("a", { resultado: "ok" }); ota.aoDesconectarDispositivo("a");
    ota.aoReconectarDispositivo("a", ${JSON.stringify(versao)});
    assert.equal(ota.estadoDaSala("a").causa, "indeterminado");
    assert.equal(rollout.atual().dispositivos[0].estado, "indeterminado");
  `));
}

test("pausa e cancelamento sobrevivem ao reinício sem novas ofertas", () => executar(`
  ["a", "b"].forEach(sala); rollout.iniciar({ salas: ["a", "b"] });
  rollout.pausar(); validar("a"); reiniciar(); rollout.tick();
  assert.equal(rollout.atual().estado, "pausado");
  rollout.cancelar(); reiniciar(); rollout.tick();
  assert.equal(rollout.atual().estado, "cancelado");
  assert.deepEqual(ofertas.map(o => o.sala), ["a"]);
`));

test("dispositivo offline expira sem oferta e início concorrente não substitui seleção", () => executar(`
  ["a", "b"].forEach(sala); online.delete("b");
  rollout.iniciar({ salas: ["a", "b"] });
  assert.throws(() => rollout.iniciar({ salas: ["a"] }), /andamento/);
  validar("a");
  const agora = Date.now; Date.now = () => agora() + rollout.GRACA_ESPERA_MS + 1;
  rollout.tick(); Date.now = agora;
  assert.equal(rollout.atual().dispositivos[1].estado, "ignorado");
  assert.deepEqual(ofertas.map(o => o.sala), ["a"]);
`));

for (const acao of ["pausar", "retomar", "cancelar"]) {
  test("controle " + acao + " não confirma sucesso se o disco falhar", () => executar(`
    ["a", "b"].forEach(sala); rollout.iniciar({ salas: ["a", "b"] });
    if (${JSON.stringify(acao)} === "retomar") rollout.pausar();
    const antes = rollout.atual();
    const escrever = fs.writeFileSync;
    fs.writeFileSync = function(p, ...args) {
      if (String(p).endsWith("rollout-ota.json.tmp")) throw new Error("disco indisponível");
      return escrever.call(this, p, ...args);
    };
    assert.throws(() => rollout[${JSON.stringify(acao)}](), /persistir/);
    fs.writeFileSync = escrever;
    assert.deepEqual(rollout.atual(), antes);
    assert.equal(ofertas.length, 1);
  `));
}

test("troca de firmware drena o lote em voo sem iniciar os pendentes", () => executar(`
  ["a", "b", "c", "d"].forEach(sala);
  rollout.iniciar({ salas: ["a", "b", "c", "d"], tamanhoLote: 3 }); validar("a");
  ota.publicarFirmware({ origem: bin, versao: "4.2.0" }); rollout.tick();
  assert.equal(rollout.ativo(), true);
  validar("b"); validar("c");
  assert.equal(rollout.atual().estado, "interrompido");
  assert.deepEqual(ofertas.map(o => o.sala), ["a", "b", "c"]);
  assert.equal(rollout.atual().dispositivos[2].estado, "validado");
`));

test("estado persistido incompleto não entra no agendador", () => executar(`
  fs.writeFileSync(rollout.ARQUIVO_ROLLOUT, JSON.stringify({ id: "incompleto", estado: "lotes", dispositivos: [{ sala: "a", estado: "pendente" }] }));
  reiniciar();
  assert.equal(rollout.atual(), null);
  rollout.tick(); assert.equal(ofertas.length, 0);
`));

test("registro legado de reversão é exibido como indeterminado", () => executar(`
  sala("a"); rollout.iniciar({ salas: ["a"] });
  const r = rollout.atual(); r.estado = "interrompido"; r.dispositivos[0].estado = "revertido";
  fs.writeFileSync(rollout.ARQUIVO_ROLLOUT, JSON.stringify(r)); reiniciar();
  assert.equal(rollout.atual().dispositivos[0].estado, "indeterminado");
`));

test("progresso duplicado não renova o timeout de uma transferência parada", () => executar(`
  sala("a"); rollout.iniciar({ salas: ["a"] });
  ota.registrarProgresso("a", { recebido: 100 });
  const e = ota.estadoDaSala("a"); e.atualizadoEm = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(ota.ARQUIVO_ESTADOS, JSON.stringify({ a: e })); reiniciar();
  ota.registrarProgresso("a", { recebido: 100 });
  assert.equal(ota.estadoDaSala("a").atualizadoEm, e.atualizadoEm);
  ota.verificarTimeouts();
  assert.equal(ota.estadoDaSala("a").fase, "falhou");
  assert.equal(rollout.atual().estado, "interrompido");
  assert.equal(ofertas.length, 1);
`));
