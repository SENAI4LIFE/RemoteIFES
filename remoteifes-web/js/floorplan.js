const Floorplan = {
  create(rootEl, tabsEl, { onSelect, fitToWidth = true, minScale = null } = {}) {
    const instancia = {
      root: rootEl,
      onSelect: onSelect || null,
      fitEnabled: fitToWidth,
      minScale,

      showSection(sectionId) {
        this.root.querySelectorAll(".fp-section").forEach((el) => {
          el.classList.toggle("hidden", el.dataset.fpSection !== sectionId);
        });
        this.fitToWidth();
      },

      fitToWidth() {
        const visible = this.root.querySelector(".fp-section:not(.hidden)");
        if (!visible) return;
        const plan = visible.querySelector(".plan");
        const wrap = visible.querySelector(".plan-wrap");
        if (!plan || !wrap) return;

        const naturalWidth = parseInt(plan.style.width, 10) || plan.offsetWidth || 1;
        const naturalHeight = parseInt(plan.style.height, 10) || plan.offsetHeight || 1;

        if (!this.fitEnabled) {
          plan.style.transform = "none";
          wrap.style.height = `${naturalHeight + 10}px`;
          return;
        }

        const availableWidth = wrap.clientWidth;
        if (!availableWidth) return;

        let scale = availableWidth / naturalWidth;
        if (scale > 1) scale = 1;
        if (this.minScale && scale < this.minScale) scale = this.minScale;
        if (!scale || Number.isNaN(scale)) scale = 1;

        plan.style.transform = `scale(${scale})`;
        plan.style.transformOrigin = "top left";
        wrap.style.height = `${naturalHeight * scale + 10}px`;
      },

      aplicarStatus(salas) {
        const porSala = {};
        salas.forEach((s) => {
          porSala[s.sala] = s;
        });

        this.root.querySelectorAll(".room.selectable").forEach((el) => {
          const dados = porSala[el.dataset.sala];
          el.classList.remove("fp-offline", "fp-online-desligado", "fp-online-ligado", "fp-reservada", "fp-sem-dados", "fp-view-only");
          if (!dados) {
            el.classList.add("fp-sem-dados");
            return;
          }
          if (!dados.online) {
            el.classList.add("fp-offline");
          } else if (dados.ligado) {
            el.classList.add("fp-online-ligado");
          } else {
            el.classList.add("fp-online-desligado");
          }
          if (dados.agendadaAgora) el.classList.add("fp-reservada");
          if (dados.podeControlarEsta === false) el.classList.add("fp-view-only");
        });
      },
    };

    rootEl.querySelectorAll(".room.selectable").forEach((el) => {
      el.addEventListener("click", () => {
        const sala = el.dataset.sala;
        if (!sala) return;
        if (instancia.onSelect) instancia.onSelect(sala, el);
      });
    });

    if (tabsEl) {
      tabsEl.querySelectorAll(".fp-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          tabsEl.querySelectorAll(".fp-tab-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          instancia.showSection(btn.dataset.fpSection);
        });
      });
      const first = tabsEl.querySelector(".fp-tab-btn");
      if (first) instancia.showSection(first.dataset.fpSection);
    }

    instancia.fitToWidth();
    window.addEventListener("resize", () => instancia.fitToWidth());

    return instancia;
  },
};
