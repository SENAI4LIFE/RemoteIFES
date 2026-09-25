const { test, expect, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// Test mode and the authorized ranges belong to the Operations Console. Administração > Sistema >
// Configurações shows them without editing controls, saving the page never sends them, and the
// server refuses a direct attempt to change them.

function tokenSuperadmin() {
  const fs = require("fs");
  const path = require("path");
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "harness", ".tokens.json"), "utf8")).superadmin;
}

async function abrirConfig(page, context, tamanho = { width: 1280, height: 900 }) {
  await injetarSessao(context, "superadmin");
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/config");
  await expect(page.locator("#cfgAcessoRede")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#cfgModoTesteValor")).not.toHaveText("—", { timeout: 15_000 });
}

test("network access is displayed read-only and saving the settings does not send it", async ({ page, context, request }) => {
  const atual = await (
    await request.get(`${process.env.E2E_API_URL}/admin/configuracoes`, { headers: { Authorization: `Bearer ${tokenSuperadmin()}` } })
  ).json();
  await abrirConfig(page, context);

  const acesso = page.locator("#cfgAcessoRede");
  await expect(acesso.locator("input, textarea, select")).toHaveCount(0);
  await expect(page.locator("#cfgModoTesteValor")).toHaveText(atual.configuracoes.modoTeste ? "ligado" : "desligado");
  await expect(page.locator("#cfgRedesAutorizadasValor")).toHaveText(atual.configuracoes.redesAutorizadas.join(", ") || "nenhuma");
  await expect(acesso).toContainText("Console de Operações");
  await expect(page.locator("#cfgModoTesteAviso")).toBeVisible({ visible: !!atual.configuracoes.modoTeste });

  const enviado = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/admin/configuracoes"));
  await page.locator("#salvarConfigBtn").click();
  const corpo = JSON.parse((await enviado).postData() || "{}");
  expect(Object.keys(corpo)).not.toContain("modoTeste");
  expect(Object.keys(corpo)).not.toContain("redesAutorizadas");
  await expect(page.locator("#configSavedHint")).toBeVisible();
});

test("the server refuses a website session that tries to change network access", async ({ request }) => {
  const r = await request.patch(`${process.env.E2E_API_URL}/admin/configuracoes`, {
    headers: { Authorization: `Bearer ${tokenSuperadmin()}` },
    data: { redesAutorizadas: ["203.0.113.0/24"] },
  });
  expect(r.status()).toBe(403);
  expect((await r.json()).erro).toMatch(/Console de Operações/);
});

test("the read-only network block fits a 320px phone with maximum text", async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("remoteifes_font_scale", "2");
    } catch (e) {}
  });
  await abrirConfig(page, context, { width: 320, height: 640 });
  await page.locator("#cfgAcessoRede").scrollIntoViewIfNeeded();
  expect(await semRolagemHorizontal(page)).toBe(true);
  const caixa = await page.locator("#cfgAcessoRede").boundingBox();
  expect(caixa.x).toBeGreaterThanOrEqual(0);
  expect(caixa.x + caixa.width).toBeLessThanOrEqual(321);
});
