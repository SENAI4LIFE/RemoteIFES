const Floorplan = {
  create(rootEl, tabsEl, { onSelect, fitToWidth = true, minScale = null, enableZoom = false } = {}) {
    const instancia = {
      root: rootEl,
      onSelect: onSelect || null,
      fitEnabled: fitToWidth,
      minScale,
      enableZoom,
      zoomMultiplier: 1,
      zoomOrigin: null,

      showSection(sectionId) {
        this.zoomMultiplier = 1;
        this.zoomOrigin = null;
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
          plan.style.transformOrigin = "top left";
          plan.style.marginLeft = "0px";
          plan.style.marginTop = "0px";
          wrap.classList.remove("fp-zoomed");
          return;
        }

        const availableWidth = wrap.clientWidth;
        const availableHeight = wrap.clientHeight;
        if (!availableWidth || !availableHeight) return;

        let baseScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
        if (baseScale > 1) baseScale = 1;
        if (this.minScale && baseScale < this.minScale) baseScale = this.minScale;
        if (!baseScale || Number.isNaN(baseScale)) baseScale = 1;

        const scale = Math.max(0.5, Math.min(3, baseScale * this.zoomMultiplier));
        plan.style.transform = `scale(${scale})`;
        plan.style.transformOrigin = this.zoomOrigin ? `${this.zoomOrigin.x}px ${this.zoomOrigin.y}px` : "top left";

        if (this.zoomMultiplier <= 1.0001) {
          plan.style.marginLeft = `${Math.max(0, (availableWidth - naturalWidth * scale) / 2)}px`;
          plan.style.marginTop = `${Math.max(0, (availableHeight - naturalHeight * scale) / 2)}px`;
          wrap.classList.remove("fp-zoomed");
          wrap.scrollLeft = 0;
          wrap.scrollTop = 0;
        } else {
          plan.style.marginLeft = "0px";
          plan.style.marginTop = "0px";
          wrap.classList.add("fp-zoomed");
        }
      },

      zoomIn() {
        if (!this.enableZoom) return;
        this.zoomMultiplier = Math.min(3, this.zoomMultiplier + 0.2);
        this.fitToWidth();
      },

      zoomOut() {
        if (!this.enableZoom) return;
        this.zoomMultiplier = Math.max(0.5, this.zoomMultiplier - 0.2);
        this.fitToWidth();
      },

      resetZoom() {
        if (!this.enableZoom) return;
        this.zoomMultiplier = 1;
        this.zoomOrigin = null;
        this.fitToWidth();
      },

      zoomToPoint(clientX, clientY) {
        if (!this.enableZoom) return;
        const visible = this.root.querySelector(".fp-section:not(.hidden)");
        if (!visible) return;
        const plan = visible.querySelector(".plan");
        if (!plan) return;
        const rect = plan.getBoundingClientRect();
        const currentScale = rect.width / (parseInt(plan.style.width, 10) || plan.offsetWidth || 1);
        if (!currentScale || Number.isNaN(currentScale)) return;
        this.zoomOrigin = {
          x: (clientX - rect.left) / currentScale,
          y: (clientY - rect.top) / currentScale,
        };
        this.zoomMultiplier = Math.min(3, Math.max(1.2, this.zoomMultiplier * 1.5));
        this.fitToWidth();
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
