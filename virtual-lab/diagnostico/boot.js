"use strict";

// TEMPORARY probe (removed before merging): on the CI runner the emulated board prints nothing after
// power-on. Boots the emulator under option variants and reports, for each, whether the ROM printed
// and where the CPU is. Disposable hosts only.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

process.env.LAB_EXECUCAO = process.env.LAB_EXECUCAO || require("../lib/ambiente").novoIdExecucao();
const { diretorioTrabalho, exigirHostDescartavel } = require("../lib/ambiente");
const { obterEmulador } = require("../lib/emulador");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function ouvir() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const conexao = new Promise((res) => s.once("connection", (c) => { s.close(); res(c); }));
      resolve({ porta: s.address().port, conexao, s });
    });
  });
}

function linhas(soquete, aoLinha) {
  let buf = "";
  soquete.on("error", (e) => aoLinha(`(socket error ${e.code})`));
  soquete.on("data", (d) => {
    buf += d.toString("latin1");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { aoLinha(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
}

async function variante(nome, emu, flash, { rede, controle = true, icount = true, stdin = "ignore", destacado = true, extra = [] }) {
  const qt = controle ? await ouvir() : null;
  const qmp = await ouvir();
  const args = ["-nographic", "-M", "esp32", "-m", "4M", "-L", emu.roms, "-drive", `file=${flash},if=mtd,format=raw`];
  if (rede) args.push("-nic", rede);
  if (controle) args.push("-S", "-accel", "tcg");
  if (icount) args.push("-icount", "shift=3,align=off,sleep=on");
  args.push("-global", "driver=timer.esp32.timg,property=wdt_disable,value=true");
  if (controle) args.push("-chardev", `socket,id=qt,host=127.0.0.1,port=${qt.porta}`, "-qtest", "chardev:qt", "-qtest-log", "none");
  args.push("-qmp", `tcp:127.0.0.1:${qmp.porta}`, ...extra);
  const p = spawn(emu.binario, args, { stdio: [stdin, "pipe", "pipe"], detached: destacado });
  let saida = "";
  let primeiroMs = null;
  const t0 = Date.now();
  const anexar = (d) => { if (primeiroMs === null && saida.length > 30) primeiroMs = Date.now() - t0; saida += d.toString("latin1"); };
  p.stdout.on("data", anexar);
  p.stderr.on("data", anexar);
  let saiu = null;
  p.once("exit", (c, s) => { saiu = { c, s }; });
  const resultado = { nome, args: args.join(" ") };
  try {
    const [cq, cm] = await Promise.race([
      Promise.all([controle ? qt.conexao : Promise.resolve(null), qmp.conexao]),
      esperar(20_000).then(() => { throw new Error("control channels did not connect"); }),
    ]);
    if (cq) cq.on("error", () => {});
    cm.on("error", () => {});
    const qmpResp = [];
    linhas(cm, (l) => { if (l.trim()) qmpResp.push(l.trim()); });
    const qmpCmd = async (obj) => { const n = qmpResp.length; cm.write(`${JSON.stringify(obj)}\n`); for (let i = 0; i < 100 && qmpResp.length === n; i++) await esperar(50); return qmpResp.slice(n).join(" | "); };
    await esperar(300);
    await qmpCmd({ execute: "qmp_capabilities" });
    if (controle) {
      const resp = [];
      linhas(cq, (l) => { if (!l.startsWith("IRQ ")) resp.push(l); });
      const q = async (c) => { const n = resp.length; cq.write(`${c}\n`); for (let i = 0; i < 100 && resp.length === n; i++) await esperar(20); return resp.slice(n).join(" | ") || "(no answer)"; };
      resultado.qtest = [];
      resultado.qtest.push(await q("irq_intercept_out /machine/soc/gpio esp32_gpios"));
      resultado.qtest.push(await q("set_irq_in /machine/soc/gpio esp32_gpios_in 26 1"));
      resultado.qtest.push(await q("writel 0x3ff60000 0xc00a0000"));
      resultado.cont = await qmpCmd({ execute: "cont" });
    }
    await esperar(20_000);
    resultado.status = await qmpCmd({ execute: "query-status" });
    resultado.registros = (await qmpCmd({ execute: "human-monitor-command", arguments: { "command-line": "info registers" } })).match(/PC=[0-9a-f]+/gi);
    await esperar(1000);
    resultado.registros2 = (await qmpCmd({ execute: "human-monitor-command", arguments: { "command-line": "info registers" } })).match(/PC=[0-9a-f]+/gi);
    await qmpCmd({ execute: "quit" });
  } catch (e) {
    resultado.erro = String(e);
  }
  for (let i = 0; i < 100 && !saiu; i++) await esperar(100);
  if (!saiu) { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } }
  resultado.saiu = saiu;
  resultado.bytes = saida.length;
  resultado.primeiroMs = primeiroMs;
  resultado.rom = /ets Jun/.test(saida);
  resultado.inicio = saida.slice(0, 1500);
  return resultado;
}

process.on("uncaughtException", (e) => console.log(`uncaught: ${e.stack}`));
(async () => {
  exigirHostDescartavel("probing the emulator");
  const emu = await obterEmulador();
  const dir = diretorioTrabalho();
  const vazio = path.join(dir, "vazio.bin");
  fs.writeFileSync(vazio, Buffer.alloc(4 * 1024 * 1024, 0xff));
  const relay = path.join(__dirname, "..", "lib", "relay.js");
  const restrita = `user,model=esp32_wifi,net=192.168.4.0/24,restrict=on,hostfwd=tcp:127.0.0.1:45999-192.168.4.1:80,guestfwd=tcp:192.168.4.9:8080-cmd:${process.execPath} --no-warnings ${relay} 45998 ${process.env.LAB_EXECUCAO}`;
  const simples = "user,model=esp32_wifi,net=192.168.4.0/24";
  const casos = [
    ["atual", { rede: restrita }],
    ["stdin-pipe", { rede: restrita, stdin: "pipe" }],
    ["rede-simples", { rede: simples }],
    ["sem-rede", { rede: null }],
    ["sem-controle", { rede: restrita, controle: false }],
    ["sem-icount", { rede: restrita, icount: false }],
    ["nao-destacado", { rede: restrita, destacado: false }],
    ["minimo", { rede: simples, controle: false, icount: false }],
  ];
  const so = process.argv[2];
  for (const [nome, opcoes] of casos) {
    if (so && so !== nome) continue;
    const r = await variante(nome, emu, vazio, opcoes);
    console.log(`\n===== ${nome}: rom=${r.rom} bytes=${r.bytes} first=${r.primeiroMs}ms exit=${JSON.stringify(r.saiu)}`);
    console.log(JSON.stringify({ ...r, inicio: undefined }, null, 1).slice(0, 3000));
    console.log(`--- output ---\n${r.inicio}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
