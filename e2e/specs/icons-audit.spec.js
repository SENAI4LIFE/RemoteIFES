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
