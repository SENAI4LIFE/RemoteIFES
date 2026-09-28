"use strict";

// Paths, external tools, host-safety guards and output handling shared by the lab.
//
// The lab treats everything it runs (emulator, firmware, test server) as untrusted. On the host it
// only ever writes under one root, <temp>/remoteifes-virtual-lab/, removes files only through
// removerSeguro(), and terminates only processes it started itself.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const RAIZ = path.join(__dirname, "..", "..");
const LAB = path.join(RAIZ, "virtual-lab");
const NOME_RAIZ = "remoteifes-virtual-lab";
const RE_EXECUCAO = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{8}$/;

/** <temp>/remoteifes-virtual-lab, canonical. Everything the lab writes lives below it. */
function raizDoLaboratorio() {
  const temp = fs.realpathSync.native(os.tmpdir());
  const raiz = path.join(temp, NOME_RAIZ);
  fs.mkdirSync(raiz, { recursive: true });
  return fs.realpathSync.native(raiz);
}

function novoIdExecucao() {
  const agora = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${agora}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * This run's directory. The runner creates the id and passes it to the test processes in
 * LAB_EXECUCAO; a malformed id is refused rather than turned into a path.
 */
function diretorioExecucao() {
  let id = process.env.LAB_EXECUCAO;
  if (!id) {
    id = novoIdExecucao();
    process.env.LAB_EXECUCAO = id;
  }
  if (!RE_EXECUCAO.test(id)) throw new Error(`invalid LAB_EXECUCAO "${id}"`);
  const dir = path.join(raizDoLaboratorio(), "execucoes", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Disposable state of the run: flash images, server data, certificates. Deleted at the end. */
function diretorioTrabalho() {
  const dir = path.join(diretorioExecucao(), "trabalho");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Redacted evidence of the run: kept locally, uploaded by CI. */
function diretorioSaida() {
  const dir = path.join(diretorioExecucao(), "resultados");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reused between runs: emulator release and firmware builds. */
function diretorioCache() {
  const dir = path.join(raizDoLaboratorio(), "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The only recursive deletion in the lab. The target is canonicalised (junctions and symlinks
 * resolved) and must lie strictly inside the lab root; anything else, including the root itself, an
 * empty or relative path, or a path that cannot be resolved, is refused.
 */
function removerSeguro(alvo) {
  if (typeof alvo !== "string" || !alvo || !path.isAbsolute(alvo)) throw new Error(`refusing to remove "${alvo}": not an absolute path`);
  if (!fs.existsSync(alvo)) return;
  const raiz = raizDoLaboratorio();
  const real = fs.realpathSync.native(alvo);
  const relativo = path.relative(raiz, real);
  if (!relativo || relativo.startsWith("..") || path.isAbsolute(relativo)) {
    throw new Error(`refusing to remove ${real}: outside ${raiz}`);
  }
  if (path.parse(real).root === real) throw new Error(`refusing to remove a filesystem root (${real})`);
  fs.rmSync(real, { recursive: true, force: true });
}

/**
 * Anything that executes the emulator, the firmware build or a guest runs only on a host declared
 * disposable: an ephemeral CI runner (the workflow sets LAB_HOST_DESCARTAVEL=1) or a throwaway VM the
 * developer controls. A developer's workstation is not one; the lab refuses rather than trust it.
 */
function exigirHostDescartavel(acao) {
  if (process.env.LAB_HOST_DESCARTAVEL === "1") return;
  throw new Error(`${acao} runs only on a disposable host (LAB_HOST_DESCARTAVEL=1). ` +
    "The emulator, the firmware build and the guest are treated as untrusted and are not run on a workstation: " +
    "use the Virtual Hardware Validation workflow on GitHub, or a throwaway VM.");
}

// --- Processes -----------------------------------------------------------------------------------

// Every child the lab starts, so an interrupted run can still stop exactly those and nothing else.
const filhos = new Map();

function registrarProcesso(filho, rotulo) {
  if (!filho || !filho.pid) return filho;
  filhos.set(filho.pid, { filho, rotulo });
  filho.once("exit", () => filhos.delete(filho.pid));
  try {
    fs.appendFileSync(path.join(diretorioExecucao(), "processos.jsonl"), `${JSON.stringify({ pid: filho.pid, rotulo, inicio: Date.now() })}\n`);
  } catch {}
  return filho;
}

/** Every loopback port the run listens on, so the runner can prove none is left open. */
function registrarPorta(porta, rotulo) {
  try {
    fs.appendFileSync(path.join(diretorioExecucao(), "portas.jsonl"), `${JSON.stringify({ porta, rotulo })}\n`);
  } catch {}
}

function encerrarFilhos() {
  // Children started detached lead their own process group: the group goes with them.
  for (const [pid, { filho }] of filhos) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { filho.kill("SIGKILL"); } catch {} }
  }
  filhos.clear();
}

let saidaInstalada = false;
function instalarLimpezaDeSaida() {
  if (saidaInstalada) return;
  saidaInstalada = true;
  process.once("exit", encerrarFilhos);
  for (const sinal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sinal, () => { encerrarFilhos(); process.exit(130); });
  }
}
instalarLimpezaDeSaida();

// --- Tools ---------------------------------------------------------------------------------------

function nucleoPlatformio() {
  return process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), ".platformio");
}

/** The PlatformIO command: LAB_PIO, or `pio` on PATH. */
function comandoPio() {
  if (process.env.LAB_PIO) return process.env.LAB_PIO;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["pio"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  throw new Error("PlatformIO not found: install it (pip install platformio) or set LAB_PIO");
}

// --- Secrets -------------------------------------------------------------------------------------

// Secrets that must never reach a log or an uploaded artifact: device secrets, AP passwords and the
// superadmin password of the throwaway server. Registered as soon as they are created.
const segredos = new Set();

function registrarSegredo(valor) {
  if (typeof valor === "string" && valor.length >= 6) segredos.add(valor);
}

function redigir(texto) {
  let saida = String(texto);
  for (const s of segredos) saida = saida.split(s).join("[segredo]");
  return saida;
}

module.exports = {
  RAIZ,
  LAB,
  RE_EXECUCAO,
  raizDoLaboratorio,
  novoIdExecucao,
  diretorioExecucao,
  diretorioTrabalho,
  diretorioSaida,
  diretorioCache,
  removerSeguro,
  exigirHostDescartavel,
  registrarProcesso,
  registrarPorta,
  encerrarFilhos,
  nucleoPlatformio,
  comandoPio,
  registrarSegredo,
  redigir,
};
