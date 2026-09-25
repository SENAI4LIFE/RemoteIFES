const { test, expect, VIEWPORTS, injetarSessao } = require("../harness/fixtures");

// The accessibility panel follows the same focus cycle as the other panels: opening moves focus
// into it, Esc closes it, closing returns focus to the button that opened it, and no hidden control
// keeps focus.

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
  test(`opening moves focus into the panel, Esc closes it and returns focus to the button (${nome})`, async ({ page, context }) => {
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

test("Esc closes the panel from any inner control and focus returns to the button", async ({ page, context }) => {
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

test("closing with the × button does not leave focus on a hidden control", async ({ page, context }) => {
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

test("clicking outside closes the panel without trapping focus or stealing it from what was clicked", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#a11yResetAllBtn").focus();
  expect((await focoAtual(page)).dentroDoPainel).toBe(true);

  // A click on a neutral area of the page: the panel closes and focus does not remain on anything
  // hidden.
  await page.locator("#screen-inicio h2, #screen-inicio .hub-secao-titulo, #screen-inicio").first().click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#a11yPanel")).toBeHidden();
  const foco = await focoAtual(page);
  expect(foco.dentroDoPainel).toBe(false);
  expect(foco.escondido).toBe(false);

  // A click on a page control: that control keeps focus and the panel does not take it back.
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#accountMenuBtn").click();
  await expect(page.locator("#a11yPanel")).toBeHidden();
  await expect(page.locator("#accountMenu")).toBeVisible();
  expect((await focoAtual(page)).dentroDoPainel).toBe(false);
});

test("opening the help panel closes the accessibility panel and vice versa, with coherent focus", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeHidden();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  // The help panel moves focus to its close button right after opening (same cycle as the
  // accessibility panel): wait for focus to enter before pressing keys, so focus return is checked
  // from the documented state. Focus on a hidden control is also caught here.
  await expect(page.locator("#helpFabCloseBtn"), "o foco entra no painel de ajuda").toBeFocused();
  expect((await focoAtual(page)).escondido, "o foco não fica em controle escondido").toBe(false);

  // The open help panel covers the floating button column; Esc closes it and returns focus to its
  // button, after which the accessibility panel opens normally.
  await page.keyboard.press("Escape");
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await expect(page.locator("#a11yCloseBtn")).toBeFocused();
});

// Focus can return to the floating button while the panel is still open (Shift+Tab from the close
// button; in Firefox after passing through the scrollable panel itself). Esc must also close it
// from there.
test("with the help panel open, Esc closes it even with focus on the floating button", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto("/#/inicio");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await page.locator("#helpFabToggleBtn").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await expect(page.locator("#helpFabCloseBtn")).toBeFocused();

  await page.locator("#helpFabToggleBtn").focus();
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
  await expect(page.locator("#helpFabPanel"), "voltar ao botão não fecha o painel").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#helpFabToggleBtn")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
});
