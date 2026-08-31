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
  await expect(page.locator("#serverStatusDesc")).toHaveText("Reconectando automaticamente…");
  await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 25_000 });
  await expect(page.locator("#mainApp")).toBeVisible();
  await expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
});

test("sessão invalidada durante reconexão volta ao login sem loop", async ({ page, context, request }) => {
  // Sessão descartável própria: derrubá-la não pode afetar o token "user" compartilhado.
  const login = await request.post(`${API_URL}/login`, { data: { usuario: "e2e_user", senha: "e2e-user-pass-123" } });
  expect(login.ok()).toBe(true);
  const token = (await login.json()).token;
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("remoteifes_token", t);
    } catch (e) {}
  }, token);
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  const logout = await request.post(`${API_URL}/logout`, { headers: { Authorization: `Bearer ${token}` } });
  expect(logout.ok()).toBe(true);
  const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
  expect(fechado.ok()).toBe(true);

  await expect(page.locator("#screen-login")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("remoteifes_token"))).toBeNull();
});

for (const papel of ["admin", "superadmin"]) {
  test(`queda temporária para ${papel} mantém somente a reconexão automática`, async ({ page, sessaoComo, context, request }) => {
    await sessaoComo(papel);
    await context.setOffline(true);
    const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
    expect(fechado.ok()).toBe(true);
    await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator("#serverStatusDesc")).toHaveText("Reconectando automaticamente…");
    await expect(page.locator("#screen-server-config")).toBeHidden();
    await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 25_000 });
  });
}

test("falha HTTP isolada não oferece reconfiguração de infraestrutura", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.route(`${API_URL}/salas`, (route) => route.abort("failed"));
  const resultado = await page.evaluate(async () => Api.listarSalas());
  expect(resultado.ok).toBe(false);
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await expect(page.locator("#screen-server-config")).toBeHidden();
  await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);
});

test("Cordova sem origem usa configuração inicial dedicada e funcional", async ({ page, context }) => {
  await context.addInitScript(() => {
    window.cordova = {};
    if (!window.sessionStorage.getItem("e2e_cordova_config_iniciado")) {
      window.localStorage.removeItem("remoteifes_server_url");
      window.sessionStorage.setItem("e2e_cordova_config_iniciado", "1");
    }
  });
  await page.goto("/");
  await expect(page.locator("#screen-server-config")).toBeVisible();
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await page.locator("#serverConfigUrl").fill("ftp://servidor-invalido");
  await page.locator("#serverConfigForm button[type=submit]").click();
  await expect(page.locator("#serverConfigError")).toBeVisible();
  await page.locator("#serverConfigUrl").fill(API_URL);
  await page.locator("#serverConfigForm button[type=submit]").click();
  await expect(page.locator("#screen-server-config")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
});

test("recarregar a página restaura a sessão sem novo login", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeHidden();
  await expect(page.locator("#userTag")).toContainText("Usuário E2E");
});
