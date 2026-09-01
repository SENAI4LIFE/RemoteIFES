const { test, expect, API_URL, tokenDe, injetarSessao, VIEWPORTS, semRolagemHorizontal } = require("../harness/fixtures");

test("API de Energia é exclusiva do superadmin", async ({ request }) => {
  expect((await request.get(`${API_URL}/admin/energia`)).status()).toBe(401);
  expect((await request.get(`${API_URL}/admin/energia`, { headers: { Authorization: `Bearer ${tokenDe("user")}` } })).status()).toBe(403);
  expect((await request.get(`${API_URL}/admin/energia`, { headers: { Authorization: `Bearer ${tokenDe("admin")}` } })).status()).toBe(403);
  expect((await request.get(`${API_URL}/admin/energia`, { headers: { Authorization: `Bearer ${tokenDe("superadmin")}` } })).status()).toBe(200);
});

test("configuração energética persiste e permanece separada do controle", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/energia");
  await expect(page.locator("#adminSub-energia")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".energy-estimate-banner")).toContainText("não medições para faturamento");
  await expect(page.locator(".energy-estimate-banner")).toContainText("não capacidade térmica em BTU/h");
  const linha = page.locator('#energyTableBody tr[data-sala="A-108"]');
  await expect(linha).toBeVisible();
  await linha.locator(".energy-watts").fill("1350");
  await linha.locator(".energy-type").selectOption("inverter");
  await linha.locator(".energy-save").click();
  await expect(page.locator("#energySummary")).toContainText("1 de");
  await page.reload();
  await expect(page.locator("#adminSub-energia")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#energyTableBody tr[data-sala="A-108"] .energy-watts')).toHaveValue("1350");
  await expect(page.locator("#btnPower")).toBeHidden();
});

test("seletor da Energia contém somente métricas energéticas", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/energia");
  await expect(page.locator("#energyMetric")).toBeVisible({ timeout: 20_000 });
  const texto = await page.locator("#energyMetric option").allTextContents();
  expect(texto.join(" ")).toContain("Consumo estimado");
  expect(texto.join(" ")).toContain("Carga atual estimada");
  expect(texto.join(" ")).not.toContain("indisponibilidade");
  expect(texto.join(" ")).not.toContain("relatos");
  expect(texto.join(" ")).not.toContain("falhas");
  await page.locator('.admin-subtab-btn[data-sub="mapa"]').click();
  await expect(page.locator("#adminSub-mapa")).toBeVisible();
  await expect(page.locator("#energyMetric")).toBeHidden();
});

test("tabela de Energia omite cobertura e placeholders redundantes", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/energia");
  await expect(page.locator("#energyTableBody tr").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".energy-table thead th")).toHaveText(["Sala / configuração", "Agora", "Hoje", "7 dias", "30 dias"]);
  await expect(page.locator(".energy-table")).not.toContainText("Confiança");
  await expect(page.locator(".energy-table")).not.toContainText("telemetria");
  const textos = await page.locator("#energyTableBody strong, #energyTableBody span").allTextContents();
  expect(textos.some((texto) => /^—(?:\s|$)/.test(texto.trim()))).toBe(false);
  await expect(page.locator("#energyTableBody")).toContainText("Potência não configurada");
  expect(await page.locator('#energyFpInner .room[title*="confiança"]').count()).toBe(0);
});

test("admin comum não abre Energia por URL direta", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/admin/energia");
  await expect(page.locator("#adminSub-usuarios")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-btn[data-sub="energia"]')).toBeHidden();
});

for (const nome of ["mobile-compact", "tablet-portrait", "desktop-compact"]) {
  test(`Energia permanece responsiva em ${nome}`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/energia");
    await expect(page.locator("#adminSub-energia")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#energyFpInner .room.selectable").first()).toBeVisible();
    expect(await semRolagemHorizontal(page)).toBe(true);
    const tabela = page.locator(".energy-table-wrap");
    const rolavel = await tabela.evaluate((el) => el.scrollWidth >= el.clientWidth);
    expect(rolavel).toBe(true);
  });
}

for (const nome of ["notebook", "desktop-compact", "desktop"]) {
  test(`todas as colunas de Energia ficam alcançáveis em ${nome}`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/energia");
    await expect(page.locator("#energyTableBody tr").first()).toBeVisible({ timeout: 20_000 });
    const geometria = await page.locator(".energy-table-wrap").evaluate((wrap) => {
      const area = wrap.getBoundingClientRect();
      const content = wrap.closest(".admin-content").getBoundingClientRect();
      const ultimaCelula = wrap.querySelector("tbody tr td:last-child").getBoundingClientRect();
      const larguras = Array.from(wrap.querySelectorAll("thead th"), (th) => th.getBoundingClientRect().width);
      const celulasContidas = Array.from(wrap.querySelectorAll("tbody td"), (td) => td.scrollWidth <= td.clientWidth + 1).every(Boolean);
      return {
        overflow: getComputedStyle(wrap).overflowX,
        semRolagem: wrap.scrollWidth <= wrap.clientWidth + 1,
        ultimaCelulaVisivel: ultimaCelula.left >= area.left - 1 && ultimaCelula.right <= area.right + 1,
        contidoNoWorkspace: area.left >= content.left - 1 && area.right <= content.right + 1,
        menorColuna: Math.min(...larguras),
        celulasContidas,
      };
    });
    expect(geometria.overflow).toBe("auto");
    expect(geometria.semRolagem).toBe(true);
    expect(geometria.ultimaCelulaVisivel).toBe(true);
    expect(geometria.contidoNoWorkspace).toBe(true);
    expect(geometria.menorColuna).toBeGreaterThan(80);
    expect(geometria.celulasContidas).toBe(true);
    expect(await semRolagemHorizontal(page)).toBe(true);
  });
}
