const Icones = (() => {
  function markup(nome, classe) {
    const cls = classe ? `icone ${classe}` : "icone";
    return `<svg class="${cls}" aria-hidden="true"><use href="#i-${nome}"></use></svg>`;
  }

  function aplicar(el, nome, classe) {
    if (el) el.innerHTML = markup(nome, classe);
  }

  return { markup, aplicar };
})();
