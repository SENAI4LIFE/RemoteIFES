(function () {
  const CHAVE = "remoteifes_font_scale";
  const MIN = 0.85;
  const MAX = 1.3;
  const PASSO = 0.075;

  function aplicarEscala(escala) {
    document.documentElement.style.setProperty("--a11y-zoom", escala);
  }

  function lerEscalaSalva() {
    const salvo = parseFloat(localStorage.getItem(CHAVE));
    return Number.isFinite(salvo) ? salvo : MIN;
  }

  function salvarEscala(escala) {
    localStorage.setItem(CHAVE, String(escala));
  }

  let escalaAtual = lerEscalaSalva();
  aplicarEscala(escalaAtual);

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("a11yToggleBtn");
    const panel = document.getElementById("a11yPanel");
    const decreaseBtn = document.getElementById("a11yDecreaseBtn");
    const increaseBtn = document.getElementById("a11yIncreaseBtn");
    const resetBtn = document.getElementById("a11yResetBtn");
    if (!toggleBtn || !panel) return;

    function ajustar(delta) {
      escalaAtual = Math.min(MAX, Math.max(MIN, +(escalaAtual + delta).toFixed(3)));
      aplicarEscala(escalaAtual);
      salvarEscala(escalaAtual);
    }

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("hidden");
    });

    decreaseBtn.addEventListener("click", () => ajustar(-PASSO));
    increaseBtn.addEventListener("click", () => ajustar(PASSO));
    resetBtn.addEventListener("click", () => {
      escalaAtual = MIN;
      aplicarEscala(escalaAtual);
      salvarEscala(escalaAtual);
    });

    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== toggleBtn) {
        panel.classList.add("hidden");
      }
    });
  });
})();
