const { test, expect, API_URL, SALA_ONLINE, injetarSessao, publicarFirmwareFixture, removerFirmwareFixture } = require("../harness/fixtures");

const PAINEL = "#otaRolloutPainel";

async function abrirFirmware(page, context) {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/esp32");
  await expect(page.locator("#adminSub-esp32")).toBeVisible();
}

test.afterEach(async ({ request }) => {
  await removerFirmwareFixture(request);
});

test("sem firmware publicado, a distribuição em etapas explica o pré-requisito e não oferece início", async ({ page, context }) => {
  await abrirFirmware(page, context);

  const painel = page.locator(PAINEL);
  await expect(painel).toBeVisible();
  await expect(painel.locator("h3")).toHaveText("Distribuição em etapas");
  await expect(painel).toContainText("Publique um firmware no servidor");
  await expect(painel.locator(".rollout-iniciar-btn")).toHaveCount(0);
});

test("um administrador comum não alcança a distribuição em etapas", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/admin/esp32");
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="esp32"]')).toBeHidden();
  await expect(page.locator("#adminSub-esp32")).toBeHidden();
  await expect(page.locator(PAINEL)).toBeHidden();
});

test("a distribuição lista o dispositivo apto, roda o canário e conclui com a versão validada", async ({ page, context, request }) => {
  const manifesto = await publicarFirmwareFixture(request, "4.1.0");
  await abrirFirmware(page, context);

  const painel = page.locator(PAINEL);
  const opcao = painel.locator(`.ota-rollout-opcao input[value="${SALA_ONLINE}"]`);
  await expect(opcao).toBeEnabled({ timeout: 20_000 });
  await expect(painel.locator(".ota-rollout-opcoes")).toContainText("firmware 4.0.0");

  await opcao.check();
  await expect(painel.locator(".rollout-canario-sel")).toHaveValue(SALA_ONLINE);
  await painel.locator(".rollout-iniciar-btn").click();

  const dialogo = page.locator(".app-dialog-card");
  await expect(dialogo).toContainText(`Distribuir o firmware ${manifesto.versao}`);
  await dialogo.locator(".app-dialog-actions .btn-on").click();

  await expect(painel.locator(".ota-rollout-item")).toHaveCount(1);
  await expect(painel.locator(".ota-rollout-etapa")).toHaveText("canário");
  await expect(painel.locator(".rollout-pausar-btn")).toBeVisible();

  await expect(painel.locator(".ota-rollout-encerrada strong")).toContainText("concluída", { timeout: 30_000 });
  await expect(painel.locator(".ota-rollout-estado")).toHaveText("validado");
  await expect(page.locator(`.esp32-device-card[data-sala="${SALA_ONLINE}"] .esp32-ota`)).toContainText("4.1.0");
});

test("um canário que reverte interrompe a distribuição e explica o motivo", async ({ page, context, request }) => {
  await publicarFirmwareFixture(request, "4.1.0");
  await request.post(`${API_URL}/__e2e/comportamento-ota/rollback`);
  await abrirFirmware(page, context);

  const painel = page.locator(PAINEL);
  const opcao = painel.locator(`.ota-rollout-opcao input[value="${SALA_ONLINE}"]`);
  await expect(opcao).toBeEnabled({ timeout: 20_000 });
  await opcao.check();
  await painel.locator(".rollout-iniciar-btn").click();
  await page.locator(".app-dialog-card .app-dialog-actions .btn-on").click();

  await expect(painel.locator(".ota-rollout-encerrada strong")).toContainText("interrompida", { timeout: 30_000 });
  await expect(painel.locator(".ota-rollout-encerrada")).toContainText("canário não passou na validação");
  await expect(painel.locator(".ota-rollout-estado")).toHaveText("revertido");
});
