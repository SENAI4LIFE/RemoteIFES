"use strict";

// The remote-protocol client behind exact stop points, against a fake GDB stub: framing, checksums,
// no-ack mode, breakpoints, continuing to the Nth stop, and a stub that goes away.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

process.env.LAB_EXECUCAO = process.env.LAB_EXECUCAO || require("../lib/ambiente").novoIdExecucao();
const { ClienteGdb } = require("../lib/paradas");

function pacote(dados) {
  let soma = 0;
  for (const c of Buffer.from(dados, "latin1")) soma = (soma + c) & 0xff;
  return `$${dados}#${soma.toString(16).padStart(2, "0")}`;
}

async function stubFalso(t, responder) {
  const recebidos = [];
  const srv = net.createServer((s) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      for (;;) {
        buf = buf.replace(/^[+-]+/, "");
        const i = buf.indexOf("$");
        const f = buf.indexOf("#", i);
        if (i < 0 || f < 0 || buf.length < f + 3) break;
        const dados = buf.slice(i + 1, f);
        const soma = parseInt(buf.slice(f + 1, f + 3), 16);
        let esperado = 0;
        for (const c of Buffer.from(dados, "latin1")) esperado = (esperado + c) & 0xff;
        assert.equal(soma, esperado, `checksum of ${dados}`);
        buf = buf.slice(f + 3);
        recebidos.push(dados);
        const r = responder(dados, recebidos);
        if (r === null) s.destroy();
        else if (r !== undefined) s.write(`+${pacote(r)}`);
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { porta: srv.address().port, recebidos };
}

test("breakpoints are set, the chip runs to the Nth stop, and detaching removes nothing it should keep", async (t) => {
  let paradas = 0;
  const stub = await stubFalso(t, (d) => {
    if (d === "QStartNoAckMode") return "OK";
    if (d === "?") return "S05";
    if (/^Z1,/.test(d)) return "OK";
    if (/^z1,/.test(d)) return "OK";
    if (d === "c") { paradas += 1; return `T05thread:0${paradas};`; }
    if (d === "D") return "OK";
    return "";
  });
  const gdb = await ClienteGdb.conectar(stub.porta);
  await gdb.preparar();
  assert.equal(await gdb.quebrar(0x400d3168), "1");
  for (let i = 0; i < 3; i++) await gdb.continuarAteParar(5000);
  await gdb.retirar("1", 0x400d3168);
  await gdb.desconectar();
  assert.deepEqual(stub.recebidos, ["QStartNoAckMode", "?", "Z1,400d3168,3", "c", "c", "c", "z1,400d3168,3", "D"]);
});

test("a stub without hardware breakpoints gets a software one", async (t) => {
  const stub = await stubFalso(t, (d) => (d === "QStartNoAckMode" ? "OK" : d === "?" ? "S05" : /^Z1,/.test(d) ? "" : /^Z0,/.test(d) ? "OK" : ""));
  const gdb = await ClienteGdb.conectar(stub.porta);
  await gdb.preparar();
  assert.equal(await gdb.quebrar(0x40000000), "0");
  gdb.soquete.destroy();
});

test("the emulator going away while running to a stop point is an error, not a hang", async (t) => {
  const stub = await stubFalso(t, (d) => (d === "QStartNoAckMode" ? "OK" : d === "?" ? "S05" : /^Z1,/.test(d) ? "OK" : d === "c" ? null : ""));
  const gdb = await ClienteGdb.conectar(stub.porta);
  await gdb.preparar();
  await gdb.quebrar(0x400d0000);
  await assert.rejects(gdb.continuarAteParar(5000), /closed/);
});
