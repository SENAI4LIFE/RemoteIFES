const FUSO = "America/Sao_Paulo";

// Built once, at load. The first time-zone formatter a process creates loads ICU's time-zone data,
// which on a cold host takes hundreds of milliseconds; left to the first call, that cost landed on
// the first client after a restart (the status message built for its connection computes each
// room's schedule) and showed the connecting screen over a working socket. Reusing the instance
// also spares every later call from building a new formatter.
const FORMATADOR_PARTES = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function partesAgoraBrasilia(instante = new Date()) {
  const partes = {};
  for (const { type, value } of FORMATADOR_PARTES.formatToParts(instante)) {
    if (type !== "literal") partes[type] = value;
  }
  return partes;
}

function horaAtualBrasilia(instante = new Date()) {
  const p = partesAgoraBrasilia(instante);
  return `${p.hour}:${p.minute}`;
}

function dataAtualBrasiliaISO(instante = new Date()) {
  const p = partesAgoraBrasilia(instante);
  return `${p.year}-${p.month}-${p.day}`;
}

// Instant in SQLite datetime('now') format (UTC), taken from the JavaScript clock.
function utcSqlite(instante = new Date()) {
  return instante.toISOString().slice(0, 19).replace("T", " ");
}

function deslocarDataISO(dataISO, dias) {
  const [ano, mes, dia] = dataISO.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

// UTC instant, in SQLite datetime('now') format, of a Brasília time (fixed UTC-3, no daylight
// saving since 2019; the same '-3 hours' used in queries).
function brasiliaParaUtcSqlite(dataISO, horaMinuto) {
  return new Date(`${dataISO}T${horaMinuto}:00-03:00`).toISOString().slice(0, 19).replace("T", " ");
}

function paraEpochMs(datetimeUtcSqlite) {
  if (!datetimeUtcSqlite) return null;
  return new Date(datetimeUtcSqlite.replace(" ", "T") + "Z").getTime();
}

module.exports = {
  FUSO,
  horaAtualBrasilia,
  dataAtualBrasiliaISO,
  brasiliaParaUtcSqlite,
  paraEpochMs,
  utcSqlite,
  deslocarDataISO,
};
