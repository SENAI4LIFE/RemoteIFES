"use strict";

// Reads (and, for fault injection, edits) an ESP32 SPI flash image the way the chip's own software
// lays it out: the partition table, the OTA selection records (otadata) and ESP-IDF NVS pages.
//
// Only what the lab asserts or corrupts is implemented. Every CRC is checked on read, so a reader bug
// shows up as a mismatch against images the real firmware wrote, not as a silently wrong answer.

const crypto = require("crypto");
const zlib = require("zlib");

// esp_rom_crc32_le(crc, buf, len) is the zlib CRC-32 continued from `crc`.
const crc32 = (buf, inicial = 0xffffffff) => zlib.crc32(buf, inicial) >>> 0;

const TABELA_PARTICOES = 0x8000;
const TIPOS_APP = { 0x00: "factory", 0x10: "ota_0", 0x11: "ota_1" };

function lerParticoes(imagem) {
  const particoes = [];
  for (let off = TABELA_PARTICOES; off < TABELA_PARTICOES + 0xc00; off += 32) {
    const magia = imagem.readUInt16LE(off);
    if (magia !== 0x50aa) break;
    const tipo = imagem[off + 2];
    const subtipo = imagem[off + 3];
    const nome = imagem.subarray(off + 12, off + 28).toString("latin1").replace(/\0.*$/s, "");
    particoes.push({
      nome,
      tipo: tipo === 0 ? "app" : tipo === 1 ? "data" : tipo,
      subtipo: tipo === 0 ? TIPOS_APP[subtipo] || subtipo : subtipo,
      deslocamento: imagem.readUInt32LE(off + 4),
      tamanho: imagem.readUInt32LE(off + 8),
    });
  }
  if (!particoes.length) throw new Error("no partition table at 0x8000");
  return particoes;
}

function particao(imagem, filtro) {
  const p = lerParticoes(imagem).find((x) => Object.entries(filtro).every(([k, v]) => x[k] === v));
  if (!p) throw new Error(`partition not found: ${JSON.stringify(filtro)}`);
  return p;
}

// --- OTA selection -------------------------------------------------------------------------------

const ESTADOS_OTA = { 0: "NEW", 1: "PENDING_VERIFY", 2: "VALID", 3: "INVALID", 4: "ABORTED", 0xffffffff: "UNDEFINED" };

/**
 * The two otadata records and the slot the second-stage bootloader will pick: the highest valid
 * sequence whose state is not INVALID or ABORTED (bootloader_utility_get_selected_boot_partition).
 */
function lerOtadata(imagem) {
  const dados = particao(imagem, { tipo: "data", subtipo: 0 });
  const apps = lerParticoes(imagem).filter((p) => p.tipo === "app" && /^ota_/.test(p.subtipo));
  const registros = [0, 1].map((i) => {
    const off = dados.deslocamento + i * 0x1000;
    const seq = imagem.readUInt32LE(off);
    const estadoBruto = imagem.readUInt32LE(off + 24);
    const crc = imagem.readUInt32LE(off + 28);
    // The record CRC covers only ota_seq (esp_ota_select_entry_t.crc = crc32_le(UINT32_MAX, &ota_seq, 4)).
    const valido = seq !== 0xffffffff && crc === crc32(imagem.subarray(off, off + 4));
    return { seq, estado: ESTADOS_OTA[estadoBruto] ?? `0x${estadoBruto.toString(16)}`, valido };
  });
  const candidatos = registros.filter((r) => r.valido && !["INVALID", "ABORTED"].includes(r.estado));
  let boot = null;
  if (candidatos.length) {
    const melhor = candidatos.reduce((a, b) => (b.seq > a.seq ? b : a));
    boot = apps[((melhor.seq - 1) >>> 0) % apps.length].subtipo;
  } else {
    boot = apps[0].subtipo;
  }
  return { registros, boot, estadoDe: (slot) => estadoDoSlot(registros, apps, slot) };
}

function estadoDoSlot(registros, apps, slot) {
  const doSlot = registros.filter((r) => r.valido && apps[((r.seq - 1) >>> 0) % apps.length].subtipo === slot);
  if (!doSlot.length) return null;
  return doSlot.reduce((a, b) => (b.seq > a.seq ? b : a)).estado;
}

/** sha256 of a partition's bytes, to prove a slot was not touched. */
function hashParticao(imagem, filtro) {
  const p = particao(imagem, filtro);
  return crypto.createHash("sha256").update(imagem.subarray(p.deslocamento, p.deslocamento + p.tamanho)).digest("hex");
}

/**
 * Which of the known application binaries occupies a slot, compared byte for byte (the Arduino build
 * leaves FW_VERSAO out of esp_app_desc_t, so the image itself is the identity). Null when none match:
 * an erased, partial or foreign slot.
 */
function appNoSlot(imagem, slot, conhecidos) {
  const p = particao(imagem, { tipo: "app", subtipo: slot });
  for (const [nome, bin] of Object.entries(conhecidos)) {
    if (bin.length <= p.tamanho && imagem.subarray(p.deslocamento, p.deslocamento + bin.length).equals(bin)) return nome;
  }
  return null;
}

// --- NVS -----------------------------------------------------------------------------------------

const PAGINA = 4096;
const ENTRADAS = 126;
const ESTADO_PAGINA = { 0xfffffffe: "ACTIVE", 0xfffffffc: "FULL", 0xfffffff8: "FREEING", 0xfffffff0: "CORRUPT", 0: "INVALID", 0xffffffff: "UNINITIALIZED" };
const TIPO = { 0x01: "u8", 0x11: "i8", 0x02: "u16", 0x12: "i16", 0x04: "u32", 0x14: "i32", 0x08: "u64", 0x18: "i64", 0x21: "str", 0x41: "blob-v1", 0x42: "blob-data", 0x48: "blob-idx" };
const TIPO_CODIGO = Object.fromEntries(Object.entries(TIPO).map(([k, v]) => [v, Number(k)]));

function crcEntrada(e) {
  let c = crc32(e.subarray(0, 4));
  c = crc32(e.subarray(8, 24), c);
  return crc32(e.subarray(24, 32), c);
}

function estadoEntrada(pagina, i) {
  return (pagina[32 + (i >> 2)] >> ((i & 3) * 2)) & 3;
}

/**
 * Every written item of the NVS partition, in page-sequence order, with its CRC verdict. Items whose
 * header CRC fails are reported, not dropped, so a test can tell "absent" from "corrupted".
 */
function lerItensNvs(imagem) {
  const p = particao(imagem, { nome: "nvs" });
  const paginas = [];
  for (let off = p.deslocamento; off < p.deslocamento + p.tamanho; off += PAGINA) {
    const pag = imagem.subarray(off, off + PAGINA);
    const estado = ESTADO_PAGINA[pag.readUInt32LE(0)] || "?";
    if (!["ACTIVE", "FULL", "FREEING"].includes(estado)) continue;
    const cabecalhoOk = pag.readUInt32LE(28) === crc32(pag.subarray(4, 28));
    paginas.push({ off, pag, seq: pag.readUInt32LE(4), estado, cabecalhoOk });
  }
  paginas.sort((a, b) => a.seq - b.seq);
  const itens = [];
  for (const { off, pag, seq } of paginas) {
    for (let i = 0; i < ENTRADAS; ) {
      if (estadoEntrada(pag, i) !== 2) { i += 1; continue; }
      const eoff = 64 + i * 32;
      const e = pag.subarray(eoff, eoff + 32);
      const span = Math.max(1, e[2]);
      const item = {
        pagina: seq,
        deslocamento: off + eoff,
        ns: e[0],
        tipo: TIPO[e[1]] || `0x${e[1].toString(16)}`,
        span,
        chunk: e[3],
        chave: e.subarray(8, 24).toString("latin1").replace(/\0.*$/s, ""),
        crcOk: e.readUInt32LE(4) === crcEntrada(e),
      };
      if (item.tipo === "str" || item.tipo === "blob-data") {
        const tamanho = e.readUInt16LE(24);
        const dados = pag.subarray(eoff + 32, eoff + 32 + tamanho);
        item.tamanho = tamanho;
        item.dados = Buffer.from(dados);
        item.dadosOk = e.readUInt32LE(28) === crc32(dados);
      } else if (item.tipo === "blob-idx") {
        item.tamanho = e.readUInt32LE(24);
        item.chunks = e[28];
        item.chunkInicial = e[29];
      } else {
        item.bruto = Buffer.from(e.subarray(24, 32));
      }
      itens.push(item);
      i += span;
    }
  }
  return itens;
}

function valorPrimitivo(item) {
  const b = item.bruto;
  switch (item.tipo) {
    case "u8": return b.readUInt8(0);
    case "i8": return b.readInt8(0);
    case "u16": return b.readUInt16LE(0);
    case "i16": return b.readInt16LE(0);
    case "u32": return b.readUInt32LE(0);
    case "i32": return b.readInt32LE(0);
    case "u64": return b.readBigUInt64LE(0);
    case "i64": return b.readBigInt64LE(0);
    default: return undefined;
  }
}

/**
 * The key/value view of one namespace as Preferences sees it. `duplicadas` lists keys that are
 * written more than once (a write interrupted between the new entry and erasing the old one).
 */
function lerNamespace(imagem, nomeNs) {
  const itens = lerItensNvs(imagem);
  const nsItem = itens.find((it) => it.ns === 0 && it.tipo === "u8" && it.chave === nomeNs && it.crcOk);
  if (!nsItem) return { existe: false, chaves: {}, duplicadas: [], corrompidas: [] };
  const indice = nsItem.bruto[0];
  const doNs = itens.filter((it) => it.ns === indice);
  const chaves = {};
  const vistas = new Map();
  const duplicadas = new Set();
  const corrompidas = [];
  for (const it of doNs) {
    if (!it.crcOk || it.dadosOk === false) { corrompidas.push(it.chave); continue; }
    if (it.tipo === "blob-data") continue;
    const id = `${it.chave}`;
    if (vistas.has(id) && it.tipo !== "blob-idx") duplicadas.add(id);
    vistas.set(id, true);
    if (it.tipo === "str") chaves[it.chave] = { tipo: "str", valor: it.dados.subarray(0, Math.max(0, it.tamanho - 1)).toString("utf8") };
    else if (it.tipo === "blob-idx") {
      const partes = doNs.filter((d) => d.tipo === "blob-data" && d.chave === it.chave && d.chunk >= it.chunkInicial && d.chunk < it.chunkInicial + it.chunks)
        .sort((a, b) => a.chunk - b.chunk);
      const dados = Buffer.concat(partes.map((d) => d.dados));
      chaves[it.chave] = { tipo: "blob", valor: dados, completo: dados.length === it.tamanho && partes.every((d) => d.dadosOk) };
    } else chaves[it.chave] = { tipo: it.tipo, valor: valorPrimitivo(it) };
  }
  return { existe: true, chaves, duplicadas: [...duplicadas], corrompidas };
}

function localizarItem(imagem, nomeNs, chave, tipo) {
  const itens = lerItensNvs(imagem);
  const nsItem = itens.find((it) => it.ns === 0 && it.chave === nomeNs && it.crcOk);
  if (!nsItem) throw new Error(`NVS namespace ${nomeNs} not found`);
  const achados = itens.filter((it) => it.ns === nsItem.bruto[0] && it.chave === chave && it.tipo === tipo && it.crcOk);
  if (achados.length !== 1) throw new Error(`expected exactly one ${tipo} item ${nomeNs}/${chave}, found ${achados.length}`);
  return achados[0];
}

/**
 * Replaces a stored string with another of the SAME length, fixing both CRCs, so the firmware reads
 * the new value as valid NVS data. Used to plant a malformed-but-well-formed setting.
 */
function substituirStringNvs(imagem, nomeNs, chave, novo) {
  const it = localizarItem(imagem, nomeNs, chave, "str");
  const bytes = Buffer.concat([Buffer.from(novo, "utf8"), Buffer.from([0])]);
  if (bytes.length !== it.tamanho) throw new Error(`new value must keep the stored length (${it.tamanho - 1} bytes)`);
  bytes.copy(imagem, it.deslocamento + 32);
  imagem.writeUInt32LE(crc32(bytes), it.deslocamento + 28);
  imagem.writeUInt32LE(crcEntrada(imagem.subarray(it.deslocamento, it.deslocamento + 32)), it.deslocamento + 4);
}

/**
 * Changes a stored primitive's TYPE in place (e.g. an i32 that a newer or corrupted image stores as
 * u8), keeping the header CRC valid. Preferences then finds the key but not with the expected type.
 */
function trocarTipoNvs(imagem, nomeNs, chave, tipoAtual, tipoNovo) {
  const it = localizarItem(imagem, nomeNs, chave, tipoAtual);
  imagem[it.deslocamento + 1] = TIPO_CODIGO[tipoNovo];
  imagem.writeUInt32LE(crcEntrada(imagem.subarray(it.deslocamento, it.deslocamento + 32)), it.deslocamento + 4);
}

/**
 * Flips one byte inside a blob's payload and repairs the NVS data CRC, so NVS hands the altered bytes
 * to the firmware and only the firmware's own record check can reject them.
 */
function alterarBlobNvs(imagem, nomeNs, chave, indiceByte) {
  const itens = lerItensNvs(imagem);
  const nsItem = itens.find((it) => it.ns === 0 && it.chave === nomeNs && it.crcOk);
  const partes = itens.filter((it) => it.ns === nsItem.bruto[0] && it.chave === chave && it.tipo === "blob-data" && it.crcOk)
    .sort((a, b) => a.chunk - b.chunk);
  if (!partes.length) throw new Error(`blob ${nomeNs}/${chave} not found`);
  let resto = indiceByte;
  for (const parte of partes) {
    if (resto < parte.tamanho) {
      const alvo = parte.deslocamento + 32 + resto;
      imagem[alvo] ^= 0x5a;
      const dados = imagem.subarray(parte.deslocamento + 32, parte.deslocamento + 32 + parte.tamanho);
      imagem.writeUInt32LE(crc32(dados), parte.deslocamento + 28);
      imagem.writeUInt32LE(crcEntrada(imagem.subarray(parte.deslocamento, parte.deslocamento + 32)), parte.deslocamento + 4);
      return;
    }
    resto -= parte.tamanho;
  }
  throw new Error("byte index past the end of the blob");
}

/**
 * Marks a key's entries erased in the page bitmap, exactly as NVS itself does when a key is removed:
 * the key is then absent for Preferences, while every other key stays intact.
 */
function apagarChaveNvs(imagem, nomeNs, chave) {
  const itens = lerItensNvs(imagem);
  const nsItem = itens.find((it) => it.ns === 0 && it.chave === nomeNs && it.crcOk);
  if (!nsItem) throw new Error(`NVS namespace ${nomeNs} not found`);
  const alvos = itens.filter((it) => it.ns === nsItem.bruto[0] && it.chave === chave);
  if (!alvos.length) throw new Error(`NVS key ${nomeNs}/${chave} not found`);
  for (const it of alvos) {
    const pagina = it.deslocamento - ((it.deslocamento - 0) % PAGINA);
    const primeira = (it.deslocamento - pagina - 64) / 32;
    for (let i = primeira; i < primeira + it.span; i++) {
      imagem[pagina + 32 + (i >> 2)] &= ~(3 << ((i & 3) * 2)) & 0xff;
    }
  }
}

/** Erases the whole NVS partition, as `esptool erase_region` or a fresh chip would leave it. */
function apagarNvs(imagem) {
  const p = particao(imagem, { nome: "nvs" });
  imagem.fill(0xff, p.deslocamento, p.deslocamento + p.tamanho);
}

module.exports = {
  crc32,
  lerParticoes,
  lerOtadata,
  hashParticao,
  appNoSlot,
  lerItensNvs,
  lerNamespace,
  substituirStringNvs,
  trocarTipoNvs,
  apagarChaveNvs,
  alterarBlobNvs,
  apagarNvs,
};
