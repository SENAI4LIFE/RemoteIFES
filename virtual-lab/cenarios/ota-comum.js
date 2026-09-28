"use strict";

// OTA on the real firmware, real bootloader and real partition layout (min_spiffs.csv).
//
// Invariant for every failure: no failed OTA attempt may destroy the last known-good bootable
// firmware. It is checked from the flash itself: the bootloader's choice (otadata), and the exact bytes
// of the known-good image still in its slot. Recovery is always the same: a valid OTA then completes.
//
// The emulator writes flash instantly and never loses power mid-sector, so a power cut here is "the
// chip stops at this instruction"; it says nothing about a real flash sector under brownout.
//
// Shared by the 05*-ota scenario files; not a test file itself.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cenario } = require("../lib/laboratorio");

const cenarioOta = (nome, meta, corpo) => cenario(nome, { firmware: ["producao", "candidato"], ...meta }, corpo);

// Firmware downloads cross a 32 KiB/s link: an image then takes about 40 s, so several of the server's
// 15 s keepalive pings fall inside it, as they do on a busy campus Wi-Fi.
const RITMO_DOWNLOAD = 32 * 1024;

async function emOperacao(lab) {
  const via = await lab.intermediario();
  via.ritmoFirmware = RITMO_DOWNLOAD;
  const { placa, sala } = await lab.placaEmOperacao({ via });
  const base = lab.firmware("producao");
  const candidato = lab.firmware("candidato");
  return { via, placa, sala, base, candidato };
}

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

/** The last known-good image is in ota_0, byte for byte, and the bootloader will start it. */
function ultimoBomIntacto(lab, placa, rotulo) {
  const s = lab.slots(placa);
  lab.observar(`slots:${rotulo}`, s);
  assert.equal(s.conteudo.ota_0, "producao", `${rotulo}: the known-good image is intact in ota_0`);
  assert.equal(s.boot, "ota_0", `${rotulo}: the bootloader still starts the known-good image`);
  return s;
}

/**
 * The outcome of the current attempt. A transfer failure the server only inferred (the socket dropped
 * or the deadline passed: `presumida`) is revised when the board later presents boot evidence for the
 * same attempt, so it is not final here; one the board reported is. Every phase seen is kept as evidence.
 */
async function desfechoOta(lab, sala, limiteMs = 900_000) {
  const historico = [];
  const final = await lab.aguardar(async () => {
    const ota = await lab.estadoOta(sala);
    if (!ota) return false;
    const ultimo = historico[historico.length - 1];
    if (!ultimo || ultimo.fase !== ota.fase || ultimo.causa !== (ota.causa || null)) historico.push({ fase: ota.fase, causa: ota.causa || null, presumida: ota.presumida === true });
    if (ota.fase === "concluido") return ota;
    if (ota.fase === "falhou" && !(ota.causa === "transferencia" && ota.presumida === true)) return ota;
    return false;
  }, { descricao: `final OTA outcome of ${sala}`, limiteMs });
  return { final, historico };
}

/**
 * The board keeps its WebSocket alive while the image flows: every server ping forwarded during the
 * download is answered within 10 s, each by its own pong. At least one ping must fall in the window,
 * or the check would prove nothing.
 */
function keepaliveDuranteDownload(lab, via, rotulo) {
  const download = via.conexoesDo("firmware").filter((c) => c.corpoInicioEm && c.corpoCompletoEm).pop();
  assert.ok(download, "a complete firmware download went through the network under test");
  const pings = via.pingsRespondidos(download.corpoInicioEm, download.corpoCompletoEm);
  lab.observar(`keepalive:${rotulo}`, { downloadS: Math.round((download.corpoCompletoEm - download.corpoInicioEm) / 1000), pings: pings.map((p) => p.respostaMs) });
  assert.ok(pings.length >= 1, "no server ping fell inside the download window; the keepalive was not exercised");
  for (const p of pings) assert.ok(p.respostaMs !== null && p.respostaMs < 10_000, `a ping sent during the download was answered after ${p.respostaMs} ms`);
}

/** Recovery: with the network healthy again, a valid OTA completes and validates. */
async function otaValidoConclui(lab, { via, placa, sala, candidato }) {
  via.firmware = {};
  via.modo = "normal";
  await lab.publicarFirmware(candidato.app, candidato.versao);
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  const desde = placa.marca();
  const oferta = await lab.ofertarOta(sala);
  assert.equal(oferta.status, 200, JSON.stringify(oferta.corpo));
  const { final: fim, historico } = await desfechoOta(lab, sala);
  lab.observar("recuperacao", { fase: fim.fase, erro: fim.erro, causa: fim.causa, historico });
  assert.equal(fim.fase, "concluido", `the next valid OTA completes (${fim.erro})`);
  keepaliveDuranteDownload(lab, via, "recuperacao");
  await placa.aguardarSerial(/Autovalidacao OK: novo firmware confirmado/, { desde });
  const s = lab.slots(placa);
  lab.observar("slotsAposRecuperacao", s);
  assert.equal(s.boot, "ota_1");
  assert.equal(s.estado.ota_1, "VALID");
  assert.equal(s.conteudo.ota_1, "candidato");
  assert.equal((await lab.estado(sala)).dispositivo.fwVersao, candidato.versao);
}

/** Waits until the download is past `bytes` of the image, as seen on the wire. */
function downloadPassou(lab, via, bytes) {
  return lab.aguardar(() => via.conexoesDo("firmware").some((c) => c.corpoParaPlaca >= bytes), { descricao: `download past ${bytes} bytes`, limiteMs: 300_000, intervaloMs: 100 });
}


module.exports = { cenarioOta, emOperacao, reinicios, ultimoBomIntacto, desfechoOta, keepaliveDuranteDownload, otaValidoConclui, downloadPassou };
