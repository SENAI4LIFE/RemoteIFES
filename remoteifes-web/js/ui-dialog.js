const Dialog = (() => {
  const SELETOR_FOCAVEIS =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let elementoAnterior = null;
  let atual = null;

  function focaveis(container) {
    return Array.from(container.querySelectorAll(SELETOR_FOCAVEIS)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }

  function fechar(resultado) {
    if (!atual) return;
    const { overlay, resolver, onKey } = atual;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    atual = null;
    const alvo = elementoAnterior;
    elementoAnterior = null;
    if (alvo && typeof alvo.focus === "function") {
      try {
        alvo.focus();
      } catch (erro) {}
    }
    resolver(resultado);
  }

  function abrir(config) {
    if (atual) fechar(null);
    elementoAnterior = document.activeElement;

    return new Promise((resolver) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay app-dialog-overlay";
      const idTitulo = `appDlgTit_${Math.random().toString(36).slice(2)}`;
      overlay.innerHTML = `
        <div class="modal-card app-dialog-card" role="dialog" aria-modal="true" aria-labelledby="${idTitulo}">
          <h2 id="${idTitulo}" class="app-dialog-title"></h2>
          <p class="app-dialog-desc hidden"></p>
          <div class="app-dialog-body"></div>
          <p class="app-dialog-error hidden" role="alert" aria-live="assertive"></p>
          <div class="app-dialog-actions"></div>
        </div>`;

      const card = overlay.querySelector(".app-dialog-card");
      const tituloEl = overlay.querySelector(".app-dialog-title");
      const descEl = overlay.querySelector(".app-dialog-desc");
      const bodyEl = overlay.querySelector(".app-dialog-body");
      const erroEl = overlay.querySelector(".app-dialog-error");
      const acoesEl = overlay.querySelector(".app-dialog-actions");

      tituloEl.textContent = config.titulo || "";
      if (config.descricao) {
        descEl.textContent = config.descricao;
        descEl.classList.remove("hidden");
      }

      function mostrarErro(mensagem) {
        erroEl.textContent = mensagem || "ocorreu um erro";
        erroEl.classList.remove("hidden");
      }
      function limparErro() {
        erroEl.textContent = "";
        erroEl.classList.add("hidden");
      }

      if (typeof config.montarCorpo === "function") {
        config.montarCorpo(bodyEl, { mostrarErro, limparErro, fechar });
      } else {
        bodyEl.classList.add("hidden");
      }

      const cancelarBtn = document.createElement("button");
      cancelarBtn.type = "button";
      cancelarBtn.className = "btn btn-off";
      cancelarBtn.textContent = config.cancelarTexto || "Cancelar";
      cancelarBtn.addEventListener("click", () => fechar(null));

      const confirmarBtn = document.createElement("button");
      confirmarBtn.type = "button";
      confirmarBtn.className = `btn ${config.perigo ? "btn-danger" : "btn-on"}`;
      confirmarBtn.textContent = config.confirmarTexto || "Confirmar";

      let ocupado = false;

      async function confirmar() {
        if (ocupado) return;
        limparErro();

        let valores = {};
        if (typeof config.coletar === "function") {
          const resultadoColeta = config.coletar(bodyEl);
          if (resultadoColeta && resultadoColeta.erro) {
            mostrarErro(resultadoColeta.erro);
            return;
          }
          valores = (resultadoColeta && resultadoColeta.valores) || {};
        }

        if (typeof config.aoConfirmar !== "function") {
          fechar(valores);
          return;
        }

        ocupado = true;
        confirmarBtn.disabled = true;
        cancelarBtn.disabled = true;
        const textoOriginal = confirmarBtn.textContent;
        confirmarBtn.textContent = config.textoOcupado || "Enviando…";
        try {
          const res = await config.aoConfirmar(valores);
          if (res && res.ok === false) {
            mostrarErro(res.erro || "não foi possível concluir a ação");
            return;
          }
          fechar(res && res.resultado !== undefined ? res.resultado : valores);
        } catch (erro) {
          mostrarErro((erro && erro.message) || "não foi possível concluir a ação");
        } finally {
          ocupado = false;
          confirmarBtn.disabled = false;
          cancelarBtn.disabled = false;
          confirmarBtn.textContent = textoOriginal;
        }
      }

      confirmarBtn.addEventListener("click", confirmar);

      if (!config.semCancelar) acoesEl.appendChild(cancelarBtn);
      acoesEl.appendChild(confirmarBtn);

      bodyEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const alvo = e.target;
        if (alvo.tagName === "TEXTAREA") return;
        if (alvo.tagName === "INPUT" && (alvo.type === "checkbox" || alvo.type === "radio")) return;
        e.preventDefault();
        confirmar();
      });

      function onKey(e) {
        if (!atual || atual.overlay !== overlay) return;
        if (e.key === "Escape") {
          e.preventDefault();
          fechar(null);
          return;
        }
        if (e.key !== "Tab") return;
        const lista = focaveis(card);
        if (lista.length === 0) return;
        const primeiro = lista[0];
        const ultimo = lista[lista.length - 1];
        if (!card.contains(document.activeElement)) {
          e.preventDefault();
          primeiro.focus();
        } else if (e.shiftKey && document.activeElement === primeiro) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primeiro.focus();
        }
      }
      document.addEventListener("keydown", onKey, true);

      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay && !ocupado) fechar(null);
      });

      document.body.appendChild(overlay);
      atual = { overlay, resolver, onKey };

      const alvoFoco =
        (config.focoInicial && card.querySelector(config.focoInicial)) ||
        card.querySelector("input:not([type=hidden]), select, textarea") ||
        confirmarBtn;
      requestAnimationFrame(() => {
        try {
          alvoFoco.focus();
        } catch (erro) {}
      });
    });
  }

  function confirmar({ titulo, mensagem, confirmarTexto = "Confirmar", cancelarTexto = "Cancelar", perigo = false } = {}) {
    return abrir({ titulo, descricao: mensagem, confirmarTexto, cancelarTexto, perigo }).then((r) => r !== null);
  }

  function aviso({ titulo, mensagem, okTexto = "Entendi" } = {}) {
    return abrir({ titulo, descricao: mensagem, confirmarTexto: okTexto, semCancelar: true }).then(() => undefined);
  }

  function texto({
    titulo,
    descricao,
    label,
    valorInicial = "",
    placeholder = "",
    obrigatorio = true,
    minLength = 0,
    maxLength = 200,
    confirmarTexto = "Salvar",
    textoOcupado = "Salvando…",
    aoConfirmar,
  } = {}) {
    return abrir({
      titulo,
      descricao,
      confirmarTexto,
      textoOcupado,
      focoInicial: "#appDlgTextoInput",
      montarCorpo(body) {
        const campo = document.createElement("div");
        campo.className = "app-dialog-field";
        const lbl = document.createElement("label");
        lbl.setAttribute("for", "appDlgTextoInput");
        lbl.textContent = label || "";
        const input = document.createElement("input");
        input.type = "text";
        input.id = "appDlgTextoInput";
        input.autocomplete = "off";
        input.value = valorInicial;
        input.placeholder = placeholder;
        if (maxLength) input.maxLength = maxLength;
        campo.append(lbl, input);
        body.appendChild(campo);
      },
      coletar(body) {
        const valor = body.querySelector("#appDlgTextoInput").value.trim();
        if (obrigatorio && !valor) return { erro: "preencha este campo" };
        if (valor && minLength && valor.length < minLength) {
          return { erro: `use ao menos ${minLength} caracteres` };
        }
        return { valores: { valor } };
      },
      aoConfirmar: aoConfirmar ? (valores) => aoConfirmar(valores.valor) : undefined,
    }).then((r) => (r ? r.valor : null));
  }

  function senha({ titulo = "Trocar senha", descricao, alvoNome, minLength = 8, maxLength = 128, aoConfirmar } = {}) {
    const legenda =
      descricao ||
      (alvoNome ? `Defina uma nova senha para ${alvoNome}.` : "Defina a nova senha.");

    return abrir({
      titulo,
      descricao: legenda,
      confirmarTexto: "Salvar nova senha",
      textoOcupado: "Salvando…",
      focoInicial: "#appDlgPwd1",
      montarCorpo(body) {
        body.innerHTML = `
          <div class="app-dialog-field">
            <label for="appDlgPwd1">Nova senha</label>
            <div class="pwd-field">
              <input type="password" id="appDlgPwd1" autocomplete="new-password" minlength="${minLength}" maxlength="${maxLength}">
              <button type="button" class="pwd-toggle" data-alvo="appDlgPwd1" aria-pressed="false">mostrar</button>
            </div>
          </div>
          <div class="app-dialog-field">
            <label for="appDlgPwd2">Confirmar nova senha</label>
            <div class="pwd-field">
              <input type="password" id="appDlgPwd2" autocomplete="new-password" minlength="${minLength}" maxlength="${maxLength}">
              <button type="button" class="pwd-toggle" data-alvo="appDlgPwd2" aria-pressed="false">mostrar</button>
            </div>
          </div>
          <p class="app-dialog-note">Mínimo de ${minLength} caracteres. A senha atual nunca é exibida. Ao salvar, as sessões abertas desse usuário são encerradas.</p>`;

        body.querySelectorAll(".pwd-toggle").forEach((btn) => {
          btn.addEventListener("click", () => {
            const alvo = body.querySelector(`#${btn.dataset.alvo}`);
            const revelar = alvo.type === "password";
            alvo.type = revelar ? "text" : "password";
            btn.setAttribute("aria-pressed", String(revelar));
            btn.textContent = revelar ? "ocultar" : "mostrar";
          });
        });
      },
      coletar(body) {
        const p1 = body.querySelector("#appDlgPwd1").value;
        const p2 = body.querySelector("#appDlgPwd2").value;
        if (!p1 || !p2) return { erro: "preencha os dois campos de senha" };
        if (p1.length < minLength) return { erro: `a senha deve ter ao menos ${minLength} caracteres` };
        if (p1.length > maxLength) return { erro: `a senha deve ter no máximo ${maxLength} caracteres` };
        if (p1 !== p2) return { erro: "as senhas não coincidem" };
        return { valores: { senha: p1 } };
      },
      aoConfirmar: aoConfirmar ? (valores) => aoConfirmar(valores.senha) : undefined,
    }).then((r) => (r ? { senha: r.senha } : null));
  }

  return { abrir, fechar, confirmar, aviso, texto, senha };
})();
