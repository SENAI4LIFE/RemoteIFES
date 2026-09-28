"use strict";

// The temporary setup AP (a short press on the switch) while the board stays connected (AP+STA).
//
// The emulator's Wi-Fi network is 192.168.4.0/24, the subnet the firmware always gives its setup AP
// (192.168.4.1), so with the AP open the board has two interfaces in one subnet, as it would on a site
// whose Wi-Fi uses 192.168.4.0/24. The portal itself is out of reach here: a user reaches it by joining
// the AP, and this emulator's radio carries one link, the board's station, while the AP is open.
//
// Diagnostic pair: a new connection made while the AP is open, with the production firmware and with
// the same firmware whose temporary AP is moved to 192.168.5.1 (variant apEmOutraSubrede). If only the
// variant reconnects, the shared subnet is what stops it.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

async function abrirApTemporario(lab, variante) {
  const ctx = await lab.placaEmOperacao({ variante });
  const desde = ctx.placa.marca();
  await ctx.placa.pressionarBotao(300);
  await ctx.placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, { desde });
  await ctx.placa.aguardarVirtual(5_000);
  return { ...ctx, desde };
}

cenario("Com o AP temporário aberto, a sessão existente continua e atende comandos", {
  inicial: "Placa em operação, conectada, na rede 192.168.4.0/24",
  falha: "toque curto no switch: o AP RemoteIFES-Setup abre em 192.168.4.1 com a placa conectada",
  exigido: ["a sessão aberta antes do AP continua", "um comando é aplicado e confirmado com o AP aberto"],
  proibido: ["sessão perdida", "reinício"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const { placa, sala, via, desde } = await abrirApTemporario(lab, "producao");
  const sessoes = via.conexoesDo("ws").length;
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarIntencaoAplicada(sala, true, { limiteMs: 180_000 });
  assert.equal(via.conexoesDo("ws").length, sessoes, "the session was not replaced");
  assert.equal(reinicios(placa, desde), 0);
});

async function reconectaComApAberto(lab, variante) {
  const { placa, sala, via, desde } = await abrirApTemporario(lab, variante);
  const sessoes = via.conexoesDo("ws").length;
  via.cortarTudo();
  await lab.aguardarDesconectada(sala);
  let reconectou = true;
  try {
    await lab.aguardarConectada(sala, { limiteMs: 240_000 });
  } catch {
    reconectou = false;
  }
  lab.observar("reconectouComApAberto", reconectou);
  lab.observar("tentativasWs", via.conexoesDo("ws").length - sessoes);
  assert.equal(reinicios(placa, desde), 0);
  assert.ok(reconectou, "a connection lost while the setup AP is open is made again while it is still open");
}

cenario("Diagnóstico: nova conexão com o AP temporário na mesma sub-rede da rede Wi-Fi", {
  inicial: "Placa em operação na rede 192.168.4.0/24; AP temporário aberto em 192.168.4.1",
  falha: "todas as conexões caem com o AP aberto",
  exigido: ["a placa reconecta antes de o AP fechar"],
  proibido: ["placa sem servidor até o AP fechar (10 minutos)"],
  recuperacao: "sessão nova",
}, (lab) => reconectaComApAberto(lab, "producao"));

cenario("Diagnóstico: nova conexão com o AP temporário em outra sub-rede", {
  inicial: "Placa em operação na rede 192.168.4.0/24; firmware com o AP temporário movido para 192.168.5.1",
  falha: "todas as conexões caem com o AP aberto",
  exigido: ["a placa reconecta antes de o AP fechar"],
  proibido: ["placa sem servidor até o AP fechar (10 minutos)"],
  recuperacao: "sessão nova",
  firmware: ["producao", "apEmOutraSubrede"],
}, (lab) => reconectaComApAberto(lab, "apEmOutraSubrede"));
