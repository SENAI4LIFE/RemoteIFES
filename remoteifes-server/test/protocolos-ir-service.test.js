const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-protocolos-ir-service-"));
process.env.REMOTEIFES_DB_PATH = path.join(tmp, "protocolos.db");
process.env.NODE_ENV = "test";

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
const protocolos = require("../src/services/protocolosIrService");
const salasService = require("../src/services/salasService");
const credenciais = require("../src/services/esp32CredenciaisService");

criarSchema();
for (const [sala, mac] of [["CLONE-1", "AA:BB:CC:DD:EE:C1"], ["TX-1", "AA:BB:CC:DD:EE:D1"], ["TX-2", "AA:BB:CC:DD:EE:D2"], ["SEM-MAC", null]]) {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(sala, sala, mac);
}

const captura = (extra = {}) => ({
  id: 1,
  sala: "CLONE-1",
  isKnown: true,
  protocolId: 5,
  protocol: "DAIKIN",
  hex: "0x1234",
  raw: [9000, 4500, 560, 560],
  carrierHz: 38000,
  ...extra,
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sem clonador definido nenhuma sala é clonadora e nada pode ser salvo", () => {
  assert.equal(protocolos.obterClonador(), null);
  assert.equal(protocolos.papelDaSala("CLONE-1"), "transmitter");
  assert.equal(protocolos.estadoClonador().motivo, "nao-designado");
  assert.throws(() => protocolos.criar({ label: "Qualquer", captura: captura() }), /nenhum módulo clonador/);
});

test("definir o clonador exige sala existente com MAC e guarda a identidade física da placa", () => {
  assert.throws(() => protocolos.definirClonador("NAO-EXISTE"), /não encontrada/);
  assert.throws(() => protocolos.definirClonador("SEM-MAC"), /não possui ESP32/);
  assert.throws(() => protocolos.definirClonador(42), /inválida/);

  const definido = protocolos.definirClonador("CLONE-1");
  assert.equal(definido.sala, "CLONE-1");
  assert.equal(definido.mac, "AA:BB:CC:DD:EE:C1");
  assert.equal(definido.deviceId, null);
  assert.ok(definido.definidoEm);
  assert.equal(protocolos.papelDaSala("CLONE-1"), "cloner");
  assert.equal(protocolos.papelDaSala("TX-1"), "transmitter");
  assert.equal(protocolos.estadoClonador().vinculoValido, true);

  const gravado = JSON.parse(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'espClonador'").get().valor);
  assert.equal(gravado.mac, "AA:BB:CC:DD:EE:C1");
});

test("a autorização de uma conexão compara o MAC físico e a credencial com o vínculo guardado", () => {
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "aa:bb:cc:dd:ee:c1", deviceId: null }), "cloner");
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "AA:BB:CC:DD:EE:99", deviceId: null }), "transmitter");
  assert.equal(protocolos.papelDaConexao("TX-1", { mac: "AA:BB:CC:DD:EE:C1", deviceId: null }), "transmitter");
  assert.equal(protocolos.papelDaConexao("CLONE-1", null), "transmitter");
});

test("capturas com origem em outra sala, RAW ou portadora inválidos são recusadas", () => {
  assert.throws(() => protocolos.criar({ label: "Origem errada", captura: captura({ sala: "TX-1" }) }), /não veio do módulo clonador/);
  assert.throws(() => protocolos.criar({ label: "Sem raw", captura: captura({ raw: [] }) }), /entre 1 e 1024 pulsos/);
  assert.throws(() => protocolos.criar({ label: "Raw longo", captura: captura({ raw: new Array(1025).fill(500) }) }), /entre 1 e 1024 pulsos/);
  assert.throws(() => protocolos.criar({ label: "Pulso alto", captura: captura({ raw: [65536] }) }), /entre 0 e 65535/);
  assert.throws(() => protocolos.criar({ label: "Pulso negativo", captura: captura({ raw: [-1] }) }), /entre 0 e 65535/);
  assert.throws(() => protocolos.criar({ label: "Pulso fracionado", captura: captura({ raw: [10.5] }) }), /entre 0 e 65535/);
  assert.throws(() => protocolos.criar({ label: "Portadora baixa", captura: captura({ carrierHz: 19999 }) }), /carrierHz/);
  assert.throws(() => protocolos.criar({ label: "Portadora alta", captura: captura({ carrierHz: 60001 }) }), /carrierHz/);
  assert.throws(() => protocolos.criar({ label: "Sem captura", captura: null }), /captura é obrigatória/);
  assert.equal(protocolos.listar().length, 0);
});

test("labels são normalizados, limitados a 2–80 caracteres e únicos sem diferenciar maiúsculas", () => {
  assert.throws(() => protocolos.criar({ label: "A", captura: captura() }), /entre 2 e 80/);
  assert.throws(() => protocolos.criar({ label: "x".repeat(81), captura: captura() }), /entre 2 e 80/);
  assert.throws(() => protocolos.criar({ label: 12, captura: captura() }), /obrigatório/);
  assert.throws(() => protocolos.criar({ label: "   ", captura: captura() }), /entre 2 e 80/);

  const salvo = protocolos.criar({ label: "  Ar   laboratório  -  ligar\t", captura: captura() });
  assert.equal(salvo.label, "Ar laboratório - ligar");
  assert.equal(salvo.isKnown, true);
  assert.equal(salvo.protocolId, 5);
  assert.equal(salvo.origemSala, "CLONE-1");
  assert.equal(salvo.origemMac, "AA:BB:CC:DD:EE:C1");
  assert.equal(salvo.carrierHz, 38000);
  assert.equal(salvo.failsafe, null);
  assert.deepEqual(salvo.salas, []);

  assert.throws(() => protocolos.criar({ label: "AR LABORATÓRIO - LIGAR", captura: captura() }), /já existe/);
  assert.throws(() => protocolos.criar({ label: "ar laboratório - ligar", captura: captura() }), /já existe/);
  assert.equal(protocolos.listar().length, 1);
});

test("sinal RAW genérico é guardado sem virar protocolo de ar-condicionado com estado", () => {
  const generico = protocolos.criar({
    label: "Projetor - power",
    captura: captura({ isKnown: false, protocolId: 7, protocol: "UNKNOWN", hex: "0x0", raw: [100, 200, 300], carrierHz: undefined }),
  });
  assert.equal(generico.isKnown, false);
  assert.equal(generico.protocolId, null);
  assert.equal(generico.carrierHz, 38000);
  assert.deepEqual(generico.raw, [100, 200, 300]);
  assert.throws(() => protocolos.criar({ label: "Reconhecido sem id", captura: captura({ isKnown: true, protocolId: -1 }) }), /protocolId válido/);
});

test("failsafe OFF é opcional, validado como qualquer RAW e pode ser removido", () => {
  const id = protocolos.listar().find((p) => p.label === "Ar laboratório - ligar").id;
  assert.throws(() => protocolos.definirFailsafe(999, captura()), /não encontrado/);
  assert.throws(() => protocolos.definirFailsafe(id, captura({ raw: [70000] })), /entre 0 e 65535/);
  assert.throws(() => protocolos.definirFailsafe(id, captura({ sala: "TX-1" })), /não veio do módulo clonador/);

  const comFailsafe = protocolos.definirFailsafe(id, captura({ raw: [9100, 4450, 570], carrierHz: 40000 }));
  assert.deepEqual(comFailsafe.failsafe.raw, [9100, 4450, 570]);
  assert.equal(comFailsafe.failsafe.carrierHz, 40000);
  assert.ok(comFailsafe.failsafe.atualizadoEm);

  const limpo = protocolos.limparFailsafe(id);
  assert.equal(limpo.failsafe, null);
  assert.throws(() => protocolos.limparFailsafe(999), /não encontrado/);
});

test("renomear respeita unicidade e excluir desfaz o vínculo das salas com o registro", () => {
  const lista = protocolos.listar();
  const ar = lista.find((p) => p.label === "Ar laboratório - ligar");
  const projetor = lista.find((p) => p.label === "Projetor - power");
  assert.throws(() => protocolos.renomear(ar.id, "projetor - POWER"), /já existe/);
  assert.equal(protocolos.renomear(ar.id, "Ar laboratório - ligar").label, "Ar laboratório - ligar");
  assert.equal(protocolos.renomear(ar.id, "Ar lab 1").label, "Ar lab 1");
  assert.throws(() => protocolos.renomear(999, "Outro"), /não encontrado/);

  salasService.definirProtocoloIR("TX-1", ar.protocolId, ar.id);
  salasService.definirProtocoloIR("TX-2", ar.protocolId, ar.id);
  assert.deepEqual(protocolos.salasAtribuidas(ar.id), ["TX-1", "TX-2"]);
  assert.deepEqual(protocolos.buscar(ar.id).salas, ["TX-1", "TX-2"]);
  assert.throws(() => salasService.definirProtocoloIR("TX-1", 5, 0), /registro de protocolo/);

  const excluido = protocolos.excluir(ar.id);
  assert.equal(excluido.id, ar.id);
  assert.equal(protocolos.buscar(ar.id), null);
  assert.equal(db.prepare("SELECT irProtocoloRegistroId FROM salas WHERE sala = 'TX-1'").get().irProtocoloRegistroId, null);
  assert.equal(db.prepare("SELECT irProtocolo FROM salas WHERE sala = 'TX-1'").get().irProtocolo, 5);
  assert.throws(() => protocolos.excluir(ar.id), /não encontrado/);
  assert.equal(protocolos.listar().length, 1);
  assert.equal(protocolos.listar()[0].id, projetor.id);
});

test("o comando de failsafe para a sala reflete o registro vinculado e o RAW guardado", () => {
  const projetor = protocolos.listar()[0];
  assert.deepEqual(salasService.comandoFailsafeIR({ sala: "TX-1", irProtocoloRegistroId: null }), { tipo: "failsafe_raw_clear" });
  assert.deepEqual(salasService.comandoFailsafeIR({ sala: "TX-1", irProtocoloRegistroId: projetor.id }), { tipo: "failsafe_raw_clear", protocolRecordId: projetor.id });
  protocolos.definirFailsafe(projetor.id, captura({ raw: [1, 2, 3], carrierHz: 36000 }));
  assert.deepEqual(salasService.comandoFailsafeIR({ sala: "TX-1", irProtocoloRegistroId: projetor.id }), {
    tipo: "failsafe_raw_set", protocolRecordId: projetor.id, raw: [1, 2, 3], carrierHz: 36000,
  });
  assert.deepEqual(salasService.comandoFailsafeIR({ sala: "TX-1", irProtocoloRegistroId: 999 }), { tipo: "failsafe_raw_clear", protocolRecordId: 999 });
});

test("trocar o MAC da sala clonadora invalida o vínculo até uma nova confirmação", () => {
  salasService.cadastrarMac("CLONE-1", "AA:BB:CC:DD:EE:C2");
  assert.equal(protocolos.papelDaSala("CLONE-1"), "transmitter");
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "AA:BB:CC:DD:EE:C2", deviceId: null }), "transmitter");
  const estado = protocolos.estadoClonador();
  assert.equal(estado.sala, "CLONE-1");
  assert.equal(estado.vinculoValido, false);
  assert.equal(estado.motivo, "mac-alterado");
  assert.throws(() => protocolos.criar({ label: "Depois da troca", captura: captura() }), /vínculo do módulo clonador mudou/);

  const confirmado = protocolos.definirClonador("CLONE-1");
  assert.equal(confirmado.mac, "AA:BB:CC:DD:EE:C2");
  assert.equal(protocolos.papelDaSala("CLONE-1"), "cloner");
});

test("com credencial provisionada o vínculo passa a exigir o mesmo deviceId; substituir ou revogar derruba a autorização", () => {
  const { deviceId } = credenciais.provisionar("CLONE-1");
  assert.equal(protocolos.papelDaSala("CLONE-1"), "cloner", "provisionar credencial na mesma placa não invalida o vínculo por MAC");
  const confirmado = protocolos.definirClonador("CLONE-1");
  assert.equal(confirmado.deviceId, deviceId);
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "AA:BB:CC:DD:EE:C2", deviceId }), "cloner");
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "AA:BB:CC:DD:EE:C2", deviceId: "esp_0000000000000000" }), "transmitter");
  assert.equal(protocolos.papelDaConexao("CLONE-1", { mac: "AA:BB:CC:DD:EE:C2", deviceId: null }), "transmitter");

  const substituida = credenciais.substituir("CLONE-1");
  assert.notEqual(substituida.deviceId, deviceId);
  assert.equal(protocolos.papelDaSala("CLONE-1"), "transmitter");
  assert.equal(protocolos.estadoClonador().motivo, "credencial-alterada");

  protocolos.definirClonador("CLONE-1");
  assert.equal(protocolos.papelDaSala("CLONE-1"), "cloner");
  credenciais.revogar("CLONE-1");
  assert.equal(protocolos.papelDaSala("CLONE-1"), "transmitter");
  assert.equal(protocolos.estadoClonador().motivo, "credencial-alterada");
});

test("remover o clonador limpa a configuração e volta todas as salas a transmissoras", () => {
  assert.equal(protocolos.definirClonador(null), null);
  assert.equal(protocolos.obterClonador(), null);
  assert.equal(JSON.parse(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'espClonador'").get().valor), null);
  assert.equal(protocolos.papelDaSala("CLONE-1"), "transmitter");
  assert.equal(protocolos.definirClonador(""), null);
});
