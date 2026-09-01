const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

const TAMANHOS = {
  "mobile portrait": VIEWPORTS["mobile-portrait"],
  "mobile landscape": VIEWPORTS["mobile-landscape"],
  tablet: VIEWPORTS["tablet-portrait"],
  notebook: VIEWPORTS.notebook,
  desktop: VIEWPORTS.desktop,
};

async function abrir(page, context, rota, tamanho) {
  await injetarSessao(context, "superadmin");
  await page.setViewportSize(tamanho);
  await page.goto(rota);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

async function esperarLayout(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function verificarContainerCentralizado(page, seletor) {
  const medida = await page.locator(seletor).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      esquerda: rect.left,
      direita: document.documentElement.clientWidth - rect.right,
      largura: rect.width,
    };
  });
  expect(Math.abs(medida.esquerda - medida.direita), JSON.stringify(medida)).toBeLessThanOrEqual(1);
  expect(medida.largura).toBeGreaterThan(0);
}

async function verificarControleAcessibilidade(page) {
  const medida = await page.evaluate(() => {
    const rect = (seletor) => document.querySelector(seletor)?.getBoundingClientRect();
    const a11y = rect(".a11y-toggle-btn");
    const ajuda = rect(".help-fab-btn");
    const navegacao = rect(".tabbar");
    const sobrepoe = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return {
      dentro: a11y.left >= 0 && a11y.right <= innerWidth && a11y.top >= 0 && a11y.bottom <= innerHeight,
      faixaVertical: a11y.top / innerHeight,
      // O controle fica logo acima do de ajuda, na mesma coluna da direita.
      folgaAteAjuda: ajuda ? ajuda.top - a11y.bottom : null,
      desalinhamento: ajuda ? Math.abs(a11y.right - ajuda.right) : null,
      sobrepoeAjuda: sobrepoe(a11y, ajuda),
      sobrepoeNavegacao: sobrepoe(a11y, navegacao),
    };
  });
  expect(medida.dentro).toBe(true);
  expect(medida.faixaVertical).toBeGreaterThan(0.45);
  expect(medida.folgaAteAjuda).toBeGreaterThan(0);
  expect(medida.folgaAteAjuda).toBeLessThanOrEqual(40);
  expect(medida.desalinhamento).toBeLessThanOrEqual(1);
  expect(medida.sobrepoeAjuda).toBe(false);
  expect(medida.sobrepoeNavegacao).toBe(false);

  await page.locator("#a11yToggleBtn").click();
  const painel = await page.locator("#a11yPanel").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: innerHeight };
  });
  expect(painel.top).toBeGreaterThanOrEqual(15);
  expect(painel.bottom).toBeLessThanOrEqual(painel.height - 15);
  if (painel.height >= 600) expect(painel.top).toBeGreaterThan(30);
  await page.locator("#a11yCloseBtn").click();
}

for (const [nome, tamanho] of Object.entries(TAMANHOS)) {
  test(`Administração centralizada e íntegra em ${nome}`, async ({ page, context }) => {
    await abrir(page, context, "/#/admin/usuarios", tamanho);
    await expect(page.locator("#adminSub-usuarios")).toBeVisible();
    await esperarLayout(page);
    expect(await semRolagemHorizontal(page)).toBe(true);
    await verificarContainerCentralizado(page, "#app");
    await expect(page.locator(".admin-subtabs")).toBeVisible();

    for (const sub of ["usuarios", "ativos", "sessoes", "logs", "dispositivos", "notificacoes", "acessos", "proprietarios", "mapa", "macs", "config", "esp32", "monitoramento", "auditoria", "energia", "relatos"]) {
      await page.locator(`.admin-subtab-btn[data-sub="${sub}"]`).click();
      await expect(page.locator(`#adminSub-${sub}`)).toBeVisible();
      const semOverflow = await semRolagemHorizontal(page);
      const ofensores = semOverflow ? [] : await page.evaluate(() => [...document.querySelectorAll("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > document.documentElement.clientWidth + 1 || r.left < -1;
        })
        .slice(0, 8)
        .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`));
      expect(semOverflow, `${sub} sem rolagem horizontal da página: ${ofensores.join(", ")}`).toBe(true);
    }

    const energia = page.locator("#adminSub-energia");
    await page.locator('.admin-subtab-btn[data-sub="energia"]').click();
    await expect(energia.locator(".energy-table-wrap")).toBeVisible();
    await expect(energia.locator("#energyTableBody tr").first()).toBeVisible({ timeout: 20_000 });
    await expect(energia.locator("#energyTableBody .energy-save").first()).toBeAttached();
    const largura = await energia.evaluate((el) => ({ secao: el.clientWidth, tabela: el.querySelector(".energy-table-wrap").clientWidth }));
    expect(largura.tabela).toBeGreaterThan(largura.secao * 0.9);
    const extremosVisiveis = await energia.evaluate((el) => {
      const areaEl = el.querySelector(".energy-table-wrap");
      areaEl.scrollLeft = 0;
      const area = areaEl.getBoundingClientRect();
      const salvar = el.querySelector("#energyTableBody .energy-save").getBoundingClientRect();
      const configuracao = salvar.left >= area.left - 1 && salvar.right <= area.right + 1;
      areaEl.scrollLeft = areaEl.scrollWidth;
      const ultima = el.querySelector("#energyTableBody tr td:last-child").getBoundingClientRect();
      const colunaFinal = ultima.left >= area.left - 1 && ultima.right <= area.right + 1;
      return { configuracao, colunaFinal };
    });
    expect(extremosVisiveis).toEqual({ configuracao: true, colunaFinal: true });
    const margens = await page.locator(".admin-content").evaluate((content) => {
      const sub = content.querySelector(".admin-sub:not(.hidden)").getBoundingClientRect();
      const area = content.getBoundingClientRect();
      return { esquerda: sub.left - area.left, direita: area.right - sub.right };
    });
    expect(Math.abs(margens.esquerda - margens.direita), JSON.stringify(margens)).toBeLessThanOrEqual(1);
    await verificarControleAcessibilidade(page);
  });

  test(`Agendamentos centralizado e íntegro em ${nome}`, async ({ page, context }) => {
    await abrir(page, context, "/#/agenda", tamanho);
    await expect(page.locator("#screen-agenda")).toBeVisible();
    await esperarLayout(page);
    expect(await semRolagemHorizontal(page)).toBe(true);
    await verificarContainerCentralizado(page, "#app");
    const form = page.locator("#screen-agenda > .card");
    await expect(form).toBeVisible();
    const alinhamento = await form.evaluate((el) => {
      const tela = document.getElementById("screen-agenda").getBoundingClientRect();
      const card = el.getBoundingClientRect();
      const label = el.querySelector("label");
      return {
        diferenca: Math.abs((card.left - tela.left) - (tela.right - card.right)),
        texto: getComputedStyle(label).textAlign,
      };
    });
    expect(alinhamento.diferenca).toBeLessThanOrEqual(1);
    expect(["left", "start"]).toContain(alinhamento.texto);
    await verificarControleAcessibilidade(page);
  });

  test(`Início e Manual preservam associação e alinhamento em ${nome}`, async ({ page, context }) => {
    await abrir(page, context, "/#/inicio", tamanho);
    const relato = page.locator('.hub-card[data-hub-card="relatos"]');
    await expect(relato).toContainText("Relatar problema");
    const associacao = await relato.evaluate((card) => {
      const r = card.getBoundingClientRect();
      const dentro = (el) => {
        const x = el.getBoundingClientRect();
        return x.left >= r.left && x.right <= r.right && x.top >= r.top && x.bottom <= r.bottom;
      };
      return { icone: dentro(card.querySelector(".hub-card-icon")), titulo: dentro(card.querySelector(".hub-card-title")) };
    });
    expect(associacao).toEqual({ icone: true, titulo: true });

    await page.goto("/#/ajuda/inicio");
    await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
    const texto = await page.locator("#manualConteudo").evaluate((el) => {
      const p = el.querySelector("p");
      const li = el.querySelector("li");
      const ul = li?.closest("ul,ol");
      return {
        paragrafo: p && getComputedStyle(p).textAlign,
        item: li && getComputedStyle(li).textAlign,
        recuo: li && ul ? li.getBoundingClientRect().left - ul.getBoundingClientRect().left : 0,
      };
    });
    expect(["left", "start"]).toContain(texto.paragrafo);
    if (texto.item) expect(["left", "start"]).toContain(texto.item);
    if (texto.item) expect(texto.recuo).toBeGreaterThan(0);
    expect(await semRolagemHorizontal(page)).toBe(true);
  });
}
