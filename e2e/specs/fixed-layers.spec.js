const { test, expect, VIEWPORTS, injetarSessao } = require("../harness/fixtures");

// Floating buttons, help panel, account menu and bottom bar: the fixed layers must fit on screen
// and not cover each other at any screen height and with text enlarged to the maximum (the bottom
// bar grows beyond 100px).

const MAXIMO_A11Y = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
};

const CURTO_DESKTOP = { width: 1024, height: 600 };

async function abrir(page, context, papel, rota, tamanho, a11yMaximo = false) {
  await injetarSessao(context, papel);
  if (a11yMaximo) {
    await context.addInitScript((ajustes) => {
      try {
        Object.entries(ajustes).forEach(([k, v]) => window.localStorage.setItem(k, v));
      } catch (e) {}
    }, MAXIMO_A11Y);
  }
  await page.setViewportSize(tamanho);
  await page.goto(rota);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function abrirPainelDeAjuda(page) {
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await expect.poll(() => page.locator("#helpFabLinks a, #helpFabLinks button").count()).toBeGreaterThan(0);
}

function medirPainelDeAjuda() {
  const painel = document.getElementById("helpFabPanel").getBoundingClientRect();
  const fechar = document.getElementById("helpFabCloseBtn");
  const rf = fechar.getBoundingClientRect();
  const noFechar = document.elementFromPoint(rf.left + rf.width / 2, rf.top + rf.height / 2);
  const links = Array.from(document.querySelectorAll("#helpFabPrimaryLinks a, #helpFabPrimaryLinks button, #helpFabLinks a, #helpFabLinks button"));
  const ultimo = links[links.length - 1];
  ultimo.scrollIntoView({ block: "nearest" });
  const ru = ultimo.getBoundingClientRect();
  const noFimDoUltimo = document.elementFromPoint(ru.right - 6, ru.top + ru.height / 2);
  return {
    topo: painel.top,
    base: painel.bottom,
    alturaTela: innerHeight,
    fecharAlcancavel: fechar.contains(noFechar),
    fimDoUltimoLinkLivre: ultimo.contains(noFimDoUltimo),
  };
}

const CENARIOS_AJUDA = [
  ["superadmin", "mobile-compact", VIEWPORTS["mobile-compact"], false],
  ["superadmin", "mobile-landscape", VIEWPORTS["mobile-landscape"], false],
  ["superadmin", "desktop curto", CURTO_DESKTOP, false],
  ["superadmin", "notebook", VIEWPORTS.notebook, false],
  ["superadmin", "tablet", VIEWPORTS["tablet-compact"], false],
  ["user", "notebook", VIEWPORTS.notebook, false],
  ["superadmin", "mobile-landscape com texto máximo", VIEWPORTS["mobile-landscape"], true],
  ["superadmin", "mobile-portrait com texto máximo", VIEWPORTS["mobile-portrait"], true],
];

for (const [papel, nome, tamanho, maximo] of CENARIOS_AJUDA) {
  test(`the help panel fits on screen and its close button is reachable (${papel}, ${nome})`, async ({ page, context }) => {
    await abrir(page, context, papel, "/#/inicio", tamanho, maximo);
    await abrirPainelDeAjuda(page);
    const medida = await page.evaluate(medirPainelDeAjuda);
    expect(medida.topo, "the panel starts inside the screen").toBeGreaterThanOrEqual(0);
    expect(medida.base, "o painel termina dentro da tela").toBeLessThanOrEqual(medida.alturaTela);
    expect(medida.fecharAlcancavel, "the Fechar button receives the tap (neither the password banner nor another layer on top)").toBe(true);
    expect(medida.fimDoUltimoLinkLivre, "the accessibility button does not cover the end of the help links").toBe(true);
    await page.locator("#helpFabCloseBtn").click();
    await expect(page.locator("#helpFabPanel")).toBeHidden();
    await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
  });
}

for (const [nome, tamanho] of [["mobile-compact", VIEWPORTS["mobile-compact"]], ["mobile-portrait", VIEWPORTS["mobile-portrait"]], ["mobile-large", VIEWPORTS["mobile-large"]], ["mobile-landscape", VIEWPORTS["mobile-landscape"]]]) {
  test(`with maximum text the floating buttons follow the real bottom bar height (${nome})`, async ({ page, context }) => {
    await abrir(page, context, "admin", "/#/inicio", tamanho, true);
    const medida = await page.evaluate(() => {
      const barra = document.querySelector(".tabbar").getBoundingClientRect();
      const ajuda = document.getElementById("helpFabToggleBtn").getBoundingClientRect();
      const a11y = document.getElementById("a11yToggleBtn").getBoundingClientRect();
      const variavel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tabbar-h"));
      // The bar scrolls horizontally when the tabs do not fit: each tab is scrolled into view
      // before checking whether anything floating covers it.
      const abas = Array.from(document.querySelectorAll(".tab-btn:not(.hidden)")).map((aba) => {
        aba.scrollIntoView({ inline: "nearest", block: "nearest" });
        const r = aba.getBoundingClientRect();
        const no = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { rotulo: aba.textContent.trim(), recebeToque: aba.contains(no) };
      });
      return { alturaBarra: barra.height, variavel, folgaAjuda: barra.top - ajuda.bottom, folgaA11y: barra.top - a11y.bottom, abas };
    });
    expect(medida.alturaBarra, "a fonte ampliada realmente alarga a barra").toBeGreaterThan(90);
    expect(Math.abs(medida.variavel - medida.alturaBarra), "--tabbar-h reflete a barra medida").toBeLessThanOrEqual(1);
    expect(medida.folgaAjuda, "the help button stays above the bar").toBeGreaterThan(0);
    expect(medida.folgaA11y, "the accessibility button stays above the bar").toBeGreaterThan(0);
    for (const aba of medida.abas) expect(aba.recebeToque, `the ${aba.rotulo} tab receives the tap`).toBe(true);
  });
}

for (const [nome, tamanho] of [["mobile-compact", VIEWPORTS["mobile-compact"]], ["mobile-large", VIEWPORTS["mobile-large"]], ["paisagem 667x375", { width: 667, height: 375 }]]) {
  test(`the last control of a long page is not under the floating buttons (${nome})`, async ({ page, context }) => {
    await abrir(page, context, "superadmin", "/#/admin/logs/auditoria", tamanho);
    await expect(page.locator("#logsAba-auditoria")).toBeVisible({ timeout: 15_000 });
    const botao = page.locator("#connectNextBtn");
    await expect(botao).toBeVisible();
    const medida = await botao.evaluate((el) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const r = el.getBoundingClientRect();
      const pontos = [0.25, 0.5, 0.75, 0.9].map((f) => document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2));
      const a11y = document.getElementById("a11yToggleBtn").getBoundingClientRect();
      return { livre: pontos.every((no) => el.contains(no)), base: r.bottom, topoDoFab: a11y.top };
    });
    expect(medida.base, "the end of the page clears the accessibility button").toBeLessThanOrEqual(medida.topoDoFab);
    expect(medida.livre, "every point of the button responds to taps").toBe(true);
  });
}

for (const [nome, tamanho] of [["mobile-landscape", VIEWPORTS["mobile-landscape"]], ["paisagem 740x360", { width: 740, height: 360 }], ["paisagem 667x375", { width: 667, height: 375 }]]) {
  test(`in short landscape the account menu stays above the floating buttons (${nome})`, async ({ page, context }) => {
    await abrir(page, context, "superadmin", "/#/inicio", tamanho);
    await page.locator("#accountMenuBtn").click();
    await expect(page.locator("#accountMenu")).toBeVisible();
    const itens = await page.evaluate(() => {
      const menu = document.getElementById("accountMenu");
      return Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => {
        const r = item.getBoundingClientRect();
        const pontos = [[r.left + r.width / 2, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]];
        return { rotulo: item.textContent.trim(), livre: pontos.every(([x, y]) => item.contains(document.elementFromPoint(x, y))) };
      });
    });
    expect(itens.length).toBeGreaterThan(0);
    for (const item of itens) expect(item.livre, `"${item.rotulo}" responde ao toque em toda a largura`).toBe(true);
  });
}

test("the default-password banner does not paint over the open account menu", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "/#/inicio", VIEWPORTS.notebook);
  await expect(page.locator("#defaultPasswordWarning")).toBeVisible();
  await page.locator("#accountMenuBtn").click();
  await expect(page.locator("#accountMenu")).toBeVisible();
  const cabecalho = await page.evaluate(() =>
    ["accountMenuName", "accountMenuLogin", "accountMenuRole"].map((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      const no = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
      return { id, visivel: el.contains(no) };
    })
  );
  for (const parte of cabecalho) expect(parte.visivel, `${parte.id} aparece por cima da faixa`).toBe(true);
});
