const Energia = (() => {
  let salas = [];
  let floorplan = null;

  function numero(valor, casas = 1) {
    if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return "—";
    return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  function kwh(valor) {
    return valor === null || valor === undefined ? "Potência não configurada" : `${numero(valor, 3)} kWh estimados`;
  }

  function horas(valor) {
    return valor === null || valor === undefined ? "—" : `${numero(valor, 2)} h`;
  }

  function watts(valor) {
    return valor === null || valor === undefined ? "Potência não configurada" : `${numero(valor, 0)} W estimados`;
  }

  function confianca(valor) {
    return ({ alta: "alta", media: "média", baixa: "baixa", nao_aplicavel: "não aplicável" })[valor] || "—";
  }

  function valorMetrica(sala, metrica) {
    if (!sala.configuracao) return null;
    if (metrica === "kwhHoje") return sala.hoje.kwhEstimado;
    if (metrica === "carga") return sala.cargaAtualPercentual;
    if (metrica === "horas") return sala.trintaDias.horasLigado;
    if (metrica === "potenciaMedia") return sala.trintaDias.potenciaMediaEstimadaWatts;
    return sala.trintaDias.kwhEstimado;
  }

  function rotuloMetrica(sala, metrica) {
    const valor = valorMetrica(sala, metrica);
    if (valor === null) return "Potência não configurada";
    if (metrica === "carga") return `${numero(valor, 0)}% de carga estimada`;
    if (metrica === "horas") return horas(valor);
    if (metrica === "potenciaMedia") return watts(valor);
    return kwh(valor);
  }

  function montarFloorplan() {
    const container = document.getElementById("energyFpInner");
    if (container.dataset.montado === "1") {
      if (floorplan) floorplan.fitToWidth();
      return;
    }
    const origem = document.getElementById("fpScaleInner");
    const tabs = document.getElementById("energyFpTabs");
    if (!origem || !tabs) return;
    container.innerHTML = origem.innerHTML;
    container.dataset.montado = "1";
    document.querySelectorAll("#screen-floorplan .fp-tab-btn").forEach((btn) => {
      const clone = document.createElement("button");
      clone.type = "button";
      clone.className = btn.className;
      clone.dataset.fpSection = btn.dataset.fpSection;
      clone.textContent = btn.textContent;
      tabs.appendChild(clone);
    });
    floorplan = Floorplan.create(container, tabs, {
      fitToWidth: true,
      onSelect: (sala) => {
        const linha = document.querySelector(`#energyTableBody tr[data-sala="${CSS.escape(sala)}"]`);
        if (linha) linha.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    });
  }

  function renderMapa() {
    montarFloorplan();
    const metrica = document.getElementById("energyMetric").value;
    const valores = salas.map((s) => valorMetrica(s, metrica)).filter((v) => v !== null && Number.isFinite(Number(v))).map(Number);
    const maximo = Math.max(0, ...valores);
    const porSala = new Map(salas.map((s) => [s.sala, s]));
    document.querySelectorAll("#energyFpInner .room.selectable").forEach((el) => {
      const sala = porSala.get(el.dataset.sala);
      el.classList.remove("energy-room-unset", "energy-room-value");
      el.style.removeProperty("--energy-intensity");
      if (!sala || !sala.configuracao) {
        el.classList.add("energy-room-unset");
        el.title = `${RoomsData.rotulo(el.dataset.sala)} · Potência não configurada`;
        return;
      }
      const valor = Number(valorMetrica(sala, metrica) || 0);
      const intensidade = maximo > 0 ? Math.max(0.08, valor / maximo) : 0.08;
      el.classList.add("energy-room-value");
      el.style.setProperty("--energy-intensity", String(intensidade));
      el.title = `${RoomsData.rotulo(sala.sala)} · ${rotuloMetrica(sala, metrica)} · confiança ${confianca(sala.confianca)}`;
    });
    if (floorplan) floorplan.fitToWidth();
  }

  function renderResumo() {
    const configuradas = salas.filter((s) => s.configuracao);
    const soma = (fn) => configuradas.reduce((total, sala) => total + Number(fn(sala) || 0), 0);
    const itens = [
      ["Salas configuradas", `${configuradas.length} de ${salas.length}`],
      ["Potência atual", watts(configuradas.length ? soma((s) => s.potenciaAtualEstimadaWatts) : null)],
      ["Consumo hoje", kwh(configuradas.length ? soma((s) => s.hoje.kwhEstimado) : null)],
      ["Consumo em 30 dias", kwh(configuradas.length ? soma((s) => s.trintaDias.kwhEstimado) : null)],
    ];
    document.getElementById("energySummary").innerHTML = itens.map(([titulo, valor]) => `
      <div class="card energy-summary-card"><span>${escapeHtml(titulo)}</span><strong>${escapeHtml(valor)}</strong></div>
    `).join("");
  }

  function renderTabela() {
    const corpo = document.getElementById("energyTableBody");
    corpo.innerHTML = "";
    salas.forEach((sala) => {
      const tr = document.createElement("tr");
      tr.dataset.sala = sala.sala;
      tr.innerHTML = `
        <td>
          <strong>${escapeHtml(RoomsData.rotulo(sala.sala))}</strong><span class="energy-room-name">${escapeHtml(sala.nome)}</span>
          <div class="energy-config-row">
            <label><span>Entrada elétrica (W)</span><input class="energy-watts" type="number" min="100" max="100000" step="1" value="${sala.configuracao?.potenciaWatts ?? ""}" placeholder="não configurada" /></label>
            <label><span>Tipo do AC</span><select class="energy-type"><option value="inverter">Inverter</option><option value="fixo">Velocidade fixa</option></select></label>
            <button type="button" class="link-btn energy-save">salvar</button>
          </div>
          <span class="energy-btu-note">Informe watts elétricos, não BTU/h.</span>
        </td>
        <td><strong>${sala.configuracao ? `${numero(sala.cargaAtualPercentual, 0)}%` : "—"}</strong><span>${watts(sala.potenciaAtualEstimadaWatts)}</span><span>alvo ${numero(sala.temperaturaAlvo, 0)} °C · ambiente ${sala.temperaturaAmbiente === null ? "indisponível" : `${numero(sala.temperaturaAmbiente, 1)} °C`}</span></td>
        <td><strong>${kwh(sala.hoje.kwhEstimado)}</strong><span>${horas(sala.hoje.horasLigado)} ligadas</span></td>
        <td><strong>${kwh(sala.seteDias.kwhEstimado)}</strong><span>${horas(sala.seteDias.horasLigado)} ligadas</span></td>
        <td><strong>${kwh(sala.trintaDias.kwhEstimado)}</strong><span>${horas(sala.trintaDias.horasLigado)} ligadas</span><span>potência média ${watts(sala.trintaDias.potenciaMediaEstimadaWatts)}</span><span>alvo médio ${sala.trintaDias.temperaturaAlvoMedia === null ? "—" : `${numero(sala.trintaDias.temperaturaAlvoMedia, 1)} °C`}</span><span>ambiente médio ${sala.trintaDias.temperaturaAmbienteMedia === null ? "indisponível" : `${numero(sala.trintaDias.temperaturaAmbienteMedia, 1)} °C`}</span></td>
        <td><strong>Confiança ${confianca(sala.confianca)}</strong><span>estado ${numero(sala.trintaDias.coberturaObservacaoPercentual, 1)}%</span><span>telemetria ${sala.trintaDias.coberturaTelemetriaPercentual === null ? "—" : `${numero(sala.trintaDias.coberturaTelemetriaPercentual, 1)}%`}</span>${sala.parcial ? "<span class=\"energy-partial\">estimativa parcial</span>" : ""}</td>
      `;
      tr.querySelector(".energy-type").value = sala.configuracao?.tipo || "inverter";
      tr.querySelector(".energy-save").addEventListener("click", async (event) => {
        const botao = event.currentTarget;
        const texto = tr.querySelector(".energy-watts").value.trim();
        botao.disabled = true;
        try {
          const resp = await Api.configurarEnergiaSala(sala.sala, {
            potenciaWatts: texto === "" ? null : Number(texto),
            tipo: tr.querySelector(".energy-type").value,
          });
          if (!resp.ok) {
            Toast.erro(resp.erro || "não foi possível salvar a configuração energética");
            return;
          }
          Toast.aviso(texto === "" ? "configuração energética removida" : "configuração energética salva");
          await carregar();
        } finally {
          botao.disabled = false;
        }
      });
      corpo.appendChild(tr);
    });
  }

  async function carregar() {
    const erro = document.getElementById("energyError");
    erro.classList.add("hidden");
    const resp = await Api.obterEnergia();
    if (!resp.ok) {
      erro.textContent = resp.erro || "não foi possível carregar as estimativas de energia";
      erro.classList.remove("hidden");
      return;
    }
    salas = resp.salas || [];
    renderResumo();
    renderTabela();
    renderMapa();
  }

  async function aoAbrir() {
    if (!state.isSuperAdmin) return;
    await carregar();
  }

  document.getElementById("energyMetric").addEventListener("change", renderMapa);
  return { aoAbrir };
})();
