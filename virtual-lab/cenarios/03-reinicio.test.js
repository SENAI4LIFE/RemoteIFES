"use strict";

// The reset button (EN) pressed at exact points of the real firmware, then recovery against the real
// server. Stop points are reached through the emulator's GDB stub, so "right after authentication"
// means that instruction, not "about then".

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

/** After a reset the board reconnects once and the server confirms the current intent again. */
async function recupera(lab, placa, sala, desde, { ligado }) {
  await placa.aguardarSerial(/--- RemoteIFES IR System Initializing/, { desde });
  const e = await lab.aguardarConfirmada(sala, { limiteMs: 300_000 });
  assert.equal(Boolean(e.dispositivo.ultimoComando && e.dispositivo.ultimoComando.power), ligado, "the confirmed state is the intent");
  assert.equal(reinicios(placa, desde), 1, "one reset, no loop");
  return e;
}

const pontos = [
  {
    nome: "Reset durante a operação normal",
    falha: "reset em um instante qualquer da operação (sem ponto de parada)",
    parar: null,
  },
  {
    nome: "Reset logo depois da autenticação do WebSocket",
    falha: "reset na instrução seguinte à abertura da sessão autenticada, antes de a placa enviar info",
    parar: { trecho: 'Serial.println("WS servidor: conectado.");' },
    religarAntes: true,
  },
  {
    nome: "Reset durante o processamento de um comando, antes do IR",
    falha: "reset na chamada que transmite o estado recebido, depois de o comando ter chegado",
    parar: { trecho: "sendKnownACState((decode_type_t)protocolo, temp, power, turbo, fan, swing);" },
    comandoDispara: true,
  },
  {
    nome: "Reset no meio de uma transmissão IR",
    falha: "reset dentro da 60ª marca do quadro IR (biblioteca IRremoteESP8266), com o LED modulando",
    parar: { funcao: "IRsend::mark", ocorrencia: 60 },
    comandoDispara: true,
    ledApagado: true,
  },
  {
    nome: "Reset durante o envio de telemetria",
    falha: "reset enquanto a placa monta a segunda telemetria da sessão",
    parar: { trecho: 'doc["tipo"] = "telemetria";', ocorrencia: 2 },
  },
];

for (const p of pontos) {
  cenario(p.nome, {
    inicial: "Placa conectada, intenção ligada confirmada (exceto quando o próprio comando é o gatilho)",
    falha: p.falha,
    exigido: ["a placa reinicia uma vez, reconecta e o servidor volta a confirmar a intenção vigente", ...(p.ledApagado ? ["o LED IR (GPIO 4) fica apagado depois do reset"] : [])],
    proibido: ["laço de reinícios", "estado confirmado diferente da intenção", "sessão duplicada"],
    recuperacao: "estado confirmado igual à intenção",
  }, async (lab) => {
    const via = await lab.intermediario();
    const { placa, sala } = await lab.placaEmOperacao({ via });
    let ligado = false;
    if (!p.comandoDispara) {
      assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
      await lab.aguardarConfirmada(sala);
      ligado = true;
    }
    if (p.religarAntes) {
      // The stop point sits in session setup, so the board must open a new session to reach it.
      const parada = placa.pararEm(p.parar.trecho, { acao: "resetar" });
      await new Promise((r) => setTimeout(r, 1500));
      via.cortarTudo();
      const desde = placa.marca();
      await parada;
      await recupera(lab, placa, sala, desde, { ligado });
    } else if (p.parar) {
      const parada = placa.pararEm(p.parar.trecho, { acao: "resetar", funcao: p.parar.funcao || null, ocorrencia: p.parar.ocorrencia || 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const desde = placa.marca();
      if (p.comandoDispara) {
        assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
        ligado = true;
      }
      await parada;
      if (p.ledApagado) {
        await placa.aguardarSerial(/--- RemoteIFES IR System Initializing/, { desde });
        const pinos = await placa.estadoPinos();
        lab.observar("gpio4AposReset", pinos[4]);
        assert.equal(pinos[4].nivel, 0, "the IR LED is off after the reset");
      }
      await recupera(lab, placa, sala, desde, { ligado });
    } else {
      await placa.aguardarVirtual(3000);
      const desde = placa.marca();
      await placa.resetar();
      await recupera(lab, placa, sala, desde, { ligado });
    }
    await placa.aguardarVirtual(10_000);
    const vivas = via.conexoesDo("ws").filter((c) => !c.fim).length;
    lab.observar("sessoesVivas", vivas);
    assert.equal(vivas, 1, "one session");
  });
}
