

const Tempo = {
  formatarDataHora(datetimeUtcSqlite) {
    if (!datetimeUtcSqlite) return "—";
    const data = new Date(datetimeUtcSqlite.replace(" ", "T") + "Z");
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(data);
  },

  paraEpochMs(datetimeUtcSqlite) {
    if (!datetimeUtcSqlite) return null;
    return new Date(datetimeUtcSqlite.replace(" ", "T") + "Z").getTime();
  },

  formatarDuracao(totalSegundos) {
    const s = Math.max(0, Math.floor(totalSegundos));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  },
};
