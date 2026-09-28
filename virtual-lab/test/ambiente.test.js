"use strict";

// Host-safety guards of the lab itself: what it may delete, when it may run the emulator, and the
// helper the emulator starts per guest connection. Nothing here boots a guest.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

process.env.LAB_EXECUCAO = process.env.LAB_EXECUCAO || require("../lib/ambiente").novoIdExecucao();
const ambiente = require("../lib/ambiente");
const seguranca = require("../lib/seguranca");

test("removal is confined to the lab root", (t) => {
  const raiz = ambiente.raizDoLaboratorio();
  const dentro = path.join(ambiente.diretorioTrabalho(), "apagar-me");
  fs.mkdirSync(path.join(dentro, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dentro, "sub", "x"), "x");
  ambiente.removerSeguro(dentro);
  assert.equal(fs.existsSync(dentro), false);

  const fora = fs.mkdtempSync(path.join(os.tmpdir(), "fora-do-lab-"));
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fora, "precioso"), "p");
  assert.throws(() => ambiente.removerSeguro(fora), /outside/);
  assert.throws(() => ambiente.removerSeguro(raiz), /outside/, "never the root itself");
  assert.throws(() => ambiente.removerSeguro("relativo/caminho"), /absolute/);
  assert.throws(() => ambiente.removerSeguro(""), /absolute/);
  assert.throws(() => ambiente.removerSeguro(path.join(raiz, "..", path.basename(fora))), /outside/, "no escape with ..");
  assert.ok(fs.existsSync(path.join(fora, "precioso")));
});

test("a link inside the lab that points outside is not followed out", { skip: process.platform === "win32" && "symlinks need a privilege on Windows" }, (t) => {
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), "alvo-do-link-"));
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fora, "precioso"), "p");
  const link = path.join(ambiente.diretorioTrabalho(), "link-para-fora");
  fs.symlinkSync(fora, link);
  assert.throws(() => ambiente.removerSeguro(link), /outside/);
  const pai = path.join(ambiente.diretorioTrabalho(), "pai");
  fs.mkdirSync(pai, { recursive: true });
  fs.symlinkSync(fora, path.join(pai, "link"));
  ambiente.removerSeguro(pai);
  assert.ok(fs.existsSync(path.join(fora, "precioso")), "removing a tree removes the link, never its target");
  fs.rmSync(link, { force: true });
});

test("a malformed run id is refused instead of becoming a path", () => {
  const antes = process.env.LAB_EXECUCAO;
  try {
    process.env.LAB_EXECUCAO = "../../escape";
    assert.throws(() => ambiente.diretorioExecucao(), /invalid LAB_EXECUCAO/);
  } finally {
    process.env.LAB_EXECUCAO = antes;
  }
});

test("the emulator, the firmware build and the guest need a host declared disposable", () => {
  const antes = process.env.LAB_HOST_DESCARTAVEL;
  try {
    delete process.env.LAB_HOST_DESCARTAVEL;
    assert.throws(() => ambiente.exigirHostDescartavel("x"), /disposable host/);
    process.env.LAB_HOST_DESCARTAVEL = "1";
    assert.doesNotThrow(() => ambiente.exigirHostDescartavel("x"));
  } finally {
    if (antes === undefined) delete process.env.LAB_HOST_DESCARTAVEL; else process.env.LAB_HOST_DESCARTAVEL = antes;
  }
});

test("the relay splices one connection to its loopback destination and prints nothing of its own", async () => {
  const eco = net.createServer((s) => s.on("data", (d) => s.write(`eco:${d}`)));
  await new Promise((r) => eco.listen(0, "127.0.0.1", r));
  const relay = spawn(process.execPath, ["--no-warnings", path.join(__dirname, "..", "lib", "relay.js"), String(eco.address().port), process.env.LAB_EXECUCAO]);
  let saida = "";
  let erro = "";
  relay.stdout.on("data", (d) => { saida += d; });
  relay.stderr.on("data", (d) => { erro += d; });
  relay.stdin.write("ola");
  await new Promise((r) => setTimeout(r, 300));
  relay.stdin.end();
  const codigo = await new Promise((r) => relay.once("exit", r));
  eco.close();
  assert.equal(saida, "eco:ola");
  assert.equal(erro, "", "stderr reaches the guest socket, so it must stay empty");
  assert.equal(codigo, 0);
  const invalido = spawn(process.execPath, [path.join(__dirname, "..", "lib", "relay.js"), "0"]);
  assert.equal(await new Promise((r) => invalido.once("exit", r)), 2, "an invalid destination is refused");
});

test("host safety judges what the lab could change and attributes listeners", () => {
  const base = { adaptadores: ["Wi-Fi|x|aa"], rotaPadrao: ["Wi-Fi>192.168.0.1"], dns: ["Wi-Fi=1.1.1.1"], proxyUsuario: "0||", firewall: ["Public|True"], tarefas: ["\\a"], servicos: ["s"], estadoAdaptadores: ["Wi-Fi=Up"], enderecos: ["Wi-Fi=192.168.0.5/24"], escuta: ["127.0.0.1:5000|10"] };
  assert.equal(seguranca.comparar(base, { ...base, enderecos: ["Wi-Fi=192.168.0.9/24"], escuta: ["127.0.0.1:5000|10", "127.0.0.1:6000|99"] }).ok, true, "DHCP and other programs' listeners are not the lab's doing");
  assert.equal(seguranca.comparar(base, { ...base, adaptadores: [...base.adaptadores, "TAP|tap|bb"] }).ok, false);
  assert.equal(seguranca.comparar(base, { ...base, rotaPadrao: [] }).ok, false);
  assert.equal(seguranca.comparar(base, { ...base, firewall: ["Public|False"] }).ok, false);
  assert.equal(seguranca.comparar(base, { ...base, tarefas: ["\\a", "\\nova"] }).ok, false);
  assert.equal(seguranca.comparar(base, { ...base, escuta: ["127.0.0.1:6000|99"] }, { pidsDoLab: new Set([99]) }).ok, false, "a listener of a lab process left behind");
  assert.equal(seguranca.comparar(base, { ...base, escuta: ["127.0.0.1:7777|5"] }, { portasDoLab: new Set([7777]) }).ok, false, "a lab port still open");
});
