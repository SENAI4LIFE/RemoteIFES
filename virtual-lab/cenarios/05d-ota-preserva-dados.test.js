"use strict";

// OTA on the real firmware: what the installed release left in flash (NVS configuration and
// credential, the LittleFS portal files) is used as it is by the new image, which OTA never rewrites.
// With base_ref (LAB_FIRMWARE_BASE_DIR), producao is an older release built on its own platform, so this
// is the upgrade a board already in the field takes. Invariant, helpers and limits: see ota-comum.js.

const assert = require("node:assert/strict");
const util = require("util");
const flash = require("../lib/flash");
const { cenarioOta, emOperacao, otaValidoConclui } = require("./ota-comum");

// Written by the firmware itself for the OTA attempt (OTA_TENTATIVA_KEY, OTA_SHA_KEY in main.ino).
const CHAVES_DO_OTA = ["otaTent", "otaSha"];

function namespaceComparavel(lab, placa) {
  const ns = lab.nvs(placa);
  const chaves = {};
  for (const [k, v] of Object.entries(ns.chaves)) chaves[k] = Buffer.isBuffer(v.valor) ? { ...v, valor: v.valor.toString("hex") } : v;
  return { existe: ns.existe, chaves, duplicadas: ns.duplicadas, corrompidas: ns.corrompidas };
}

// The heap each image reports when its session opens (device-ws-diagnostico): only the room and integers.
function ultimoDiagnostico(lab, sala) {
  const linhas = String(lab.servidor.saida || "").split("\n").filter((l) => l.includes("[device-ws-diagnostico]"));
  for (const l of linhas.reverse()) {
    try {
      const d = JSON.parse(l.slice(l.indexOf("{")));
      if (d.sala === sala) return { heapLivre: d.heapLivre, heapMinimo: d.heapMinimo, heapMaiorBloco: d.heapMaiorBloco, uptimeS: d.uptimeS };
    } catch {}
  }
  return null;
}

cenarioOta("OTA preserva a configuração na NVS e os arquivos do LittleFS", {
  inicial: "Placa na versão instalada (producao), configurada pelo portal e conectada com a própria credencial",
  falha: "nenhuma",
  exigido: [
    "o candidato autentica com a credencial e a configuração gravadas pela versão instalada",
    "cada chave da NVS gravada pela versão instalada fica idêntica; só surgem as chaves do próprio OTA",
    "o candidato monta o LittleFS gravado pela versão instalada, sem formatá-lo",
    "um comando explícito é confirmado pelo candidato",
  ],
  proibido: ["NVS reescrita ou corrompida", "LittleFS formatado ou alterado", "falha ao montar o LittleFS"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  const antes = namespaceComparavel(lab, ctx.placa);
  const fsAntes = flash.hashParticao(lab.lerFlash(ctx.placa), { nome: "spiffs" });
  assert.ok(antes.existe, "the installed release wrote its configuration");
  for (const k of ["ssid", "host", "porta", "devId", "devSec"]) assert.ok(k in antes.chaves, `the installed release stored ${k}`);
  const heapAntes = ultimoDiagnostico(lab, ctx.sala);
  const desde = ctx.placa.marca();
  await otaValidoConclui(lab, ctx);
  const serial = ctx.placa.serial.slice(desde);
  assert.doesNotMatch(serial, /Falha ao montar LittleFS/);
  const depois = namespaceComparavel(lab, ctx.placa);
  lab.observar("nvs", { chavesAntes: Object.keys(antes.chaves).sort(), chavesDepois: Object.keys(depois.chaves).sort(), corrompidas: depois.corrompidas, duplicadas: depois.duplicadas });
  assert.equal(depois.corrompidas.length + depois.duplicadas.length, 0, "no corrupt or duplicate NVS entry after the upgrade");
  for (const k of Object.keys(antes.chaves)) assert.ok(util.isDeepStrictEqual(depois.chaves[k], antes.chaves[k]), `NVS key ${k} is unchanged by the upgrade`);
  for (const k of Object.keys(depois.chaves)) assert.ok(k in antes.chaves || CHAVES_DO_OTA.includes(k), `NVS key ${k} appeared during the upgrade`);
  assert.equal(flash.hashParticao(lab.lerFlash(ctx.placa), { nome: "spiffs" }), fsAntes, "the LittleFS partition is unchanged by the upgrade");
  assert.equal((await lab.api("POST", "/comando", { sala: ctx.sala, cmd: "desligar" })).status, 200);
  await lab.aguardarConfirmada(ctx.sala, { limiteMs: 240_000 });
  const heap = { [ctx.base.versao + " (producao)"]: heapAntes, [ctx.candidato.versao + " (candidato)"]: ultimoDiagnostico(lab, ctx.sala) };
  lab.observar("heap", heap);
  console.log(`heap por imagem: ${JSON.stringify(heap)}`);
});
