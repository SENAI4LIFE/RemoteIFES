const Status = (() => {
  const DEF = {
    disponivel: { rotulo: "disponível", icone: "●", classe: "ok" },
    indisponivel: { rotulo: "indisponível", icone: "✕", classe: "err" },
    offline: { rotulo: "offline", icone: "○", classe: "off" },
    "temporariamente-indisponivel": { rotulo: "temporariamente indisponível", icone: "◐", classe: "warn" },
    "desabilitado-config": { rotulo: "desativado por configuração", icone: "⊘", classe: "muted" },
    "restrito-permissao": { rotulo: "restrito por permissão", icone: "🔒", classe: "muted" },
    carregando: { rotulo: "carregando", icone: "…", classe: "loading" },
    falha: { rotulo: "falha", icone: "!", classe: "err" },
  };

  function normalizar(estado) {
    return DEF[estado] ? estado : "indisponivel";
  }

  function chip(estado, rotulo) {
    const key = normalizar(estado);
    const d = DEF[key];
    const texto = rotulo || d.rotulo;
    return (
      `<span class="status-chip status-${d.classe}" role="status">` +
      `<span class="status-chip-dot" aria-hidden="true">${d.icone}</span>` +
      `<span class="status-chip-label">${escapeHtml(texto)}</span>` +
      `</span>`
    );
  }

  function aplicar(el, estado, rotulo) {
    if (!el) return;
    el.innerHTML = chip(estado, rotulo);
  }

  return { chip, aplicar, estados: Object.keys(DEF) };
})();
