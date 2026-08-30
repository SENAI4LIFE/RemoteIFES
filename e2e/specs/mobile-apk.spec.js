const crypto = require("crypto");
const fs = require("fs");
const { test, expect, API_URL, injetarSessao, semRolagemHorizontal, publicarApkFixture, despublicarApkFixture } = require("../harness/fixtures");

test.afterEach(async ({ request }) => {
  await despublicarApkFixture(request);
});

test("o APK publicado é anunciado com versão, tamanho, SHA-256 e botão de download", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await injetarSessao(context, "user");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/aplicativo");
  await expect(page.locator("#screen-mobile-app")).toBeVisible();

  await expect(page.locator(".mobile-app-unavailable")).toHaveCount(0);
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();
  await expect(baixar).toContainText("Baixar APK");
  await expect(baixar.locator("svg")).toHaveCount(1);

  const integridade = page.locator(".mobile-app-integrity");
  await expect(integridade).toContainText(meta.version);
  await expect(integridade).toContainText(`build ${meta.build}`);
  await expect(integridade).toContainText("Android 7.0 (API 24)");
  await expect(page.locator(".mobile-app-hash").first()).toContainText(meta.sha256);
  await expect(integridade).toContainText(meta.certificateSha256);

  await expect(page.locator(".mobile-app-instructions h2")).toHaveText(["Instalação", "Atualizações"]);
  expect(await semRolagemHorizontal(page), "página do aplicativo sem rolagem horizontal").toBe(true);
});

test("baixar o APK publicado confirma a integridade pelo SHA-256 exibido", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await injetarSessao(context, "user");
  await page.goto("/#/aplicativo");
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    baixar.click(),
  ]);

  await expect(page.locator(".mobile-app-verify")).toContainText("Integridade confirmada");
  await expect(page.locator(".mobile-app-verify")).not.toHaveClass(/mobile-app-verify-erro/);

  const caminho = await download.path();
  const baixado = crypto.createHash("sha256").update(fs.readFileSync(caminho)).digest("hex");
  expect(baixado, "arquivo salvo é exatamente o artefato anunciado").toBe(meta.sha256);
});

test("um APK adulterado em trânsito é recusado pela verificação de integridade no cliente", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await injetarSessao(context, "user");
  await page.goto("/#/aplicativo");
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();

  await page.route("**/mobile-app/android", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/vnd.android.package-archive" },
      body: Buffer.from("conteudo-adulterado-em-transito"),
    })
  );

  let baixou = false;
  page.on("download", () => {
    baixou = true;
  });
  await baixar.click();

  await expect(page.locator(".mobile-app-verify-erro")).toContainText("verificação de integridade");
  await expect(baixar).toBeEnabled();
  expect(baixou, "nenhum arquivo é salvo quando o hash diverge").toBe(false);
});

test("o endpoint de download entrega exatamente os bytes cujo hash é anunciado", async ({ request, tokens }) => {
  const meta = await publicarApkFixture(request);
  const info = await request.get(`${API_URL}/mobile-app/info`, {
    headers: { Authorization: `Bearer ${tokens.user}` },
  });
  const corpo = await info.json();
  expect(corpo.android.disponivel).toBe(true);
  expect(corpo.android.sha256).toBe(meta.sha256);
  expect(corpo.versao).toBe(meta.version);

  const apk = await request.get(`${API_URL}/mobile-app/android`, {
    headers: { Authorization: `Bearer ${tokens.user}` },
  });
  expect(apk.status()).toBe(200);
  expect(apk.headers()["x-apk-sha256"]).toBe(meta.sha256);
  const bytes = await apk.body();
  expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
});
