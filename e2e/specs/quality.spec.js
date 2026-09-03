const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

const ADMIN_COMUM = ["usuarios", "proprietarios", "sessoes", "ativos", "mapa", "dispositivos", "notificacoes", "logs"];
const SUPERADMIN = [...ADMIN_COMUM, "relatos", "macs", "esp32", "monitoramento", "config", "auditoria"];

for (const [papel, subtabs] of [["admin", ADMIN_COMUM], ["superadmin", SUPERADMIN]]) {
  for (const viewport of ["mobile-compact", "desktop-compact"]) {
    test(`${papel}: todas as subtelas administrativas carregam sem erro ou overflow em ${viewport}`, async ({ page, context }) => {
      await injetarSessao(context, papel);
      await page.setViewportSize(VIEWPORTS[viewport]);
      const erros = [];
      page.on("pageerror", (erro) => erros.push(`pageerror: ${erro.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") erros.push(`console: ${msg.text()}`);
      });
      page.on("response", (res) => {
        if (res.status() >= 400) erros.push(`http ${res.status()}: ${res.url()}`);
      });

      for (const subtab of subtabs) {
        await page.goto(`/#/admin/${subtab}`);
        await expect(page.locator(`#adminSub-${subtab}`)).toBeVisible({ timeout: 20_000 });
        expect(await semRolagemHorizontal(page), `${subtab} sem rolagem horizontal`).toBe(true);
      }

      expect(erros).toEqual([]);
    });
  }
}

test("controles interativos visíveis têm nome acessível e alvo mínimo no celular", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.setViewportSize(VIEWPORTS["mobile-compact"]);
  await page.goto("/#/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });

  const problemas = await page.locator("button:visible, a:visible, input:visible, select:visible, textarea:visible").evaluateAll((elementos) => elementos.flatMap((el) => {
    const rect = el.getBoundingClientRect();
    const nome = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.value || "").trim();
    const id = el.id || el.getAttribute("data-action") || el.getAttribute("data-tab") || el.tagName.toLowerCase();
    const resultado = [];
    if (!nome) resultado.push(`${id}: sem nome acessível`);
    if (rect.width < 24 || rect.height < 24) resultado.push(`${id}: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    return resultado;
  }));

  expect(problemas).toEqual([]);
});

test("métricas locais da tela inicial permanecem nos alvos de Core Web Vitals", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await context.addInitScript(() => {
    window.__metricasRemIFES = { lcp: 0, cls: 0, inp: 0 };
    new PerformanceObserver((lista) => {
      const entradas = lista.getEntries();
      if (entradas.length) window.__metricasRemIFES.lcp = entradas[entradas.length - 1].startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((lista) => {
      for (const entrada of lista.getEntries()) if (!entrada.hadRecentInput) window.__metricasRemIFES.cls += entrada.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((lista) => {
      for (const entrada of lista.getEntries()) window.__metricasRemIFES.inp = Math.max(window.__metricasRemIFES.inp, entrada.duration);
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  });
  await page.goto("/#/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await page.locator("#accountMenuBtn").click();
  await expect(page.locator("#accountMenu")).toBeVisible();
  await page.waitForTimeout(500);
  const metricas = await page.evaluate(() => window.__metricasRemIFES);
  expect(metricas.lcp).toBeLessThanOrEqual(2500);
  expect(metricas.cls).toBeLessThanOrEqual(0.1);
  expect(metricas.inp).toBeLessThanOrEqual(200);
});
