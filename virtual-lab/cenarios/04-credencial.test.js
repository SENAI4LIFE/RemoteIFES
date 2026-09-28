"use strict";

// Device credentials on the real firmware and its real NVS, interrupted at exact instructions.
//
// The server side of the two-phase rotation is already covered by protocol tests with simulated
// boards. What only the real firmware shows is how its NVS writes, its restart and its reconnection
// interact with that protocol when the chip stops at the worst moment.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");
const { registrarSegredo } = require("../lib/ambiente");

const LINHA_GRAVACAO = 'bool gravado = gravarChaveNvsVerificada("devId", novoId) && gravarChaveNvsVerificada("devSec", novoSegredo);';

function segredoNaNvs(lab, placa) {
  const nvs = lab.nvs(placa);
  return { deviceId: nvs.chaves.devId && nvs.chaves.devId.valor, segredo: nvs.chaves.devSec && nvs.chaves.devSec.valor };
}

/** The secret the board presented when it opened its most recent WebSocket through `via`. */
function ultimoSegredoApresentado(via, desde = 0) {
  const ws = via.conexoesDo("ws", desde).filter((c) => c.cabecalhos);
  return ws.length ? ws[ws.length - 1].cabecalhos["x-device-secret"] || null : null;
}

async function rotacionar(lab, sala) {
  const r = await lab.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial/rotacionar`);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  registrarSegredo(r.corpo.segredo);
  return r.corpo;
}

async function credencialNoServidor(lab, sala) {
  return (await lab.estado(sala)).credencial;
}

cenario("Rotação: energia cortada com a oferta recebida, antes de gravar na NVS", {
  inicial: "Placa conectada com a credencial A",
  falha: "o administrador rotaciona; a placa recebe o segredo B e perde energia na linha que grava a NVS, antes de qualquer escrita",
  exigido: ["ao religar, a placa conecta com A, que o servidor ainda aceita", "o servidor reentrega B pela conexão", "a placa grava B, reconecta com B e só então a rotação é ativada"],
  proibido: ["placa sem conseguir autenticar", "rotação ativada sem a placa apresentar B"],
  recuperacao: "rotação concluída com B em uso",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala, credencial: a } = await lab.placaEmOperacao({ via });
  const parada = placa.pararEm(LINHA_GRAVACAO, { acao: "desligar" });
  await new Promise((r) => setTimeout(r, 1500));
  const b = await rotacionar(lab, sala);
  await parada;
  const naNvs = segredoNaNvs(lab, placa);
  lab.observar("nvsAposCorte", { segredoEhA: naNvs.segredo === a.segredo, segredoEhB: naNvs.segredo === b.segredo });
  assert.equal(naNvs.segredo, a.segredo, "nothing was written before the cut");
  const pendente = await credencialNoServidor(lab, sala);
  lab.observar("servidorAntesDeReligar", { rotacaoPendente: pendente.rotacaoPendente, rotacionadoEm: pendente.rotacionadoEm });
  assert.equal(pendente.rotacaoPendente, true);
  const desde = via.conexoes.length;
  await placa.ligar();
  await lab.aguardar(async () => segredoNaNvs(lab, placa).segredo === b.segredo, { descricao: "B written to NVS after re-delivery", limiteMs: 300_000 });
  const final = await lab.aguardar(async () => {
    const c = await credencialNoServidor(lab, sala);
    return !c.rotacaoPendente && c.rotacionadoEm ? c : false;
  }, { descricao: "rotation activated", limiteMs: 300_000 });
  await lab.aguardarConectada(sala);
  const apresentados = via.conexoesDo("ws", desde).filter((c) => c.cabecalhos).map((c) => (c.cabecalhos["x-device-secret"] === a.segredo ? "A" : c.cabecalhos["x-device-secret"] === b.segredo ? "B" : "?"));
  lab.observar("segredosApresentadosAposReligar", apresentados);
  assert.equal(apresentados[0], "A", "the board came back with the credential it had");
  assert.equal(apresentados[apresentados.length - 1], "B", "and ended on the rotated one");
  assert.ok(!apresentados.includes("?"));
  lab.observar("servidorFinal", { rotacaoPendente: final.rotacaoPendente, graceRotacaoAtivo: final.graceRotacaoAtivo });
});

cenario("Rotação: energia cortada com o segredo novo gravado e verificado, antes de reconectar", {
  inicial: "Placa conectada com a credencial A",
  falha: "a placa grava e relê B na NVS e perde energia antes de passar a usá-lo (linha que troca a credencial em RAM)",
  exigido: ["a rotação continua pendente no servidor enquanto a placa não apresenta B", "ao religar a placa apresenta B e o servidor ativa a rotação nessa prova"],
  proibido: ["ativação antes da prova", "placa bloqueada"],
  recuperacao: "rotação concluída com B em uso",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala, credencial: a } = await lab.placaEmOperacao({ via });
  const parada = placa.pararEm("deviceId = novoId;", { acao: "desligar" });
  await new Promise((r) => setTimeout(r, 1500));
  const b = await rotacionar(lab, sala);
  await parada;
  assert.equal(segredoNaNvs(lab, placa).segredo, b.segredo, "B is in NVS");
  const antes = await credencialNoServidor(lab, sala);
  assert.equal(antes.rotacaoPendente, true, "not active: the board never presented B");
  const desde = via.conexoes.length;
  await placa.ligar();
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  assert.equal(ultimoSegredoApresentado(via, desde), b.segredo, "the board came back with B");
  assert.notEqual(ultimoSegredoApresentado(via, desde), a.segredo);
  const depois = await credencialNoServidor(lab, sala);
  lab.observar("servidor", { antes: { rotacaoPendente: antes.rotacaoPendente }, depois: { rotacaoPendente: depois.rotacaoPendente, rotacionadoEm: Boolean(depois.rotacionadoEm) } });
  assert.equal(depois.rotacaoPendente, false);
  assert.ok(depois.rotacionadoEm);
});

cenario("Rotação ativada e gravação perdida: a placa volta com o segredo anterior dentro da tolerância", {
  inicial: "Rotação A→B concluída (B apresentado e ativado)",
  falha: "com a placa desligada, a NVS volta a conter A, como se a gravação de B não tivesse sobrevivido ao desligamento",
  exigido: ["o servidor aceita A dentro da tolerância de 24 h e reentrega B pela conexão", "a placa grava B e volta a conectar com B"],
  proibido: ["placa bloqueada", "B deixando de valer"],
  recuperacao: "placa em operação com B",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala, credencial: a } = await lab.placaEmOperacao({ via });
  const b = await rotacionar(lab, sala);
  await lab.aguardar(async () => {
    const c = await credencialNoServidor(lab, sala);
    return !c.rotacaoPendente && c.rotacionadoEm;
  }, { descricao: "rotation activated", limiteMs: 300_000 });
  await placa.desligar();
  const imagem = lab.lerFlash(placa);
  require("../lib/flash").substituirStringNvs(imagem, "remoteifes", "devSec", a.segredo);
  lab.gravarFlash(placa, imagem);
  assert.equal(segredoNaNvs(lab, placa).segredo, a.segredo);
  const desde = via.conexoes.length;
  await placa.ligar();
  await lab.aguardar(async () => segredoNaNvs(lab, placa).segredo === b.segredo, { descricao: "B re-delivered and written", limiteMs: 300_000 });
  // The session opened with A may still be up when B is written; the board then reconnects with B.
  await lab.aguardar(() => via.conexoesDo("ws", desde).some((c) => c.cabecalhos && c.cabecalhos["x-device-secret"] === b.segredo), { descricao: "a session opened with B", limiteMs: 300_000 });
  await lab.aguardarConectada(sala);
  const apresentados = via.conexoesDo("ws", desde).filter((c) => c.cabecalhos).map((c) => (c.cabecalhos["x-device-secret"] === a.segredo ? "A" : c.cabecalhos["x-device-secret"] === b.segredo ? "B" : "?"));
  lab.observar("segredosApresentados", apresentados);
  assert.equal(apresentados[0], "A");
  assert.equal(apresentados[apresentados.length - 1], "B");
  const c = await credencialNoServidor(lab, sala);
  lab.observar("servidor", { graceRotacaoAtivo: c.graceRotacaoAtivo, atualReentregavel: c.atualReentregavel });
});

cenario("Credencial malformada entregue pela conexão não é gravada", {
  inicial: "Placa conectada com a credencial A (transporte sem TLS, onde a injeção é possível)",
  falha: "quadros credencial_rotacionar com segredo curto, deviceId curto e campos ausentes são injetados na conexão",
  exigido: ["a placa descarta todos sem tocar a NVS", "a sessão continua a mesma"],
  proibido: ["gravação de credencial inválida", "reconexão provocada"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala, credencial: a } = await lab.placaEmOperacao({ via });
  const nvsAntes = lab.nvs(placa);
  const conexoesAntes = via.conexoesDo("ws").length;
  const desde = placa.marca();
  for (const q of [
    { tipo: "credencial_rotacionar", deviceId: a.deviceId, segredo: "curto" },
    { tipo: "credencial_rotacionar", deviceId: "ab", segredo: "x".repeat(40) },
    { tipo: "credencial_provisionar", segredo: "y".repeat(40) },
    { tipo: "credencial_rotacionar", deviceId: a.deviceId },
  ]) await via.injetarTexto(JSON.stringify(q));
  await placa.aguardarVirtual(3000);
  const nvsDepois = lab.nvs(placa);
  assert.equal(nvsDepois.chaves.devSec.valor, a.segredo);
  assert.equal(nvsDepois.chaves.devId.valor, a.deviceId);
  assert.deepEqual(Object.keys(nvsDepois.chaves).sort(), Object.keys(nvsAntes.chaves).sort());
  assert.equal(via.conexoesDo("ws").length, conexoesAntes, "no reconnection");
  assert.doesNotMatch(placa.serial.slice(desde), /Credencial de dispositivo/);
  assert.ok((await lab.estado(sala)).dispositivo.conectado);
});

cenario("Provisionamento pela conexão interrompido entre as duas gravações da NVS", {
  inicial: "Migração: credencial não obrigatória, placa conectada só pelo MAC, sala sem credencial",
  falha: "o administrador provisiona a credencial; a placa grava devId, e perde energia enquanto o relê, antes de gravar devSec",
  exigido: ["a placa volta a operar sem intervenção no local, ou continua alcançável e recuperável pelo servidor"],
  proibido: ["placa que não autentica mais e só volta com visita ao local"],
  recuperacao: "a placa conecta com uma credencial válida",
}, async (lab) => {
  const via = await lab.intermediario();
  const cfg = await lab.api("PATCH", "/admin/configuracoes", { espCredenciaisObrigatorias: false });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.corpo));
  await lab.prepararSala("A-103a", { credencial: false });
  const placa = lab.novaPlaca({ via });
  await placa.ligar();
  await lab.configurarPeloPortal(placa, { credencial: null });
  await lab.aguardarConectada("A-103a", { limiteMs: 240_000 });
  // The read-back of the first key: devId is written, devSec is not yet.
  const parada = placa.pararEm('return preferences.getString(chave, "") == valor;', { ocorrencia: 1, acao: "desligar" });
  await new Promise((r) => setTimeout(r, 1500));
  const prov = await lab.api("POST", "/admin/esp32/A-103a/credencial");
  assert.equal(prov.status, 200, JSON.stringify(prov.corpo));
  registrarSegredo(prov.corpo.segredo);
  await parada;
  const naNvs = segredoNaNvs(lab, placa);
  lab.observar("nvsAposCorte", { devId: naNvs.deviceId === prov.corpo.deviceId ? "novo" : naNvs.deviceId ? "outro" : "ausente", devSec: naNvs.segredo === prov.corpo.segredo ? "novo" : naNvs.segredo ? "outro" : "ausente" });
  assert.equal(naNvs.deviceId, prov.corpo.deviceId, "the cut landed after devId was written");
  assert.equal(naNvs.segredo, undefined, "the cut landed before devSec was written");
  const desde = via.conexoes.length;
  await placa.ligar();
  let recuperou = true;
  try {
    await lab.aguardarConectada("A-103a", { limiteMs: 300_000 });
  } catch {
    recuperou = false;
  }
  const tentativas = via.conexoes.slice(desde).map((c) => `${c.tipo}:${c.requisicao ? c.requisicao.split(" ")[1].split("?")[0] : "-"}:${c.cabecalhos && c.cabecalhos["x-device-id"] ? "com-credencial" : "sem-credencial"}`);
  lab.observar("conexoesAposReligar", tentativas.slice(0, 12));
  lab.observar("recuperouSemVisita", recuperou);
  assert.ok(recuperou, "after a power cut between the two NVS writes the board could not authenticate again without a site visit");
});
