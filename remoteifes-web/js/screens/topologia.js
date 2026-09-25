// Device topology (superadministrator): server, direct boards, gateways and the boards behind them.
// The data is the server's in-memory observation (GET /admin/topologia), refreshed every 15 s only
// while this tab is open. Drawn as plain SVG; a table repeats every node for keyboard and screen
// reader use.
const Topologia = (() => {
  const ATUALIZAR_MS = 15_000;
  const LARGURA_NO = 132;
  const ALTURA_NIVEL = 96;
  const RAIO = 13;
  const NS = "http://www.w3.org/2000/svg";

  const ROTULOS_ESTADO = {
    conectado: "conectado",
    autenticando: "autenticando",
    anunciado: "anunciado pelo gateway",
    recusado: "recusado (credencial)",
    inalcancavel: "inalcançável",
    direto: "conectado",
  };

  let dados = null;
  let relogio = null;
  let selecionado = null;

  const el = (id) => document.getElementById(id);

  function texto(valor, alternativo = "—") {
    return valor === null || valor === undefined || valor === "" ? alternativo : String(valor);
  }

  // The observation carries ISO instants; shown in Brasília time like the rest of the interface.
  function quando(iso) {
    if (!iso) return "—";
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return "—";
    return data.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function classeEstado(estado) {
    if (estado === "conectado" || estado === "direto") return "topo-ok";
    if (estado === "autenticando" || estado === "anunciado") return "topo-atencao";
    return "topo-falha";
  }

  /** Nodes and parent links, after the transport and state filters. */
  function montarArvore() {
    const filtroTransporte = el("topoFiltroTransporte").value;
    const filtroEstado = el("topoFiltroEstado").value;
    const itens = [{ id: "servidor", rotulo: "Servidor", tipo: "servidor", pai: null, estado: "conectado" }];
    const gatewayPorSala = new Map();
    for (const d of dados.diretos) {
      if (filtroTransporte === "mesh" && !d.gateway) continue;
      const id = `direto:${d.sala}`;
      if (d.gateway) gatewayPorSala.set(d.sala, id);
      itens.push({ id, rotulo: d.sala, tipo: d.gateway ? "gateway" : "direto", pai: "servidor", estado: "direto", dado: d });
    }
    const porDevice = new Map();
    for (const n of dados.nos) {
      if (filtroTransporte === "direto") continue;
      if (filtroEstado === "problema" && n.estado === "conectado") continue;
      const id = `no:${n.deviceId}`;
      porDevice.set(n.deviceId, id);
      itens.push({ id, rotulo: n.sala || n.deviceId.slice(-6), tipo: "mesh", paiDevice: n.pai, gateway: n.gateway, estado: n.estado, dado: n });
    }
    for (const item of itens) {
      if (item.tipo !== "mesh") continue;
      const paiNo = item.paiDevice && item.paiDevice !== "gateway" ? porDevice.get(item.paiDevice) : null;
      item.pai = paiNo || gatewayPorSala.get(item.gateway) || "servidor";
    }
    if (filtroEstado === "problema") {
      return itens.filter((i) => i.tipo === "servidor" || i.tipo === "gateway" || i.estado !== "conectado" && i.estado !== "direto");
    }
    return itens;
  }

  function layout(itens) {
    const filhos = new Map(itens.map((i) => [i.id, []]));
    const porId = new Map(itens.map((i) => [i.id, i]));
    for (const i of itens) if (i.pai && filhos.has(i.pai)) filhos.get(i.pai).push(i.id);
    let folha = 0;
    const posicionar = (id, nivel) => {
      const item = porId.get(id);
      item.nivel = nivel;
      const f = filhos.get(id);
      if (!f.length) {
        item.x = folha * LARGURA_NO + LARGURA_NO / 2;
        folha += 1;
      } else {
        f.forEach((c) => posicionar(c, nivel + 1));
        item.x = (porId.get(f[0]).x + porId.get(f[f.length - 1]).x) / 2;
      }
      item.y = nivel * ALTURA_NIVEL + 40;
      item.retransmissor = item.tipo === "mesh" && f.length > 0;
    };
    posicionar("servidor", 0);
    const niveis = Math.max(...itens.map((i) => i.nivel || 0)) + 1;
    return { largura: Math.max(folha, 1) * LARGURA_NO, altura: niveis * ALTURA_NIVEL + 30, porId };
  }

  function rotaAteServidor(porId, id) {
    const caminho = new Set();
    let atual = porId.get(id);
    while (atual && atual.pai) {
      caminho.add(`${atual.pai}>${atual.id}`);
      atual = porId.get(atual.pai);
    }
    return caminho;
  }

  function criar(tag, atributos = {}, pai = null) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(atributos)) n.setAttribute(k, v);
    if (pai) pai.appendChild(n);
    return n;
  }

  function descrever(item) {
    if (item.tipo === "servidor") return "Servidor RemoteIFES";
    const d = item.dado;
    if (item.tipo === "mesh") {
      return `Sala ${texto(d.sala, "desconhecida")}, pela malha, ${ROTULOS_ESTADO[d.estado] || d.estado}, ${texto(d.saltos, "?")} salto(s)`;
    }
    return `Sala ${d.sala}, ${item.tipo === "gateway" ? "gateway da malha" : "Wi-Fi direto"}, conectado`;
  }

  function desenhar() {
    const svg = el("topoSvg");
    const itens = montarArvore();
    const { largura, altura, porId } = layout(itens);
    const destacadas = selecionado && porId.has(selecionado) ? rotaAteServidor(porId, selecionado) : new Set();
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
    svg.setAttribute("width", String(largura));
    svg.setAttribute("height", String(altura));

    const arestas = criar("g", { class: "topo-arestas" }, svg);
    for (const item of itens) {
      if (!item.pai || !porId.has(item.pai)) continue;
      const pai = porId.get(item.pai);
      const chave = `${item.pai}>${item.id}`;
      const classe = ["topo-aresta", item.tipo === "mesh" ? "topo-aresta-mesh" : "topo-aresta-direta", destacadas.has(chave) ? "topo-rota" : ""].join(" ");
      criar("line", { x1: pai.x, y1: pai.y, x2: item.x, y2: item.y, class: classe }, arestas);
      const rssi = item.dado && typeof item.dado.rssi === "number" ? `${item.dado.rssi} dBm` : null;
      if (rssi) {
        // Beside the child end of the link, clear of the parent's label.
        const rotulo = criar("text", { x: item.x + RAIO + 4, y: item.y - RAIO - 4, class: "topo-rotulo-aresta" }, arestas);
        rotulo.textContent = rssi;
      }
    }

    const nosSvg = criar("g", { class: "topo-nos" }, svg);
    for (const item of itens) {
      const g = criar("g", {
        class: `topo-no ${classeEstado(item.estado)} topo-${item.tipo}${item.id === selecionado ? " topo-selecionado" : ""}`,
        transform: `translate(${item.x} ${item.y})`,
        tabindex: "0",
        role: "button",
        "aria-label": descrever(item),
        "data-id": item.id,
      }, nosSvg);
      if (item.retransmissor) criar("circle", { r: RAIO + 5, class: "topo-anel-retransmissor" }, g);
      if (item.tipo === "gateway" || item.tipo === "servidor") criar("rect", { x: -RAIO, y: -RAIO, width: RAIO * 2, height: RAIO * 2, rx: 4 }, g);
      else criar("circle", { r: RAIO }, g);
      const rotulo = criar("text", { y: RAIO + 16, class: "topo-rotulo" }, g);
      rotulo.textContent = item.rotulo.length > 14 ? `${item.rotulo.slice(0, 13)}…` : item.rotulo;
      const titulo = criar("title", {}, g);
      titulo.textContent = descrever(item);
    }
    preencherTabela(itens);
    mostrarDetalhe(selecionado ? porId.get(selecionado) : null);
  }

  function preencherTabela(itens) {
    const corpo = el("topoTabela").querySelector("tbody");
    corpo.replaceChildren();
    for (const item of itens) {
      if (item.tipo === "servidor") continue;
      const d = item.dado;
      const tr = document.createElement("tr");
      const celulas = [
        texto(d.sala, d.deviceId),
        item.tipo === "mesh" ? "malha" : item.tipo === "gateway" ? "direto (gateway)" : "direto",
        ROTULOS_ESTADO[item.estado] || item.estado,
        item.tipo === "mesh" ? texto(d.saltos) : "—",
        typeof d.rssi === "number" ? `${d.rssi} dBm` : "—",
        item.tipo === "mesh" ? quando(d.ultimaVez) : quando(d.ultimaAtividadeEm),
      ];
      for (const c of celulas) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      tr.tabIndex = 0;
      tr.addEventListener("click", () => selecionar(item.id));
      tr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          selecionar(item.id);
        }
      });
      corpo.appendChild(tr);
    }
  }

  function linhaDetalhe(dl, rotulo, valor) {
    const dt = document.createElement("dt");
    dt.textContent = rotulo;
    const dd = document.createElement("dd");
    dd.textContent = valor;
    dl.append(dt, dd);
  }

  function mostrarDetalhe(item) {
    const caixa = el("topoDetalhe");
    caixa.replaceChildren();
    if (!item || item.tipo === "servidor") {
      caixa.textContent = "Selecione um nó para ver o caminho até o servidor e o diagnóstico.";
      return;
    }
    const d = item.dado;
    const titulo = document.createElement("h3");
    titulo.textContent = `Sala ${texto(d.sala, "desconhecida")}`;
    const dl = document.createElement("dl");
    linhaDetalhe(dl, "Dispositivo", texto(d.deviceId, "credencial não provisionada"));
    if (item.tipo === "mesh") {
      linhaDetalhe(dl, "Transporte", "malha, pelo gateway da sala " + texto(d.gateway));
      linhaDetalhe(dl, "Pai na malha", d.pai === "gateway" ? "o próprio gateway" : texto(d.pai));
      linhaDetalhe(dl, "Saltos até o gateway", texto(d.saltos));
      linhaDetalhe(dl, "Situação", ROTULOS_ESTADO[d.estado] || d.estado);
      linhaDetalhe(dl, "Canal de comandos", d.canalComandos ? "pronto" : "indisponível");
      linhaDetalhe(dl, "Firmware", texto(d.fwVersao));
      linhaDetalhe(dl, "Sinal (RSSI)", typeof d.rssi === "number" ? `${d.rssi} dBm` : "—");
      linhaDetalhe(dl, "Última notícia", quando(d.ultimaVez));
      linhaDetalhe(dl, "Mudanças de rota", `${d.mudancasDeRota}${d.ultimaMudancaRotaEm ? ` (última em ${quando(d.ultimaMudancaRotaEm)})` : ""}`);
      linhaDetalhe(dl, "Entregas", `${d.entregas.enviados} enviadas, ${d.entregas.confirmados} confirmadas, ${d.entregas.falhas} falhas, ${d.entregas.pendentes} pendentes`);
      linhaDetalhe(dl, "Quadros recusados", `${d.rejeitados} inválidos, ${d.duplicados} repetidos`);
      linhaDetalhe(dl, "Atualização OTA", "indisponível pela malha; conecte a placa diretamente para atualizar");
    } else {
      linhaDetalhe(dl, "Transporte", item.tipo === "gateway" ? "Wi-Fi direto; gateway da malha" : "Wi-Fi direto");
      linhaDetalhe(dl, "Canal de comandos", d.canalComandos ? "pronto" : "indisponível");
      linhaDetalhe(dl, "Firmware", texto(d.fwVersao));
      linhaDetalhe(dl, "Sinal (RSSI)", typeof d.rssi === "number" ? `${d.rssi} dBm` : "—");
      linhaDetalhe(dl, "Conectado desde", quando(d.conectadoEm));
    }
    caixa.append(titulo, dl);
  }

  function selecionar(id) {
    selecionado = id;
    desenhar();
    const alvo = el("topoSvg").querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function resumir() {
    const aviso = el("topoAviso");
    const nos = dados.nos.length;
    const conectados = dados.nos.filter((n) => n.estado === "conectado").length;
    if (!dados.meshEmUso) {
      aviso.textContent = `Rede mesh não utilizada: todas as ${dados.diretos.length} placas conectadas estão no Wi-Fi direto.`;
    } else {
      aviso.textContent = `${dados.gateways.length} gateway(s), ${conectados} de ${nos} placa(s) da malha conectadas, ${dados.diretos.length} placa(s) no Wi-Fi direto.`;
    }
  }

  async function atualizar() {
    const resp = await Api.obterTopologia();
    if (!resp.ok) {
      el("topoAviso").textContent = resp.erro || "Não foi possível carregar a topologia.";
      return;
    }
    dados = resp;
    resumir();
    desenhar();
  }

  function aoAbrir() {
    aoFechar();
    atualizar();
    relogio = setInterval(atualizar, ATUALIZAR_MS);
  }

  function aoFechar() {
    if (relogio) clearInterval(relogio);
    relogio = null;
  }

  function ligar() {
    const svg = el("topoSvg");
    if (!svg) return;
    svg.addEventListener("click", (ev) => {
      const g = ev.target.closest("[data-id]");
      if (g) selecionar(g.getAttribute("data-id"));
    });
    svg.addEventListener("keydown", (ev) => {
      const g = ev.target.closest("[data-id]");
      if (g && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        selecionar(g.getAttribute("data-id"));
      }
    });
    el("topoFiltroTransporte").addEventListener("change", () => dados && desenhar());
    el("topoFiltroEstado").addEventListener("change", () => dados && desenhar());
  }

  ligar();
  return { aoAbrir, aoFechar };
})();
