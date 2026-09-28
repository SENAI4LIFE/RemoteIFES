"use strict";

// The flash reader against an image built here from the documented ESP-IDF layouts. The scenarios
// then check the same reader against NVS the real firmware wrote (no CRC errors there either).

const test = require("node:test");
const assert = require("node:assert/strict");
const flash = require("../lib/flash");

const crc = flash.crc32;

function tabelaDeParticoes(imagem) {
  const entradas = [
    ["nvs", 1, 0x02, 0x9000, 0x5000],
    ["otadata", 1, 0x00, 0xe000, 0x2000],
    ["app0", 0, 0x10, 0x10000, 0x1e0000],
    ["app1", 0, 0x11, 0x1f0000, 0x1e0000],
    ["spiffs", 1, 0x82, 0x3d0000, 0x20000],
  ];
  entradas.forEach(([nome, tipo, subtipo, off, tam], i) => {
    const e = 0x8000 + i * 32;
    imagem.writeUInt16LE(0x50aa, e);
    imagem[e + 2] = tipo;
    imagem[e + 3] = subtipo;
    imagem.writeUInt32LE(off, e + 4);
    imagem.writeUInt32LE(tam, e + 8);
    imagem.fill(0, e + 12, e + 32);
    imagem.write(nome, e + 12, "latin1");
  });
}

function registroOta(imagem, i, seq, estado) {
  const off = 0xe000 + i * 0x1000;
  imagem.writeUInt32LE(seq, off);
  imagem.writeUInt32LE(estado, off + 24);
  imagem.writeUInt32LE(crc(imagem.subarray(off, off + 4)), off + 28);
}

/** One NVS page with the entries given, CRCs as ESP-IDF computes them. */
function paginaNvs(imagem, entradas) {
  const pag = 0x9000;
  imagem.writeUInt32LE(0xfffffffe, pag);
  imagem.writeUInt32LE(0, pag + 4);
  imagem[pag + 8] = 0xfe;
  imagem.writeUInt32LE(crc(imagem.subarray(pag + 4, pag + 28)), pag + 28);
  let i = 0;
  const escrever = (ns, tipo, chave, dados, extra = null) => {
    const off = pag + 64 + i * 32;
    const span = extra ? 1 + Math.ceil(extra.length / 32) : 1;
    imagem[off] = ns;
    imagem[off + 1] = tipo;
    imagem[off + 2] = span;
    imagem[off + 3] = 0xff;
    imagem.fill(0, off + 8, off + 24);
    imagem.write(chave, off + 8, "latin1");
    dados.copy(imagem, off + 24);
    if (extra) extra.copy(imagem, off + 32);
    let c = crc(imagem.subarray(off, off + 4));
    c = crc(imagem.subarray(off + 8, off + 24), c);
    c = crc(imagem.subarray(off + 24, off + 32), c);
    imagem.writeUInt32LE(c, off + 4);
    for (let k = i; k < i + span; k++) {
      imagem[pag + 32 + (k >> 2)] &= ~(1 << ((k & 3) * 2)) & 0xff;
    }
    i += span;
  };
  for (const e of entradas) {
    if (e.tipo === "ns") { const d = Buffer.alloc(8, 0xff); d[0] = e.indice; escrever(0, 0x01, e.nome, d); }
    if (e.tipo === "str") {
      const bytes = Buffer.concat([Buffer.from(e.valor), Buffer.from([0])]);
      const d = Buffer.alloc(8, 0xff); d.writeUInt16LE(bytes.length, 0); d.writeUInt32LE(crc(bytes), 4);
      escrever(e.ns, 0x21, e.chave, d, bytes);
    }
    if (e.tipo === "i32") { const d = Buffer.alloc(8, 0xff); d.writeInt32LE(e.valor, 0); escrever(e.ns, 0x14, e.chave, d); }
  }
}

function imagemBase() {
  const imagem = Buffer.alloc(4 * 1024 * 1024, 0xff);
  tabelaDeParticoes(imagem);
  paginaNvs(imagem, [
    { tipo: "ns", nome: "remoteifes", indice: 1 },
    { tipo: "str", ns: 1, chave: "tls", valor: "ca" },
    { tipo: "i32", ns: 1, chave: "porta", valor: 8080 },
    { tipo: "str", ns: 1, chave: "host", valor: "192.168.4.9" },
  ]);
  return imagem;
}

test("partitions, NVS strings and integers are read with every CRC checked", () => {
  const imagem = imagemBase();
  assert.deepEqual(flash.lerParticoes(imagem).map((p) => p.nome), ["nvs", "otadata", "app0", "app1", "spiffs"]);
  const ns = flash.lerNamespace(imagem, "remoteifes");
  assert.equal(ns.chaves.tls.valor, "ca");
  assert.equal(ns.chaves.porta.valor, 8080);
  assert.equal(ns.chaves.host.valor, "192.168.4.9");
  assert.deepEqual(ns.corrompidas, []);
  assert.ok(flash.lerItensNvs(imagem).every((i) => i.crcOk && i.dadosOk !== false));
});

test("a damaged entry is reported as corrupted, not silently dropped", () => {
  const imagem = imagemBase();
  const tls = flash.lerItensNvs(imagem).find((i) => i.chave === "tls");
  imagem[tls.deslocamento + 32] ^= 0x01;
  assert.deepEqual(flash.lerNamespace(imagem, "remoteifes").corrompidas, ["tls"]);
});

test("edits keep NVS consistent: same-length string, type change, key erase", () => {
  const imagem = imagemBase();
  flash.substituirStringNvs(imagem, "remoteifes", "tls", "cx");
  assert.equal(flash.lerNamespace(imagem, "remoteifes").chaves.tls.valor, "cx");
  assert.throws(() => flash.substituirStringNvs(imagem, "remoteifes", "tls", "longer"));
  flash.trocarTipoNvs(imagem, "remoteifes", "porta", "i32", "u8");
  assert.equal(flash.lerNamespace(imagem, "remoteifes").chaves.porta.tipo, "u8");
  flash.apagarChaveNvs(imagem, "remoteifes", "host");
  const ns = flash.lerNamespace(imagem, "remoteifes");
  assert.equal(ns.chaves.host, undefined);
  assert.equal(ns.chaves.tls.valor, "cx", "other keys are untouched");
  assert.deepEqual(ns.corrompidas, []);
});

test("otadata: the bootloader's choice and each slot's state", () => {
  const imagem = imagemBase();
  registroOta(imagem, 0, 1, 0xffffffff);
  registroOta(imagem, 1, 2, 2);
  let o = flash.lerOtadata(imagem);
  assert.equal(o.boot, "ota_1");
  assert.equal(o.estadoDe("ota_1"), "VALID");
  registroOta(imagem, 1, 2, 3);
  o = flash.lerOtadata(imagem);
  assert.equal(o.boot, "ota_0", "an INVALID newer slot is skipped");
  assert.equal(o.estadoDe("ota_1"), "INVALID");
  registroOta(imagem, 1, 0, 0xffffffff);
  assert.equal(flash.lerOtadata(imagem).boot, "ota_0", "sequence 0 does not win over 1");
});

test("a slot is identified by the exact bytes of a known image", () => {
  const imagem = imagemBase();
  const app = Buffer.alloc(4096, 7);
  app[0] = 0xe9;
  app.copy(imagem, 0x10000);
  assert.equal(flash.appNoSlot(imagem, "ota_0", { producao: app }), "producao");
  imagem[0x10000 + 100] ^= 1;
  assert.equal(flash.appNoSlot(imagem, "ota_0", { producao: app }), null);
  assert.equal(flash.appNoSlot(imagem, "ota_1", { producao: app }), null);
});
