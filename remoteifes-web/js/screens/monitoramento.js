const Monitoramento = (() => {
  let intervalo = null;

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

  function card(titulo, linhas) {
    const corpo = linhas
      .map(([k, v, cls]) => `<div class="mon-row${cls ? ` ${cls}` : ""}"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`)
      .join("");
    return `<div class="card mon-card"><h4>${escapeHtml(titulo)}</h4>${corpo}</div>`;
  }

  function render(m) {
    const alertasEl = document.getElementById("monAlertas");
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

    const grid = [
      card("Serviço", [
        ["Ambiente", s.ambiente],
        ["Tempo no ar", fmtDuracao(s.uptimeSegundos)],
        ["Memória (RSS)", `${s.memoriaRssMB} MB`],
        ["Carga 1 min", s.cargaMedia1min],
        ["Node / PID", `${s.nodeVersao} / ${s.pid}`],
      ]),
      card("Banco de dados", [
        ["Responde", b.ok ? "sim" : "não", b.ok ? "ok" : "alerta"],
        ["Latência", `${b.respostaMs} ms`],
        ["Arquivo", fmtBytes(b.arquivoBytes)],
        ["WAL", fmtBytes(b.walBytes)],
      ]),
      card("Armazenamento", arm.erro
        ? [["Erro", arm.erro, "alerta"]]
        : [
            ["Livre", `${fmtBytes(arm.livreBytes)} (${arm.livrePercent}%)`, arm.alerta ? "alerta" : ""],
            ["Total", fmtBytes(arm.totalBytes)],
            ["Local", arm.caminho],
          ]),
      card("Backups", [
        ["Automático", bk.automatico ? "ligado" : "desligado"],
        ["Quantidade", bk.quantidade],
        ["Último", bk.ultimo || "nenhum", bk.alerta ? "alerta" : ""],
        ["Idade do último", bk.idadeHoras === null ? "—" : `${bk.idadeHoras} h`, bk.alerta ? "alerta" : ""],
      ]),
      card("ESP32", [
        ["Com MAC cadastrado", e.comMac],
        ["Online", e.online],
        ["Offline inesperado", e.offlineInesperado, e.offlineInesperado > 0 ? "aviso" : ""],
        ["Conectados (WS)", e.conectadosWs],
        ["Reconexões (1 h)", e.reconexoesAnormais1h, e.salasInstaveis.length ? "alerta" : ""],
        ["OTA em andamento", e.otaEmAndamento],
        ["OTA com falha", e.otaComFalha, e.otaComFalha > 0 ? "alerta" : ""],
        ["Quedas (24 h)", e.offlineUlt24h],
      ]),
      card("Credenciais de dispositivo", [
        ["Provisionadas", c.comCredencial ?? "—"],
        ["Só MAC", c.somenteMac ?? "—", (c.somenteMac || 0) > 0 && c.obrigatorio ? "alerta" : ""],
        ["Revogadas", c.revogadas ?? "—"],
        ["Exigência global", c.obrigatorio ? "ligada" : "desligada"],
      ]),
      card("Falhas desde a inicialização", [
        ["Comandos", fc.comandoFalha || 0, (fc.comandoFalha || 0) > 0 ? "aviso" : ""],
        ["Telemetria", fc.telemetriaFalha || 0, (fc.telemetriaFalha || 0) > 0 ? "aviso" : ""],
        ["OTA", fc.otaFalha || 0, (fc.otaFalha || 0) > 0 ? "aviso" : ""],
        ["Credencial", fc.credencialFalha || 0],
        ["Reconexão anormal", fc.reconexaoAnormal || 0],
        ["Agendador/serviço", fc.schedulerFalha || 0, (fc.schedulerFalha || 0) > 0 ? "alerta" : ""],
      ]),
    ];

    document.getElementById("monGrid").innerHTML = grid.join("");
  }

  async function carregar() {
    try {
      const resp = await Api.obterMonitoramento();
      if (!resp || !resp.ok) throw new Error("resposta inválida");
      document.getElementById("monErro").classList.add("hidden");
      render(resp.monitoramento);
    } catch (e) {
      document.getElementById("monErro").classList.remove("hidden");
    }
  }

  async function aoAbrir() {
    await carregar();
    if (!intervalo) intervalo = setInterval(carregar, 20000);
  }

  function aoFechar() {
    if (intervalo) {
      clearInterval(intervalo);
      intervalo = null;
    }
  }

  return { aoAbrir, aoFechar };
})();
