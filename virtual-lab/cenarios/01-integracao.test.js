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
    "ligar gera a transmissão IR no GPIO 4, o buzzer pulsa no GPIO 27 e a placa relata o estado",
    "o servidor confirma o estado desejado pelo eco da versão na telemetria",
  ],
  proibido: ["IR ou buzzer ativos entre ligar a placa e abrir a sessão", "entradas duplicadas ou corrompidas na NVS"],
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
  // No IR from power-on until the session is open. Right after it opens the server restores the
  // room's desired state (restauracao: true), and that transmission is expected.
  const conectouEm = placa.momentoDoSerial(/WS servidor: conectado/);
  assert.ok(conectouEm, "the board logged its WebSocket session");
  const antesDaSessao = placa.bordas.filter((b) => (b.pino === 4 || b.pino === 27) && b.ms < conectouEm).length;
  const restauracao = placa.bordas.filter((b) => b.pino === 4 && b.ms >= conectouEm).length;
  lab.observar("bordasIrEBuzzerAntesDaSessao", antesDaSessao);
  lab.observar("bordasIrDaRestauracao", restauracao);
  assert.equal(antesDaSessao, 0, "no IR or buzzer activity from power-on to the session");

  // One command from the panel.
  const antes = placa.bordas.length;
  const cmd = await lab.api("POST", "/comando", { sala: "A-103a", cmd: "ligar" });
  assert.equal(cmd.status, 200, JSON.stringify(cmd.corpo));
  const confirmado = await lab.aguardarConfirmada("A-103a", { limiteMs: 120_000 });
  const ir = placa.bordasDe(4, antes);
  const buzzer = placa.bordasDe(27, antes);
  lab.observar("comando", { ultimoComando: confirmado.dispositivo.ultimoComando, bordasIr: ir.length, buzzer: buzzer.map((b) => b.nivel) });
  assert.ok(ir.length > 1000, `a modulated IR frame on GPIO 4 (${ir.length} edges)`);
  assert.equal(ir.filter((b) => b.nivel === 1).length, ir.filter((b) => b.nivel === 0).length, "the carrier ends low");
  assert.deepEqual(buzzer.map((b) => b.nivel).slice(0, 2), [1, 0], "the buzzer sounds and stops");
  assert.equal(confirmado.dispositivo.ultimoComando.power, true);
  assert.equal(confirmado.dispositivo.ultimoComando.protocol, 16);

  // Telemetry without a DHT11 attached: the only sensor claim the lab makes.
  const telemetria = await lab.aguardar(async () => {
    const e = await lab.estado("A-103a");
    return e.dispositivo.ultimaTelemetria && e.dispositivo.ultimaTelemetria.rssi !== undefined ? e.dispositivo.ultimaTelemetria : false;
  }, { descricao: "telemetry" });
  lab.observar("telemetriaSemSensor", telemetria);
  assert.equal(telemetria.temp, null, "no temperature is invented without a sensor");
  assert.equal(telemetria.hum, null);
});
