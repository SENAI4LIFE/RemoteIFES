"use strict";

// The real firmware's network behaviour when the server or the path to it misbehaves.
//
// Rates are per minute of the board's own time. The bounds come from the firmware's design intervals
// (identification every 15 s without a room and 60 s with one, WebSocket reconnection every 5 s,
// HTTP heartbeat every 30 s while the socket is down), with margin; a retry loop without a delay
// would exceed them by orders of magnitude.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

function travamentos(placa, desde = 0) {
  return placa.contarSerial(/Guru Meditation|abort\(\) was called|Backtrace:|panic/, desde);
}

async function taxaPorMinuto(lab, via, placa, msVirtuais) {
  const desde = via.conexoes.length;
  const t0 = await placa.agoraMs();
  await placa.aguardarVirtual(msVirtuais);
  const t1 = await placa.agoraMs();
  const conexoes = via.conexoes.slice(desde);
  const minutos = (t1 - t0) / 60_000;
  return { porMinuto: conexoes.length / minutos, minutos, tipos: conexoes.reduce((m, c) => ({ ...m, [c.tipo]: (m[c.tipo] || 0) + 1 }), {}) };
}

cenario("Servidor fora do ar quando a placa liga", {
  inicial: "Placa configurada e já vinculada; servidor inalcançável (conexões recusadas)",
  falha: "a placa é religada com o servidor fora do ar e fica 3 minutos (tempo da placa) sem resposta",
  exigido: ["tentativas continuam, espaçadas: no máximo 8 por minuto", "nenhum reinício ou travamento", "quando o servidor volta, a placa conecta em até 30 s"],
  proibido: ["laço de tentativas sem espera", "desistência definitiva", "reinícios em série"],
  recuperacao: "sessão aberta e comando confirmado",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  await placa.desligar();
  via.modo = "recusar";
  const marca = placa.marca();
  await placa.ligar();
  await placa.aguardarSerial(/IP: 192\.168\.4\.15/, { desde: marca });
  const taxa = await taxaPorMinuto(lab, via, placa, 180_000);
  lab.observar("comServidorFora", taxa);
  assert.ok(taxa.porMinuto <= 8, `${taxa.porMinuto.toFixed(1)} attempts per minute of board time`);
  assert.ok(taxa.porMinuto >= 2, "the board kept trying");
  assert.equal(reinicios(placa, marca), 1, "only the power-on");
  assert.equal(travamentos(placa, marca), 0);
  via.modo = "normal";
  const volta = await placa.agoraMs();
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  const esperaMs = (await placa.agoraMs()) - volta;
  lab.observar("reconexaoMsVirtual", Math.round(esperaMs));
  assert.ok(esperaMs <= 30_000, `connected ${Math.round(esperaMs)} ms (board time) after the server came back`);
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala);
});

cenario("Servidor some com a placa conectada e volta; cortes repetidos", {
  inicial: "Placa conectada e confirmada",
  falha: "todas as conexões são cortadas e recusadas por 2 minutos (tempo da placa); um comando é dado nesse intervalo; depois, três cortes em sequência curta",
  exigido: [
    "tentativas espaçadas: no máximo 20 por minuto",
    "a placa não reinicia",
    "ao voltar, recebe a intenção atual (restauração) e a confirma",
    "depois dos cortes em série, uma única sessão",
  ],
  proibido: ["sessões duplicadas", "estado confirmado divergente da intenção", "reinícios"],
  recuperacao: "sessão única, estado confirmado igual à intenção",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  await lab.aguardarConfirmada(sala);
  const marca = placa.marca();
  via.modo = "recusar";
  via.cortarTudo();
  await lab.aguardarDesconectada(sala);
  const cmd = await lab.api("POST", "/comando", { sala, cmd: "ligar" });
  assert.equal(cmd.status, 200, "the intent is accepted while the board is away");
  const taxa = await taxaPorMinuto(lab, via, placa, 120_000);
  lab.observar("durantaQueda", taxa);
  assert.ok(taxa.porMinuto <= 20, `${taxa.porMinuto.toFixed(1)} attempts per minute of board time`);
  assert.ok(taxa.porMinuto >= 3);
  via.modo = "normal";
  await lab.aguardarIntencaoAplicada(sala, true); // the intent given during the outage reached the board
  for (let i = 0; i < 3; i++) {
    via.cortarTudo();
    await placa.aguardarVirtual(1500);
  }
  await lab.aguardarConfirmada(sala, { limiteMs: 300_000 });
  await placa.aguardarVirtual(10_000);
  const vivas = via.conexoesDo("ws").filter((c) => !c.fim).length;
  lab.observar("sessoesVivasNoFim", vivas);
  assert.equal(vivas, 1, "one session after the storm");
  assert.equal(reinicios(placa, marca), 0);
  assert.equal(travamentos(placa, marca), 0);
});

cenario("Servidor morto (SIGKILL) e religado com a placa conectada", {
  inicial: "Placa conectada; intenção ligada confirmada",
  falha: "o processo do servidor é morto com SIGKILL e religado na mesma porta",
  exigido: ["a placa reconecta sozinha", "a intenção persistida é restaurada e confirmada"],
  proibido: ["intenção perdida", "reinício da placa"],
  recuperacao: "estado confirmado igual à intenção anterior à queda",
}, async (lab) => {
  const { placa, sala } = await lab.placaEmOperacao();
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala);
  const marca = placa.marca();
  await lab.servidor.parar("SIGKILL");
  await placa.aguardarSerial(/WS servidor: desconectado/, { desde: marca });
  await lab.servidor.subir();
  const { estado, relato } = await lab.aguardarIntencaoAplicada(sala, true);
  lab.observar("aposReinicioDoServidor", { relato, versao: estado.dispositivo.versaoEstadoReportada });
  assert.equal(reinicios(placa, marca), 0);
});

cenario("Conexão cortada logo depois de o comando chegar à placa", {
  inicial: "Placa conectada e confirmada desligada",
  falha: "a conexão cai no instante seguinte à entrega de um send_known_state (ligar): a placa recebe o comando, a resposta não chega",
  exigido: ["a placa executa o comando uma vez", "ao reconectar, o servidor e a placa convergem: estado confirmado = intenção (ligado)"],
  proibido: ["servidor confirmando sem relato da placa", "divergência permanente"],
  recuperacao: "estado confirmado ligado",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  await lab.aguardarConfirmada(sala);
  let cortou = false;
  via.aoQuadroDoServidor = (texto) => {
    if (cortou || !/"send_known_state"/.test(texto) || /"restauracao":true/.test(texto) || !/"power":true/.test(texto)) return undefined;
    cortou = true;
    return "cortar";
  };
  const bordas = placa.bordas.length;
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardar(() => cortou, { descricao: "command frame delivered and connection cut" });
  via.aoQuadroDoServidor = null;
  const antes = await lab.estado(sala);
  lab.observar("logoAposOCorte", { confirmado: antes.dispositivo.estadoConfirmado, conectado: antes.dispositivo.conectado });
  await lab.aguardarIntencaoAplicada(sala, true);
  const ir = placa.bordasDe(4, bordas).length;
  lab.observar("bordasIr", ir);
  assert.ok(ir > 1000, "the command was transmitted");
});

cenario("Respostas do servidor atrasadas em 1,5 s", {
  inicial: "Placa conectada",
  falha: "cada bloco de dados, nos dois sentidos, é atrasado 1,5 s",
  exigido: ["a sessão se mantém por 2 minutos (tempo da placa)", "um comando é confirmado"],
  proibido: ["reconexões provocadas pelo atraso", "reinício"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  via.atrasoMs = 1500;
  const marca = placa.marca();
  const sessoes = via.conexoesDo("ws").length;
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala, { limiteMs: 300_000 });
  await placa.aguardarVirtual(120_000);
  assert.equal(via.conexoesDo("ws").length, sessoes, "no reconnection");
  assert.ok((await lab.estado(sala)).dispositivo.conectado);
  assert.equal(reinicios(placa, marca), 0);
});

cenario("Servidor aceita a conexão e não responde", {
  inicial: "Placa conectada",
  falha: "a sessão é derrubada e, por 2 minutos (tempo da placa), toda conexão é aceita e nada é respondido",
  exigido: ["tentativas espaçadas: no máximo 20 por minuto", "nenhum reinício", "reconexão quando o servidor volta a responder"],
  proibido: ["placa presa esperando para sempre", "reinícios"],
  recuperacao: "sessão aberta e comando confirmado",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  const marca = placa.marca();
  via.modo = "buraco";
  via.cortarTudo();
  const taxa = await taxaPorMinuto(lab, via, placa, 120_000);
  lab.observar("comServidorMudo", taxa);
  assert.ok(taxa.porMinuto <= 20, `${taxa.porMinuto.toFixed(1)} attempts per minute of board time`);
  assert.ok(taxa.porMinuto >= 1);
  assert.equal(reinicios(placa, marca), 0);
  via.modo = "normal";
  via.cortarTudo();
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala);
});

cenario("Quadros malformados e fora dos limites vindos do servidor", {
  inicial: "Placa conectada, transporte sem TLS (onde a injeção é possível)",
  falha: "texto que não é JSON, tipos desconhecidos, campos com tipo errado, RAW com 1025 pulsos, RAW com mais de 2 s, failsafe com portadora fora da faixa, quadro binário e um JSON de 100 KB",
  exigido: ["a placa descarta ou recusa cada um, relatando as recusas previstas", "nenhum IR é emitido pelos recusados", "a placa não reinicia e segue obedecendo a um comando válido"],
  proibido: ["reinício, pânico ou travamento", "IR emitido por um quadro recusado", "failsafe gravado fora da faixa"],
  recuperacao: "comando válido confirmado depois da série",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  await lab.aguardarConfirmada(sala);
  const marca = placa.marca();
  const msgs = via.daPlaca.length;
  const bordas = placa.bordas.length;
  const rawLongo = Array.from({ length: 1025 }, () => 500);
  const rawDemorado = Array.from({ length: 100 }, () => 30_000);
  const injetar = async (texto) => { await via.injetarTexto(texto); await placa.aguardarVirtual(600); };
  await injetar("isto nao e json");
  await injetar("{\"tipo\":");
  await injetar(JSON.stringify({ tipo: "tipo_que_nao_existe", x: 1 }));
  await injetar(JSON.stringify({ tipo: "send_known_state", protocol: "abc", temp: "quente", power: "sim" }));
  await injetar(JSON.stringify({ tipo: "send_raw", raw: rawLongo, carrierHz: 38000 }));
  await injetar(JSON.stringify({ tipo: "send_raw", raw: rawDemorado, carrierHz: 38000 }));
  await injetar(JSON.stringify({ tipo: "failsafe_raw_set", raw: [9000, 4500, 560], carrierHz: 19999 }));
  await via.injetar(Buffer.from([0x82, 0x04, 0xde, 0xad, 0xbe, 0xef]));
  await placa.aguardarVirtual(600);
  await injetar(JSON.stringify({ tipo: "send_raw", raw: Array.from({ length: 12000 }, () => 1), carrierHz: 38000 }));
  await placa.aguardarVirtual(3000);
  const recusas = via.mensagensDaPlaca({ tipo: "comando" }, msgs).map((m) => `${m.cmd}:${m.valor || ""}`);
  lab.observar("relatosDaPlaca", recusas);
  assert.ok(recusas.includes("controle_raw:rejeitado_tamanho"), "the 1025-pulse RAW was refused by size");
  assert.ok(recusas.includes("controle_raw:rejeitado_duracao"), "the 3 s RAW was refused by duration");
  assert.ok(recusas.includes("failsafe_off:rejeitado"), "the out-of-range carrier was refused");
  assert.equal(placa.bordasDe(4, bordas).length, 0, "no IR was emitted");
  assert.equal(reinicios(placa, marca), 0, "no restart");
  assert.equal(placa.contarSerial(/Guru Meditation|abort\(\)|Backtrace:/, marca), 0, "no panic");
  const nvs = lab.nvs(placa);
  assert.equal(nvs.chaves.fsRec, undefined, "no failsafe was stored");
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarIntencaoAplicada(sala, true);
  lab.observar("sessoesWs", via.conexoesDo("ws").length);
});
