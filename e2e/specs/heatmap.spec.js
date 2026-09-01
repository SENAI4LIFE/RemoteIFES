const { test, expect, VIEWPORTS, API_URL, injetarSessao, tokenDe, semRolagemHorizontal } = require("../harness/fixtures");

async function abrirMonitoramento(page, context, papel = "superadmin", tamanho = VIEWPORTS.notebook) {
  await injetarSessao(context, papel);
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/monitoramento");
  // Garante documento novo mesmo quando so o fragmento mudaria.
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

async function abrirHeatmap(page) {
  await expect(page.locator("#heatmapBloco")).toBeVisible({ timeout: 15_000 });
  await page.locator(".heatmap-summary").first().click();
  await expect.poll(() => page.locator("#heatmapBloco").evaluate((el) => el.open)).toBe(true);
  await expect.poll(() => page.locator("#heatmapTabelaCorpo tr").count(), { timeout: 20_000 }).toBeGreaterThan(0);
}

test("o mapa de calor é exclusivo do superadministrador", async ({ page, context, request }) => {
  for (const [papel, status] of [["user", 403], ["admin", 403], ["superadmin", 200]]) {
    const resp = await request.get(`${API_URL}/admin/heatmap?metrica=comandos&periodo=24h`, {
      headers: { Authorization: `Bearer ${tokenDe(papel)}` },
    });
    expect(resp.status(), `HTTP para ${papel}`).toBe(status);
  }

  // O administrador comum nem chega a ver a aba que hospeda a secao.
  await abrirMonitoramento(page, context, "admin");
  await expect(page.locator('.admin-subtab-btn[data-sub="monitoramento"]')).toBeHidden();
  await expect(page.locator("#heatmapBloco")).toBeHidden();
});

test("nada é calculado antes de a seção ser aberta", async ({ page, context }) => {
  const chamadas = [];
  await page.route("**/admin/heatmap*", (rota) => {
    chamadas.push(rota.request().url());
    return rota.continue();
  });

  await abrirMonitoramento(page, context);
  await expect(page.locator("#heatmapBloco")).toBeVisible({ timeout: 15_000 });
  // Monitoramento atualiza a cada 20 s; o mapa de calor fechado nao deve acompanhar.
  await page.waitForTimeout(3000);
  expect(chamadas, "consulta emitida com a seção fechada").toEqual([]);

  await abrirHeatmap(page);
  expect(chamadas.length).toBe(1);

  // Sem polling: a secao aberta e parada nao dispara novas consultas.
  await page.waitForTimeout(4000);
  expect(chamadas.length).toBe(1);
});

test("métrica e período recalculam o mapa e refletem no cabeçalho da tabela", async ({ page, context }) => {
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

test("cada sala do mapa recebe o valor da sala correspondente", async ({ page, context }) => {
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

test("a escala de cor cobre frio a quente e o estado Sem dados é distinto", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await abrirHeatmap(page);

  // Disponibilidade: metrica onde maior e melhor, com inversao explicita na legenda.
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

test("clicar em uma sala mostra métrica, período e números dela", async ({ page, context }) => {
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

test("o mapa de calor é responsivo e não cria rolagem horizontal na página", async ({ page, context }) => {
  for (const nome of ["mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
    await abrirMonitoramento(page, context, "superadmin", VIEWPORTS[nome]);
    await abrirHeatmap(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await semRolagemHorizontal(page), `rolagem horizontal em ${nome}`).toBe(true);
    const dentro = await page.locator("#heatmapBloco").evaluate((el) => {
      const p = el.parentElement.getBoundingClientRect();
      return el.getBoundingClientRect().right <= p.right + 2;
    });
    expect(dentro, `mapa de calor dentro do container em ${nome}`).toBe(true);
  }
});

test("a seção fecha ao sair do Monitoramento e não recalcula sozinha", async ({ page, context }) => {
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
