const { test, expect, injetarSessao, irParaSala } = require("../harness/fixtures");

for (const largura of [360, 1280]) {
  test(`sprite resolve no navegador em ${largura}px e mantém nomes e contraste`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize({ width: largura, height: 800 });
    await page.goto("/#/inicio");
    await expect(page.locator("#screen-inicio")).toBeVisible();
    const icones = await page.evaluate(() => {
      const erros = [];
      for (const use of document.querySelectorAll('use[href^="#i-"]')) {
        const id = use.getAttribute("href");
        if (!document.querySelector(id)) erros.push(id);
        const svg = use.closest("svg");
        if (svg.getAttribute("aria-hidden") !== "true" || svg.tabIndex >= 0) erros.push(`acessibilidade ${id}`);
        if (svg.getBoundingClientRect().width && !use.getBBox().width) erros.push(`vazio ${id}`);
      }
      return erros;
    });
    expect(icones).toEqual([]);
    await irParaSala(page, "A-108");
    await expect(page.locator("#btnPower")).toHaveAccessibleName("Ligar ou desligar o ar-condicionado");
    const topbar = page.locator(".icone-topbar:visible").first();
    await expect(topbar).toHaveCSS("fill", "rgb(255, 255, 255)");
    await page.goto("/#/admin/status/sistema");
    const summary = page.locator(".heatmap-summary").first();
    await expect(summary).toBeVisible();
    const marcador = () => summary.evaluate(el => {
      const css = getComputedStyle(el, "::after");
      return { content: css.content, transform: css.transform, border: css.borderRightWidth };
    });
    const fechado = await marcador();
    expect(fechado.content).toBe('""');
    expect(fechado.border).toBe("2px");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#heatmapBloco")).toHaveAttribute("open", "");
    expect((await marcador()).transform).not.toBe(fechado.transform);
    await page.evaluate(() => document.body.classList.add("a11y-high-contrast"));
    expect((await marcador()).border).toBe("2px");
    await page.emulateMedia({ forcedColors: "active" });
    expect((await marcador()).border).toBe("2px");
  });
}

const TONS = ["tom-operacao", "tom-info", "tom-atencao", "tom-critico", "tom-admin", "tom-dispositivo"];

async function auditarTons(page) {
  return page.evaluate((tons) => {
    const canal = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const luz = ([r, g, b]) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
    const partes = (cor) => (String(cor).match(/[\d.]+/g) || []).map(Number);
    const fundo = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const p = partes(getComputedStyle(n).backgroundColor);
        if (p.length >= 3 && (p.length < 4 || p[3] > 0.5)) return p.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const achados = { problemas: [], tons: {} };
    for (const svg of document.querySelectorAll("svg.icone")) {
      if (!svg.getBoundingClientRect().width) continue;
      const nome = svg.querySelector("use").getAttribute("href");
      const css = getComputedStyle(svg);
      if (css.fill !== css.color) achados.problemas.push(`${nome}: fill ${css.fill} não segue currentColor ${css.color}`);
      const tom = tons.find((t) => svg.classList.contains(t));
      if (!tom) continue;
      const razao = (() => {
        const a = luz(partes(css.color).slice(0, 3));
        const b = luz(fundo(svg));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      })();
      if (razao < 3) achados.problemas.push(`${tom} ${nome}: contraste ${razao.toFixed(2)}:1`);
      achados.tons[tom] = css.color;
    }
    return achados;
  }, TONS);
}

test("os tons semânticos pintam o glifo com contraste, no modo normal e no alto contraste", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  const vistos = new Set();

  for (const contraste of [false, true]) {
    for (const rota of ["/#/inicio", "/#/admin/usuarios", "/#/admin/config"]) {
      await page.goto(rota);
      await expect(page.locator(rota === "/#/inicio" ? "#screen-inicio" : "#screen-admin")).toBeVisible({ timeout: 20_000 });
      if (contraste) await page.evaluate(() => document.body.classList.add("a11y-high-contrast"));
      const { problemas, tons } = await auditarTons(page);
      expect(problemas, `${rota} (alto contraste: ${contraste})`).toEqual([]);
      Object.keys(tons).forEach((t) => vistos.add(t));
      const distintas = new Set(Object.values(tons));
      expect(distintas.size, `${rota} usa mais de um tom`).toBeGreaterThan(1);
    }
  }

  expect([...vistos].sort()).toEqual([...TONS].sort());
});

test("tela pública: os tons dos ícones sobrevivem ao alto contraste nas superfícies claras", async ({ appPage }) => {
  for (const contraste of [false, true]) {
    if (contraste) await appPage.evaluate(() => document.body.classList.add("a11y-high-contrast"));
    expect((await auditarTons(appPage)).problemas, `portal (alto contraste: ${contraste})`).toEqual([]);
    await appPage.locator('.portal-funcao[data-funcao="salas"]').click();
    await expect(appPage.locator(".portal-funcao.is-active")).toBeVisible();
    expect((await auditarTons(appPage)).problemas, `portal ativo (alto contraste: ${contraste})`).toEqual([]);
    await appPage.locator('.portal-funcao[data-funcao="salas"]').click();
  }

  await appPage.locator('.portal-option[data-tipo="normal"]').click();
  await expect(appPage.locator("#screen-login")).toBeVisible();
  expect((await auditarTons(appPage)).problemas, "login em alto contraste").toEqual([]);
});

test("barra superior e chips de status ficam fora do sistema de tons", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });

  const topo = await page.locator(".icone-topbar").evaluateAll((svgs, tons) => svgs.map((svg) => ({
    tom: tons.some((t) => svg.classList.contains(t)),
    fill: getComputedStyle(svg).fill,
  })), TONS);
  expect(topo.length).toBeGreaterThan(0);
  expect(topo.every((i) => !i.tom && i.fill === "rgb(255, 255, 255)")).toBe(true);

  await page.goto("/#/admin/status/sistema");
  const chips = page.locator(".status-chip:visible");
  await expect(chips.first()).toBeVisible({ timeout: 20_000 });
  const iguais = await chips.evaluateAll((els, tons) => els.map((chip) => {
    const svg = chip.querySelector("svg.icone");
    if (!svg) return true;
    return !tons.some((t) => svg.classList.contains(t)) && getComputedStyle(svg).color === getComputedStyle(chip).color;
  }), TONS);
  expect(iguais.every(Boolean)).toBe(true);
});
