"use strict";

// OTA on the real firmware: candidates that must roll back to the known-good image.
// Invariant, helpers and limits: see ota-comum.js.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cenarioOta, emOperacao, reinicios, ultimoBomIntacto, desfechoOta, keepaliveDuranteDownload, otaValidoConclui, downloadPassou } = require("./ota-comum");

cenarioOta("Candidato que não alcança o servidor volta sozinho à versão anterior", {
  inicial: "Placa na versão de produção, conectada; candidato publicado e ofertado",
  falha: "a rede passa a recusar as conexões da placa no instante em que ela termina de gravar o candidato",
  exigido: [
    "o candidato inicia pendente de validação",
    "sem canal com o servidor por 90 s (tempo da placa), ele se marca inválido e o bootloader volta à versão de ota_0",
    "ota_1 fica marcado como inválido",
  ],
  proibido: ["candidato confirmado sem ter falado com o servidor", "servidor registrando conclusão"],
  recuperacao: "com a rede de volta, a versão anterior reconecta e um OTA válido conclui",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  await lab.publicarFirmware(ctx.candidato.app, ctx.candidato.versao);
  const desde = ctx.placa.marca();
  assert.equal((await lab.ofertarOta(ctx.sala)).status, 200);
  await ctx.placa.aguardarSerial(/OTA: firmware gravado e verificado/, { desde, limiteMs: 600_000 });
  ctx.via.modo = "recusar";
  ctx.via.cortarTudo();
  await ctx.placa.aguardarSerial(new RegExp(`fw ${ctx.candidato.versao.replace(/\./g, "\\.")}\\)`), { desde });
  await ctx.placa.aguardarSerial(/aguardando autovalidacao/, { desde });
  const bootCandidato = await ctx.placa.agoraMs();
  await ctx.placa.aguardarSerial(/Autovalidacao falhou dentro do prazo: revertendo/, { desde, limiteMs: 1_200_000 });
  const prazoMs = (await ctx.placa.agoraMs()) - bootCandidato;
  lab.observar("candidatoPendenteMsVirtual", Math.round(prazoMs));
  assert.ok(prazoMs >= 85_000 && prazoMs <= 150_000, `rolled back after ${Math.round(prazoMs)} ms of board time (self-test deadline 90 s)`);
  const volta = ctx.placa.marca();
  await ctx.placa.aguardarSerial(new RegExp(`fw ${ctx.base.versao.replace(/\./g, "\\.")}\\)`), { desde: volta });
  const s = ultimoBomIntacto(lab, ctx.placa, "apos-rollback");
  assert.ok(["INVALID", "ABORTED"].includes(s.estado.ota_1), `ota_1 is ${s.estado.ota_1}`);
  assert.doesNotMatch(ctx.placa.serial.slice(desde), /Autovalidacao OK/);
  ctx.via.modo = "normal";
  await lab.aguardarConectada(ctx.sala, { limiteMs: 300_000 });
  assert.equal((await lab.estado(ctx.sala)).dispositivo.fwVersao, ctx.base.versao);
  const ota = await lab.aguardarFaseOta(ctx.sala, "falhou");
  lab.observar("servidor", { fase: ota.fase, causa: ota.causa, erro: ota.erro });
  await otaValidoConclui(lab, ctx);
});

cenarioOta("Candidato que aborta no boot: o bootloader volta à versão anterior", {
  inicial: "Placa na versão de produção, conectada",
  firmware: ["producao", "candidato", "candidatoQueAborta"],
  falha: "o firmware ofertado é a mesma fonte com abort() como primeira instrução de setup()",
  exigido: ["o candidato aborta uma vez e o bootloader passa a iniciar ota_0", "ota_1 marcado como abortado ou inválido"],
  proibido: ["laço de reinícios no candidato", "ota_0 alterado"],
  recuperacao: "a versão anterior reconecta e um OTA válido conclui",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  const quebrado = lab.firmware("candidatoQueAborta");
  const [a, b, c] = ctx.candidato.versao.split(".").map(Number);
  await lab.publicarFirmware(quebrado.app, `${a}.${b}.${c + 1}`);
  const desde = ctx.placa.marca();
  assert.equal((await lab.ofertarOta(ctx.sala)).status, 200);
  await ctx.placa.aguardarSerial(/OTA: firmware gravado e verificado/, { desde, limiteMs: 600_000 });
  await ctx.placa.aguardarSerial(/abort\(\) was called/, { desde });
  const volta = ctx.placa.marca();
  await ctx.placa.aguardarSerial(new RegExp(`fw ${ctx.base.versao.replace(/\./g, "\\.")}\\)`), { desde: volta, limiteMs: 300_000 });
  const abortos = ctx.placa.contarSerial(/abort\(\) was called/, desde);
  lab.observar("abortos", abortos);
  assert.equal(abortos, 1, "the broken image ran once");
  const s = ultimoBomIntacto(lab, ctx.placa, "apos-aborto");
  assert.ok(["ABORTED", "INVALID"].includes(s.estado.ota_1), `ota_1 is ${s.estado.ota_1}`);
  await lab.aguardarConectada(ctx.sala, { limiteMs: 300_000 });
  const ota = await lab.aguardarFaseOta(ctx.sala, "falhou");
  lab.observar("servidor", { fase: ota.fase, causa: ota.causa, erro: ota.erro });
  await otaValidoConclui(lab, ctx);
});
