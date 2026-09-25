const { test, expect } = require("../harness/fixtures");

async function carregarSimulandoMotor(page, context, simulacao) {
  await context.addInitScript(simulacao);
  const erros = [];
  page.on("pageerror", (erro) => erros.push(erro.message));
  await page.goto("/");
  return erros;
}

async function estadoDaPagina(page) {
  return page.evaluate(() => ({
    scripts: document.scripts.length,
    telas: document.querySelectorAll("section[id^='screen-']").length,
    versaoFrontend: typeof window.REMOTEIFES_FRONTEND_VERSION,
    configuracao: typeof window.RemoteIFESConfig,
  }));
}

async function esperarAvisoSemApp(page, erros) {
  const aviso = page.locator("#navegador-incompativel");
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("Navegador desatualizado");
  await expect(aviso).toContainText("Android System WebView");
  await expect(aviso).toContainText("Chrome ou WebView 108");
  expect(await estadoDaPagina(page)).toEqual({ scripts: 1, telas: 0, versaoFrontend: "undefined", configuracao: "undefined" });
  expect(erros).toEqual([]);
}

test("an engine without :has() sees the outdated-browser notice instead of a half-working app", async ({ page, context }) => {
  const erros = await carregarSimulandoMotor(page, context, () => {
    const original = CSS.supports.bind(CSS);
    CSS.supports = (...args) => (String(args[0]).includes(":has(") ? false : original(...args));
  });
  await esperarAvisoSemApp(page, erros);
});

test("an engine without dvh units sees the outdated-browser notice", async ({ page, context }) => {
  const erros = await carregarSimulandoMotor(page, context, () => {
    const original = CSS.supports.bind(CSS);
    CSS.supports = (...args) => (String(args[1]).includes("dvh") ? false : original(...args));
  });
  await esperarAvisoSemApp(page, erros);
});

test("an engine that does not parse ES2020 syntax sees the notice, without stray syntax errors", async ({ page, context }) => {
  const erros = await carregarSimulandoMotor(page, context, () => {
    const Original = Function;
    window.Function = function () {
      if (Array.from(arguments).some((fonte) => /\?\./.test(String(fonte)))) throw new SyntaxError("Unexpected token .");
      return Original.apply(null, arguments);
    };
  });
  await esperarAvisoSemApp(page, erros);
});

test("an engine without Element.replaceChildren sees the outdated-browser notice", async ({ page, context }) => {
  const erros = await carregarSimulandoMotor(page, context, () => {
    delete Element.prototype.replaceChildren;
  });
  await esperarAvisoSemApp(page, erros);
});

test("in an engine with the required features the notice does not exist and the app loads fully", async ({ appPage }) => {
  await expect(appPage.locator("#navegador-incompativel")).toHaveCount(0);
  const estado = await estadoDaPagina(appPage);
  expect(estado.scripts).toBeGreaterThan(1);
  expect(estado.telas).toBeGreaterThan(0);
  expect(estado.versaoFrontend).toBe("string");
  expect(estado.configuracao).toBe("object");
});
