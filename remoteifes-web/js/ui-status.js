const Status = (() => {
  const DEF = {
    disponivel: { rotulo: "disponível", icone: "circulo-cheio", classe: "ok" },
    indisponivel: { rotulo: "indisponível", icone: "circulo-x", classe: "err" },
    offline: { rotulo: "offline", icone: "circulo-vazio", classe: "off" },
    "temporariamente-indisponivel": { rotulo: "temporariamente indisponível", icone: "circulo-meio", classe: "warn" },
    "desabilitado-config": { rotulo: "desativado por configuração", icone: "circulo-cortado", classe: "muted" },
    "restrito-permissao": { rotulo: "restrito por permissão", icone: "cadeado", classe: "muted" },
    carregando: { rotulo: "carregando", icone: "circulo-reticencias", classe: "loading" },
    falha: { rotulo: "falha", icone: "circulo-exclamacao", classe: "err" },
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
      `<span class="status-chip-dot" aria-hidden="true">${Icones.markup(d.icone)}</span>` +
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
