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
      sobrepoeAjuda: sobrepoe(a11y, ajuda),
      sobrepoeNavegacao: sobrepoe(a11y, navegacao),
    };
  });
  expect(medida).toEqual({ dentro: true, sobrepoeAjuda: false, sobrepoeNavegacao: false });
}

for (const [nome, tamanho] of Object.entries(TAMANHOS)) {
  test(`Administração centralizada e íntegra em ${nome}`, async ({ page, context }) => {
    await abrir(page, context, "/#/admin/usuarios", tamanho);
    await expect(page.locator("#adminSub-usuarios")).toBeVisible();
    await esperarLayout(page);
    expect(await semRolagemHorizontal(page)).toBe(true);
    await verificarContainerCentralizado(page, "#app");
    await expect(page.locator(".admin-subtabs")).toBeVisible();

    for (const sub of ["energia", "relatos", "auditoria", "monitoramento", "dispositivos"]) {
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
    const largura = await energia.evaluate((el) => ({ secao: el.clientWidth, tabela: el.querySelector(".energy-table-wrap").clientWidth }));
    expect(largura.tabela).toBeGreaterThan(largura.secao * 0.9);
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
}
