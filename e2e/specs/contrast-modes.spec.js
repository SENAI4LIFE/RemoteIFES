const { test, expect, VIEWPORTS, injetarSessao, despublicarApkFixture } = require("../harness/fixtures");

// Text contrast (WCAG 2.x: 4.5:1; 3:1 for large text) measured on the computed colors of every
// visible text, in the light theme and in high contrast. Accent colors, pastel warning/error tones
// and neutral surfaces come from shared variables: in high contrast they switch together, with no
// per-screen overrides.

// Runs inside the page: returns the texts whose contrast with the background is below the minimum.
function varrerContraste(raizSel) {
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const razao = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const mistura = (topo, base) => ({ r: topo.r * topo.a + base.r * (1 - topo.a), g: topo.g * topo.a + base.g * (1 - topo.a), b: topo.b * topo.a + base.b * (1 - topo.a), a: 1 });
  // Stacks backgrounds up to the first opaque one; gradients and images invalidate the measurement.
  const fundoDe = (el) => {
    const camadas = [];
    let e = el;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { camadas.push(c); if (c.a >= 1) break; }
      e = e.parentElement;
    }
    let cor = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = camadas.length - 1; i >= 0; i -= 1) cor = camadas[i].a >= 1 ? camadas[i] : mistura(camadas[i], cor);
    return cor;
  };
  const seletor = (el) => {
    const partes = [];
    let e = el;
    while (e && e !== document.body && partes.length < 4) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      else if (e.classList.length) p += `.${Array.from(e.classList).slice(0, 2).join(".")}`;
      partes.unshift(p);
      e = e.parentElement;
    }
    return partes.join(" > ");
  };
  const raiz = raizSel ? document.querySelector(raizSel) : document.body;
  if (!raiz) return { erro: `raiz ${raizSel} não encontrada`, achados: [], textos: 0 };
  const achados = [];
  const vistos = new Set();
  const andarilho = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  let no;
  while ((no = andarilho.nextNode())) {
    const texto = no.textContent.replace(/\s+/g, " ").trim();
    if (!texto) continue;
    const el = no.parentElement;
    if (!el || vistos.has(el)) continue;
    vistos.add(el);
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TITLE"].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (!el.checkVisibility || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const cs = getComputedStyle(el);
    if (cs.opacity === "0") continue;
    const cor = parse(cs.color);
    if (!cor || cor.a === 0) continue;
    const fundo = fundoDe(el);
    if (!fundo) continue;
    const corFinal = cor.a >= 1 ? cor : mistura(cor, fundo);
    const tamanho = parseFloat(cs.fontSize);
    const negrito = parseInt(cs.fontWeight, 10) >= 700;
    const grande = tamanho >= 24 || (negrito && tamanho >= 18.66);
    const minimo = grande ? 3 : 4.5;
    const rz = razao(corFinal, fundo);
    if (rz < minimo) achados.push({ sel: seletor(el), texto: texto.slice(0, 40), cor: cs.color, fundo: `rgb(${Math.round(fundo.r)}, ${Math.round(fundo.g)}, ${Math.round(fundo.b)})`, razao: Math.round(rz * 100) / 100, minimo });
  }
  return { achados, textos: vistos.size };
}

const ALTO_CONTRASTE = { remoteifes_high_contrast: "1" };

async function abrir(page, context, papel, rota, ajustes, seletor) {
  if (papel) await injetarSessao(context, papel);
  await context.addInitScript((chaves) => {
    try {
      Object.entries(chaves).forEach(([k, v]) => window.localStorage.setItem(k, v));
    } catch (e) {}
  }, ajustes);
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto(rota);
  await expect(page.locator(seletor).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function esperarContraste(page, raiz, rotulo) {
  const resultado = await page.evaluate(varrerContraste, raiz || null);
  expect(resultado.textos, `${rotulo}: there is text to measure`).toBeGreaterThan(0);
  const lista = resultado.achados.map((a) => `${a.razao}:1 (mín ${a.minimo}) ${a.sel} «${a.texto}» ${a.cor} sobre ${a.fundo}`).join("\n");
  expect(resultado.achados, `${rotulo}: texts below the minimum contrast:\n${lista}`).toEqual([]);
}

// Screens and states visited in both modes. `raiz` restricts the measurement to the open layer.
const TELAS = [
  { nome: "portal", papel: null, rota: "/", seletor: "#screen-portal" },
  { nome: "login", papel: null, rota: "/", seletor: "#screen-portal", preparar: async (page) => { await page.locator('.portal-option[data-tipo="admin"]').click(); await expect(page.locator("#screen-login")).toBeVisible(); } },
  { nome: "início do superadmin (faixa de saúde)", papel: "superadmin", rota: "/#/inicio", seletor: "#hubResumo" },
  { nome: "blocos e andares", papel: "user", rota: "/#/salas", seletor: "#screen-simple", preparar: async (page) => { await page.evaluate(() => SimpleWizard.irParaBloco()); await expect(page.locator("#simpleStepBloco")).toBeVisible(); } },
  { nome: "salas por estado", papel: "user", rota: "/#/salas/lista/A/1", seletor: "#roomList li" },
  { nome: "planta baixa", papel: "user", rota: "/#/salas/planta/a-terreo", seletor: "#fpScaleInner .room" },
  { nome: "painel da sala", papel: "user", rota: "/#/sala/A-108", seletor: "#screen-panel" },
  { nome: "manual (notas e código)", papel: "superadmin", rota: "/#/ajuda/esp32-setup-ap", seletor: "#screen-manual", raiz: "#screen-manual", preparar: async (page) => { await expect(page.locator("#manualConteudo .manual-nota").first()).toBeVisible(); await expect(page.locator("#manualConteudo code").first()).toBeVisible(); } },
  { nome: "aplicativo sem APK publicado", papel: "user", rota: "/#/aplicativo", seletor: ".mobile-app-unavailable", raiz: "#screen-mobile-app", antes: async (request) => despublicarApkFixture(request) },
  { nome: "alertas (notificações)", papel: "admin", rota: "/#/admin/notificacoes", seletor: "#adminNotifList .notif-item" },
  { nome: "sino", papel: "admin", rota: "/#/admin", seletor: "#screen-admin", raiz: "#notifPanel", preparar: async (page) => { await page.locator("#notifBellBtn").click(); await expect(page.locator("#notifList li").first()).toBeVisible(); } },
  { nome: "status do sistema", papel: "superadmin", rota: "/#/admin/status/sistema", seletor: "#monGrid .mon-card" },
  { nome: "mapa de status", papel: "admin", rota: "/#/admin/status/mapa", seletor: "div.mapa-cell" },
  { nome: "menu da conta", papel: "user", rota: "/#/inicio", seletor: "#screen-inicio", raiz: "#accountMenu", preparar: async (page) => { await page.locator("#accountMenuBtn").click(); await expect(page.locator("#accountMenu")).toBeVisible(); } },
  { nome: "painel de relatos", papel: "superadmin", rota: "/#/inicio", seletor: "#screen-inicio", raiz: "#relatosPanel", preparar: async (page) => { await page.locator("#bugReportBtn").click(); await expect(page.locator("#relatosPanel")).toBeVisible(); } },
  { nome: "painel de ajuda", papel: "superadmin", rota: "/#/inicio", seletor: "#screen-inicio", raiz: "#helpFabPanel", preparar: async (page) => { await page.locator("#helpFabToggleBtn").click(); await expect(page.locator("#helpFabLinks a, #helpFabLinks button").first()).toBeVisible(); } },
  { nome: "painel de acessibilidade", papel: "user", rota: "/#/inicio", seletor: "#screen-inicio", raiz: "#a11yPanel", preparar: async (page) => { await page.locator("#a11yToggleBtn").click(); await expect(page.locator("#a11yPanel")).toBeVisible(); } },
];

for (const [modo, ajustes] of [["tema claro", {}], ["alto contraste", ALTO_CONTRASTE]]) {
  for (const tela of TELAS) {
    test(`${tela.nome}: every visible text meets the minimum contrast in ${modo}`, async ({ page, context, request }) => {
      if (tela.antes) await tela.antes(request);
      await abrir(page, context, tela.papel, tela.rota, ajustes, tela.seletor);
      if (ajustes.remoteifes_high_contrast) await expect(page.locator("body")).toHaveClass(/a11y-high-contrast/);
      if (tela.preparar) await tela.preparar(page);
      await esperarContraste(page, tela.raiz, `${tela.nome} em ${modo}`);
    });
  }
}

// The pairs flagged in audits, measured directly.
test("the pairs flagged in audits stay above the minimum in both modes", async ({ page, context }) => {
  const medir = (seletor) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { cor: cs.color, fundo: (() => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg; e = e.parentElement; } return "rgb(255, 255, 255)"; })() };
  }, seletor);
  const razao = (a, b) => {
    const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const l1 = lum(parse(a)), l2 = lum(parse(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  await abrir(page, context, "user", "/#/salas/lista/A/1", {}, "#roomList li");
  const offline = await medir(".status-badge.off");
  expect(offline, "there is an offline badge in the list").not.toBeNull();
  expect(razao(offline.cor, offline.fundo), "offline badge in the light theme").toBeGreaterThanOrEqual(4.5);

  await page.goto("/#/salas/planta/a-terreo");
  await expect(page.locator("#fpScaleInner .corridor").first()).toBeVisible();
  const corredor = await medir("#fpScaleInner .fp-section:not(.hidden) .corridor");
  expect(razao(corredor.cor, corredor.fundo), "CORREDOR label").toBeGreaterThanOrEqual(4.5);

  await page.goto("/#/inicio");
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  const fechar = await medir("#relatosPanel .relatos-fechar-btn");
  expect(razao(fechar.cor, fechar.fundo), "reports panel close button").toBeGreaterThanOrEqual(4.5);
});

test("in high contrast the top bar, floor plan labels and muted badges are legible", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "/#/salas/planta/a-terreo", ALTO_CONTRASTE, "#fpScaleInner .room");
  const medida = await page.evaluate(() => {
    const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const razao = (a, b) => { const l1 = lum(parse(a)), l2 = lum(parse(b)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const par = (el, fundoEl) => razao(getComputedStyle(el).color, getComputedStyle(fundoEl || el).backgroundColor);
    const salaOffline = document.querySelector("#fpScaleInner .fp-section:not(.hidden) .room.fp-offline .num");
    const salaDesligada = document.querySelector("#fpScaleInner .fp-section:not(.hidden) .room.fp-online-desligado .num");
    const titulo = document.querySelector(".home-btn-title");
    const timer = document.getElementById("accountSessionTimer");
    const avatar = document.getElementById("accountMenuBtn");
    const topbar = document.querySelector(".topbar");
    return {
      salaOffline: salaOffline ? par(salaOffline, salaOffline.parentElement) : null,
      salaDesligada: salaDesligada ? par(salaDesligada, salaDesligada.parentElement) : null,
      titulo: par(titulo, topbar),
      timer: par(timer, topbar),
      avatar: par(avatar, avatar),
      fabAjuda: par(document.getElementById("helpFabToggleBtn")),
      fabA11y: par(document.getElementById("a11yToggleBtn")),
    };
  });
  expect(medida.salaOffline, "offline room label on the floor plan").toBeGreaterThanOrEqual(4.5);
  expect(medida.salaDesligada, "turned-off room label on the floor plan").toBeGreaterThanOrEqual(4.5);
  expect(medida.titulo, "top bar title").toBeGreaterThanOrEqual(4.5);
  expect(medida.timer, "session timer").toBeGreaterThanOrEqual(4.5);
  expect(medida.avatar, "avatar initials").toBeGreaterThanOrEqual(4.5);
  expect(medida.fabAjuda, "floating help button").toBeGreaterThanOrEqual(4.5);
  expect(medida.fabA11y, "floating accessibility button (currentColor icon)").toBeGreaterThanOrEqual(3);
});
