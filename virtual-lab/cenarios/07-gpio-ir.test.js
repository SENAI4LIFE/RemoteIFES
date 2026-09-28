"use strict";

// The action switch, the buzzer and the IR output as the chip's GPIO lines see them.
//
// What this proves is the firmware's logic at the pins: which edges it produces and how it reacts to
// the switch line. It does not prove voltages, LED drive current, the optical signal or what an air
// conditioner receives. The emulator's carrier timing follows virtual time, so edge counts are
// compared with what the RAW timings imply, with a tolerance for the loop's own overhead.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

/** Carrier edges a RAW should produce at `hz`: two per carrier cycle over every mark (even index). */
function bordasEsperadas(raw, hz) {
  let ciclos = 0;
  for (let i = 0; i < raw.length; i += 2) ciclos += Math.ceil((raw[i] * hz) / 1e6);
  return 2 * ciclos;
}

const RAW_FAILSAFE = [9000, 4500, 560, 560, 560, 1690, 560, 560, 560, 1690, 560, 1690, 560];

// The portal opened by a short press is reached by joining the setup AP. While the board is a station,
// this emulator's radio carries no second link for a device joined to the AP, so the portal's answer
// during operation is left to physical hardware (see cenarios/09 and HARDWARE-ACCEPTANCE.md).
cenario("Toque curto abre o RemoteIFES-Setup sem interromper a operação", {
  inicial: "Placa em operação, conectada",
  falha: "toque de 300 ms (tempo da placa) no switch; depois um segundo toque",
  exigido: ["o ponto de acesso temporário abre", "a sessão com o servidor continua", "o segundo toque prorroga a janela em vez de reabrir"],
  proibido: ["reinício", "queda da sessão", "failsafe disparado por um toque curto"],
  recuperacao: "não se aplica (a janela fecha sozinha em 10 minutos; esse prazo não é esperado aqui)",
}, async (lab) => {
  const { placa, sala, via } = await lab.placaEmOperacao();
  const desde = placa.marca();
  const sessoes = via.conexoesDo("ws").length;
  const ms = await placa.pressionarBotao(300);
  lab.observar("toqueMsVirtual", Math.round(ms));
  await placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, { desde });
  await placa.aguardarVirtual(2000);
  await placa.pressionarBotao(300);
  await placa.aguardarSerial(/janela do RemoteIFES-Setup prorrogada/, { desde });
  assert.ok((await lab.estado(sala)).dispositivo.conectado);
  assert.equal(via.conexoesDo("ws").length, sessoes, "the session was not interrupted");
  assert.equal(reinicios(placa, desde), 0);
  assert.doesNotMatch(placa.serial.slice(desde), /Failsafe/);
});

cenario("Repique do contato mais curto que o debounce é ignorado", {
  inicial: "Placa em operação",
  falha: "o switch muda de nível 9 vezes o mais rápido possível e volta ao repouso",
  exigido: ["se o repique durou menos de 40 ms (tempo da placa), nada acontece", "um toque real logo depois é reconhecido"],
  proibido: ["ponto de acesso aberto pelo repique", "failsafe disparado"],
  recuperacao: "toque real reconhecido",
}, async (lab) => {
  const { placa } = await lab.placaEmOperacao();
  const desde = placa.marca();
  const ms = await placa.quicarBotao(9);
  lab.observar("repiqueMsVirtual", Math.round(ms * 10) / 10);
  if (ms >= 40) throw new Error(`the bounce took ${ms} ms of board time, not inside the 40 ms debounce: inconclusive on this host`);
  await placa.aguardarVirtual(1000);
  assert.doesNotMatch(placa.serial.slice(desde), /Switch:|Failsafe/, "the bounce did nothing");
  await placa.pressionarBotao(300);
  await placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, { desde });
});

cenario("Segurar o switch sem failsafe configurado não transmite nada", {
  inicial: "Placa em operação sem failsafe OFF gravado",
  falha: "o switch é mantido pressionado por 6 s (tempo da placa)",
  exigido: ["a placa relata que não há RAW OFF salvo", "nenhuma borda no GPIO 4"],
  proibido: ["IR transmitido", "trava de OFF local gravada"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const { placa } = await lab.placaEmOperacao();
  const desde = placa.marca();
  const bordas = placa.bordas.length;
  await placa.pressionarBotao(6000);
  await placa.aguardarSerial(/Failsafe ignorado: nenhum RAW OFF salvo na NVS/, { desde });
  assert.equal(placa.bordasDe(4, bordas).length, 0);
  assert.equal(lab.nvs(placa).chaves.fsLatch, undefined, "no latch without a transmission");
});

cenario("Failsafe local: transmissão, trava persistente, restauração recusada e comando explícito", {
  inicial: "Placa em operação com failsafe OFF gravado; intenção ligada confirmada",
  falha: "o switch é mantido por 6 s; depois a energia é cortada e religada",
  exigido: [
    "o RAW salvo sai no GPIO 4 com a contagem de ciclos da portadora esperada (±15%) e o buzzer soa",
    "a trava fsLatch é gravada na NVS e sobrevive ao corte de energia",
    "na reconexão a restauração automática (ligado) é recusada pela placa e o servidor adota o OFF local",
    "um comando explícito limpa a trava",
  ],
  proibido: ["IR de restauração enquanto travada", "trava perdida no corte de energia"],
  recuperacao: "comando explícito aplicado e trava removida da NVS",
}, async (lab) => {
  const { placa, sala, via } = await lab.placaEmOperacao();
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala);
  await lab.definirFailsafe(sala, { raw: RAW_FAILSAFE, carrierHz: 38000 });
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.configurado === true, { descricao: "failsafe stored" });
  const desde = placa.marca();
  const antes = placa.bordas.length;
  await placa.pressionarBotao(6000);
  await placa.aguardarSerial(/Failsafe OFF transmitido localmente/, { desde });
  // loop() switches the buzzer off a moment after the frame.
  await lab.aguardar(() => placa.bordasDe(27, antes).some((b) => b.nivel === 0), { descricao: "buzzer off after the failsafe", limiteMs: 60_000, intervaloMs: 100 });
  const ir = placa.bordasDe(4, antes).length;
  const esperado = bordasEsperadas(RAW_FAILSAFE, 38000);
  lab.observar("failsafe", { bordas: ir, esperado, buzzer: placa.bordasDe(27, antes).map((b) => b.nivel) });
  assert.ok(Math.abs(ir - esperado) <= esperado * 0.15, `${ir} carrier edges, ${esperado} expected from the RAW`);
  assert.deepEqual(placa.bordasDe(27, antes).map((b) => b.nivel).slice(0, 2), [1, 0]);
  assert.equal(lab.nvs(placa).chaves.fsLatch.valor, 1, "latch written to NVS");
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.latched === true, { descricao: "server sees the latch" });

  await placa.desligar();
  assert.equal(lab.nvs(placa).chaves.fsLatch.valor, 1, "latch survives the power cut");
  const religou = placa.marca();
  const msgs = via.daPlaca.length;
  await placa.ligar();
  await placa.aguardarSerial(/Failsafe OFF local continua em vigor/, { desde: religou });
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  await placa.aguardarVirtual(8000);
  const recusas = via.mensagensDaPlaca({ tipo: "comando", cmd: "controle_nativo", valor: "ignorado_failsafe_latch" }, msgs);
  const irNaReconexao = placa.bordas.filter((b) => b.pino === 4 && b.ms >= placa.momentoDoSerial(/WS servidor: conectado/, religou)).length;
  lab.observar("reconexaoTravada", { recusas: recusas.length, bordasIr: irNaReconexao });
  assert.equal(irNaReconexao, 0, "no IR from the automatic restoration while latched");
  const e = await lab.estado(sala);
  assert.equal(e.dispositivo.failsafe.latched, true);

  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala, { limiteMs: 300_000 });
  assert.equal(lab.nvs(placa).chaves.fsLatch, undefined, "an explicit command clears the latch");
});

cenario("Portadora do RAW chega ao pino: 38 kHz e 56 kHz", {
  inicial: "Placa em operação",
  falha: "o mesmo RAW é transmitido pelo teste de administração a 38 kHz e a 56 kHz",
  exigido: ["cada transmissão tem a contagem de bordas esperada (±15%)", "a razão entre as duas acompanha a razão das portadoras"],
  proibido: ["portadora ignorada", "IR sem buzzer"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const { placa, sala } = await lab.placaEmOperacao();
  const raw = [3000, 1500, 500, 500, 500, 1500, 500, 500, 2000, 800, 500];
  const medidas = {};
  for (const hz of [38000, 56000]) {
    await placa.aguardarVirtual(1000);
    const antes = placa.bordas.length;
    const r = await lab.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/teste/raw`, { raw, carrierHz: hz });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    await lab.aguardar(() => placa.bordasDe(27, antes).some((b) => b.nivel === 0), { descricao: "transmission finished (buzzer off)" });
    medidas[hz] = { bordas: placa.bordasDe(4, antes).length, esperado: bordasEsperadas(raw, hz) };
  }
  lab.observar("portadoras", medidas);
  for (const m of Object.values(medidas)) assert.ok(Math.abs(m.bordas - m.esperado) <= m.esperado * 0.15, JSON.stringify(m));
  const razao = medidas[56000].bordas / medidas[38000].bordas;
  assert.ok(Math.abs(razao - 56 / 38) < 0.12, `edge ratio ${razao.toFixed(3)} for a carrier ratio of ${(56 / 38).toFixed(3)}`);
});

// A server that accepts connections and never answers keeps the firmware inside blocking HTTP and
// WebSocket calls (2.5 s connect and 2.5 s read timeouts) for most of each loop() pass. The switch is
// sampled by a 10 ms timer outside the loop, so neither a hold nor a tap may be lost to that.
cenario("Toque longo com o servidor inalcançável: o failsafe sai sem servidor", {
  inicial: "Placa em operação com failsafe gravado",
  falha: "o servidor passa a aceitar conexões sem responder; o switch é mantido por 6 s (tempo da placa) nesse período",
  exigido: ["o failsafe OFF é transmitido sem servidor", "a placa reconecta quando o servidor volta"],
  proibido: ["failsafe perdido enquanto a placa espera a rede", "reinício"],
  recuperacao: "a placa reconecta quando o servidor volta",
}, async (lab) => {
  const { placa, sala, via } = await lab.placaEmOperacao();
  await lab.definirFailsafe(sala, { raw: RAW_FAILSAFE });
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.configurado === true, { descricao: "failsafe stored" });
  via.modo = "buraco";
  via.cortarTudo();
  await placa.aguardarVirtual(10_000);
  const desde = placa.marca();
  const antes = placa.bordas.length;
  await placa.pressionarBotao(6000);
  const soltou = await placa.agoraMs();
  // The timer records the hold at 5 s; loop() transmits when it next runs, which with a silent server
  // can be a blocking call (at most 2.5 s connect plus 2.5 s read) later.
  await placa.aguardarSerial(/Failsafe OFF transmitido localmente/, { desde, limiteMs: 300_000 });
  const atraso = Math.round((await placa.agoraMs()) - soltou);
  lab.observar("atrasoDoFailsafeAposSoltarMsVirtual", atraso);
  assert.ok(atraso <= 10_000, `the failsafe went out ${atraso} ms of board time after the release`);
  assert.ok(placa.bordasDe(4, antes).length > 0, "the failsafe went out with no server");
  assert.doesNotMatch(placa.serial.slice(desde), /Switch: RemoteIFES-Setup/, "a hold is not taken for a tap");
  assert.equal(reinicios(placa, desde), 0);
  via.modo = "normal";
  via.cortarTudo();
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
});

cenario("Toques curtos com o servidor inalcançável: nenhum se perde", {
  inicial: "Placa em operação",
  falha: "o servidor passa a aceitar conexões sem responder; oito toques de 300 ms, a cada 12 s (tempo da placa)",
  exigido: ["cada toque é reconhecido: o primeiro abre o RemoteIFES-Setup e cada um dos outros prorroga a janela"],
  proibido: ["toque perdido enquanto a placa espera a rede", "reinício"],
  recuperacao: "a placa reconecta quando o servidor volta, com o AP temporário ainda aberto",
}, async (lab) => {
  const { placa, sala, via } = await lab.placaEmOperacao();
  via.modo = "buraco";
  via.cortarTudo();
  await placa.aguardarVirtual(10_000);
  const desde = placa.marca();
  for (let i = 0; i < 8; i++) {
    await placa.pressionarBotao(300);
    await placa.aguardarVirtual(12_000);
  }
  const abertos = placa.contarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, desde);
  const prorrogados = placa.contarSerial(/Switch: janela do RemoteIFES-Setup prorrogada/, desde);
  lab.observar("toquesReconhecidos", { abertos, prorrogados });
  assert.equal(abertos, 1);
  assert.equal(prorrogados, 7, "every later tap extended the window");
  assert.equal(reinicios(placa, desde), 0);
  via.modo = "normal";
  via.cortarTudo();
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
});
