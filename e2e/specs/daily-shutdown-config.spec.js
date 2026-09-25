const { test, expect, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// Daily air conditioner shutdown in Administração > Sistema > Configurações (superadministrator):
// enable, time, scope and room selection persist, the server refuses an empty selection, and the
// section shows the next occurrence. The harness does not run the scheduler, so nothing executes.

async function abrirConfig(page, context, tamanho = { width: 1280, height: 900 }) {
  await injetarSessao(context, "superadmin");
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/config");
  await expect(page.locator("#cfgDesligamentoCard")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#cfgDesligamentoSituacao")).not.toHaveText("", { timeout: 15_000 });
}

async function restaurar(request) {
  const tokens = require("fs").readFileSync(require("path").join(__dirname, "..", "harness", ".tokens.json"), "utf8");
  await request.patch(`${process.env.E2E_API_URL}/admin/configuracoes`, {
    headers: { Authorization: `Bearer ${JSON.parse(tokens).superadmin}` },
    data: { desligamentoDiario: { ativo: false, escopo: "todas", salas: [] } },
  });
}

test.afterEach(async ({ request }) => {
  await restaurar(request);
});

test("the superadministrator enables the daily shutdown for selected rooms and the setting persists", async ({ page, context }) => {
  await abrirConfig(page, context);
  await expect(page.locator("#cfgDesligamentoSituacao")).toHaveText("Desligamento diário desativado.");
  await expect(page.locator("#cfgDesligamentoSalas")).toBeHidden();

  await page.locator("#cfgDesligamentoAtivo").check();
  await page.locator("#cfgDesligamentoHora").fill("22:30");
  await page.locator("#cfgDesligamentoEscopo").selectOption("selecionadas");
  await expect(page.locator("#cfgDesligamentoSalas")).toBeVisible();
  await page.locator('#cfgDesligamentoSalasLista input[value="A-313"]').check();
  await page.locator('#cfgDesligamentoSalasLista input[value="A-312"]').check();
  await page.locator("#salvarConfigBtn").click();
  await expect(page.locator("#configSavedHint")).toBeVisible();
  await expect(page.locator("#cfgDesligamentoSituacao")).toContainText(/Próximo desligamento: \d{2}\/\d{2}\/\d{4} às 22:30\./);

  await page.reload();
  await expect(page.locator("#cfgDesligamentoCard")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#cfgDesligamentoAtivo")).toBeChecked();
  await expect(page.locator("#cfgDesligamentoHora")).toHaveValue("22:30");
  await expect(page.locator("#cfgDesligamentoEscopo")).toHaveValue("selecionadas");
  await expect(page.locator('#cfgDesligamentoSalasLista input[value="A-313"]')).toBeChecked();
  await expect(page.locator('#cfgDesligamentoSalasLista input[value="A-312"]')).toBeChecked();
  await expect(page.locator('#cfgDesligamentoSalasLista input[value="A-311"]')).not.toBeChecked();
});

test("an enabled shutdown without selected rooms is refused with a Portuguese message", async ({ page, context }) => {
  await abrirConfig(page, context);
  await page.locator("#cfgDesligamentoAtivo").check();
  await page.locator("#cfgDesligamentoEscopo").selectOption("selecionadas");
  await page.locator("#salvarConfigBtn").click();
  await expect(page.locator(".toast").filter({ hasText: "selecione ao menos uma sala" })).toBeVisible();
  await expect(page.locator("#configSavedHint")).toBeHidden();
});

test("the daily shutdown section fits a phone without horizontal page scroll", async ({ page, context }) => {
  await abrirConfig(page, context, { width: 360, height: 800 });
  await page.locator("#cfgDesligamentoEscopo").selectOption("selecionadas");
  const lista = page.locator("#cfgDesligamentoSalasLista");
  await expect(lista).toBeVisible();
  const medidas = await lista.evaluate((el) => ({ rolaSozinha: el.scrollHeight > el.clientHeight, direita: el.getBoundingClientRect().right }));
  expect(medidas.rolaSozinha, "the room list scrolls inside itself").toBe(true);
  expect(medidas.direita).toBeLessThanOrEqual(360);
  expect(await semRolagemHorizontal(page)).toBe(true);
});
