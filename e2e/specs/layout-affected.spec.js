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
    const workspaceUsuarios = await page.locator(".admin-layout").evaluate((layout) => {
      const sidebar = layout.querySelector(".admin-subtabs").getBoundingClientRect();
      const content = layout.querySelector(".admin-content").getBoundingClientRect();
      const card = layout.querySelector("#adminSub-usuarios .card").getBoundingClientRect();
      const ladoALado = sidebar.bottom > content.top && sidebar.top < content.bottom && sidebar.right <= content.left + 1;
      return {
        ladoALado,
        vao: card.left - sidebar.right,
        margemEsquerda: card.left - content.left,
        margemDireita: content.right - card.right,
        proporcao: card.width / content.width,
      };
    });
    if (workspaceUsuarios.ladoALado) {
      expect(workspaceUsuarios.vao).toBeLessThanOrEqual(80);
      expect(Math.abs(workspaceUsuarios.margemEsquerda - workspaceUsuarios.margemDireita)).toBeLessThanOrEqual(1);
      expect(workspaceUsuarios.proporcao).toBeGreaterThan(0.9);
    }

    for (const sub of ["usuarios", "ativos", "sessoes", "logs", "dispositivos", "notificacoes", "proprietarios", "mapa", "macs", "config", "esp32", "monitoramento", "auditoria", "relatos"]) {
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

    await page.locator('.admin-subtab-btn[data-sub="notificacoes"]').click();
    const proporcaoNormal = await page.locator("#adminSub-notificacoes").evaluate((sub) => {
      const content = sub.closest(".admin-content").getBoundingClientRect();
      const card = sub.querySelector(".card").getBoundingClientRect();
      return card.width / content.width;
    });
    expect(proporcaoNormal).toBeGreaterThan(0.9);

    const margens = await page.locator(".admin-content").evaluate((content) => {
      const sub = content.querySelector(".admin-sub:not(.hidden)").getBoundingClientRect();
      const area = content.getBoundingClientRect();
      return { esquerda: sub.left - area.left, direita: area.right - sub.right };
    });
    expect(Math.abs(margens.esquerda - margens.direita), JSON.stringify(margens)).toBeLessThanOrEqual(1);
    await verificarControleAcessibilidade(page);
  });

  test(`Agendamentos ocupa a largura do conteúdo e permanece íntegro em ${nome}`, async ({ page, context }) => {
    await abrir(page, context, "/#/agenda", tamanho);
    await expect(page.locator("#screen-agenda")).toBeVisible();
    await esperarLayout(page);
    expect(await semRolagemHorizontal(page)).toBe(true);
    await verificarContainerCentralizado(page, "#app");
    const form = page.locator("#screen-agenda > .card");
    await expect(form).toBeVisible();
    await expect(page.locator("#agendaEmpty")).toBeVisible();
    const alinhamento = await form.evaluate((el) => {
      const screen = document.getElementById("screen-agenda");
      const tela = screen.getBoundingClientRect();
      const card = el.getBoundingClientRect();
      const label = el.querySelector("label");
      const bordas = [screen.querySelector(".screen-head"), screen.querySelector(":scope > .hint"), el, screen.querySelector("#agendaEmpty")].map((item) => {
        const rect = item.getBoundingClientRect();
        return { esquerda: Math.abs(rect.left - tela.left), direita: Math.abs(rect.right - tela.right) };
      });
      return {
        esquerda: Math.abs(card.left - tela.left),
        direita: Math.abs(card.right - tela.right),
        largura: Math.abs(card.width - tela.width),
        bordas,
        texto: getComputedStyle(label).textAlign,
      };
    });
    expect(alinhamento.esquerda).toBeLessThanOrEqual(1);
    expect(alinhamento.direita).toBeLessThanOrEqual(1);
    expect(alinhamento.largura).toBeLessThanOrEqual(1);
    alinhamento.bordas.forEach((bordas) => {
      expect(bordas.esquerda).toBeLessThanOrEqual(1);
      expect(bordas.direita).toBeLessThanOrEqual(1);
    });
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

test("Agendamentos mantém largura integral com acessibilidade máxima", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("remoteifes_font_scale", "2");
    localStorage.setItem("remoteifes_line_height", "3");
    localStorage.setItem("remoteifes_letter_spacing", "0.25");
  });
  await abrir(page, context, "/#/agenda", VIEWPORTS["mobile-portrait"]);
  const geometria = await page.locator("#screen-agenda > .card").evaluate((card) => {
    const tela = document.getElementById("screen-agenda").getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const botao = card.querySelector("#criarAgendaBtn").getBoundingClientRect();
    return {
      esquerda: Math.abs(rect.left - tela.left),
      direita: Math.abs(rect.right - tela.right),
      botaoDentro: botao.left >= rect.left && botao.right <= rect.right && botao.top >= rect.top && botao.bottom <= rect.bottom,
    };
  });
  expect(geometria.esquerda).toBeLessThanOrEqual(1);
  expect(geometria.direita).toBeLessThanOrEqual(1);
  expect(geometria.botaoDentro).toBe(true);
  expect(await semRolagemHorizontal(page)).toBe(true);
});
