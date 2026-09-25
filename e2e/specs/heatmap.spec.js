const { test, expect, VIEWPORTS, API_URL, injetarSessao, tokenDe, semRolagemHorizontal } = require("../harness/fixtures");

async function abrirMonitoramento(page, context, papel = "superadmin", tamanho = VIEWPORTS.notebook) {
  await injetarSessao(context, papel);
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/monitoramento");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

async function abrirHeatmap(page) {
  await expect(page.locator("#heatmapBloco")).toBeVisible({ timeout: 15_000 });
  await page.locator(".heatmap-summary").first().click();
  await expect.poll(() => page.locator("#heatmapBloco").evaluate((el) => el.open)).toBe(true);
  await expect.poll(() => page.locator("#heatmapTabelaCorpo tr").count(), { timeout: 20_000 }).toBeGreaterThan(0);
}

test("the heatmap is superadministrator-only", async ({ page, context, request }) => {
  for (const [papel, status] of [["user", 403], ["admin", 403], ["superadmin", 200]]) {
    const resp = await request.get(`${API_URL}/admin/heatmap?metrica=comandos&periodo=24h`, {
      headers: { Authorization: `Bearer ${tokenDe(papel)}` },
    });
    expect(resp.status(), `HTTP for ${papel}`).toBe(status);
  }

  await abrirMonitoramento(page, context, "admin");
  await expect(page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]')).toBeHidden();
  await expect(page.locator("#heatmapBloco")).toBeHidden();
});

test("nothing is computed before the section is opened", async ({ page, context }) => {
  const chamadas = [];
  await page.route("**/admin/heatmap*", (rota) => {
    chamadas.push(rota.request().url());
    return rota.continue();
  });

  await abrirMonitoramento(page, context);
  await expect(page.locator("#heatmapBloco")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3000);
  expect(chamadas, "query issued with the section closed").toEqual([]);

  await abrirHeatmap(page);
  expect(chamadas.length).toBe(1);

  await page.waitForTimeout(4000);
  expect(chamadas.length).toBe(1);
});

test("metric and period recompute the map and are reflected in the table header", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);

  const legenda = () => page.locator("#heatmapTabelaCaption").innerText();
  await expect(page.locator("#heatmapTabelaCaption")).toContainText("Disponibilidade do ESP32");
  await expect(page.locator("#heatmapTabelaCaption")).toContainText("7 dias");

  await page.locator("#heatmapPeriodo").selectOption("24h");
  await expect.poll(legenda, { timeout: 15_000 }).toContain("24 horas");

  await page.locator("#heatmapMetrica").selectOption("comandos");
  await expect.poll(legenda, { timeout: 15_000 }).toContain("Comandos enviados");
  await expect(page.locator("#heatmapDescricao")).toContainText("Comandos registrados para a sala");

  await page.locator("#heatmapPeriodo").selectOption("30d");
  await expect.poll(legenda, { timeout: 15_000 }).toContain("30 dias");
});

test("each room on the map receives the value of the matching room", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);
  await page.locator("#heatmapMetrica").selectOption("comandos");
  await expect.poll(() => page.locator("#heatmapTabelaCaption").innerText(), { timeout: 15_000 }).toContain("Comandos enviados");

  const conferencia = await page.evaluate(() => {
    const daTabela = new Map();
    document.querySelectorAll("#heatmapTabelaCorpo tr").forEach((tr) => {
      daTabela.set(tr.dataset.sala, tr.querySelector("td").textContent.trim());
    });
    const divergencias = [];
    let comparadas = 0;
    document.querySelectorAll("#heatmapFpInner .room.selectable").forEach((el) => {
      const sala = el.dataset.sala;
      const noMapa = el.querySelector(".heatmap-valor");
      if (!daTabela.has(sala) || !noMapa) return;
      comparadas += 1;
      const esperado = daTabela.get(sala) === "Sem dados" ? "sem dados" : daTabela.get(sala);
      if (noMapa.textContent.trim() !== esperado) divergencias.push(`${sala}: ${noMapa.textContent.trim()} != ${esperado}`);
      if (!el.getAttribute("aria-label") || !el.getAttribute("aria-label").includes(sala)) divergencias.push(`${sala} sem equivalente textual`);
    });
    return { comparadas, divergencias };
  });
  expect(conferencia.comparadas).toBeGreaterThan(10);
  expect(conferencia.divergencias).toEqual([]);
});

test("the color scale covers cold to hot and the Sem dados state is distinct", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);

  await expect(page.locator("#heatmapLegendaMin")).toContainText("melhor");
  await expect(page.locator("#heatmapLegendaMax")).toContainText("pior");
  await expect(page.locator(".heatmap-escala")).toBeVisible();
  await expect(page.locator(".heatmap-legenda-chave")).toContainText("sem dados");

  const estado = await page.evaluate(() => {
    const salas = [...document.querySelectorAll("#heatmapFpInner .room.selectable")];
    const classes = new Set();
    salas.forEach((s) => s.classList.forEach((c) => { if (c.startsWith("heatmap-")) classes.add(c); }));
    const semDados = salas.filter((s) => s.classList.contains("heatmap-sem-dados"));
    const comFaixa = salas.filter((s) => [...s.classList].some((c) => /^heatmap-f\d$/.test(c)));
    return {
      classes: [...classes].sort(),
      semDados: semDados.length,
      comFaixa: comFaixa.length,
      textoSemDados: semDados.length ? semDados[0].querySelector(".heatmap-valor").textContent.trim() : null,
      fundoSemDados: semDados.length ? getComputedStyle(semDados[0]).backgroundImage : null,
    };
  });

  expect(estado.semDados + estado.comFaixa).toBeGreaterThan(10);
  if (estado.semDados) {
    expect(estado.textoSemDados).toBe("sem dados");
    expect(estado.fundoSemDados).toContain("gradient");
  }
  expect(estado.classes.some((c) => /^heatmap-f\d$/.test(c) || c === "heatmap-sem-dados")).toBe(true);
});

test("clicking a room shows its metric, period and numbers", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);

  const primeira = page.locator("#heatmapFpInner .fp-section:not(.hidden) .room.selectable").first();
  const sala = await primeira.getAttribute("data-sala");
  await primeira.click();

  const detalhe = page.locator("#heatmapDetalhe");
  await expect(detalhe).toContainText(sala);
  await expect(detalhe).toContainText("Disponibilidade do ESP32");
  await expect(detalhe).toContainText("7 dias");
});

test("the heatmap is responsive and creates no horizontal page scroll", async ({ page, context }) => {
  for (const nome of ["mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
    await abrirMonitoramento(page, context, "superadmin", VIEWPORTS[nome]);
    await abrirHeatmap(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await semRolagemHorizontal(page), `horizontal scroll at ${nome}`).toBe(true);
    const dentro = await page.locator("#heatmapBloco").evaluate((el) => {
      const p = el.parentElement.getBoundingClientRect();
      return el.getBoundingClientRect().right <= p.right + 2;
    });
    expect(dentro, `heat map inside the container at ${nome}`).toBe(true);
  }
});

test("the section closes when leaving Monitoramento and does not recompute by itself", async ({ page, context }) => {
  const chamadas = [];
  await page.route("**/admin/heatmap*", (rota) => {
    chamadas.push(rota.request().url());
    return rota.continue();
  });
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);
  expect(chamadas.length).toBe(1);

  await page.locator('.admin-subtab-btn[data-sub="usuarios"]').click();
  await expect(page.locator("#adminSub-usuarios")).toBeVisible();
  expect(await page.locator("#heatmapBloco").evaluate((el) => el.open)).toBe(false);
  await page.waitForTimeout(2000);
  expect(chamadas.length).toBe(1);
});
