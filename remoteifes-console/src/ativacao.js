const fs = require("fs");
const path = require("path");

// Activation confirmation after a Console self-update.
//
// The updater swaps the version pointer and asks for a restart; the new version can still fail
// after it started (a crash once it is listening, an exception on the first request). The stable
// bootstrap only catches failures thrown while loading, so such a version would be restarted into
// the same failure forever. Instead:
//
//  - the updater records `ativacao: { versao, anterior, partidas: 0, confirmada: false }` when the
//    target payload carries this module (older payloads cannot confirm and get no record);
//  - the stable bootstrap counts the starts of an unconfirmed version and, after LIMITE_PARTIDAS
//    starts without confirmation, points back to `anterior` and records `reversaoAutomatica`;
//  - this module confirms the running version once it has listened and stayed up for
//    CONFIRMACAO_MS, which ends the counting.
//
// It is bounded, not a two-phase commit: a healthy version interrupted repeatedly before the
// confirmation delay (host restarts) would also be reverted, and the report says exactly that.

const CONFIRMACAO_MS = (() => {
  const pedido = Number(process.env.CONSOLE_CONFIRMACAO_ATIVACAO_MS);
  return Number.isFinite(pedido) && pedido >= 0 ? Math.min(pedido, 10 * 60 * 1000) : 20_000;
})();

function arquivoEstado(raiz) {
  return path.join(raiz, "estado-instalacao.json");
}

function lerEstado(raiz) {
  try {
    return JSON.parse(fs.readFileSync(arquivoEstado(raiz), "utf8"));
  } catch {
    return null;
  }
}

function gravarEstado(raiz, valor) {
  const arquivo = arquivoEstado(raiz);
  const temporario = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, `${JSON.stringify(valor, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporario, arquivo);
}

/**
 * Marks `versao` as confirmed when it is the pending activation. Returns true when it confirmed.
 */
function confirmar({ raiz, versao }) {
  const info = lerEstado(raiz);
  const a = info && info.ativacao;
  if (!a || a.confirmada || a.versao !== versao) return false;
  gravarEstado(raiz, { ...info, ativacao: { ...a, confirmada: true, confirmadaEm: new Date().toISOString() } });
  return true;
}

function agendarConfirmacao({ raiz, versao, aoConfirmar = () => {} }) {
  const relogio = setTimeout(() => {
    try {
      if (confirmar({ raiz, versao })) aoConfirmar();
    } catch {}
  }, CONFIRMACAO_MS);
  if (typeof relogio.unref === "function") relogio.unref();
  return relogio;
}

module.exports = { confirmar, agendarConfirmacao, CONFIRMACAO_MS };
