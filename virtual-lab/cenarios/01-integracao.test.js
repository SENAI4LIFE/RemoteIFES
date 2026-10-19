"use strict";

// The real firmware, configured the way an installer does it, operating against the real server.

const assert = require("node:assert/strict");
const { cenario, MAC_PLACA } = require("../lib/laboratorio");

cenario("Fábrica, portal, Wi-Fi, credencial, comando e confirmação", {
  inicial: "Placa com a imagem de fábrica (NVS vazia) e servidor com a sala vinculada ao MAC e credencial emitida",
  falha: "nenhuma: caminho feliz completo, é a referência dos demais cenários",
  exigido: [
    "sem configuração a placa abre o RemoteIFES-Setup e serve o portal",
    "o formulário grava a configuração na NVS e a placa reinicia sozinha em operação",
    "o WebSocket autentica com a credencial por dispositivo e o servidor vê fw, MAC e transporte direto",
    "o LED de conexão (GPIO 25) acende antes da sessão e apaga com ela",
    "a sessão aberta soa o buzzer e a sincronização que o servidor envia não transmite IR",
    "ligar gera a transmissão IR no GPIO 4, com o buzzer no GPIO 27 ligado ao menos 100 ms antes, e a placa relata o estado",
    "o servidor confirma o estado desejado pelo eco da versão na telemetria",
  ],
  proibido: ["IR ou buzzer ativos entre ligar a placa e abrir a sessão", "IR na sincronização da sessão", "entradas duplicadas ou corrompidas na NVS"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const credencial = await lab.prepararSala("A-103a");
  const via = await lab.intermediario();
  const placa = lab.novaPlaca({ via });
  await placa.ligar();

  await lab.configurarPeloPortal(placa, { credencial });
  await placa.aguardarSerial(/Conectando a rede salva: MasseyWifi/);
  const estado = await lab.aguardarConectada("A-103a", { limiteMs: 240_000 });
  const d = estado.dispositivo;
  lab.observar("servidorVe", { fw: d.fwVersao, mac: d.mac, transporte: d.transporte, credencial: estado.credencial });
  assert.equal(d.fwVersao, lab.firmware().versao);
  assert.equal(d.mac, MAC_PLACA);
  assert.equal(d.transporte, "direto");

  // What the configuration left in the board's own NVS.
  await placa.aguardarVirtual(500);
  const nvs = lab.nvs(placa);
  lab.observar("chavesNvs", Object.keys(nvs.chaves).sort());
  assert.equal(nvs.chaves.devId.valor, credencial.deviceId);
  assert.equal(nvs.chaves.devSec.valor, credencial.segredo);
  assert.equal(nvs.chaves.tls.valor, "off");
  assert.deepEqual(nvs.duplicadas, []);
  assert.deepEqual(nvs.corrompidas, []);

  // Pins as the chip's registers hold them in operation.
  const pinos = await placa.estadoPinos();
  lab.observar("pinos", pinos);
  assert.equal(pinos[4].saida, true, "GPIO 4 (IR) is an output");
  assert.equal(pinos[4].nivel, 0, "the IR LED is off at rest");
  assert.equal(pinos[27].saida, true, "GPIO 27 (buzzer) is an output");
  assert.equal(pinos[27].nivel, 0, "the buzzer is silent at rest");
  assert.equal(pinos[26].saida, false, "GPIO 26 (switch) is an input");
  assert.equal(pinos[26].pullUp, true, "the switch has its internal pull-up enabled");
  assert.equal(pinos[25].saida, true, "GPIO 25 (network LED) is an output");
  assert.equal(pinos[25].nivel, 0, "the network LED is off while the server channel is open");
  // No IR from power-on until the session is open. Right after it opens the server sends the room's
  // desired state as a restoration (restauracao: true), which the board takes without transmitting.
  const conectouEm = placa.momentoDoSerial(/WS servidor: conectado/);
  assert.ok(conectouEm, "the board logged its WebSocket session");
  await placa.aguardarSerial(/Sincronizacao do servidor recebida sem transmissao IR/);
  await placa.aguardarVirtual(1000);
  const irEBuzzer = placa.bordas.filter((b) => b.pino === 4 || b.pino === 27);
  const ledAntesDaSessao = placa.bordas.filter((b) => b.pino === 25 && b.nivel === 1 && b.ms < conectouEm).length;
  lab.observar("bordasIrEBuzzerAteASincronizacao", irEBuzzer.map((b) => `${b.pino}:${b.nivel}`));
  lab.observar("ledAcesoAntesDaSessao", ledAntesDaSessao);
  assert.deepEqual(irEBuzzer.map((b) => `${b.pino}:${b.nivel}`), ["27:1", "27:0"], "from power-on through the session and its restoration: no IR, and the buzzer only once, for the session");
  const sessao = via.conexoesDo("ws").find((c) => / 101 /.test(c.resposta || ""));
  assert.ok(sessao, "the server accepted the board's WebSocket through the lab's network");
  assert.ok(irEBuzzer[0].ms >= sessao.respostaEm, "no buzzer before the session: the beep can only follow the server's 101, which the lab records as it relays it");
  assert.ok(ledAntesDaSessao > 0, "the network LED was lit before the session");

  // One command from the panel.
  const antes = placa.bordas.length;
  let confirmado;
  const passoUs = await placa.comRelogioFino(async () => {
    const cmd = await lab.api("POST", "/comando", { sala: "A-103a", cmd: "ligar" });
    assert.equal(cmd.status, 200, JSON.stringify(cmd.corpo));
    confirmado = await lab.aguardarConfirmada("A-103a", { limiteMs: 120_000 });
    // The board reports right after the IR frame; the buzzer is switched off by loop() a moment later.
    await lab.aguardar(() => placa.bordasDe(27, antes).some((b) => b.nivel === 0), { descricao: "buzzer off after the transmission", limiteMs: 60_000, intervaloMs: 100 });
  });
  const ir = placa.bordasDe(4, antes);
  const buzzer = placa.bordasDe(27, antes);
  const aviso = placa.antecedenciaDoBuzzer(antes);
  lab.observar("comando", { bordasIr: ir.length, buzzer: buzzer.map((b) => b.nivel), buzzerAntesDoIrUs: aviso.us, passoDoRelogioUs: passoUs });
  assert.ok(ir.length > 1000, `a modulated IR frame on GPIO 4 (${ir.length} edges)`);
  assert.equal(ir.filter((b) => b.nivel === 1).length, ir.filter((b) => b.nivel === 0).length, "the carrier ends low");
  assert.deepEqual(buzzer.map((b) => b.nivel).slice(0, 2), [1, 0], "the buzzer sounds and stops");
  assert.ok(aviso.buzzerAntesDoIr, "the buzzer rises before the first IR edge");
  assert.ok(passoUs < 20_000, `the board clock was read every ${passoUs} µs at most`);
  assert.ok(aviso.us >= 100_000 - 2 * passoUs, `the buzzer led the IR by ${aviso.us} µs of board time (clock step ${passoUs} µs)`);
  assert.equal(confirmado.dispositivo.estadoConfirmado, true);
  const { relato } = await lab.aguardarIntencaoAplicada("A-103a", true);
  lab.observar("relatoDaPlaca", relato);
  assert.equal(relato.protocol, 16, "the board reports the room's protocol");

  // Telemetry without a DHT11 attached: the only sensor claim the lab makes.
  const telemetria = await lab.aguardar(async () => {
    const e = await lab.estado("A-103a");
    return e.dispositivo.ultimaTelemetria && e.dispositivo.ultimaTelemetria.rssi !== undefined ? e.dispositivo.ultimaTelemetria : false;
  }, { descricao: "telemetry" });
  lab.observar("telemetriaSemSensor", telemetria);
  assert.equal(telemetria.temp, null, "no temperature is invented without a sensor");
  assert.equal(telemetria.hum, null);
});
