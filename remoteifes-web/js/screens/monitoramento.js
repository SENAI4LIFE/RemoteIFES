const Monitoramento = (() => {
  let intervalo = null;
  let carregado = false;
  const CHAVE_GRAFICOS = "remoteifes_mon_graficos";
  let faixaAtual = "24h";
  let carregandoHistorico = false;
  let historicoPedido = 0;
  let assinaturaComposicao = "";
  let ultimoEstado = null;
  let historicoRenderizado = false;

  const el = (id) => document.getElementById(id);

  function fmtBytes(n) {
    if (n === null || n === undefined) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function fmtDuracao(seg) {
    if (!Number.isFinite(seg)) return "—";
    const d = Math.floor(seg / 86400);
    const h = Math.floor((seg % 86400) / 3600);
    const m = Math.floor((seg % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}min`;
    return `${m}min`;
  }

  function chip(estado) {
    return typeof Status !== "undefined" ? Status.chip(estado) : "";
  }

  function card(titulo, estado, linhas) {
    const corpo = linhas
      .map(([k, v, cls]) => `<div class="mon-row${cls ? ` ${cls}` : ""}"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`)
      .join("");
    return `<div class="card mon-card"><h4>${escapeHtml(titulo)}${estado ? chip(estado) : ""}</h4>${corpo}</div>`;
  }

  function estadoArmazenamento(arm) {
    if (arm.erro) return "falha";
    if (arm.critico) return "falha";
    if (arm.alerta) return "temporariamente-indisponivel";
    return "disponivel";
  }

  function estadoBackup(bk) {
    if (!bk.automatico) return "desabilitado-config";
    if (bk.alerta) return "falha";
    return "disponivel";
  }

  function estadoEsp32(e) {
    if (e.otaComFalha > 0 || (e.salasInstaveis && e.salasInstaveis.length)) return "falha";
    if (e.offlineInesperado > 0) return "temporariamente-indisponivel";
    return "disponivel";
  }

  function estadoCredenciais(c) {
    if (!c || !c.obrigatorio) return "desabilitado-config";
    if ((c.somenteMac || 0) > 0) return "temporariamente-indisponivel";
    return "disponivel";
  }

  function estadoFalhas(fc) {
    if ((fc.schedulerFalha || 0) > 0) return "falha";
    const algum = Object.values(fc).some((n) => (n || 0) > 0);
    return algum ? "temporariamente-indisponivel" : "disponivel";
  }

  const ROTULO_TABELA = {
    auditoria_eventos: "Auditoria",
    esp_indisponibilidades: "Indisponibilidades",
    comandos_log: "Comandos",
    esp_eventos: "Eventos ESP32",
    esp_acessos: "Acessos ESP32",
    notificacoes: "Notificações",
    sessoes: "Sessões",
    agendamentos_execucoes: "Execuções de agenda",
    monitoramento_amostras: "Amostras de monitoramento",
    monitoramento_horas: "Horas de monitoramento",
  };

  function render(m) {
    const alertasEl = el("monAlertas");
    if (m.alertas && m.alertas.length) {
      alertasEl.classList.remove("hidden");
      alertasEl.innerHTML = `<strong>Atenção</strong><ul>${m.alertas.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`;
    } else {
      alertasEl.classList.add("hidden");
      alertasEl.innerHTML = "";
    }

    const b = m.banco;
    const arm = m.armazenamento;
    const bk = m.backup;
    const e = m.esp32;
    const s = m.servico;
    const c = m.credenciais || {};
    const fc = m.falhas.contadores || {};
    const tabelas = b.tabelas || {};
    const pm2 = s.pm2 || null;

    const linhasServico = [
      ["Ambiente", s.ambiente],
      ["Tempo no ar", fmtDuracao(s.uptimeSegundos)],
      ["Memória (RSS)", `${s.memoriaRssMB} MB`],
      ["Carga 1 min", s.cargaMedia1min],
      ["Node / PID", `${s.nodeVersao} / ${s.pid}`],
    ];
    if (pm2) {
      linhasServico.push(["PM2", `${pm2.nome || "processo"}${pm2.id !== null ? ` #${pm2.id}` : ""}${pm2.modo ? ` (${pm2.modo})` : ""}`]);
      linhasServico.push(["Reinícios (PM2)", pm2.reinicios === null ? "—" : `${pm2.reinicios}${pm2.reiniciosInstaveis ? ` · ${pm2.reiniciosInstaveis} instáveis` : ""}`, pm2.reiniciosInstaveis ? "aviso" : ""]);
    }

    const grid = [
      card("Serviço", "disponivel", linhasServico),
      card("Banco de dados", b.ok ? "disponivel" : "falha", [
        ["Responde", b.ok ? "sim" : "não", b.ok ? "ok" : "alerta"],
        ["Latência", `${b.respostaMs} ms`],
        ["Arquivo", fmtBytes(b.arquivoBytes)],
        ["WAL", fmtBytes(b.walBytes)],
        ["Espaço reutilizável", fmtBytes(b.reutilizavelBytes)],
      ]),
      card("Armazenamento", estadoArmazenamento(arm), arm.erro
        ? [["Erro", arm.erro, "alerta"]]
        : [
            ["Livre", `${fmtBytes(arm.livreBytes)} (${arm.livrePercent}%)`, arm.alerta ? "alerta" : ""],
            ["Total", fmtBytes(arm.totalBytes)],
            ["Local", arm.caminho, "caminho"],
          ]),
      card("Backups", estadoBackup(bk), [
        ["Automático", bk.automatico ? "ligado" : "desligado"],
        ["Quantidade", bk.quantidade],
        ["Último", bk.ultimo || "nenhum", bk.alerta ? "alerta" : ""],
        ["Idade do último", bk.idadeHoras === null ? "—" : `${bk.idadeHoras} h`, bk.alerta ? "alerta" : ""],
      ]),
      card("ESP32", estadoEsp32(e), [
        ["Com MAC cadastrado", e.comMac],
        ["Online", e.online],
        ["Offline inesperado", e.offlineInesperado, e.offlineInesperado > 0 ? "aviso" : ""],
        ["Conectados (WS)", e.conectadosWs],
        ["Reconexões (1 h)", e.reconexoesAnormais1h, e.salasInstaveis.length ? "alerta" : ""],
        ["OTA em andamento", e.otaEmAndamento],
        ["OTA com falha", e.otaComFalha, e.otaComFalha > 0 ? "alerta" : ""],
        ["Quedas (24 h)", e.offlineUlt24h],
      ]),
      card("Credenciais de dispositivo", estadoCredenciais(c), [
        ["Provisionadas", c.comCredencial ?? "—"],
        ["Só MAC", c.somenteMac ?? "—", (c.somenteMac || 0) > 0 && c.obrigatorio ? "alerta" : ""],
        ["Revogadas", c.revogadas ?? "—"],
        ["Exigência global", c.obrigatorio ? "ligada" : "desligada"],
      ]),
      card("Históricos com limite", Object.values(tabelas).some((t) => t.usoPercentual >= 90) ? "temporariamente-indisponivel" : "disponivel",
        Object.entries(tabelas).map(([nome, info]) => [
          ROTULO_TABELA[nome] || nome,
          `${info.total} / ${info.limite} (${info.usoPercentual}%)`,
          info.usoPercentual >= 90 ? "alerta" : info.usoPercentual >= 75 ? "aviso" : "",
        ])),
      card("Falhas desde a inicialização", estadoFalhas(fc), [
        ["Comandos", fc.comandoFalha || 0, (fc.comandoFalha || 0) > 0 ? "aviso" : ""],
        ["Telemetria", fc.telemetriaFalha || 0, (fc.telemetriaFalha || 0) > 0 ? "aviso" : ""],
        ["OTA", fc.otaFalha || 0, (fc.otaFalha || 0) > 0 ? "aviso" : ""],
        ["Credencial", fc.credencialFalha || 0],
        ["Reconexão anormal", fc.reconexaoAnormal || 0],
        ["Agendador/serviço", fc.schedulerFalha || 0, (fc.schedulerFalha || 0) > 0 ? "alerta" : ""],
      ]),
    ];

    const gridEl = el("monGrid");
    gridEl.innerHTML = grid.join("");
    gridEl.setAttribute("aria-busy", "false");
    ultimoEstado = m;
    if (blocoGraficosAberto()) renderComposicao(m);
  }

  function skeleton() {
    const gridEl = el("monGrid");
    gridEl.setAttribute("aria-busy", "true");
    gridEl.innerHTML = Array.from({ length: 8 })
      .map(() => `<div class="card mon-card mon-card-skeleton" aria-hidden="true"><span class="mon-skel-line"></span><span class="mon-skel-line"></span><span class="mon-skel-line"></span></div>`)
      .join("");
  }

  async function carregar() {
    try {
      const resp = await Api.obterMonitoramento();
      if (!resp || !resp.ok) throw new Error("resposta inválida");
      el("monErro").classList.add("hidden");
      render(resp.monitoramento);
      carregado = true;
    } catch (e) {
      el("monErro").classList.remove("hidden");
      el("monGrid").setAttribute("aria-busy", "false");
      if (!carregado) el("monGrid").innerHTML = "";
    }
  }

  function blocoGraficosAberto() {
    const bloco = el("monGraficosBloco");
    return !!bloco && bloco.open && typeof Graficos !== "undefined";
  }

  function lerPreferenciaGraficos() {
    try {
      return localStorage.getItem(CHAVE_GRAFICOS) !== "0";
    } catch (e) {
      return true;
    }
  }

  function guardarPreferenciaGraficos(aberto) {
    try {
      localStorage.setItem(CHAVE_GRAFICOS, aberto ? "1" : "0");
    } catch (e) {}
  }

  function renderComposicao(m) {
    const e = m.esp32 || {};
    const c = m.credenciais || null;
    const tabelas = (m.banco && m.banco.tabelas) || {};
    const fases = e.otaPorFase || {};
    const chave = JSON.stringify([e.comMac, e.online, c, fases, tabelas]);
    if (chave === assinaturaComposicao) return;
    assinaturaComposicao = chave;

    const comMac = Number(e.comMac) || 0;
    const online = Math.min(comMac, Number(e.online) || 0);
    Graficos.rosca(el("grEspAtual"), {
      id: "gr-esp-atual",
      titulo: "ESP32 online e offline",
      subtitulo: "dispositivos com MAC cadastrado, agora",
      itens: [
        { nome: "Online", valor: online, cor: "gr-ok" },
        { nome: "Offline", valor: comMac - online, cor: "gr-neutro" },
      ],
      central: `${online}/${comMac}`,
      centralRotulo: "online",
      vazio: "Nenhum ESP32 com MAC cadastrado.",
    });

    Graficos.rosca(el("grCredAtual"), {
      id: "gr-cred-atual",
      titulo: "Credenciais de dispositivo",
      subtitulo: c ? `exigência global ${c.obrigatorio ? "ligada" : "desligada"}` : "resumo indisponível",
      itens: [
        { nome: "Provisionadas", valor: c ? c.comCredencial : 0, cor: "gr-ok" },
        { nome: "Só MAC", valor: c ? c.somenteMac : 0, cor: c && c.obrigatorio ? "gr-alerta" : "gr-aviso" },
        { nome: "Revogadas", valor: c ? c.revogadas : 0, cor: "gr-neutro" },
      ],
      central: c ? String(c.comCredencial ?? 0) : "—",
      centralRotulo: "provisionadas",
      vazio: "Nenhuma credencial ou dispositivo cadastrado.",
    });

    const rotuloFase = { ofertado: "Ofertado", baixando: "Baixando", gravado: "Gravado", reiniciando: "Reiniciando", concluido: "Concluído", falhou: "Falhou" };
    const corFase = { ofertado: "gr-cor-1", baixando: "gr-cor-3", gravado: "gr-cor-6", reiniciando: "gr-cor-4", concluido: "gr-ok", falhou: "gr-alerta" };
    const itensOta = Object.keys(rotuloFase).map((fase) => ({ nome: rotuloFase[fase], valor: Number(fases[fase]) || 0, cor: corFase[fase] }));
    const totalOta = itensOta.reduce((acc, it) => acc + it.valor, 0);
    Graficos.rosca(el("grOtaAtual"), {
      id: "gr-ota-atual",
      titulo: "Atualizações OTA por fase",
      subtitulo: "estados registrados (terminais expiram em 7 dias)",
      itens: itensOta,
      central: String(totalOta),
      centralRotulo: totalOta === 1 ? "registro" : "registros",
      vazio: "Nenhuma atualização de firmware registrada.",
    });

    const itensTabelas = Object.entries(tabelas).map(([nome, info]) => ({
      nome: ROTULO_TABELA[nome] || nome,
      valor: Number(info.usoPercentual) || 0,
      rotulo: `${Graficos.fmtNumero(info.usoPercentual, 1)}%${info.usoPercentual >= 90 ? " (alerta)" : info.usoPercentual >= 75 ? " (atenção)" : ""}`,
      detalhe: `${info.total} de ${info.limite} linhas`,
      cor: info.usoPercentual >= 90 ? "gr-alerta" : info.usoPercentual >= 75 ? "gr-aviso" : "gr-cor-1",
    }));
    Graficos.barras(el("grTabelasAtual"), {
      id: "gr-tabelas-atual",
      titulo: "Uso dos históricos com limite",
      subtitulo: "linhas guardadas em relação ao limite de retenção de cada tabela",
      unidade: "%",
      maximo: 100,
      itens: itensTabelas,
      rotuloCategoria: "Tabela",
      rotuloValor: "Uso",
      resumo: itensTabelas.length
        ? `${itensTabelas.filter((it) => it.valor >= 75).length} de ${itensTabelas.length} tabelas acima de 75% do limite; inclui as duas tabelas do próprio histórico de monitoramento.`
        : "Sem tabelas com limite.",
    });
  }

  function rotuloBucket(segundos) {
    if (segundos % 3600 === 0) return `${segundos / 3600} h`;
    return `${Math.round(segundos / 60)} min`;
  }

  function formatarInstante(iso) {
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? Graficos.rotuloInstante(ms, 0) : "—";
  }

  function renderHistorico(h) {
    const t = h.t;
    const md = h.medidas;
    const ct = h.contagens;
    const bucket = h.bucketSegundos;
    const base = { t, bucketSegundos: bucket, n: h.n, reinicios: h.reinicios };
    const subMedia = `${h.rotulo} · média por intervalo de ${rotuloBucket(bucket)}`;
    const subContagem = `${h.rotulo} · ocorrências por intervalo de ${rotuloBucket(bucket)}`;

    Graficos.serieTemporal(el("grEsp32"), {
      ...base,
      id: "gr-esp32",
      titulo: "ESP32 conectados",
      subtitulo: subMedia,
      largo: true,
      unidade: "inteiro",
      series: [
        { nome: "Com MAC cadastrado", valores: md.espComMac, estilo: "fina", cor: "gr-cor-4" },
        { nome: "Online", valores: md.espOnline, estilo: "area", cor: "gr-cor-1" },
        { nome: "Conectados (WS)", valores: md.espWs, cor: "gr-cor-3" },
      ],
    });
    Graficos.colunas(el("grEventos"), {
      t, bucketSegundos: bucket,
      id: "gr-eventos",
      titulo: "Reconexões e quedas de ESP32",
      subtitulo: subContagem,
      modo: "agrupado",
      series: [
        { nome: "Reconexões", valores: ct.reconexoes, cor: "gr-cor-1" },
        { nome: "Quedas", valores: ct.quedas, cor: "gr-cor-2" },
      ],
    });
    const seriesFalhas = [
      { nome: "Telemetria", valores: ct.telemetriaFalhas, cor: "gr-cor-1" },
      { nome: "Credencial", valores: ct.credencialFalhas, cor: "gr-cor-2" },
      { nome: "Agendador", valores: ct.schedulerFalhas, cor: "gr-cor-3" },
      { nome: "Banco", valores: ct.bancoFalhas, cor: "gr-cor-4" },
      { nome: "OTA", valores: ct.otaFalhas, cor: "gr-cor-5" },
    ];
    Graficos.colunas(el("grFalhas"), {
      t, bucketSegundos: bucket,
      id: "gr-falhas",
      titulo: "Falhas por período",
      subtitulo: subContagem,
      series: seriesFalhas,
    });
    const seriesComandos = [
      { nome: "Manual", valores: ct.comandosManual, cor: "gr-cor-1" },
      { nome: "Agendamento", valores: ct.comandosAgendamento, cor: "gr-cor-2" },
      { nome: "ESP32 local", valores: ct.comandosEsp32, cor: "gr-cor-3" },
    ];
    if (ct.comandosOutros.some((v) => v > 0)) seriesComandos.push({ nome: "Outros", valores: ct.comandosOutros, cor: "gr-cor-6" });
    Graficos.colunas(el("grComandos"), {
      t, bucketSegundos: bucket,
      id: "gr-comandos",
      titulo: "Comandos por período",
      subtitulo: subContagem,
      largo: true,
      series: seriesComandos,
    });
    Graficos.serieTemporal(el("grRss"), {
      ...base,
      id: "gr-rss",
      titulo: "Memória do processo (RSS)",
      subtitulo: subMedia,
      unidade: "MB",
      series: [
        { nome: "Média", valores: md.rssMB, estilo: "area", cor: "gr-cor-1" },
        { nome: "Pico", valores: md.rssMBMax, estilo: "fina", cor: "gr-cor-1" },
      ],
    });
    Graficos.serieTemporal(el("grCpu"), {
      ...base,
      id: "gr-cpu",
      titulo: "CPU do processo",
      subtitulo: `${subMedia} · 100% = um núcleo`,
      unidade: "%",
      series: [
        { nome: "Média", valores: md.cpuPercent, estilo: "area", cor: "gr-cor-2" },
        { nome: "Pico", valores: md.cpuPercentMax, estilo: "fina", cor: "gr-cor-2" },
      ],
    });
    Graficos.serieTemporal(el("grBancoMs"), {
      ...base,
      id: "gr-banco-ms",
      titulo: "Latência do banco",
      subtitulo: subMedia,
      unidade: "ms",
      series: [
        { nome: "Média", valores: md.bancoMs, estilo: "area", cor: "gr-cor-3" },
        { nome: "Pico", valores: md.bancoMsMax, estilo: "fina", cor: "gr-cor-3" },
      ],
    });
    Graficos.serieTemporal(el("grBancoBytes"), {
      ...base,
      id: "gr-banco-bytes",
      titulo: "Arquivo do banco e WAL",
      subtitulo: subMedia,
      unidade: "bytes",
      series: [
        { nome: "Arquivo", valores: md.bancoBytes, cor: "gr-cor-1" },
        { nome: "WAL", valores: md.walBytes, cor: "gr-cor-2" },
      ],
    });
    Graficos.serieTemporal(el("grDisco"), {
      ...base,
      id: "gr-disco",
      titulo: "Disco livre",
      subtitulo: `${h.rotulo} · mínimo por intervalo de ${rotuloBucket(bucket)}`,
      unidade: "bytes",
      series: [{ nome: "Livre", valores: md.discoLivreBytesMin, estilo: "area", cor: "gr-cor-3" }],
    });
    historicoRenderizado = true;
  }

  function renderMeta(h) {
    const meta = el("monGraficosMeta");
    const aviso = el("monGraficosAviso");
    const vazio = el("monGraficosVazio");
    const grid = el("monGraficosSeries");
    const pontos = h.t.length;
    meta.textContent = `Amostra a cada ${h.amostragemSegundos} s · amostras brutas por ${h.retencao.amostrasHoras} h e médias por hora por ${h.retencao.horasDias} dias · ${pontos} intervalos de ${rotuloBucket(h.bucketSegundos)} · ${h.cobertura.amostras} amostras no período · gerado ${formatarInstante(h.geradoEm)}.`;
    const semAmostras = !h.cobertura.desde;
    vazio.classList.toggle("hidden", !semAmostras);
    vazio.textContent = semAmostras
      ? "Ainda não há amostras de histórico. A primeira é gravada cerca de um minuto após o servidor iniciar; as contagens de eventos abaixo já usam os registros existentes."
      : "";
    const parcial = !semAmostras && !h.cobertura.completa;
    aviso.classList.toggle("hidden", !parcial);
    aviso.textContent = parcial ? `Histórico disponível desde ${formatarInstante(h.cobertura.desde)}; o período selecionado começa antes disso, e os intervalos anteriores aparecem sem amostra.` : "";
    grid.classList.toggle("gr-sem-amostras", semAmostras);
  }

  async function carregarHistorico() {
    if (!blocoGraficosAberto()) return;
    if (typeof state !== "undefined" && !state.isSuperAdmin) return;
    const grid = el("monGraficosSeries");
    const erro = el("monGraficosErro");
    const pedido = ++historicoPedido;
    carregandoHistorico = true;
    grid.setAttribute("aria-busy", "true");
    grid.classList.add("gr-carregando");
    try {
      const resp = await Api.obterMonitoramentoHistorico(faixaAtual);
      if (pedido !== historicoPedido) return;
      if (!resp || !resp.ok) throw new Error("resposta inválida");
      erro.classList.add("hidden");
      renderMeta(resp);
      renderHistorico(resp);
      if (ultimoEstado) renderComposicao(ultimoEstado);
    } catch (e) {
      if (pedido !== historicoPedido) return;
      erro.textContent = "Não foi possível carregar o histórico do monitoramento agora.";
      erro.classList.remove("hidden");
    } finally {
      if (pedido === historicoPedido) {
        carregandoHistorico = false;
        grid.classList.remove("gr-carregando");
        grid.setAttribute("aria-busy", "false");
      }
    }
  }

  function selecionarFaixa(faixa) {
    faixaAtual = faixa;
    document.querySelectorAll("#monGraficosBloco .gr-faixa").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.faixa === faixa ? "true" : "false");
    });
  }

  function ligarGraficos() {
    const bloco = el("monGraficosBloco");
    if (!bloco) return;
    bloco.open = lerPreferenciaGraficos();
    bloco.addEventListener("toggle", () => {
      guardarPreferenciaGraficos(bloco.open);
      if (!bloco.open) return;
      if (ultimoEstado) renderComposicao(ultimoEstado);
      if (!historicoRenderizado) carregarHistorico();
    });
    document.querySelectorAll("#monGraficosBloco .gr-faixa").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.faixa === faixaAtual && historicoRenderizado) return;
        selecionarFaixa(btn.dataset.faixa);
        carregarHistorico();
      });
    });
    const atualizar = el("monGraficosAtualizarBtn");
    if (atualizar) atualizar.addEventListener("click", () => carregarHistorico());
    selecionarFaixa(faixaAtual);
  }

  async function aoAbrir() {
    if (typeof state !== "undefined" && !state.isSuperAdmin) return;
    if (!carregado) skeleton();
    await carregar();
    if (!intervalo) intervalo = setInterval(carregar, 20000);
    carregarHistorico();
  }

  function aoFechar() {
    if (intervalo) {
      clearInterval(intervalo);
      intervalo = null;
    }
  }

  const retryBtn = el("monRetryBtn");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      if (!carregado) skeleton();
      carregar();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ligarGraficos);
  else ligarGraficos();

  return { aoAbrir, aoFechar, carregarHistorico, faixaAtual: () => faixaAtual };
})();
