const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Automatic update check of the installed Console.
//
// RemoteIFES and this Console work indefinitely on a campus LAN with no Internet. Internet only
// lets the Console discover and download a newer version of itself, so this check is kept apart
// from everything else:
//   - it starts minutes after the Console is up and runs on its own timer, never inside a request,
//     the launcher's readiness, /health or anything the application does;
//   - it does not probe connectivity: the scheduled check itself is the attempt, and its failure
//     is how "no Internet now" is learned;
//   - a failure is a result, not an error: nothing is marked unhealthy, nothing pops up, and the
//     audit log records only changes of state (first failure, recovery, a different refusal);
//   - failures back off exponentially with jitter up to a day, persisted in the state directory so
//     restarts do not reset it; a success returns to the normal twice-a-day rhythm;
//   - one timer, unref'ed (it never keeps the process alive nor delays the idle exit), and at most
//     one check in flight. Every network operation under it has its own deadline.
// A verified newer version is installed side by side and loads at the next start of the Console
// (src/atualizador.js, atualizarAutomaticamente).

const TEMPOS = {
  esperaInicialMs: 2 * 60_000,
  intervaloMs: 12 * 3600_000,
  recuoBaseMs: 30 * 60_000,
  recuoTetoMs: 24 * 3600_000,
  ocupadoMs: 30 * 60_000,
  variacao: 0.2,
};

// Results that say "not now, the network": they back off.
const TEMPORARIOS = new Set(["sem-rede", "falha-local"]);

function arquivo() {
  return path.join(config.DIR_ESTADO, "verificacao-automatica.json");
}

function ler() {
  const bruto = estado.lerJson(arquivo(), {});
  return {
    proximaEm: Number.isFinite(bruto.proximaEm) ? bruto.proximaEm : null,
    falhasSeguidas: Number.isSafeInteger(bruto.falhasSeguidas) && bruto.falhasSeguidas > 0 ? bruto.falhasSeguidas : 0,
    ultimaTentativa: bruto.ultimaTentativa && typeof bruto.ultimaTentativa === "object" ? bruto.ultimaTentativa : null,
    ultimoSucessoEm: typeof bruto.ultimoSucessoEm === "string" ? bruto.ultimoSucessoEm : null,
  };
}

function gravar(valor) {
  try {
    estado.gravarJson(arquivo(), valor, 0o600);
  } catch {
    // A state directory that cannot be written costs only the memory of the schedule.
  }
}

function comVariacao(ms, aleatorio) {
  const v = TEMPOS.variacao;
  return Math.round(ms * (1 - v + 2 * v * aleatorio()));
}

/** Delay after the n-th consecutive failure (n >= 1): 30 min, 1 h, 2 h ... up to one day. */
function atrasoDeFalha(n, aleatorio = Math.random) {
  const bruto = Math.min(TEMPOS.recuoTetoMs, TEMPOS.recuoBaseMs * 2 ** Math.min(Math.max(n, 1) - 1, 20));
  return comVariacao(bruto, aleatorio);
}

/**
 * The state after a check. Pure, so the pacing is tested without timers.
 */
function proximoEstado(anterior, resultado, agora, aleatorio = Math.random) {
  const tipo = resultado.tipo;
  const temporario = TEMPORARIOS.has(tipo);
  const falhasSeguidas = temporario ? anterior.falhasSeguidas + 1 : 0;
  let atraso;
  if (temporario) atraso = atrasoDeFalha(falhasSeguidas, aleatorio);
  else if (tipo === "ocupado") atraso = comVariacao(TEMPOS.ocupadoMs, aleatorio);
  else atraso = comVariacao(TEMPOS.intervaloMs, aleatorio);
  const sucesso = ["em-dia", "atualizado", "sem-publicacao"].includes(tipo);
  return {
    proximaEm: agora + atraso,
    falhasSeguidas,
    ultimaTentativa: {
      em: new Date(agora).toISOString(),
      tipo,
      motivo: resultado.motivo || null,
      versao: resultado.versao || null,
    },
    ultimoSucessoEm: sucesso ? new Date(agora).toISOString() : anterior.ultimoSucessoEm,
  };
}

/**
 * Audit only what changed. A campus without Internet would otherwise write the same line twice a
 * day forever, and a log that repeats itself is one nobody reads.
 */
function registrar(anterior, novo) {
  const antes = anterior.ultimaTentativa || {};
  const agora = novo.ultimaTentativa;
  if (agora.tipo === "atualizado") {
    return estado.auditar("atualizacao-automatica-instalada", { versao: agora.versao });
  }
  if (agora.tipo === "recusado" && (antes.tipo !== "recusado" || antes.motivo !== agora.motivo)) {
    return estado.auditar("atualizacao-automatica-recusada", { motivo: agora.motivo });
  }
  const eraTemporario = TEMPORARIOS.has(antes.tipo);
  const eTemporario = TEMPORARIOS.has(agora.tipo);
  if (eTemporario && !eraTemporario) {
    return estado.auditar("atualizacao-automatica-adiada", { motivo: agora.motivo, proximaEm: new Date(novo.proximaEm).toISOString() });
  }
  if (!eTemporario && eraTemporario && agora.tipo !== "ocupado") {
    return estado.auditar("atualizacao-automatica-restabelecida", { depoisDeFalhas: anterior.falhasSeguidas });
  }
  return null;
}

let ativo = null;

/**
 * Starts the schedule in this process. Idempotent. The options exist for tests: a clock, a source
 * of randomness and the check itself.
 */
function iniciar({ agora = Date.now, aleatorio = Math.random, verificar = null } = {}) {
  if (ativo) return ativo;
  const executar = verificar || (() => require("./atualizador").atualizarAutomaticamente());
  let temporizador = null;
  let agendadoPara = null;
  let emCurso = null;
  let parado = false;

  const agendar = (quando) => {
    if (parado) return;
    clearTimeout(temporizador);
    // A clock set back, or a file edited by hand, must not postpone the check for months.
    const atraso = Math.min(Math.max(quando - agora(), 0), TEMPOS.recuoTetoMs * 2);
    agendadoPara = agora() + atraso;
    temporizador = setTimeout(ciclo, atraso);
    if (typeof temporizador.unref === "function") temporizador.unref();
  };

  async function ciclo() {
    temporizador = null;
    agendadoPara = null;
    if (parado || emCurso) return;
    const anterior = ler();
    const inicio = agora();
    // Written BEFORE the attempt: if the process ends in the middle (idle exit, a crash, power), the
    // next start does not retry at once but after the delay a failure would have earned.
    gravar({ ...anterior, proximaEm: inicio + atrasoDeFalha(anterior.falhasSeguidas + 1, aleatorio) });
    emCurso = (async () => {
      let resultado;
      try {
        resultado = await executar();
      } catch (erro) {
        resultado = { tipo: "falha-local", motivo: (erro && erro.message) || String(erro) };
      }
      const novo = proximoEstado(anterior, resultado || { tipo: "falha-local" }, agora(), aleatorio);
      gravar(novo);
      try {
        registrar(anterior, novo);
      } catch {}
      return novo;
    })();
    try {
      const novo = await emCurso;
      agendar(novo.proximaEm);
    } finally {
      emCurso = null;
    }
  }

  const salvo = ler();
  agendar(Math.max(salvo.proximaEm || 0, agora() + comVariacao(TEMPOS.esperaInicialMs, aleatorio)));

  ativo = {
    parar() {
      parado = true;
      clearTimeout(temporizador);
      temporizador = null;
      agendadoPara = null;
      ativo = null;
    },
    /** For tests: runs a check now, outside the timer. */
    async executarAgora() {
      clearTimeout(temporizador);
      await ciclo();
      return ler();
    },
    emCurso: () => emCurso,
    temporizadorAtivo: () => temporizador !== null,
    agendadoPara: () => agendadoPara,
  };
  return ativo;
}

/**
 * What the interface shows: the latest automatic attempt, kept apart from the last successful
 * observation of the publication (observacao-release.json), which a failure never erases.
 */
function resumo() {
  const s = ler();
  if (!s.ultimaTentativa && !s.proximaEm) return null;
  return {
    ultimaTentativa: s.ultimaTentativa,
    proximaEm: s.proximaEm ? new Date(s.proximaEm).toISOString() : null,
    falhasSeguidas: s.falhasSeguidas,
    ultimoSucessoEm: s.ultimoSucessoEm,
  };
}

module.exports = { TEMPOS, iniciar, resumo, proximoEstado, atrasoDeFalha, registrar };
