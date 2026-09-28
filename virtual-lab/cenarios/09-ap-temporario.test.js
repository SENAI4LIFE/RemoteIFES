"use strict";

// The temporary setup AP (a short press on the switch) while the board stays connected (AP+STA).
//
// The emulator's Wi-Fi network is 192.168.4.0/24, the subnet the firmware always gives its setup AP
// (192.168.4.1). With the AP open the board then has two interfaces in one subnet. The same firmware is
// run with its AP moved to 192.168.5.1 (diagnostic variant apEmOutraSubrede): if only that one keeps its
// session, the overlap is what breaks it, and it would break a real board on a site network that uses
// 192.168.4.0/24; if neither does, AP+STA is beyond what this emulator carries.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

async function tocarEComandar(lab, variante) {
  const { placa, sala, via } = await lab.placaEmOperacao({ variante });
  const desde = placa.marca();
  const sessoes = via.conexoesDo("ws").length;
  await placa.pressionarBotao(300);
  await placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, { desde });
  await placa.aguardarVirtual(15_000);
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  let aplicado = true;
  try {
    await lab.aguardarIntencaoAplicada(sala, true, { limiteMs: 180_000 });
  } catch (erro) {
    aplicado = erro.message;
  }
  lab.observar("comandoComApAberto", aplicado);
  lab.observar("sessoesWsDepoisDoToque", via.conexoesDo("ws").length - sessoes);
  assert.equal(aplicado, true, "with the setup AP open the board keeps serving commands");
}

cenario("AP temporário com o AP na mesma sub-rede da rede Wi-Fi (192.168.4.0/24)", {
  inicial: "Placa em operação, conectada, na rede 192.168.4.0/24",
  falha: "toque curto no switch: o AP RemoteIFES-Setup abre em 192.168.4.1 com a placa conectada",
  exigido: ["a placa continua atendendo comandos com o AP aberto"],
  proibido: ["sessão perdida enquanto o AP está aberto"],
  recuperacao: "não se aplica",
  firmware: ["producao"],
}, (lab) => tocarEComandar(lab, "producao"));

cenario("AP temporário com o AP em outra sub-rede (diagnóstico)", {
  inicial: "Placa em operação, conectada, na rede 192.168.4.0/24; firmware com o AP movido para 192.168.5.1",
  falha: "toque curto no switch: o AP RemoteIFES-Setup abre em 192.168.5.1 com a placa conectada",
  exigido: ["a placa continua atendendo comandos com o AP aberto"],
  proibido: ["sessão perdida enquanto o AP está aberto"],
  recuperacao: "não se aplica",
  firmware: ["apEmOutraSubrede"],
}, (lab) => tocarEComandar(lab, "apEmOutraSubrede"));
