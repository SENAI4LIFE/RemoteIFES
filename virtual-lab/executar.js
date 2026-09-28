#!/usr/bin/env node
"use strict";

// Runs the virtual hardware lab and reports three verdicts; the run passes only if all three do:
//
//   Functional validation   the scenarios (or, with --unidade, the lab's own unit tests)
//   Host cleanup            no process, listener or file of the run left behind
//   Host safety             the host's network, security and persistence settings unchanged
//
//   node virtual-lab/executar.js --unidade                safe on any machine: no emulator, no guest
//   node virtual-lab/executar.js [--concorrencia N] [--filtro regex] [cenarios/01-*.test.js ...]
//                                                         only on a disposable host (LAB_HOST_DESCARTAVEL=1)
//
// Scenarios boot untrusted software (the emulator, the firmware, a network the guest drives), so they
// never run on a workstation: the GitHub workflow "Virtual Hardware Validation" runs them on
// ephemeral runners.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ambiente = require("./lib/ambiente");
const seguranca = require("./lib/seguranca");

const LAB = __dirname;
const LIMITE_EXECUCAO_MS = Number(process.env.LAB_LIMITE_MINUTOS || 240) * 60 * 1000;

function argumentos() {
  const a = process.argv.slice(2);
  const opcoes = { unidade: false, concorrencia: process.env.CI ? 3 : 2, filtro: null, arquivos: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--unidade") opcoes.unidade = true;
    else if (a[i] === "--preparar") opcoes.preparar = true;
    else if (a[i] === "--concorrencia") opcoes.concorrencia = Math.max(1, Math.min(8, Number(a[++i]) || 1));
    else if (a[i] === "--filtro") opcoes.filtro = a[++i];
    else if (/^cenarios\/[0-9a-z-]+\.test\.js$/.test(a[i].replace(/\\/g, "/"))) opcoes.arquivos.push(a[i].replace(/\\/g, "/"));
    else throw new Error(`unknown argument ${a[i]}`);
  }
  return opcoes;
}

function lerJsonl(arquivo) {
  try {
    return fs.readFileSync(arquivo, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * A recorded process is still the one the run started only when its PID is alive with the start time
 * recorded for it. Anything else (an exited child whose PID the kernel reused, or a host where the
 * start time cannot be read) is not the run's to signal.
 */
function aindaDoLab(p) {
  return vivo(p.pid) && !!p.arranque && ambiente.arranqueDoProcesso(p.pid) === p.arranque;
}

function porQueRecusar(opcoes) {
  if (seguranca.elevado()) return "running elevated (administrator/root): the lab never needs it and refuses to run with it";
  const livre = seguranca.espacoLivreBytes();
  const minimo = opcoes.unidade ? 200 * 2 ** 20 : 3 * 2 ** 30;
  if (livre < minimo) return `only ${(livre / 2 ** 30).toFixed(1)} GiB free in ${os.tmpdir()}`;
  if (!opcoes.unidade) {
    if (process.env.LAB_HOST_DESCARTAVEL !== "1") return "scenarios run only on a disposable host (LAB_HOST_DESCARTAVEL=1); use the Virtual Hardware Validation workflow";
    if (process.platform !== "linux") return "scenarios need Linux: the guest network is restricted with libslirp guest forwarding, which Windows does not support";
  }
  return null;
}

/** Fetches the pinned emulator and builds every firmware variant into the lab cache, then exits. */
async function preparar() {
  const { obterEmulador } = require("./lib/emulador");
  const { construir, VARIANTES } = require("./lib/firmware");
  const emulador = await obterEmulador();
  const builds = {};
  for (const v of Object.keys(VARIANTES)) {
    const b = await construir(v);
    builds[v] = { versao: b.versao, ramEstaticaBytes: b.tamanho && b.tamanho.ram ? b.tamanho.ram.usados : null, flashBytes: b.tamanho && b.tamanho.flash ? b.tamanho.flash.usados : null };
  }
  console.log(JSON.stringify({ binario: emulador.binario, versao: emulador.versao, cache: ambiente.diretorioCache(), firmware: builds }));
}

async function main() {
  const opcoes = argumentos();
  const motivo = porQueRecusar(opcoes);
  if (motivo) {
    console.error(`virtual lab: refusing to run: ${motivo}`);
    process.exit(2);
  }
  if (opcoes.preparar) return preparar();
  const id = ambiente.novoIdExecucao();
  process.env.LAB_EXECUCAO = id;
  const dirExecucao = ambiente.diretorioExecucao();
  const saida = ambiente.diretorioSaida();
  console.log(`virtual lab run ${id}\n  state:   ${dirExecucao}`);

  const antes = seguranca.fotografar();
  const tempAntes = new Set(fs.readdirSync(os.tmpdir()));

  if (!opcoes.unidade) {
    // Everything the test processes share is prepared once, before they start in parallel.
    const { obterEmulador, MANIFESTO } = require("./lib/emulador");
    const { construir, VARIANTES } = require("./lib/firmware");
    const emulador = await obterEmulador();
    console.log(`  emulator: ${emulador.versao}`);
    for (const v of Object.keys(VARIANTES)) {
      const b = await construir(v);
      const t = b.tamanho || {};
      const uso = t.flash && t.ram ? `, flash ${t.flash.usados} B, static RAM ${t.ram.usados} B` : "";
      console.log(`  firmware ${v}: ${b.versao} (source ${b.impressao.slice(0, 12)}${uso})`);
    }
    fs.writeFileSync(path.join(saida, "ambiente.json"), JSON.stringify({ emulador: emulador.versao, origem: emulador.origem, manifesto: MANIFESTO.commit, host: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version }, null, 2));
  }

  const arquivos = opcoes.unidade
    ? fs.readdirSync(path.join(LAB, "test")).filter((n) => n.endsWith(".test.js")).map((n) => `test/${n}`)
    : opcoes.arquivos.length ? opcoes.arquivos : fs.readdirSync(path.join(LAB, "cenarios")).filter((n) => n.endsWith(".test.js")).map((n) => `cenarios/${n}`);
  const args = ["--test", `--test-concurrency=${opcoes.concorrencia}`, "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", `--test-reporter-destination=${path.join(saida, "resultado.tap")}`];
  if (opcoes.filtro) args.push(`--test-name-pattern=${opcoes.filtro}`);
  args.push(...arquivos);

  const testes = ambiente.registrarProcesso(spawn(process.execPath, args, { cwd: LAB, stdio: "inherit", detached: process.platform !== "win32", env: { ...process.env, LAB_EXECUCAO: id } }), "node-test");
  const limite = setTimeout(() => {
    console.error(`virtual lab: run exceeded ${LIMITE_EXECUCAO_MS / 60000} minutes; stopping it`);
    try { process.kill(-testes.pid, "SIGKILL"); } catch { testes.kill("SIGKILL"); }
  }, LIMITE_EXECUCAO_MS);
  const codigo = await new Promise((r) => testes.once("exit", (c) => r(c)));
  clearTimeout(limite);
  const funcional = codigo === 0;

  // --- Host cleanup --------------------------------------------------------------------------------
  const limpeza = { terminados: [], problemas: [] };
  if (process.platform !== "win32") {
    try { process.kill(-testes.pid, "SIGKILL"); } catch {}
  }
  const processos = lerJsonl(path.join(dirExecucao, "processos.jsonl"));
  for (const p of processos) {
    if (!aindaDoLab(p)) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { process.kill(p.pid, "SIGKILL"); } catch {} }
    limpeza.terminados.push(`${p.rotulo}:${p.pid}`);
  }
  if (process.platform === "linux") {
    const relays = spawnSync("pgrep", ["-f", `relay\\.js [0-9]+ ${id}`], { encoding: "utf8" });
    for (const pid of (relays.stdout || "").split(/\s+/).filter(Boolean).map(Number)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      limpeza.terminados.push(`relay:${pid}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  for (const p of processos) {
    if (aindaDoLab(p)) limpeza.problemas.push(`process still running: ${p.rotulo} ${p.pid}`);
    else if (vivo(p.pid) && !p.arranque) limpeza.problemas.push(`process ${p.rotulo} ${p.pid} may still be running; its identity cannot be verified here, so it was not signalled`);
  }
  const portas = lerJsonl(path.join(dirExecucao, "portas.jsonl"));
  for (const { porta, rotulo } of portas) {
    const aberta = await new Promise((r) => {
      const s = require("net").connect(porta, "127.0.0.1");
      s.once("connect", () => { s.destroy(); r(true); });
      s.once("error", () => r(false));
      s.setTimeout(2000, () => { s.destroy(); r(false); });
    });
    if (aberta) limpeza.problemas.push(`port still listening: ${porta} (${rotulo}) — possibly reused by another program`);
  }
  const novosTemp = fs.readdirSync(os.tmpdir()).filter((n) => !tempAntes.has(n) && /^(remoteifes-(isolado|lab)-|placa-)/.test(n));
  for (const n of novosTemp) limpeza.problemas.push(`file of the run outside the lab root: ${path.join(os.tmpdir(), n)}`);
  try {
    ambiente.removerSeguro(path.join(dirExecucao, "trabalho"));
  } catch (erro) {
    limpeza.problemas.push(`could not remove the run's work directory: ${erro.message}`);
  }
  if (fs.existsSync(path.join(dirExecucao, "trabalho"))) limpeza.problemas.push("the run's work directory is still there");

  // --- Host safety ---------------------------------------------------------------------------------
  const depois = seguranca.fotografar();
  const pidsDoLab = new Set(processos.map((p) => p.pid));
  const portasDoLab = new Set(portas.map((p) => p.porta));
  const seguro = seguranca.comparar(antes, depois, { pidsDoLab, portasDoLab });

  const resumo = {
    execucao: id,
    funcional: funcional ? "PASS" : "FAIL",
    limpeza: limpeza.problemas.length === 0 ? "PASS" : "FAIL",
    seguranca: seguro.ok ? "PASS" : "FAIL",
    limpezaDetalhes: limpeza,
    segurancaDetalhes: seguro,
    resultados: saida,
  };
  resumo.geral = resumo.funcional === "PASS" && resumo.limpeza === "PASS" && resumo.seguranca === "PASS" ? "PASS" : "FAIL";
  fs.writeFileSync(path.join(saida, "resumo.json"), JSON.stringify(resumo, null, 2));
  console.log(`\nFunctional validation: ${resumo.funcional}\nHost cleanup:          ${resumo.limpeza}${limpeza.terminados.length ? ` (terminated leftovers: ${limpeza.terminados.join(", ")})` : ""}\nHost safety:           ${resumo.seguranca}\nOverall:               ${resumo.geral}\n  evidence: ${saida}`);
  for (const p of [...limpeza.problemas, ...seguro.problemas.map((x) => JSON.stringify(x))]) console.log(`  - ${p}`);
  process.exit(resumo.geral === "PASS" ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro.stack || erro.message);
  ambiente.encerrarFilhos();
  process.exit(1);
});
