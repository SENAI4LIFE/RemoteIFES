// Draws the connectors of a composed figure after CSS has laid it out. Each composition declares
// window.CONECTORES; this script turns them into orthogonal SVG paths with arrowheads and labels,
// anchored on the element boxes, so a longer label or a moved card never needs new coordinates.
//
// Connector fields:
//   de, para       CSS selectors of the two ends
//   lados          [side of `de`, side of `para`]: "direita" | "esquerda" | "topo" | "base"
//   em             [position along each side, 0..1] (default 0.5)
//   estilo         "solido" | "tracejado" (optional path) | "tunel" (sealed session band) | "radio"
//   pontas         "fim" | "inicio" | "ambas" | "nenhuma" (default "fim")
//   tom            name of a tone variable: "verde", "azul", "petroleo", ... (default: --linha)
//   eixo           fixed x (horizontal sides) or y (vertical sides) of the bend, in figure px
//   reto           vertical sides only: end directly above/below the start (a straight line)
//   rotulo         text placed on the path, at fraction `noRotulo` of its length (default 0.5)
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const SETA = 9;
  const FOLGA = 3;
  const RAIO = 10;

  function ancora(tela, el, lado, fracao) {
    const t = tela.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x0 = r.left - t.left - tela.clientLeft;
    const y0 = r.top - t.top - tela.clientTop;
    const f = fracao ?? 0.5;
    if (lado === "direita") return { x: x0 + r.width + FOLGA, y: y0 + r.height * f, dir: [1, 0] };
    if (lado === "esquerda") return { x: x0 - FOLGA, y: y0 + r.height * f, dir: [-1, 0] };
    if (lado === "topo") return { x: x0 + r.width * f, y: y0 - FOLGA, dir: [0, -1] };
    return { x: x0 + r.width * f, y: y0 + r.height + FOLGA, dir: [0, 1] };
  }

  function rota(a, b, eixo) {
    const horizA = a.dir[1] === 0;
    const horizB = b.dir[1] === 0;
    if (horizA && horizB) {
      if (Math.abs(a.y - b.y) < 0.5) return [a, b];
      const x = eixo ?? (a.x + b.x) / 2;
      return [a, { x, y: a.y }, { x, y: b.y }, b];
    }
    if (!horizA && !horizB) {
      if (Math.abs(a.x - b.x) < 0.5) return [a, b];
      const y = eixo ?? (a.y + b.y) / 2;
      return [a, { x: a.x, y }, { x: b.x, y }, b];
    }
    return horizA ? [a, { x: b.x, y: a.y }, b] : [a, { x: a.x, y: b.y }, b];
  }

  function encurtar(p, q, d) {
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: p.x + ((q.x - p.x) / len) * d, y: p.y + ((q.y - p.y) / len) * d };
  }

  function caminho(pts) {
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const ant = pts[i - 1];
      const p = pts[i];
      const prox = pts[i + 1];
      const r = Math.min(RAIO, Math.hypot(p.x - ant.x, p.y - ant.y) / 2, Math.hypot(prox.x - p.x, prox.y - p.y) / 2);
      const e = encurtar(p, ant, r);
      const s = encurtar(p, prox, r);
      d += ` L ${e.x} ${e.y} Q ${p.x} ${p.y} ${s.x} ${s.y}`;
    }
    const u = pts[pts.length - 1];
    return d + ` L ${u.x} ${u.y}`;
  }

  function pontoNoCaminho(pts, fracao) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      segs.push(l);
      total += l;
    }
    let alvo = total * fracao;
    for (let i = 0; i < segs.length; i++) {
      if (alvo <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? Math.min(1, alvo / segs[i]) : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
      }
      alvo -= segs[i];
    }
    return pts[0];
  }

  function seta(svg, ponta, anterior, cor) {
    const len = Math.hypot(ponta.x - anterior.x, ponta.y - anterior.y) || 1;
    const ux = (ponta.x - anterior.x) / len;
    const uy = (ponta.y - anterior.y) / len;
    const bx = ponta.x - ux * SETA;
    const by = ponta.y - uy * SETA;
    const px = -uy * (SETA * 0.5);
    const py = ux * (SETA * 0.5);
    const tri = document.createElementNS(NS, "path");
    tri.setAttribute("d", `M ${ponta.x} ${ponta.y} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`);
    tri.setAttribute("fill", cor);
    svg.appendChild(tri);
  }

  window.desenharConectores = function desenharConectores() {
    const tela = document.getElementById("tela");
    const svg = document.createElementNS(NS, "svg");
    svg.id = "conectores";
    const fundo = document.createElementNS(NS, "g");
    const frente = document.createElementNS(NS, "g");
    svg.append(fundo, frente);
    tela.appendChild(svg);
    svg.setAttribute("width", tela.clientWidth);
    svg.setAttribute("height", tela.clientHeight);

    for (const c of window.CONECTORES || []) {
      const de = tela.querySelector(c.de);
      const para = tela.querySelector(c.para);
      if (!de || !para) throw new Error(`connector end not found: ${c.de} -> ${c.para}`);
      const [ladoA, ladoB] = c.lados;
      const [emA, emB] = c.em || [];
      const a = ancora(tela, de, ladoA, emA);
      const b = ancora(tela, para, ladoB, emB);
      if (c.reto) b.x = a.x;
      const pts = rota(a, b, c.eixo);
      const cor = c.tom ? `var(--${c.tom})` : "var(--linha)";
      const pontas = c.pontas || "fim";
      const estilo = c.estilo || "solido";

      if (estilo === "tunel") {
        const banda = document.createElementNS(NS, "path");
        banda.setAttribute("d", caminho(pts));
        banda.setAttribute("fill", "none");
        banda.setAttribute("stroke", cor);
        banda.setAttribute("stroke-opacity", "0.28");
        banda.setAttribute("stroke-width", "12");
        banda.setAttribute("stroke-linecap", "round");
        banda.setAttribute("stroke-linejoin", "round");
        fundo.appendChild(banda);
      } else {
        const desenho = pts.map((p) => ({ x: p.x, y: p.y }));
        if (pontas === "fim" || pontas === "ambas") desenho[desenho.length - 1] = encurtar(pts[pts.length - 1], pts[pts.length - 2], SETA - 1);
        if (pontas === "inicio" || pontas === "ambas") desenho[0] = encurtar(pts[0], pts[1], SETA - 1);
        const linha = document.createElementNS(NS, "path");
        linha.setAttribute("d", caminho(desenho));
        linha.setAttribute("fill", "none");
        linha.setAttribute("stroke", cor);
        linha.setAttribute("stroke-width", estilo === "radio" ? "2.2" : "2");
        linha.setAttribute("stroke-linecap", "round");
        linha.setAttribute("stroke-linejoin", "round");
        if (estilo === "tracejado") linha.setAttribute("stroke-dasharray", "6 5");
        if (estilo === "radio") linha.setAttribute("stroke-dasharray", "0.1 5");
        frente.appendChild(linha);
        if (pontas === "fim" || pontas === "ambas") seta(frente, pts[pts.length - 1], pts[pts.length - 2], cor);
        if (pontas === "inicio" || pontas === "ambas") seta(frente, pts[0], pts[1], cor);
      }

      if (c.rotulo) {
        const p = pontoNoCaminho(pts, c.noRotulo ?? 0.5);
        const r = document.createElement("div");
        r.className = "rotulo-conector" + (c.classeRotulo ? ` ${c.classeRotulo}` : "");
        r.innerHTML = c.rotulo;
        r.style.left = `${p.x + (c.desvioRotulo?.[0] || 0)}px`;
        r.style.top = `${p.y + (c.desvioRotulo?.[1] || 0)}px`;
        if (c.tomRotulo) r.style.color = `var(--${c.tomRotulo})`;
        tela.appendChild(r);
      }
    }
  };
})();
