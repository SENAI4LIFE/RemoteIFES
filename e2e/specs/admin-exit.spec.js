const { test, expect, VIEWPORTS, injetarSessao } = require("../harness/fixtures");

async function abrir(page, context, rota) {
  await injetarSessao(context, "superadmin");
  await context.addInitScript(() => {
    window.__wsEnviados = [];
    const enviar = WebSocket.prototype.send;
    WebSocket.prototype.send = function (dados) {
      try { window.__wsEnviados.push(JSON.parse(dados)); } catch (erro) {}
      return enviar.call(this, dados);
    };
  });
  await page.setViewportSize(VIEWPORTS.notebook);
  await page.goto(`/#${rota}`);
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
}

function enviados(page, tipo) {
  return page.evaluate((t) => window.__wsEnviados.filter((m) => m.tipo === t), tipo);
}

test("leaving Status > Sistema through the main navigation stops monitoring polling and returning restarts it", async ({ page, context }) => {
  const consultas = [];
  await page.route("**/admin/monitoramento", (rota) => {
    consultas.push(Date.now());
    return rota.continue();
  });
  await abrir(page, context, "/admin/status/sistema");
  await expect(page.locator("#monGrid .mon-card:not(.mon-card-skeleton)").first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => consultas.length).toBeGreaterThanOrEqual(1);

  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-admin")).toBeHidden();
  const aoSair = consultas.length;
  await page.waitForTimeout(22_000);
  expect(consultas.length, "no monitoring query after leaving Administration").toBe(aoSair);

  await page.locator('.tab-btn[data-tab="admin"]').click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator("#adminSub-status")).toBeVisible();
  await expect.poll(() => consultas.length, { timeout: 10_000 }).toBeGreaterThan(aoSair);
});

test("leaving Usuários ativos clears the sessions timer, and leaving Firmware/OTA and Protocolos IR cancels device observation", async ({ page, context }) => {
  await abrir(page, context, "/admin/status/ativos");
  await expect(page.locator("#ativosList li").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => Admin._ativosIntervalId !== null)).toBe(true);
  await page.locator('.tab-btn[data-tab="inicio"]').click();
  await expect(page.locator("#screen-admin")).toBeHidden();
  expect(await page.evaluate(() => Admin._ativosIntervalId), "active users timer stopped").toBe(null);

  await page.goto("/#/admin/esp32");
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await enviados(page, "observar_dispositivos")).some((m) => m.salas.length > 0), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => { window.__wsEnviados = []; });
  await page.locator('.tab-btn[data-tab="agenda"]').click();
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect.poll(async () => (await enviados(page, "observar_dispositivos")).some((m) => m.salas.length === 0)).toBe(true);

  await page.goto("/#/admin/protocolos");
  await expect(page.locator("#adminSub-protocolos")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { window.__wsEnviados = []; });
  await page.locator('.tab-btn[data-tab="grade"]').click();
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect.poll(async () => (await enviados(page, "observar_dispositivos")).some((m) => m.salas.length === 0)).toBe(true);
});

test("leaving Administration while Status > Sistema is still loading does not leave polling running", async ({ page, context }) => {
  const consultas = [];
  let liberar;
  const segurar = new Promise((resolve) => { liberar = resolve; });
  await page.route("**/admin/monitoramento", async (rota) => {
    consultas.push(Date.now());
    if (consultas.length === 1) await segurar;
    return rota.continue();
  });
  await abrir(page, context, "/admin/status/sistema");
  await expect.poll(() => consultas.length).toBe(1);
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-admin")).toBeHidden();
  liberar();
  await page.waitForTimeout(22_000);
  expect(consultas.length, "a late asynchronous entry must not start polling after leaving").toBe(1);
});
