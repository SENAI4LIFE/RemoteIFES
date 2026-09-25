#!/usr/bin/env node
// Stable layer of the Operations Console.
//
// This file is installed by the package (deb, zip, bundle) and is **never rewritten by an update**.
// It only resolves which version is active and loads it. That lets the package manager keep owning
// a fixed set of files while the updater swaps the payload side by side, without the two models
// colliding.
//
// It is also the safety net: if the active version is broken or missing, it falls back to the
// previous one and says why, instead of leaving the service unable to start.
//
// A version can also fail after it loaded (a crash once listening). For a self-update the updater
// records a pending activation; this bootstrap counts the starts of that version until the version
// confirms itself (src/ativacao.js in the payload) and, after LIMITE_PARTIDAS starts without
// confirmation, points back to the previous version and records why.

const fs = require("fs");
const path = require("path");

const RAIZ = __dirname;
const ARQUIVO_ESTADO = path.join(RAIZ, "estado-instalacao.json");
const DIR_VERSOES = path.join(RAIZ, "versoes");
// Which entry to load. `launcher-bootstrap.js` sets "launcher"; any other value (or none) means the
// Console. Whoever starts the backend must set the value explicitly, because inheriting "launcher"
// from a launcher would make this bootstrap load another launcher instead of the Console the
// launcher was trying to start.
const ALVO = process.env.CONSOLE_BOOTSTRAP_ALVO === "launcher" ? "launcher.js" : "console.js";

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8"));
  } catch {
    return {};
  }
}

const LIMITE_PARTIDAS = 2;

function gravarEstado(valor) {
  const temporario = `${ARQUIVO_ESTADO}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, `${JSON.stringify(valor, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporario, ARQUIVO_ESTADO);
}

/**
 * Counts one start of a pending (unconfirmed) activation, or reverts it. Only the Console entry
 * counts: opening the launcher is not a start of the service.
 */
function registrarPartida() {
  if (ALVO !== "console.js") return;
  const info = lerEstado();
  const a = info.ativacao;
  if (!a || a.confirmada || a.versao !== info.versaoAtiva) return;
  const partidas = Number(a.partidas) || 0;
  try {
    if (partidas >= LIMITE_PARTIDAS && versaoUtilizavel(a.anterior)) {
      gravarEstado({
        ...info,
        versaoAtiva: a.anterior,
        versaoAnterior: a.versao,
        ativacao: null,
        reversaoAutomatica: {
          de: a.versao,
          para: a.anterior,
          partidas,
          em: new Date().toISOString(),
          motivo: `a versão ${a.versao} iniciou ${partidas} vezes sem confirmar que se mantém no ar`,
        },
      });
      console.error(`[bootstrap] a versão ${a.versao} não se manteve no ar em ${partidas} partidas; voltando para ${a.anterior}.`);
      return;
    }
    gravarEstado({ ...info, ativacao: { ...a, partidas: partidas + 1 } });
  } catch (erro) {
    console.error(`[bootstrap] não foi possível registrar a partida da versão ${a.versao}: ${erro.message}`);
  }
}

function versaoUtilizavel(versao) {
  if (!versao) return null;
  const dir = path.join(DIR_VERSOES, versao);
  return fs.existsSync(path.join(dir, ALVO)) ? dir : null;
}

function versoesPresentes() {
  try {
    return fs
      .readdirSync(DIR_VERSOES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i += 1) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });
  } catch {
    return [];
  }
}

/**
 * Candidates in order of preference: the pointer, the previous version, the newest present, and the
 * payload beside this file (development install).
 *
 * There are several because *the file existing* is not the same as *being able to load it*. A
 * signed payload can carry every required file and still have a syntax error or a failing require;
 * then `require()` throws and the next candidate is tried, so a bad update does not leave the
 * Console unable to start precisely when it is the tool needed to fix things.
 */
function candidatas() {
  const info = lerEstado();
  const lista = [];
  const juntar = (versao, origem) => {
    const dir = versaoUtilizavel(versao);
    if (dir && !lista.some((c) => c.dir === dir)) lista.push({ dir, versao, origem });
  };

  juntar(info.versaoAtiva, "ponteiro");
  juntar(info.versaoAnterior, "anterior");
  for (const versao of versoesPresentes()) juntar(versao, "mais-recente");
  if (fs.existsSync(path.join(RAIZ, ALVO))) lista.push({ dir: RAIZ, versao: null, origem: "no-lugar" });
  return lista;
}

registrarPartida();
const disponiveis = candidatas();
if (!disponiveis.length) {
  console.error(
    `[bootstrap] nenhuma versão utilizável do console foi encontrada em ${DIR_VERSOES}.\n` +
      "Reinstale o pacote do Console de Operações para restaurar a instalação."
  );
  process.exit(1);
}

// CONSOLE_RAIZ_INSTALACAO pins the stable layer for the payload, which needs it to manage versoes/
// and the pointer even when running from inside versoes/<v>/.
process.env.CONSOLE_RAIZ_INSTALACAO = RAIZ;

// The state location comes from the installation RECORD, not the platform default.
//
// The system shortcut runs this bootstrap without any environment variable. Without reading the
// record, a user-scope installation would look for state in `/var/lib/...` (or `%ProgramData%`) and
// the first operator would not find the token the installer had just written. A variable already
// set by the operator or the service still takes precedence.
{
  const registrado = lerEstado();
  if (!process.env.CONSOLE_ESTADO_DIR && typeof registrado.estado === "string" && registrado.estado) {
    process.env.CONSOLE_ESTADO_DIR = registrado.estado;
  }
  if (!process.env.CONSOLE_PORTA && Number.isInteger(registrado.porta) && registrado.porta > 0) {
    process.env.CONSOLE_PORTA = String(registrado.porta);
  }
}

let iniciou = false;
for (const [indice, candidata] of disponiveis.entries()) {
  if (indice > 0) {
    console.error(`[bootstrap] tentando a versão ${candidata.versao || "local"} (${candidata.origem}).`);
  }
  try {
    // Calls the exported entry instead of relying on a load side effect: here the main module is
    // this bootstrap, so `require.main === module` would be false in the payload.
    const modulo = require(path.join(candidata.dir, ALVO));
    if (typeof modulo.executar !== "function") {
      throw new Error(`${ALVO} não expõe uma entrada "executar"`);
    }
    modulo.executar();
    iniciou = true;
    break;
  } catch (erro) {
    console.error(
      `[bootstrap] a versão ${candidata.versao || "local"} não carregou: ${erro && erro.message ? erro.message : erro}`
    );
  }
}

if (!iniciou) {
  console.error(
    "[bootstrap] nenhuma versão instalada do console conseguiu iniciar.\n" +
      "Reinstale o pacote do Console de Operações para restaurar a instalação."
  );
  process.exit(1);
}
