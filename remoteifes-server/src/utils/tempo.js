const FUSO = "America/Sao_Paulo";

const DIAS_SEMANA_FORMATADOR = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO,
  weekday: "short",
});

const MAPA_DIA_SEMANA = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partesAgoraBrasilia() {
  const formatador = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const partes = {};
  for (const { type, value } of formatador.formatToParts(new Date())) {
    if (type !== "literal") partes[type] = value;
  }
  return partes;
}

function horaAtualBrasilia() {
  const p = partesAgoraBrasilia();
  return `${p.hour}:${p.minute}`;
}

function diaAtualBrasilia() {
  const abreviacao = DIAS_SEMANA_FORMATADOR.format(new Date());
  return MAPA_DIA_SEMANA[abreviacao];
}

function dataAtualBrasiliaISO() {
  const p = partesAgoraBrasilia();
  return `${p.year}-${p.month}-${p.day}`;
}

function formatarParaBrasilia(datetimeUtcSqlite) {
  if (!datetimeUtcSqlite) return null;
  const data = new Date(datetimeUtcSqlite.replace(" ", "T") + "Z");
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(data);
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
  diaAtualBrasilia,
  dataAtualBrasiliaISO,
  formatarParaBrasilia,
  brasiliaParaUtcSqlite,
  paraEpochMs,
};
