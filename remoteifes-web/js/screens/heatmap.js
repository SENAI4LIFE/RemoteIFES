// Mapa de calor operacional (superadministrador). Busca sob demanda: nada e
// calculado enquanto a secao esta fechada e nao existe polling.
const Heatmap = (() => {
  const FAIXAS = [
    { classe: "heatmap-f0", rotulo: "muito baixo" },
    { classe: "heatmap-f1", rotulo: "baixo" },
    { classe: "heatmap-f2", rotulo: "medio" },
    { classe: "heatmap-f3", rotulo: "alto" },
    { classe: "heatmap-f4", rotulo: "muito alto" },
  ];
  const CLASSES = FAIXAS.map((f) => f.classe).concat("heatmap-sem-dados");

  let floorplan = null;
  let dados = null;
  let carregando = false;

  const el = (id) => document.getElementById(id);
  const aberto = () => {
    const bloco = el("heatmapBloco");
    return !!bloco && bloco.open;
  };

  function numero(valor, casas) {
    if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return null;
    return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  function formatar(valor, d = dados) {
    const texto = numero(valor, d.casas);
    if (texto === null) return "Sem dados";
    return d.unidade ? `${texto}${d.unidade === "%" ? "" : " "}${d.unidade}` : texto;
  }

  // Escala fria->quente em cinco faixas. "Quente" e sempre o extremo pior:
  // para disponibilidade, quem tem menos porcentagem fica quente.
  function faixaDe(valor, d) {
    if (valor === null) return null;
    const min = d.minimo === null ? 0 : d.minimo;
    const max = d.maximo === null ? 0 : d.maximo;
    if (max <= min) return d.maiorEhPior ? 0 : 0;
    let posicao = (valor - min) / (max - min);
    if (!d.maiorEhPior) posicao = 1 - posicao;
    return Math.min(FAIXAS.length - 1, Math.max(0, Math.floor(posicao * FAIXAS.length - 1e-9)));
  }

  function montarFloorplan() {
    const container = el("heatmapFpInner");
    if (!container) return;
    if (container.dataset.montado === "1") {
      if (floorplan) floorplan.fitToWidth();
      return;
    }
    const origem = el("fpScaleInner");
    const tabs = el("heatmapFpTabs");
    if (!origem || !tabs || !origem.innerHTML.trim()) return;
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
      onSelect: (sala) => mostrarDetalhe(sala),
    });
  }

  function mostrarDetalhe(sala) {
    const caixa = el("heatmapDetalhe");
    if (!caixa || !dados) return;
    const item = dados.salas.find((s) => s.sala === sala);
    if (!item) {
      caixa.textContent = `${sala}: sala fora do conjunto monitorado.`;
      return;
    }
    const partes = [
      `${item.sala} (${item.nome})`,
      `${dados.rotuloMetrica} em ${dados.rotuloPeriodo}: ${formatar(item.valor)}`,
    ];
    if (item.valor !== null) {
      const faixa = faixaDe(item.valor, dados);
      partes.push(`faixa ${FAIXAS[faixa].rotulo}`);
    }
    if (item.quedas !== undefined) partes.push(`${item.quedas} queda(s), ${item.minutosOffline} min offline`);
    caixa.textContent = `${partes.join(" · ")}.`;
  }

  function pintarMapa() {
    montarFloorplan();
    const container = el("heatmapFpInner");
    if (!container || !dados) return;
    const porSala = new Map(dados.salas.map((s) => [s.sala, s]));
    container.querySelectorAll(".room.selectable").forEach((sala) => {
      const item = porSala.get(sala.dataset.sala);
      CLASSES.forEach((c) => sala.classList.remove(c));
      let valorEl = sala.querySelector(".heatmap-valor");
      if (!valorEl) {
        valorEl = document.createElement("span");
        valorEl.className = "heatmap-valor";
        sala.appendChild(valorEl);
      }
      if (!item || item.valor === null) {
        sala.classList.add("heatmap-sem-dados");
        valorEl.textContent = "sem dados";
        sala.title = `${sala.dataset.sala}: sem dados de ${dados.rotuloMetrica.toLowerCase()} em ${dados.rotuloPeriodo}.`;
        sala.setAttribute("aria-label", sala.title);
        return;
      }
      const faixa = faixaDe(item.valor, dados);
      sala.classList.add(FAIXAS[faixa].classe);
      valorEl.textContent = formatar(item.valor);
      const extra = item.quedas !== undefined ? `, ${item.quedas} queda(s) e ${item.minutosOffline} min offline` : "";
      sala.title = `${item.sala} · ${item.nome}: ${formatar(item.valor)} (${FAIXAS[faixa].rotulo})${extra}.`;
      sala.setAttribute("aria-label", sala.title);
    });
  }

  function pintarTabela() {
    const corpo = el("heatmapTabelaCorpo");
    if (!corpo || !dados) return;
    const ordenadas = [...dados.salas].sort((a, b) => {
      if (a.valor === null && b.valor === null) return a.sala.localeCompare(b.sala);
      if (a.valor === null) return 1;
      if (b.valor === null) return -1;
      const pior = dados.maiorEhPior ? b.valor - a.valor : a.valor - b.valor;
      return pior !== 0 ? pior : a.sala.localeCompare(b.sala);
    });
    corpo.innerHTML = ordenadas
      .map((s) => {
        const faixa = faixaDe(s.valor, dados);
        const rotulo = faixa === null ? "sem dados" : FAIXAS[faixa].rotulo;
        const classe = faixa === null ? "heatmap-sem-dados" : FAIXAS[faixa].classe;
        return `<tr data-sala="${escapeHtml(s.sala)}"><th scope="row">${escapeHtml(s.sala)} <span class="heatmap-tabela-nome">${escapeHtml(s.nome)}</span></th><td>${escapeHtml(formatar(s.valor))}</td><td><span class="heatmap-faixa ${classe}"></span>${escapeHtml(rotulo)}</td></tr>`;
      })
      .join("");
    const caption = el("heatmapTabelaCaption");
    if (caption) {
      caption.textContent = `${dados.rotuloMetrica} por sala em ${dados.rotuloPeriodo}: ${dados.comDados} de ${dados.total} salas com dados`;
    }
  }

  function preencherSeletores() {
    const metrica = el("heatmapMetrica");
    const periodo = el("heatmapPeriodo");
    if (!dados || !metrica || !periodo) return;
    if (!metrica.options.length && dados.metricas) {
      metrica.innerHTML = dados.metricas.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.rotulo)}</option>`).join("");
    }
    if (!periodo.options.length && dados.periodos) {
      periodo.innerHTML = dados.periodos.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.rotulo)}</option>`).join("");
    }
    metrica.value = dados.metrica;
    periodo.value = dados.periodo;
  }

  function render() {
    preencherSeletores();
    el("heatmapDescricao").textContent = `${dados.descricao} Janela: últimas ${dados.janela.horas} h.`;
    const aviso = el("heatmapAviso");
    aviso.classList.toggle("hidden", !dados.avisoRetencao);
    aviso.textContent = dados.avisoRetencao || "";
    el("heatmapLegendaMin").textContent = dados.maiorEhPior ? `menor: ${formatar(dados.minimo)}` : `melhor: ${formatar(dados.maximo)}`;
    el("heatmapLegendaMax").textContent = dados.maiorEhPior ? `maior: ${formatar(dados.maximo)}` : `pior: ${formatar(dados.minimo)}`;
    el("heatmapDetalhe").textContent = "Selecione uma sala no mapa para ver os números dela.";
    pintarMapa();
    pintarTabela();
  }

  async function carregar() {
    if (carregando || !aberto()) return;
    if (typeof state !== "undefined" && !state.isSuperAdmin) return;
    carregando = true;
    const erro = el("heatmapErro");
    try {
      const resp = await Api.obterHeatmap(el("heatmapMetrica").value || "disponibilidade", el("heatmapPeriodo").value || "7d");
      if (!resp || !resp.ok) throw new Error("resposta inválida");
      dados = resp;
      erro.classList.add("hidden");
      render();
    } catch (e) {
      erro.textContent = "Não foi possível calcular o mapa de calor agora.";
      erro.classList.remove("hidden");
    } finally {
      carregando = false;
    }
  }

  function aoAbrir() {
    if (aberto()) carregar();
  }

  function aoFechar() {
    const bloco = el("heatmapBloco");
    if (bloco) bloco.open = false;
  }

  function ligar() {
    const bloco = el("heatmapBloco");
    if (!bloco) return;
    bloco.addEventListener("toggle", () => {
      if (bloco.open) carregar();
    });
    ["heatmapMetrica", "heatmapPeriodo"].forEach((id) => {
      const campo = el(id);
      if (campo) campo.addEventListener("change", () => carregar());
    });
    const atualizar = el("heatmapAtualizarBtn");
    if (atualizar) atualizar.addEventListener("click", () => carregar());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ligar);
  else ligar();

  return { aoAbrir, aoFechar, carregar };
})();
