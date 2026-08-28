const { test, expect, API_URL } = require("../harness/fixtures");

test("a conexão WebSocket entrega a lista de salas em tempo real após a sessão", async ({ page, context }) => {
  const framesSalas = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (data) => {
      const payload = typeof data.payload === "string" ? data.payload : "";
      if (payload.includes('"tipo":"salas"')) framesSalas.push(payload);
    });
  });

  const { injetarSessao } = require("../harness/fixtures");
  await injetarSessao(context, "user");
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => framesSalas.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

test("queda de rede mostra o aviso de conexão e o app se recupera ao voltar", async ({ page, sessaoComo, context, request }) => {
  await sessaoComo("user");
  await expect(page.locator("#screen-server-status")).toBeHidden();

  await context.setOffline(true);
  const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
  expect(fechado.ok()).toBe(true);
  await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#serverStatusTitulo")).toContainText("Sem conexão");

  await context.setOffline(false);
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 25_000 });
  await expect(page.locator("#mainApp")).toBeVisible();
  await expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
});

test("recarregar a página restaura a sessão sem novo login", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeHidden();
  await expect(page.locator("#userTag")).toContainText("Usuário E2E");
});
