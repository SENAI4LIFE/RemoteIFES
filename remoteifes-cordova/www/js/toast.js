const Toast = (() => {
  const DURACAO_ERRO_MS = 6000;
  const DURACAO_AVISO_MS = 8000;

  let pilha = null;
  const estadosAtivos = new Map();

  function obterPilha() {
    if (!pilha) {
      pilha = document.createElement("div");
      pilha.className = "toast-stack";
      pilha.setAttribute("aria-live", "polite");
      document.body.appendChild(pilha);
    }
    return pilha;
  }

  function mostrar(texto, tipo, duracaoMs) {
    if (!texto) return null;
    const el = document.createElement("p");
    el.className = `toast toast-${tipo}`;
    el.textContent = texto;
    el.addEventListener("click", () => remover(el));

    obterPilha().appendChild(el);

    if (duracaoMs) {
      setTimeout(() => remover(el), duracaoMs);
    }
    return el;
  }

  function remover(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function erro(texto) {
    return mostrar(texto, "erro", DURACAO_ERRO_MS);
  }

  function aviso(texto) {
    return mostrar(texto, "aviso", DURACAO_AVISO_MS);
  }

  // Para avisos de estado contínuo (ex: "dispositivo offline"), evita repetir
  // a mensagem a cada atualização — só dispara na transição de inativo -> ativo.
  function criarAvisoDeEstado(chave, texto) {
    return function aplicar(ativo) {
      const jaAtivo = estadosAtivos.get(chave) || false;
      if (ativo && !jaAtivo) {
        aviso(texto);
      }
      estadosAtivos.set(chave, !!ativo);
    };
  }

  return { erro, aviso, criarAvisoDeEstado };
})();
