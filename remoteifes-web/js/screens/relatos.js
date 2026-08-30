const Relatos = {
  _badgeIntervalId: null,
  _painelAberto: false,

  CATEGORIAS: [
    { valor: "ar_condicionado", rotulo: "Ar-condicionado" },
    { valor: "agendamento", rotulo: "Agendamento" },
    { valor: "interface", rotulo: "Interface / site" },
    { valor: "acesso_login", rotulo: "Acesso e login" },
    { valor: "esp32_dispositivo", rotulo: "Dispositivo (ESP32)" },
    { valor: "outro", rotulo: "Outro" },
  ],

  STATUS_ROTULO: {
    novo: "Novo",
    aberto: "Aberto",
    em_analise: "Em análise",
    resolvido: "Resolvido",
  },

  rotuloCategoria(valor) {
    const item = this.CATEGORIAS.find((c) => c.valor === valor);
    return item ? item.rotulo : "Outro";
  },

  formatarHora(criadoEm) {
    if (!criadoEm) return "";
    return String(criadoEm).replace("T", " ").slice(0, 16);
  },

  paginaAtual() {
    const visivel = document.querySelector("#mainApp .screen:not(.hidden)");
    if (visivel && visivel.id) return visivel.id.replace(/^screen-/, "");
    const acesso = ["screen-portal", "screen-login", "screen-manutencao-acesso"].find(
      (id) => document.getElementById(id) && !document.getElementById(id).classList.contains("hidden")
    );
    return acesso ? acesso.replace(/^screen-/, "") : "app";
  },

  contextoAutomatico() {
    return {
      path: `${location.pathname}${location.hash || ""}`.slice(0, 200),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  },

  aoLogar() {
    const wrap = document.getElementById("bugWrap");
    if (wrap) wrap.classList.remove("hidden");
    if (state.isSuperAdmin) this.iniciarBadge();
    else this.pararBadge();
  },

  aoDeslogar() {
    this.pararBadge();
    this.fecharPainel();
    const wrap = document.getElementById("bugWrap");
    if (wrap) wrap.classList.add("hidden");
    const badge = document.getElementById("bugReportBadge");
    if (badge) badge.classList.add("hidden");
  },

  iniciarBadge() {
    this.pararBadge();
    this.atualizarBadge();
    this._badgeIntervalId = setInterval(() => this.atualizarBadge(), 20000);
  },

  pararBadge() {
    if (this._badgeIntervalId) {
      clearInterval(this._badgeIntervalId);
      this._badgeIntervalId = null;
    }
  },

  async atualizarBadge() {
    if (!state.isSuperAdmin) return;
    const resp = await Api.contarRelatos();
    const badge = document.getElementById("bugReportBadge");
    const botao = document.getElementById("bugReportBtn");
    if (!badge || !resp || typeof resp.novos !== "number") return;
    const novos = resp.novos;
    if (novos > 0) {
      badge.textContent = novos > 99 ? "99+" : String(novos);
      badge.classList.remove("hidden");
      if (botao) botao.setAttribute("aria-label", `Relatar um problema — ${novos} ${novos === 1 ? "relato novo" : "relatos novos"}`);
    } else {
      badge.classList.add("hidden");
      if (botao) botao.setAttribute("aria-label", "Relatar um problema");
    }
    if (typeof Admin !== "undefined" && typeof Admin.atualizarBadgeRelatos === "function") {
      Admin.atualizarBadgeRelatos(novos);
    }
  },

  alternarPainel() {
    if (this._painelAberto) this.fecharPainel();
    else this.abrirPainel();
  },

  abrirPainel() {
    const painel = document.getElementById("relatosPanel");
    if (!painel) return;
    this._painelAberto = true;
    painel.classList.remove("hidden");
    const botao = document.getElementById("bugReportBtn");
    if (botao) botao.setAttribute("aria-expanded", "true");
    this.renderPainel();
  },

  fecharPainel() {
    const painel = document.getElementById("relatosPanel");
    if (painel) painel.classList.add("hidden");
    this._painelAberto = false;
    const botao = document.getElementById("bugReportBtn");
    if (botao) botao.setAttribute("aria-expanded", "false");
  },

  async renderPainel() {
    const painel = document.getElementById("relatosPanel");
    if (!painel || !this._painelAberto) return;

    const cabecalho = `
      <div class="relatos-panel-head">
        <h3>Relatar um problema</h3>
        <button type="button" class="link-btn relatos-fechar-btn" aria-label="Fechar painel de relatos">&times;</button>
      </div>
      <button type="button" class="btn btn-on btn-block relatos-novo-btn">Relatar um problema</button>`;

    const gestao = state.isSuperAdmin
      ? `<p class="hint relatos-gestao"><button type="button" class="link-btn relatos-gestao-btn">Gerenciar relatos em Administração &rsaquo; Relatos de problemas &rarr;</button></p>`
      : "";

    painel.innerHTML = cabecalho + gestao + `
      <p class="hint relatos-subtitulo">Seus relatos enviados</p>
      <ul class="relato-lista" aria-live="polite"></ul>
      <p class="hint relato-vazio hidden">Você ainda não enviou nenhum relato.</p>`;
    await this.renderMeus(painel);

    painel.querySelector(".relatos-fechar-btn").addEventListener("click", () => this.fecharPainel());
    painel.querySelector(".relatos-novo-btn").addEventListener("click", () => this.abrirFormulario());
    const gestaoBtn = painel.querySelector(".relatos-gestao-btn");
    if (gestaoBtn) {
      gestaoBtn.addEventListener("click", () => {
        this.fecharPainel();
        if (typeof Router !== "undefined") Router.ir("/admin/relatos", { push: true });
      });
    }
  },

  async renderMeus(painel) {
    const lista = painel.querySelector(".relato-lista");
    const vazio = painel.querySelector(".relato-vazio");
    const relatos = await Api.meusRelatos();
    lista.innerHTML = "";
    if (!Array.isArray(relatos) || relatos.length === 0) {
      vazio.classList.remove("hidden");
      return;
    }
    vazio.classList.add("hidden");
    relatos.forEach((r) => {
      const li = document.createElement("li");
      li.className = "relato-item";
      li.innerHTML = `
        <div class="relato-item-title">
          <span></span>
          <span class="relato-status relato-status-${r.status}">${escapeHtml(this.STATUS_ROTULO[r.status] || r.status)}</span>
        </div>
        <div class="relato-item-meta">${escapeHtml(this.rotuloCategoria(r.categoria))} &middot; ${escapeHtml(this.formatarHora(r.criadoEm))}</div>
        <div class="relato-item-corpo hidden">
          <p class="relato-item-descricao"></p>
          <div class="relato-item-resposta hidden">
            <span class="relato-item-resposta-rotulo">Resposta da equipe:</span>
            <p class="relato-item-resposta-texto"></p>
          </div>
        </div>`;
      li.querySelector(".relato-item-title span").textContent = r.titulo;
      li.querySelector(".relato-item-descricao").textContent = r.descricao;
      if (r.resposta) {
        li.querySelector(".relato-item-resposta").classList.remove("hidden");
        li.querySelector(".relato-item-resposta-texto").textContent = r.resposta;
      }
      li.setAttribute("role", "button");
      li.tabIndex = 0;
      const alternar = () => li.querySelector(".relato-item-corpo").classList.toggle("hidden");
      li.addEventListener("click", alternar);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          alternar();
        }
      });
      lista.appendChild(li);
    });
  },

  abrirFormulario() {
    this.fecharPainel();
    const opcoesCategoria = this.CATEGORIAS.map(
      (c) => `<option value="${c.valor}">${escapeHtml(c.rotulo)}</option>`
    ).join("");

    Dialog.abrir({
      titulo: "Relatar um problema",
      descricao:
        "Descreva o que aconteceu. Sua identificação e a página atual são registradas automaticamente. Não inclua senhas nem códigos de acesso.",
      confirmarTexto: "Enviar relato",
      textoOcupado: "Enviando…",
      focoInicial: "#relatoTitulo",
      montarCorpo: (body) => {
        body.innerHTML = `
          <div class="app-dialog-field">
            <label for="relatoTitulo">Título (resumo curto)</label>
            <input type="text" id="relatoTitulo" maxlength="140" autocomplete="off" />
          </div>
          <div class="app-dialog-field">
            <label for="relatoCategoria">Categoria</label>
            <select id="relatoCategoria">${opcoesCategoria}</select>
          </div>
          <div class="app-dialog-field relato-sala-field hidden">
            <label for="relatoSala">Sala relacionada (opcional)</label>
            <select id="relatoSala"><option value="">&mdash; nenhuma &mdash;</option></select>
          </div>
          <div class="app-dialog-field">
            <label for="relatoDescricao">O que aconteceu? Como reproduzir?</label>
            <textarea id="relatoDescricao" rows="5" maxlength="4000"></textarea>
          </div>
          <p class="app-dialog-note" id="relatoContextoNota"></p>`;

        const nota = body.querySelector("#relatoContextoNota");
        nota.textContent = `Registrado automaticamente: página "${this.paginaAtual()}" e tamanho da tela (${window.innerWidth}x${window.innerHeight}).`;

        Api.listarSalas()
          .then((salas) => {
            if (!Array.isArray(salas) || salas.length === 0) return;
            const sel = body.querySelector("#relatoSala");
            salas.forEach((s) => {
              const opt = document.createElement("option");
              opt.value = s.sala;
              opt.textContent = `${RoomsData.rotulo(s.sala)} — ${s.nome}`;
              sel.appendChild(opt);
            });
            if (state.salaAtual) sel.value = state.salaAtual;
            body.querySelector(".relato-sala-field").classList.remove("hidden");
          })
          .catch(() => {});
      },
      coletar: (body) => {
        const titulo = body.querySelector("#relatoTitulo").value.trim();
        const descricao = body.querySelector("#relatoDescricao").value.trim();
        if (titulo.length < 3) return { erro: "informe um título com ao menos 3 caracteres" };
        if (descricao.length < 10) return { erro: "descreva o problema com ao menos 10 caracteres" };
        const salaSel = body.querySelector("#relatoSala");
        return {
          valores: {
            titulo,
            descricao,
            categoria: body.querySelector("#relatoCategoria").value,
            sala: salaSel && salaSel.value ? salaSel.value : undefined,
          },
        };
      },
      aoConfirmar: async (v) => {
        const resp = await Api.criarRelato({
          titulo: v.titulo,
          descricao: v.descricao,
          categoria: v.categoria,
          sala: v.sala,
          pagina: this.paginaAtual(),
          contexto: this.contextoAutomatico(),
        });
        if (!resp || !resp.ok) {
          return { ok: false, erro: (resp && resp.erro) || "não foi possível enviar o relato" };
        }
        return { ok: true };
      },
    }).then((r) => {
      if (r === null) return;
      Toast.aviso("Relato enviado. Obrigado por ajudar a melhorar o sistema!");
      if (state.isSuperAdmin) this.atualizarBadge();
      if (this._painelAberto) this.renderPainel();
    });
  },

  async abrirDetalhe(id) {
    const resp = await Api.obterRelato(id);
    if (!resp || !resp.ok || !resp.relato) {
      Toast.erro((resp && resp.erro) || "não foi possível abrir o relato");
      return;
    }
    const r = resp.relato;
    this.atualizarBadge();

    return Dialog.abrir({
      titulo: `Relato #${r.id}`,
      confirmarTexto: "Fechar",
      semCancelar: true,
      montarCorpo: (body, helpers) => {
        const autor = r.autor || {};
        body.innerHTML = `
          <div class="relato-detalhe">
            <div class="relato-detalhe-titulo">
              <span></span>
              <span class="relato-status relato-status-${r.status}">${escapeHtml(this.STATUS_ROTULO[r.status] || r.status)}</span>
            </div>
            <dl class="relato-detalhe-campos">
              <div><dt>Enviado por</dt><dd class="d-autor"></dd></div>
              <div><dt>Quando</dt><dd>${escapeHtml(this.formatarHora(r.criadoEm))}</dd></div>
              <div><dt>Categoria</dt><dd>${escapeHtml(this.rotuloCategoria(r.categoria))}</dd></div>
              ${r.sala ? `<div><dt>Sala</dt><dd>${escapeHtml(RoomsData.rotulo(r.sala))}</dd></div>` : ""}
              ${r.pagina ? `<div><dt>Página</dt><dd class="d-pagina"></dd></div>` : ""}
            </dl>
            <div class="relato-detalhe-bloco">
              <div class="relato-detalhe-rotulo">Descrição</div>
              <p class="relato-detalhe-descricao"></p>
            </div>
            ${r.contexto ? `<details class="relato-contexto"><summary>Contexto técnico</summary><pre></pre></details>` : ""}
            <div class="app-dialog-field">
              <label for="relatoResposta">Resposta / anotação (opcional, visível ao autor)</label>
              <textarea id="relatoResposta" rows="3" maxlength="2000"></textarea>
            </div>
            <div class="relato-detalhe-acoes"></div>
            <div class="relato-detalhe-perigo"></div>
          </div>`;

        body.querySelector(".d-autor").textContent =
          `${autor.nome || "usuário"}${autor.login ? ` (@${autor.login})` : ""}`;
        if (r.pagina) body.querySelector(".d-pagina").textContent = r.pagina;
        body.querySelector(".relato-detalhe-descricao").textContent = r.descricao;
        if (r.contexto) {
          body.querySelector(".relato-contexto pre").textContent = JSON.stringify(r.contexto, null, 2);
        }
        const respostaEl = body.querySelector("#relatoResposta");
        respostaEl.value = r.resposta || "";

        const acoes = body.querySelector(".relato-detalhe-acoes");
        const acao = (rotulo, novoStatus, classe) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `btn ${classe}`;
          btn.textContent = rotulo;
          btn.addEventListener("click", async () => {
            helpers.limparErro();
            acoes.querySelectorAll("button").forEach((b) => (b.disabled = true));
            const atualizacao = await Api.atualizarRelato(r.id, {
              status: novoStatus,
              resposta: respostaEl.value,
            });
            if (!atualizacao || !atualizacao.ok) {
              helpers.mostrarErro((atualizacao && atualizacao.erro) || "não foi possível atualizar o relato");
              acoes.querySelectorAll("button").forEach((b) => (b.disabled = false));
              return;
            }
            helpers.fechar(true);
            Toast.aviso(`Relato #${r.id} atualizado.`);
            this.atualizarBadge();
            if (this._painelAberto) this.renderPainel();
          });
          acoes.appendChild(btn);
        };

        if (r.status !== "em_analise" && r.status !== "resolvido") acao("Marcar em análise", "em_analise", "btn-off");
        if (r.status === "em_analise") acao("Voltar para aberto", "aberto", "btn-off");
        if (r.status !== "resolvido") acao("Marcar como resolvido", "resolvido", "btn-on");
        if (r.status === "resolvido") acao("Reabrir relato", "aberto", "btn-off");

        const perigo = body.querySelector(".relato-detalhe-perigo");
        if (perigo && typeof state !== "undefined" && state.isSuperAdmin) {
          const bloquearTudo = (v) => {
            acoes.querySelectorAll("button").forEach((b) => (b.disabled = v));
            perigo.querySelectorAll("button").forEach((b) => (b.disabled = v));
            respostaEl.disabled = v;
          };
          const mostrarBotaoExcluir = () => {
            perigo.innerHTML = `<button type="button" class="btn btn-danger relato-excluir-btn">Excluir relato</button>`;
            perigo.querySelector(".relato-excluir-btn").addEventListener("click", mostrarConfirmacao);
          };
          const mostrarConfirmacao = () => {
            helpers.limparErro();
            perigo.innerHTML = `
              <p class="relato-detalhe-perigo-aviso">Excluir permanentemente o relato #${r.id}? Esta ação não pode ser desfeita e remove a descrição, a resposta e o histórico de revisão.</p>
              <div class="relato-detalhe-perigo-linha">
                <button type="button" class="btn btn-danger relato-excluir-confirmar">Excluir definitivamente</button>
                <button type="button" class="btn btn-off relato-excluir-cancelar">Cancelar</button>
              </div>`;
            perigo.querySelector(".relato-excluir-cancelar").addEventListener("click", mostrarBotaoExcluir);
            perigo.querySelector(".relato-excluir-confirmar").addEventListener("click", async () => {
              helpers.limparErro();
              bloquearTudo(true);
              const resp = await Api.excluirRelato(r.id);
              if (!resp || !resp.ok) {
                helpers.mostrarErro((resp && resp.erro) || "não foi possível excluir o relato");
                bloquearTudo(false);
                return;
              }
              helpers.fechar(true);
              Toast.aviso(`Relato #${r.id} excluído.`);
              this.atualizarBadge();
              if (this._painelAberto) this.renderPainel();
            });
          };
          mostrarBotaoExcluir();
        }
      },
    });
  },
};

(function () {
  const botao = document.getElementById("bugReportBtn");
  const painel = document.getElementById("relatosPanel");
  if (botao) {
    botao.addEventListener("click", (e) => {
      e.stopPropagation();
      Relatos.alternarPainel();
    });
  }
  if (painel) {
    painel.addEventListener("click", (e) => e.stopPropagation());
  }
  document.addEventListener("click", () => Relatos.fecharPainel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && Relatos._painelAberto) Relatos.fecharPainel();
  });
})();
