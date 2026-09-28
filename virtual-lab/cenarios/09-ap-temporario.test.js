"use strict";

// The temporary setup AP (a short press on the switch) while the board stays connected (AP+STA).
//
// The lab's Wi-Fi network is 192.168.4.0/24, the subnet the firmware gives its factory setup AP, so this is
// also a site whose network already uses 192.168.4.x. Firmware up to 4.3.0 opened the temporary AP in that
// same subnet: the session already open went on, but a connection lost while the AP was open could not
// be made again until it closed, ten minutes after the last press. The temporary AP now moves to
// 192.168.5.1 in that case. (The portal itself is out of reach here: a user reaches it by joining the AP,
// and this emulator's radio carries one link, the board's station, while the AP is open.)

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

async function abrirApTemporario(lab) {
  const ctx = await lab.placaEmOperacao();
  const desde = ctx.placa.marca();
  await ctx.placa.pressionarBotao(300);
  const m = await ctx.placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente em (\S+);/, { desde });
  lab.observar("enderecoDoApTemporario", m[1]);
  await ctx.placa.aguardarVirtual(5_000);
  return { ...ctx, desde, endereco: m[1] };
}

cenario("Com o AP temporário aberto, a sessão existente continua e atende comandos", {
  inicial: "Placa em operação, conectada, numa rede 192.168.4.0/24",
  falha: "toque curto no switch: o AP RemoteIFES-Setup abre com a placa conectada",
  exigido: ["a sessão aberta antes do AP continua", "um comando é aplicado e confirmado com o AP aberto"],
  proibido: ["sessão perdida", "reinício"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const { placa, sala, via, desde } = await abrirApTemporario(lab);
  const sessoes = via.conexoesDo("ws").length;
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarIntencaoAplicada(sala, true, { limiteMs: 180_000 });
  assert.equal(via.conexoesDo("ws").length, sessoes, "the session was not replaced");
  assert.equal(reinicios(placa, desde), 0);
});

cenario("Com o AP temporário aberto numa rede 192.168.4.0/24, uma conexão perdida é refeita", {
  inicial: "Placa em operação numa rede 192.168.4.0/24; AP temporário aberto",
  falha: "todas as conexões caem com o AP aberto",
  exigido: ["o AP temporário fica fora da sub-rede da rede Wi-Fi (192.168.5.1)", "a placa reconecta antes de o AP fechar"],
  proibido: ["AP temporário na sub-rede da estação", "placa sem servidor até o AP fechar (10 minutos)", "reinício"],
  recuperacao: "sessão nova com o AP ainda aberto",
}, async (lab) => {
  const { placa, sala, via, desde, endereco } = await abrirApTemporario(lab);
  assert.equal(endereco, "192.168.5.1", "the temporary AP left the station's subnet");
  const sessoes = via.conexoesDo("ws").length;
  via.cortarTudo();
  await lab.aguardarDesconectada(sala);
  await lab.aguardarConectada(sala, { limiteMs: 240_000 });
  lab.observar("tentativasWs", via.conexoesDo("ws").length - sessoes);
  assert.doesNotMatch(placa.serial.slice(desde), /RemoteIFES-Setup encerrado/, "the AP was still open when the board reconnected");
  assert.equal(reinicios(placa, desde), 0);
});
