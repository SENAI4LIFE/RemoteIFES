const fs = require("fs");

// Restore exclusion.
//
// A managed restore (Operations Console, bin/restaurar.js) proves that no process writes to the
// database and then swaps the file. Proof and swap are not one instant: a RemoteIFES process started
// in between (the service restarted by hand, `npm start`, a terminal script) would open the old file
// and keep writing to it after the swap, or write into the file being replaced. The restore
// therefore publishes a marker next to the database for the whole window, and every RemoteIFES
// process refuses to open the database while the marker names a live process.
//
// A marker whose process is gone, or older than any restore can last, is ignored: a crashed restore
// must not keep the application down.

const IDADE_MAXIMA_MS = 30 * 60 * 1000;

function caminhoMarcador(caminhoBanco) {
  return `${caminhoBanco}.restauracao`;
}

function processoVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    return erro.code === "EPERM";
  }
}

/**
 * @returns {{ pid: number, desde: string } | null} the restore in progress, or null.
 */
function restauracaoEmAndamento(caminhoBanco, { agora = Date.now() } = {}) {
  if (!caminhoBanco || caminhoBanco === ":memory:") return null;
  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(caminhoMarcador(caminhoBanco), "utf8"));
  } catch {
    return null;
  }
  const pid = Number(dados && dados.pid);
  const desde = Date.parse(dados && dados.desde);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(desde)) return null;
  if (pid === process.pid) return null;
  if (agora - desde > IDADE_MAXIMA_MS) return null;
  if (!processoVivo(pid)) return null;
  return { pid, desde: dados.desde };
}

/**
 * Publishes the marker for the current process and returns the function that removes it. The
 * Console's restore runner writes the same format ({ pid, desde }) independently, so a Console
 * newer or older than the checkout still coordinates with it.
 */
function publicarMarcador(caminhoBanco) {
  const marcador = caminhoMarcador(caminhoBanco);
  const temporario = `${marcador}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }), { mode: 0o644 });
  fs.renameSync(temporario, marcador);
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(marcador, "utf8")).pid === process.pid) fs.rmSync(marcador, { force: true });
    } catch {}
  };
}

module.exports = { caminhoMarcador, restauracaoEmAndamento, publicarMarcador, IDADE_MAXIMA_MS };
