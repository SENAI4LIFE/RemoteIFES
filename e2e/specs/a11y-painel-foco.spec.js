const { test, expect, VIEWPORTS, injetarSessao } = require("../harness/fixtures");

// O painel de acessibilidade segue o mesmo ciclo de foco dos outros painéis: ao abrir o
// foco entra nele, Esc fecha, ao fechar o foco volta ao botão que abriu e nenhum controle
// escondido fica com o foco.

async function focoAtual(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const painel = document.getElementById("a11yPanel");
    return {
      id: el ? el.id || el.tagName.toLowerCase() : null,
      dentroDoPainel: !!el && painel.contains(el),
      escondido: !!el && el !== document.body && el.offsetParent === null,
    };
  });
}

for (const [nome, preparar] of [
  ["no portal, deslogado", async () => {}],
  ["com sessão aberta", async (context) => injetarSessao(context, "user")],
]) {
  test(`abrir leva o foco ao painel, Esc fecha e devolve o foco ao botão (${nome})`, async ({ page, context }) => {
    await preparar(context);
    await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
    await page.goto("/");
    await expect(page.locator("#a11yToggleBtn")).toBeVisible({ timeout: 20_000 });

    await page.locator("#a11yToggleBtn").click();
    await expect(page.locator("#a11yPanel")).toBeVisible();
    await expect(page.locator("#a11yToggleBtn")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#a11yCloseBtn"), "o foco inicial fica no botão de fechar do painel").toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator("#a11yPanel")).toBeHidden();
    await expect(page.locator("#a11yToggleBtn")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#a11yToggleBtn"), "Esc devolve o foco ao botão que abriu").toBeFocused();
  });
}

test("Esc fecha o painel a partir de qualquer controle interno e o foco volta ao botão", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await expect(page.locator("#a11yCloseBtn")).toBeFocused();

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const antes = await focoAtual(page);
  expect(antes.dentroDoPainel, "Tab percorre os controles do painel").toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#a11yPanel")).toBeHidden();
  await expect(page.locator("#a11yToggleBtn")).toBeFocused();
});

test("fechar pelo botão × não deixa o foco em um controle escondido", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#a11yCloseBtn").click();
  await expect(page.locator("#a11yPanel")).toBeHidden();
  const foco = await focoAtual(page);
  expect(foco.escondido, "nenhum elemento escondido fica com o foco").toBe(false);
  expect(foco.dentroDoPainel).toBe(false);
  await expect(page.locator("#a11yToggleBtn")).toBeFocused();
});

test("clicar fora fecha o painel sem prender o foco nele nem roubar o foco do que foi clicado", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#a11yResetAllBtn").focus();
  expect((await focoAtual(page)).dentroDoPainel).toBe(true);

  // Um clique em área neutra da página: o painel fecha e o foco não fica em nada escondido.
  await page.locator("#screen-inicio h2, #screen-inicio .hub-secao-titulo, #screen-inicio").first().click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#a11yPanel")).toBeHidden();
  const foco = await focoAtual(page);
  expect(foco.dentroDoPainel).toBe(false);
  expect(foco.escondido).toBe(false);

  // Um clique em um controle da página: ele fica com o foco, o painel não o rouba de volta.
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#accountMenuBtn").click();
  await expect(page.locator("#a11yPanel")).toBeHidden();
  await expect(page.locator("#accountMenu")).toBeVisible();
  expect((await focoAtual(page)).dentroDoPainel).toBe(false);
});

test("abrir o painel de ajuda fecha o de acessibilidade e vice-versa, com foco coerente", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeHidden();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await expect.poll(async () => (await focoAtual(page)).escondido, "o foco não fica em controle escondido").toBe(false);

  // O painel de ajuda aberto cobre a coluna dos botões flutuantes; Esc o fecha e devolve o
  // foco ao seu botão, e daí o painel de acessibilidade abre normalmente.
  await page.keyboard.press("Escape");
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await expect(page.locator("#a11yCloseBtn")).toBeFocused();
});
