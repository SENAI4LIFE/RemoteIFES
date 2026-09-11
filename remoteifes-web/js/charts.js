const Graficos = (() => {
  const FUSO = "America/Sao_Paulo";
  const registro = new Map();
  let observador = null;
  let janelaOuvida = false;

  const fmtHoraMin = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  const fmtDiaMes = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit" });
  const fmtPartes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  function esc(texto) {
    return typeof escapeHtml === "function" ? escapeHtml(String(texto)) : String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function escalaFonte() {
    const bruto = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale"));
    return Number.isFinite(bruto) && bruto > 0 ? bruto : 1;
  }

  function espacamentoLetrasEm() {
    const bruto = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a11y-letter-spacing"));
    return Number.isFinite(bruto) && bruto > 0 ? bruto : 0;
  }

  function deslocamentoFusoMs(ms) {
    const partes = {};
    fmtPartes.formatToParts(new Date(ms)).forEach((p) => { partes[p.type] = p.value; });
    const local = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
    return local - Math.floor(ms / 1000) * 1000;
  }

  function fmtNumero(valor, casas) {
    if (valor === null || valor === undefined || !Number.isFinite(valor)) return "—";
    return valor.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas === undefined ? 1 : casas });
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = Math.abs(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${fmtNumero(v * Math.sign(n || 1), v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function formatadorDe(unidade) {
    if (typeof unidade === "function") return unidade;
    if (unidade === "bytes") return fmtBytes;
    if (unidade === "%") return (v) => (v === null || v === undefined ? "—" : `${fmtNumero(v, 1)}%`);
    if (unidade === "MB") return (v) => (v === null || v === undefined ? "—" : `${fmtNumero(v, 1)} MB`);
    if (unidade === "ms") return (v) => (v === null || v === undefined ? "—" : `${fmtNumero(v, 2)} ms`);
    if (unidade === "inteiro") return (v) => fmtNumero(v, 0);
    return (v) => fmtNumero(v, 1);
  }

  function ticksBonitos(maximo, quantidade, inteiros) {
    if (!(maximo > 0)) return [0, 1];
    const bruto = maximo / Math.max(1, quantidade);
    const potencia = Math.pow(10, Math.floor(Math.log10(bruto)));
    const candidatos = [1, 2, 2.5, 5, 10].map((m) => m * potencia).filter((p) => !inteiros || p >= 1);
    const passo = candidatos.find((p) => bruto <= p) || candidatos[candidatos.length - 1] || 1;
    const ticks = [];
    for (let v = 0; v <= maximo + passo * 0.001; v += passo) ticks.push(+v.toFixed(6));
    if (ticks[ticks.length - 1] < maximo) ticks.push(+(ticks[ticks.length - 1] + passo).toFixed(6));
    return ticks;
  }

  function rotuloInstante(ms, bucketMs) {
    const inicio = new Date(ms);
    if (!bucketMs) return `${fmtDiaMes.format(inicio)} ${fmtHoraMin.format(inicio)}`;
    const fim = new Date(ms + bucketMs);
    if (bucketMs >= 86400000) return `${fmtDiaMes.format(inicio)} a ${fmtDiaMes.format(new Date(ms + bucketMs - 1))}`;
    return `${fmtDiaMes.format(inicio)} ${fmtHoraMin.format(inicio)}–${fmtHoraMin.format(fim)}`;
  }

  function ticksTempo(t, bucketMs, larguraPlot, larguraRotulo) {
    if (!t.length) return [];
    const maximo = Math.max(2, Math.floor(larguraPlot / (larguraRotulo + 18)));
    const inicio = t[0];
    const fim = t[t.length - 1] + bucketMs;
    const passos = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 7200, 10080, 20160].map((m) => m * 60000).filter((p) => p >= bucketMs);
    const deslocamento = deslocamentoFusoMs(inicio);
    for (const passo of passos) {
      const primeiro = Math.ceil((inicio + deslocamento) / passo) * passo - deslocamento;
      const ticks = [];
      for (let x = primeiro; x < fim; x += passo) ticks.push(x);
      if (ticks.length <= maximo) {
        const diario = passo >= 86400000;
        const variosDias = fim - inicio > 36 * 3600000;
        return ticks.map((x) => {
          const meiaNoite = (x + deslocamento) % 86400000 === 0;
          const rotulo = diario || (variosDias && meiaNoite) ? fmtDiaMes.format(new Date(x)) : fmtHoraMin.format(new Date(x));
          return { x, rotulo, diario };
        });
      }
    }
    return [];
  }

  function garantirObservador() {
    if (observador || typeof ResizeObserver === "undefined") {
      if (!observador && !janelaOuvida) {
        janelaOuvida = true;
        window.addEventListener("resize", () => registro.forEach((item, el) => redesenharSeMudou(el, item)));
      }
      return;
    }
    observador = new ResizeObserver((entradas) => {
      entradas.forEach((entrada) => {
        const item = registro.get(entrada.target);
        if (item) redesenharSeMudou(entrada.target, item);
      });
    });
  }

  function redesenharSeMudou(el, item) {
    const largura = el.getBoundingClientRect().width;
    if (largura <= 0 || Math.abs(largura - item.largura) < 2) return;
    item.largura = largura;
    if (item.agendado) return;
    item.agendado = true;
    requestAnimationFrame(() => {
      item.agendado = false;
      item.desenhar();
    });
  }

  function registrar(container, desenhar) {
    garantirObservador();
    const existente = registro.get(container);
    if (existente) {
      existente.desenhar = desenhar;
      existente.largura = container.getBoundingClientRect().width;
      return;
    }
    registro.set(container, { desenhar, largura: container.getBoundingClientRect().width, agendado: false });
    if (observador) observador.observe(container);
  }

  function esqueleto(container, spec) {
    if (container.dataset.grId !== spec.id) {
      container.dataset.grId = spec.id;
      container.classList.add("gr");
      container.classList.toggle("gr-largo", !!spec.largo);
      container.innerHTML =
        `<figure class="gr-figura" role="group" aria-labelledby="${esc(spec.id)}-titulo" aria-describedby="${esc(spec.id)}-resumo">` +
        `<figcaption class="gr-cabecalho"><span class="gr-titulo" id="${esc(spec.id)}-titulo"></span><span class="gr-subtitulo"></span></figcaption>` +
        `<ul class="gr-legenda"></ul>` +
        `<div class="gr-plot" tabindex="0"></div>` +
        `<div class="gr-leitura" role="status" aria-live="polite"></div>` +
        `<p class="gr-resumo" id="${esc(spec.id)}-resumo"></p>` +
        `<details class="gr-tabela"><summary>Ver tabela de valores</summary><div class="gr-tabela-wrap"></div></details>` +
        `</figure>`;
    }
    const q = (sel) => container.querySelector(sel);
    q(".gr-titulo").textContent = spec.titulo || "";
    q(".gr-subtitulo").textContent = spec.subtitulo || "";
    q(".gr-subtitulo").hidden = !spec.subtitulo;
    return {
      container,
      legenda: q(".gr-legenda"),
      plot: q(".gr-plot"),
      leitura: q(".gr-leitura"),
      resumo: q(".gr-resumo"),
      tabela: q(".gr-tabela"),
      tabelaWrap: q(".gr-tabela-wrap"),
    };
  }

  function montarTabela(refs, cabecalho, linhas) {
    const desenhar = () => {
      if (refs.tabelaWrap.dataset.pronta === "1") return;
      refs.tabelaWrap.dataset.pronta = "1";
      refs.tabelaWrap.innerHTML =
        `<table><thead><tr>${cabecalho.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${linhas.map((l) => `<tr>${l.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</tbody></table>`;
    };
    refs.tabelaWrap.dataset.pronta = "0";
    refs.tabelaWrap.innerHTML = "";
    if (refs.tabela.open) desenhar();
    refs.tabela.ontoggle = () => { if (refs.tabela.open) desenhar(); };
  }

  function montarLegenda(refs, itens) {
    refs.legenda.innerHTML = itens
      .map((it) => `<li><i class="gr-chave gr-chave-${esc(it.forma || "linha")} ${esc(it.cor || "")}" aria-hidden="true"></i><span>${esc(it.nome)}</span>${it.valor !== undefined ? `<strong>${esc(it.valor)}</strong>` : ""}</li>`)
      .join("");
    refs.legenda.hidden = itens.length === 0;
  }

  function ligarNavegacao(refs, total, selecionar, eixo) {
    const plot = refs.plot;
    plot.setAttribute("aria-label", `${refs.container.querySelector(".gr-titulo").textContent}: use as setas do teclado para percorrer os valores`);
    let atual = -1;
    const aplicar = (i) => {
      if (total <= 0) return;
      atual = Math.max(0, Math.min(total - 1, i));
      selecionar(atual);
    };
    plot.onkeydown = (ev) => {
      const avancar = eixo === "y" ? ["ArrowDown"] : ["ArrowRight", "ArrowUp"];
      const recuar = eixo === "y" ? ["ArrowUp"] : ["ArrowLeft", "ArrowDown"];
      if (avancar.includes(ev.key)) { aplicar(atual < 0 ? 0 : atual + 1); ev.preventDefault(); }
      else if (recuar.includes(ev.key)) { aplicar(atual < 0 ? total - 1 : atual - 1); ev.preventDefault(); }
      else if (ev.key === "Home") { aplicar(0); ev.preventDefault(); }
      else if (ev.key === "End") { aplicar(total - 1); ev.preventDefault(); }
      else if (ev.key === "Escape") { atual = -1; selecionar(-1); }
    };
    plot.onfocus = () => { if (atual < 0 && total > 0) aplicar(total - 1); };
    return { definir: (i) => { atual = i; } };
  }

  function baseSvg(largura, altura) {
    return `<svg viewBox="0 0 ${largura} ${altura}" width="${largura}" height="${altura}" aria-hidden="true" focusable="false">`;
  }

  function larguraTexto(texto, fonte) {
    return String(texto).length * fonte * (0.58 + espacamentoLetrasEm());
  }

  function truncarTexto(texto, fonte, larguraMaxima) {
    const bruto = String(texto);
    if (larguraTexto(bruto, fonte) <= larguraMaxima) return bruto;
    const porChar = fonte * (0.58 + espacamentoLetrasEm());
    const cabem = Math.max(1, Math.floor(larguraMaxima / porChar) - 2);
    return `${bruto.slice(0, cabem)}…`;
  }

  function serieTemporal(container, spec) {
    const refs = esqueleto(container, spec);
    const fmt = formatadorDe(spec.unidade);
    const t = spec.t || [];
    const bucketMs = (spec.bucketSegundos || 0) * 1000;
    const series = spec.series || [];
    const total = t.length;

    const desenhar = () => {
      const escala = escalaFonte();
      const fonte = 11 * escala;
      const largura = Math.max(200, Math.floor(refs.plot.getBoundingClientRect().width || container.getBoundingClientRect().width));
      const altura = Math.round(190 * Math.min(1.5, Math.max(1, escala * 0.85)));
      const valores = series.flatMap((s) => s.valores.filter((v) => v !== null && v !== undefined));
      const maximoBruto = valores.length ? Math.max(...valores) : 0;
      const ticksY = ticksBonitos(spec.maximo !== undefined ? Math.max(spec.maximo, maximoBruto) : maximoBruto, 4, spec.unidade === "inteiro");
      const maximo = ticksY[ticksY.length - 1] || 1;
      const rotulosY = ticksY.map(fmt);
      const margemEsq = Math.ceil(Math.max(...rotulosY.map((r) => larguraTexto(r, fonte))) + 8);
      const margemDir = 10;
      const margemTopo = 8;
      const margemBase = Math.ceil(fonte + 12);
      const x0 = margemEsq;
      const x1 = largura - margemDir;
      const y0 = margemTopo;
      const y1 = altura - margemBase;
      const plotW = Math.max(10, x1 - x0);
      const plotH = Math.max(10, y1 - y0);
      const passoX = total > 1 ? plotW / total : plotW;
      const xDe = (i) => x0 + (i + 0.5) * passoX;
      const yDe = (v) => y1 - (v / maximo) * plotH;
      let svg = baseSvg(largura, altura);
      svg += `<rect class="gr-fundo" x="${x0}" y="${y0}" width="${plotW}" height="${plotH}"/>`;
      ticksY.forEach((v, i) => {
        const y = yDe(v);
        svg += `<line class="gr-grade" x1="${x0}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
        svg += `<text class="gr-eixo" x="${x0 - 5}" y="${(y + fonte * 0.35).toFixed(1)}" text-anchor="end">${esc(rotulosY[i])}</text>`;
      });
      const ticksX = ticksTempo(t, bucketMs, plotW, larguraTexto("00:00", fonte));
      ticksX.forEach((tk) => {
        const x = x0 + ((tk.x - t[0]) / (bucketMs || 1)) * passoX;
        if (x < x0 - 1 || x > x1 + 1) return;
        svg += `<line class="gr-grade gr-grade-x" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y0}" y2="${y1}"/>`;
        svg += `<text class="gr-eixo" x="${x.toFixed(1)}" y="${(y1 + fonte + 4).toFixed(1)}" text-anchor="middle">${esc(tk.rotulo)}</text>`;
      });
      (spec.reinicios || []).forEach((r) => {
        const em = new Date(r.em).getTime();
        if (!Number.isFinite(em) || !total) return;
        const x = x0 + ((em - t[0]) / (bucketMs || 1)) * passoX;
        if (x < x0 || x > x1) return;
        svg += `<line class="gr-reinicio" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y0}" y2="${y1}"/>`;
        svg += `<path class="gr-reinicio-marca" d="M${(x - 5).toFixed(1)} ${y0} L${(x + 5).toFixed(1)} ${y0} L${x.toFixed(1)} ${y0 + 7} Z"/>`;
      });
      series.forEach((s, si) => {
        const cor = s.cor || `gr-cor-${si + 1}`;
        let caminho = "";
        let area = "";
        let inicioSeg = null;
        const pontosIsolados = [];
        for (let i = 0; i <= total; i += 1) {
          const v = i < total ? s.valores[i] : null;
          if (v === null || v === undefined) {
            if (inicioSeg !== null) {
              if (i - inicioSeg === 1) pontosIsolados.push(inicioSeg);
              area += ` L${xDe(i - 1).toFixed(1)} ${y1} Z`;
              inicioSeg = null;
            }
            continue;
          }
          const x = xDe(i).toFixed(1);
          const y = yDe(v).toFixed(1);
          if (inicioSeg === null) {
            inicioSeg = i;
            caminho += `M${x} ${y}`;
            area += `M${x} ${y1} L${x} ${y}`;
          } else {
            caminho += ` L${x} ${y}`;
            area += ` L${x} ${y}`;
          }
        }
        if (s.estilo === "area" && area) svg += `<path class="gr-area ${cor}" d="${area}"/>`;
        if (caminho) svg += `<path class="gr-linha ${cor}${s.estilo === "fina" ? " gr-linha-fina" : ""}" d="${caminho}"/>`;
        pontosIsolados.forEach((i) => {
          svg += `<circle class="gr-ponto ${cor}" cx="${xDe(i).toFixed(1)}" cy="${yDe(s.valores[i]).toFixed(1)}" r="3"/>`;
        });
      });
      svg += `<line class="gr-cursor" x1="0" x2="0" y1="${y0}" y2="${y1}" visibility="hidden"/>`;
      series.forEach((s, si) => {
        svg += `<circle class="gr-cursor-ponto ${s.cor || `gr-cor-${si + 1}`}" cx="0" cy="0" r="4" visibility="hidden"/>`;
      });
      if (!valores.length) svg += `<text class="gr-vazio" x="${(x0 + plotW / 2).toFixed(1)}" y="${(y0 + plotH / 2).toFixed(1)}" text-anchor="middle">Sem amostras neste período</text>`;
      svg += "</svg>";
      refs.plot.innerHTML = svg;

      const cursor = refs.plot.querySelector(".gr-cursor");
      const pontosCursor = Array.from(refs.plot.querySelectorAll(".gr-cursor-ponto"));
      const selecionar = (i) => {
        if (i < 0 || i >= total) {
          cursor.setAttribute("visibility", "hidden");
          pontosCursor.forEach((p) => p.setAttribute("visibility", "hidden"));
          refs.leitura.textContent = "";
          return;
        }
        const x = xDe(i).toFixed(1);
        cursor.setAttribute("x1", x);
        cursor.setAttribute("x2", x);
        cursor.setAttribute("visibility", "visible");
        const partes = [rotuloInstante(t[i], bucketMs)];
        series.forEach((s, si) => {
          const v = s.valores[i];
          const p = pontosCursor[si];
          if (v === null || v === undefined) {
            p.setAttribute("visibility", "hidden");
            partes.push(`${s.nome}: sem amostra`);
          } else {
            p.setAttribute("cx", x);
            p.setAttribute("cy", yDe(v).toFixed(1));
            p.setAttribute("visibility", "visible");
            partes.push(`${s.nome}: ${fmt(v)}`);
          }
        });
        if (spec.n && Number.isFinite(spec.n[i])) partes.push(`${spec.n[i]} amostra${spec.n[i] === 1 ? "" : "s"}`);
        const reinicio = (spec.reinicios || []).some((r) => {
          const em = new Date(r.em).getTime();
          return em >= t[i] && em < t[i] + bucketMs;
        });
        if (reinicio) partes.push("reinício do serviço neste intervalo");
        refs.leitura.textContent = partes.join(" · ");
        navegacao.definir(i);
      };
      const navegacao = ligarNavegacao(refs, total, selecionar, "x");
      const svgEl = refs.plot.querySelector("svg");
      const daPosicao = (ev) => {
        const r = svgEl.getBoundingClientRect();
        const x = ((ev.clientX - r.left) / r.width) * largura;
        return Math.max(0, Math.min(total - 1, Math.floor((x - x0) / passoX)));
      };
      svgEl.onpointermove = (ev) => { if (total) selecionar(daPosicao(ev)); };
      svgEl.onpointerdown = (ev) => { if (total) { selecionar(daPosicao(ev)); refs.plot.focus({ preventScroll: true }); } };
      svgEl.onpointerleave = () => { if (document.activeElement !== refs.plot) selecionar(-1); };
    };

    montarLegenda(refs, series.length > 1 || (spec.reinicios || []).length
      ? [
          ...series.map((s, si) => ({ nome: s.nome, forma: s.estilo === "area" ? "area" : "linha", cor: s.cor || `gr-cor-${si + 1}` })),
          ...((spec.reinicios || []).length ? [{ nome: "reinício do serviço", forma: "reinicio", cor: "gr-reinicio-chave" }] : []),
        ]
      : []);
    const principal = series[0];
    const validos = principal ? principal.valores.map((v, i) => [v, i]).filter(([v]) => v !== null && v !== undefined) : [];
    if (spec.resumo) refs.resumo.textContent = spec.resumo;
    else if (!validos.length) refs.resumo.textContent = "Sem amostras neste período.";
    else {
      const ultimo = validos[validos.length - 1];
      const nums = validos.map(([v]) => v);
      refs.resumo.textContent = `${principal.nome}: último ${fmt(ultimo[0])} (${rotuloInstante(t[ultimo[1]], bucketMs)}) · mínimo ${fmt(Math.min(...nums))} · máximo ${fmt(Math.max(...nums))}${(spec.reinicios || []).length ? ` · ${spec.reinicios.length} reinício(s) no período` : ""}.`;
    }
    montarTabela(refs, ["Intervalo", ...series.map((s) => s.nome), ...(spec.n ? ["Amostras"] : [])],
      t.map((ms, i) => [rotuloInstante(ms, bucketMs), ...series.map((s) => fmt(s.valores[i])), ...(spec.n ? [String(spec.n[i] ?? "")] : [])]));
    registrar(container, desenhar);
    desenhar();
  }

  function agruparContagens(t, series, bucketMs, fator) {
    if (fator <= 1) return { t, series, bucketMs };
    const novoT = [];
    const novas = series.map((s) => ({ ...s, valores: [] }));
    for (let i = 0; i < t.length; i += fator) {
      novoT.push(t[i]);
      series.forEach((s, si) => {
        let soma = 0;
        for (let j = i; j < Math.min(t.length, i + fator); j += 1) soma += s.valores[j] || 0;
        novas[si].valores.push(soma);
      });
    }
    return { t: novoT, series: novas, bucketMs: bucketMs * fator };
  }

  function colunas(container, spec) {
    const refs = esqueleto(container, spec);
    const fmt = formatadorDe(spec.unidade || "inteiro");
    const empilhado = spec.modo !== "agrupado";
    const seriesBase = spec.series || [];
    const tBase = spec.t || [];
    const bucketBase = (spec.bucketSegundos || 0) * 1000;

    const desenhar = () => {
      const escala = escalaFonte();
      const fonte = 11 * escala;
      const largura = Math.max(200, Math.floor(refs.plot.getBoundingClientRect().width || container.getBoundingClientRect().width));
      const altura = Math.round(190 * Math.min(1.5, Math.max(1, escala * 0.85)));
      const margemDir = 10;
      const margemTopo = 8;
      const margemBase = Math.ceil(fonte + 12);
      const larguraMinimaSlot = empilhado ? 7 : seriesBase.length * 4 + 4;
      const plotWEstimado = largura - 40 - margemDir;
      const fator = tBase.length ? Math.max(1, Math.ceil(larguraMinimaSlot / (plotWEstimado / tBase.length))) : 1;
      const { t, series, bucketMs } = agruparContagens(tBase, seriesBase, bucketBase, fator);
      const total = t.length;
      const totais = t.map((_, i) => (empilhado ? series.reduce((acc, s) => acc + (s.valores[i] || 0), 0) : Math.max(...series.map((s) => s.valores[i] || 0), 0)));
      const maximoBruto = totais.length ? Math.max(...totais) : 0;
      const ticksY = ticksBonitos(maximoBruto, 3, true);
      const maximo = ticksY[ticksY.length - 1] || 1;
      const rotulosY = ticksY.map(fmt);
      const margemEsq = Math.ceil(Math.max(...rotulosY.map((r) => larguraTexto(r, fonte))) + 8);
      const x0 = margemEsq;
      const x1 = largura - margemDir;
      const y0 = margemTopo;
      const y1 = altura - margemBase;
      const plotW = Math.max(10, x1 - x0);
      const plotH = Math.max(10, y1 - y0);
      const passoX = total ? plotW / total : plotW;
      const folga = Math.min(2, passoX * 0.15);
      const yDe = (v) => y1 - (v / maximo) * plotH;
      let svg = baseSvg(largura, altura);
      svg += `<rect class="gr-fundo" x="${x0}" y="${y0}" width="${plotW}" height="${plotH}"/>`;
      ticksY.forEach((v, i) => {
        const y = yDe(v);
        svg += `<line class="gr-grade" x1="${x0}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
        svg += `<text class="gr-eixo" x="${x0 - 5}" y="${(y + fonte * 0.35).toFixed(1)}" text-anchor="end">${esc(rotulosY[i])}</text>`;
      });
      const ticksX = ticksTempo(t, bucketMs, plotW, larguraTexto("00:00", fonte));
      ticksX.forEach((tk) => {
        const x = x0 + ((tk.x - t[0]) / (bucketMs || 1)) * passoX;
        if (x < x0 - 1 || x > x1 + 1) return;
        svg += `<text class="gr-eixo" x="${x.toFixed(1)}" y="${(y1 + fonte + 4).toFixed(1)}" text-anchor="middle">${esc(tk.rotulo)}</text>`;
      });
      for (let i = 0; i < total; i += 1) {
        const xSlot = x0 + i * passoX;
        if (empilhado) {
          let base = 0;
          series.forEach((s, si) => {
            const v = s.valores[i] || 0;
            if (v <= 0) return;
            const yTopo = yDe(base + v);
            const yBase = yDe(base) - (base > 0 ? 2 : 0);
            const h = Math.max(0, yBase - yTopo);
            if (h > 0) svg += `<rect class="gr-coluna ${s.cor || `gr-cor-${si + 1}`}" x="${(xSlot + folga).toFixed(1)}" y="${yTopo.toFixed(1)}" width="${Math.max(1, passoX - folga * 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
            base += v;
          });
        } else {
          const larguraBarra = Math.max(1, (passoX - folga * 2 - (series.length - 1)) / series.length);
          series.forEach((s, si) => {
            const v = s.valores[i] || 0;
            if (v <= 0) return;
            const x = xSlot + folga + si * (larguraBarra + 1);
            svg += `<rect class="gr-coluna ${s.cor || `gr-cor-${si + 1}`}" x="${x.toFixed(1)}" y="${yDe(v).toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${(y1 - yDe(v)).toFixed(1)}" rx="1"/>`;
          });
        }
      }
      svg += `<rect class="gr-destaque" x="0" y="${y0}" width="${passoX.toFixed(1)}" height="${plotH}" visibility="hidden"/>`;
      if (maximoBruto === 0) svg += `<text class="gr-vazio" x="${(x0 + plotW / 2).toFixed(1)}" y="${(y0 + plotH / 2).toFixed(1)}" text-anchor="middle">Nenhuma ocorrência no período</text>`;
      svg += "</svg>";
      refs.plot.innerHTML = svg;

      const destaque = refs.plot.querySelector(".gr-destaque");
      const selecionar = (i) => {
        if (i < 0 || i >= total) {
          destaque.setAttribute("visibility", "hidden");
          refs.leitura.textContent = "";
          return;
        }
        destaque.setAttribute("x", (x0 + i * passoX).toFixed(1));
        destaque.setAttribute("visibility", "visible");
        const partes = [rotuloInstante(t[i], bucketMs), ...series.map((s) => `${s.nome}: ${fmt(s.valores[i] || 0)}`)];
        if (empilhado && series.length > 1) partes.push(`total: ${fmt(totais[i])}`);
        refs.leitura.textContent = partes.join(" · ");
        navegacao.definir(i);
      };
      const navegacao = ligarNavegacao(refs, total, selecionar, "x");
      const svgEl = refs.plot.querySelector("svg");
      const daPosicao = (ev) => {
        const r = svgEl.getBoundingClientRect();
        const x = ((ev.clientX - r.left) / r.width) * largura;
        return Math.max(0, Math.min(total - 1, Math.floor((x - x0) / passoX)));
      };
      svgEl.onpointermove = (ev) => { if (total) selecionar(daPosicao(ev)); };
      svgEl.onpointerdown = (ev) => { if (total) { selecionar(daPosicao(ev)); refs.plot.focus({ preventScroll: true }); } };
      svgEl.onpointerleave = () => { if (document.activeElement !== refs.plot) selecionar(-1); };
      refs.container.dataset.grAgrupamento = String(fator);
    };

    montarLegenda(refs, seriesBase.length > 1 ? seriesBase.map((s, si) => ({ nome: s.nome, forma: "coluna", cor: s.cor || `gr-cor-${si + 1}` })) : []);
    const totaisSerie = seriesBase.map((s) => s.valores.reduce((acc, v) => acc + (v || 0), 0));
    const totalGeral = totaisSerie.reduce((a, b) => a + b, 0);
    if (spec.resumo) refs.resumo.textContent = spec.resumo;
    else if (!totalGeral) refs.resumo.textContent = "Nenhuma ocorrência no período.";
    else refs.resumo.textContent = `Total no período: ${seriesBase.map((s, si) => `${fmt(totaisSerie[si])} ${s.nome.toLowerCase()}`).join(", ")}.`;
    montarTabela(refs, ["Intervalo", ...seriesBase.map((s) => s.nome)], tBase.map((ms, i) => [rotuloInstante(ms, bucketBase), ...seriesBase.map((s) => fmt(s.valores[i] || 0))]));
    registrar(container, desenhar);
    desenhar();
  }

  function barras(container, spec) {
    const refs = esqueleto(container, spec);
    const fmt = formatadorDe(spec.unidade || "%");
    const itens = spec.itens || [];
    const total = itens.length;
    const maximo = spec.maximo || Math.max(1, ...itens.map((it) => it.valor || 0));

    const desenhar = () => {
      const escala = escalaFonte();
      const fonte = 11 * escala;
      const largura = Math.max(200, Math.floor(refs.plot.getBoundingClientRect().width || container.getBoundingClientRect().width));
      const linhaH = Math.ceil(fonte * 2.2);
      const estreito = largura < 420 * Math.min(escala, 1.5);
      const alturaLinha = estreito ? linhaH + fonte + 6 : linhaH;
      const margemEsq = estreito ? 6 : Math.ceil(Math.min(largura * 0.4, Math.max(...itens.map((it) => larguraTexto(it.nome, fonte))) + 10));
      const margemDir = Math.ceil(Math.min(largura * 0.45, Math.max(...itens.map((it) => larguraTexto(it.rotulo || fmt(it.valor), fonte))) + 10));
      const altura = total * alturaLinha + 8;
      const x0 = margemEsq;
      const x1 = Math.max(x0 + 20, largura - margemDir);
      const plotW = x1 - x0;
      let svg = baseSvg(largura, altura);
      itens.forEach((it, i) => {
        const yTopo = 4 + i * alturaLinha + (estreito ? fonte + 4 : 0);
        const hBarra = Math.max(8, linhaH - 10);
        const yBarra = yTopo + (linhaH - hBarra) / 2;
        const w = Math.max(0, Math.min(1, (it.valor || 0) / maximo)) * plotW;
        const yTexto = estreito ? yTopo - 2 : yBarra + hBarra / 2 + fonte * 0.35;
        const nome = truncarTexto(it.nome, fonte, estreito ? largura - x0 - 4 : margemEsq - 10);
        svg += `<text class="gr-eixo gr-rotulo-categoria" x="${estreito ? x0 : x0 - 6}" y="${yTexto.toFixed(1)}" text-anchor="${estreito ? "start" : "end"}">${esc(nome)}</text>`;
        svg += `<rect class="gr-trilha" x="${x0}" y="${yBarra.toFixed(1)}" width="${plotW.toFixed(1)}" height="${hBarra}" rx="3"/>`;
        if (w > 0) svg += `<rect class="gr-barra ${esc(it.cor || "gr-cor-1")}" x="${x0}" y="${yBarra.toFixed(1)}" width="${Math.max(2, w).toFixed(1)}" height="${hBarra}" rx="3"/>`;
        svg += `<text class="gr-eixo gr-valor" x="${x1 + 6}" y="${(yBarra + hBarra / 2 + fonte * 0.35).toFixed(1)}" text-anchor="start">${esc(truncarTexto(it.rotulo || fmt(it.valor), fonte, margemDir - 6))}</text>`;
        svg += `<rect class="gr-destaque-linha" data-i="${i}" x="0" y="${(yTopo - (estreito ? fonte + 4 : 0)).toFixed(1)}" width="${largura}" height="${alturaLinha}" visibility="hidden"/>`;
      });
      svg += "</svg>";
      refs.plot.innerHTML = svg;
      const destaques = Array.from(refs.plot.querySelectorAll(".gr-destaque-linha"));
      const selecionar = (i) => {
        destaques.forEach((d, di) => d.setAttribute("visibility", di === i ? "visible" : "hidden"));
        if (i < 0 || i >= total) { refs.leitura.textContent = ""; return; }
        const it = itens[i];
        refs.leitura.textContent = `${it.nome}: ${it.rotulo || fmt(it.valor)}${it.detalhe ? ` · ${it.detalhe}` : ""}`;
        navegacao.definir(i);
      };
      const navegacao = ligarNavegacao(refs, total, selecionar, "y");
      const svgEl = refs.plot.querySelector("svg");
      const daPosicao = (ev) => {
        const r = svgEl.getBoundingClientRect();
        const y = ((ev.clientY - r.top) / r.height) * altura;
        return Math.max(0, Math.min(total - 1, Math.floor((y - 4) / alturaLinha)));
      };
      svgEl.onpointermove = (ev) => { if (total) selecionar(daPosicao(ev)); };
      svgEl.onpointerdown = (ev) => { if (total) { selecionar(daPosicao(ev)); refs.plot.focus({ preventScroll: true }); } };
      svgEl.onpointerleave = () => { if (document.activeElement !== refs.plot) selecionar(-1); };
    };

    montarLegenda(refs, spec.legenda || []);
    refs.resumo.textContent = spec.resumo || (total ? `${total} categorias; maior valor: ${itens.reduce((a, b) => ((b.valor || 0) > (a.valor || 0) ? b : a)).nome}.` : "Sem categorias.");
    montarTabela(refs, [spec.rotuloCategoria || "Categoria", spec.rotuloValor || "Valor", ...(itens.some((it) => it.detalhe) ? ["Detalhe"] : [])],
      itens.map((it) => [it.nome, it.rotulo || fmt(it.valor), ...(itens.some((x) => x.detalhe) ? [it.detalhe || ""] : [])]));
    registrar(container, desenhar);
    desenhar();
  }

  function rosca(container, spec) {
    const refs = esqueleto(container, spec);
    const itens = (spec.itens || []).map((it) => ({ ...it, valor: Math.max(0, Number(it.valor) || 0) }));
    const soma = itens.reduce((acc, it) => acc + it.valor, 0);
    const fatias = itens.filter((it) => it.valor > 0);
    const total = fatias.length;
    const percentual = (v) => (soma > 0 ? `${fmtNumero((v / soma) * 100, 0)}%` : "—");

    const desenhar = () => {
      const escala = escalaFonte();
      const fonte = 11 * escala;
      const largura = Math.max(160, Math.floor(refs.plot.getBoundingClientRect().width || container.getBoundingClientRect().width));
      const lado = Math.min(largura, Math.round(170 * Math.min(1.6, Math.max(1, escala))));
      const raio = lado / 2 - 4;
      const espessura = Math.max(14, Math.round(raio * 0.32));
      const cx = largura / 2;
      const cy = lado / 2;
      let svg = baseSvg(largura, lado);
      if (!total) {
        svg += `<circle class="gr-trilha" cx="${cx}" cy="${cy}" r="${raio - espessura / 2}" fill="none" stroke-width="${espessura}"/>`;
      } else {
        let angulo = -Math.PI / 2;
        const r = raio - espessura / 2;
        fatias.forEach((it, i) => {
          const fracao = it.valor / soma;
          const fim = angulo + fracao * Math.PI * 2;
          const a0 = angulo;
          const a1 = total === 1 ? fim - 0.0001 : fim;
          const x0 = cx + r * Math.cos(a0);
          const y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(a1);
          const y1 = cy + r * Math.sin(a1);
          const grande = a1 - a0 > Math.PI ? 1 : 0;
          svg += `<path class="gr-fatia ${esc(it.cor || `gr-cor-${i + 1}`)}" data-i="${i}" d="M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${grande} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" fill="none" stroke-width="${espessura}"/>`;
          angulo = fim;
        });
      }
      const central = spec.central !== undefined ? spec.central : String(soma);
      svg += `<text class="gr-central" x="${cx}" y="${(cy + fonte * 0.5).toFixed(1)}" text-anchor="middle">${esc(central)}</text>`;
      if (spec.centralRotulo) svg += `<text class="gr-eixo" x="${cx}" y="${(cy + fonte * 1.9).toFixed(1)}" text-anchor="middle">${esc(spec.centralRotulo)}</text>`;
      svg += "</svg>";
      refs.plot.innerHTML = svg;
      const caminhos = Array.from(refs.plot.querySelectorAll(".gr-fatia"));
      const selecionar = (i) => {
        caminhos.forEach((c, ci) => c.classList.toggle("gr-fatia-ativa", ci === i));
        if (i < 0 || i >= total) { refs.leitura.textContent = ""; return; }
        const it = fatias[i];
        refs.leitura.textContent = `${it.nome}: ${fmtNumero(it.valor, 0)} de ${fmtNumero(soma, 0)} (${percentual(it.valor)})`;
        navegacao.definir(i);
      };
      const navegacao = ligarNavegacao(refs, total, selecionar, "x");
      const svgEl = refs.plot.querySelector("svg");
      const daPosicao = (ev) => {
        const rct = svgEl.getBoundingClientRect();
        const x = ((ev.clientX - rct.left) / rct.width) * largura - cx;
        const y = ((ev.clientY - rct.top) / rct.height) * lado - cy;
        const dist = Math.sqrt(x * x + y * y);
        if (dist < raio - espessura - 6 || dist > raio + 6) return -1;
        let ang = Math.atan2(y, x) + Math.PI / 2;
        if (ang < 0) ang += Math.PI * 2;
        let acumulado = 0;
        for (let i = 0; i < total; i += 1) {
          acumulado += (fatias[i].valor / soma) * Math.PI * 2;
          if (ang <= acumulado + 1e-9) return i;
        }
        return total - 1;
      };
      svgEl.onpointermove = (ev) => { if (total) selecionar(daPosicao(ev)); };
      svgEl.onpointerdown = (ev) => { if (total) { selecionar(daPosicao(ev)); refs.plot.focus({ preventScroll: true }); } };
      svgEl.onpointerleave = () => { if (document.activeElement !== refs.plot) selecionar(-1); };
    };

    montarLegenda(refs, itens.map((it, i) => ({ nome: it.nome, forma: "fatia", cor: it.cor || `gr-cor-${i + 1}`, valor: `${fmtNumero(it.valor, 0)} (${percentual(it.valor)})` })));
    refs.resumo.textContent = spec.resumo || (soma > 0
      ? `Total ${fmtNumero(soma, 0)}: ${itens.map((it) => `${it.nome} ${fmtNumero(it.valor, 0)} (${percentual(it.valor)})`).join(", ")}.`
      : spec.vazio || "Nada a compor no momento.");
    montarTabela(refs, [spec.rotuloCategoria || "Categoria", "Quantidade", "Participação"], itens.map((it) => [it.nome, fmtNumero(it.valor, 0), percentual(it.valor)]));
    registrar(container, desenhar);
    desenhar();
  }

  function limpar(container) {
    const item = registro.get(container);
    if (item && observador) observador.unobserve(container);
    registro.delete(container);
    delete container.dataset.grId;
    container.classList.remove("gr", "gr-largo");
    container.innerHTML = "";
  }

  return { serieTemporal, colunas, barras, rosca, limpar, fmtBytes, fmtNumero, rotuloInstante };
})();
