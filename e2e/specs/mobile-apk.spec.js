const crypto = require("crypto");
const fs = require("fs");
const { test, expect, API_URL, VIEWPORTS, injetarSessao, semRolagemHorizontal, publicarApkFixture, despublicarApkFixture } = require("../harness/fixtures");

test.afterEach(async ({ request }) => {
  await despublicarApkFixture(request);
});

async function abrirAplicativo(page, context) {
  await injetarSessao(context, "user");
  await page.goto("/#/aplicativo");
  await expect(page.locator("#screen-mobile-app")).toBeVisible();
}

// Simulates the packaged app: the installed build is written into the bundle by the same build that
// produces the APK, so only the packaged version can state what is installed on the device.
async function comoAplicativoInstalado(page, build, versao = "1.0.0") {
  await page.evaluate(({ build, versao }) => {
    window.RemoteIFESConfig.empacotado = true;
    window.RemoteIFESConfig.appAndroidVersao = versao;
    window.RemoteIFESConfig.appAndroidBuild = build;
    location.hash = "#/inicio";
  }, { build, versao });
  await expect(page.locator("#screen-mobile-app")).toBeHidden();
  await page.evaluate(() => { location.hash = "#/aplicativo"; });
  await expect(page.locator("#screen-mobile-app")).toBeVisible();
  await expect(page.locator(".mobile-app-status")).toBeVisible();
}

test("the published app is announced with version, date, release notes and a download action", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await abrirAplicativo(page, context);

  await expect(page.locator(".mobile-app-unavailable")).toHaveCount(0);
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();
  await expect(baixar).toContainText("Baixar aplicativo");
  await expect(baixar.locator("svg")).toHaveCount(1);

  await expect(page.locator(".mobile-app-versao")).toContainText(meta.version);
  await expect(page.locator(".mobile-app-versao")).toContainText("01/09/2026");
  await expect(page.locator(".mobile-app-notas li")).toHaveText(["Correções de estabilidade no controle das salas."]);
  await expect(page.locator(".mobile-app-instructions h2")).toHaveText(["Como instalar", "Atualizações"]);
  expect(await semRolagemHorizontal(page), "página do aplicativo sem rolagem horizontal").toBe(true);
});

test("technical details stay out of the main flow but remain available", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await abrirAplicativo(page, context);

  const tecnico = page.locator(".mobile-app-tecnico");
  await expect(tecnico.locator(".mobile-app-hash").first()).toBeHidden();
  await tecnico.locator("summary").click();

  const integridade = tecnico.locator(".mobile-app-integrity");
  await expect(integridade).toContainText(meta.version);
  await expect(integridade).toContainText(`build ${meta.build}`);
  await expect(integridade).toContainText("Android 7.0 (API 24)");
  await expect(tecnico.locator(".mobile-app-hash").first()).toContainText(meta.sha256);
  await expect(integridade).toContainText(meta.certificateSha256);
});

test("in the browser the page shows the available version without claiming what is installed", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await abrirAplicativo(page, context);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-navegador/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Versão disponível");
  await expect(status).toContainText("não dá para saber qual versão está instalada");
  await expect(page.locator(".mobile-app-download-btn")).toContainText("Baixar aplicativo");
});

test("an app installed at the published version appears as up to date", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  await comoAplicativoInstalado(page, meta.build, meta.version);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-atualizada/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Atualizado");
  await expect(status).toContainText(`build ${meta.build}`);
  await expect(status).toContainText("Não é preciso fazer nada");
});

test("an older installed build appears as an available update", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  await comoAplicativoInstalado(page, "9000", "0.9.0");

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-desatualizada/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Atualização disponível");
  await expect(status).toContainText("Instalada: 0.9.0 (build 9000)");
  await expect(status).toContainText(`Publicada: ${meta.version} (build ${meta.build})`);
  await expect(page.locator(".mobile-app-download-btn")).toContainText("Baixar atualização");
  await expect(page.locator(".mobile-app-instructions h2").first()).toHaveText("Como atualizar");
});

test("without the installed version the app says so instead of guessing", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  await comoAplicativoInstalado(page, null);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-desconhecida/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Versão instalada indisponível");
  await expect(page.locator(".mobile-app-download-btn")).toBeVisible();
});

test("without a published release the page offers the PWA and does not promise a download", async ({ page, context }) => {
  await abrirAplicativo(page, context);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-indisponivel/);
  await expect(page.locator(".mobile-app-unavailable")).toBeVisible();
  await expect(page.locator(".mobile-app-download-btn")).toHaveCount(0);
  await expect(page.locator(".mobile-app-card.is-recommended h3")).toHaveText("Instalar como PWA");
});

test("a release published while the page is open appears when returning to the foreground", async ({ page, context, request }) => {
  await abrirAplicativo(page, context);
  await expect(page.locator(".mobile-app-status")).toHaveClass(/is-indisponivel/);

  const meta = await publicarApkFixture(request);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(page.locator(".mobile-app-download-btn")).toBeVisible();
  await expect(page.locator(".mobile-app-versao")).toContainText(meta.version);
});

test("downloading the published app confirms integrity through the announced SHA-256", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    baixar.click(),
  ]);

  await expect(page.locator(".mobile-app-verify")).toContainText("Integridade confirmada");
  await expect(page.locator(".mobile-app-verify")).not.toHaveClass(/mobile-app-verify-erro/);
  expect(download.suggestedFilename()).toBe(`RemoteIFES-${meta.version}-${meta.build}.apk`);

  const caminho = await download.path();
  const baixado = crypto.createHash("sha256").update(fs.readFileSync(caminho)).digest("hex");
  expect(baixado, "arquivo salvo é exatamente o artefato anunciado").toBe(meta.sha256);
});

async function semCryptoSubtle(context) {
  await context.addInitScript(() => {
    Object.defineProperty(window.crypto, "subtle", { configurable: true, get: () => undefined });
  });
}

test("on an HTTP origin without crypto.subtle (local network without HTTPS) the download still checks the SHA-256", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await semCryptoSubtle(context);
  await abrirAplicativo(page, context);
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe("undefined");
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), baixar.click()]);

  await expect(page.locator(".mobile-app-verify")).toContainText("Integridade confirmada");
  await expect(page.locator(".mobile-app-verify")).not.toHaveClass(/mobile-app-verify-erro/);
  const baixado = crypto.createHash("sha256").update(fs.readFileSync(await download.path())).digest("hex");
  expect(baixado).toBe(meta.sha256);
});

test("on an HTTP origin without crypto.subtle a tampered APK is still refused", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await semCryptoSubtle(context);
  await abrirAplicativo(page, context);
  const baixar = page.locator(".mobile-app-download-btn");
  await expect(baixar).toBeVisible();
  await page.route("**/mobile-app/android", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/vnd.android.package-archive" }, body: Buffer.from("conteudo-adulterado-em-transito") })
  );
  let baixou = false;
  page.on("download", () => {
    baixou = true;
  });
  await baixar.click();
  await expect(page.locator(".mobile-app-verify-erro")).toContainText("verificação de integridade");
  expect(baixou).toBe(false);
});

test("an APK tampered with in transit is refused by the client integrity check", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await abrirAplicativo(page, context);
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

test("the download endpoint delivers exactly the bytes whose hash is announced", async ({ request, tokens }) => {
  const meta = await publicarApkFixture(request);
  const info = await request.get(`${API_URL}/mobile-app/info`, {
    headers: { Authorization: `Bearer ${tokens.user}` },
  });
  const corpo = await info.json();
  expect(corpo.android.disponivel).toBe(true);
  expect(corpo.android.sha256).toBe(meta.sha256);
  expect(corpo.android.dataPublicacao).toBe("2026-09-01");
  expect(corpo.versao).toBe(meta.version);

  const apk = await request.get(`${API_URL}/mobile-app/android`, {
    headers: { Authorization: `Bearer ${tokens.user}` },
  });
  expect(apk.status()).toBe(200);
  expect(apk.headers()["x-apk-sha256"]).toBe(meta.sha256);
  const bytes = await apk.body();
  expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
});

for (const nome of ["mobile-compact", "mobile-portrait", "tablet-compact", "notebook"]) {
  test(`the app page fits on screen and keeps touch targets (${nome})`, async ({ page, context, request }) => {
    await publicarApkFixture(request);
    await page.setViewportSize(VIEWPORTS[nome]);
    await abrirAplicativo(page, context);
    await expect(page.locator(".mobile-app-download-btn")).toBeVisible();

    expect(await semRolagemHorizontal(page), "sem rolagem horizontal").toBe(true);
    const alturaBotao = await page.locator(".mobile-app-download-btn").evaluate((el) => el.getBoundingClientRect().height);
    expect(alturaBotao, "botão principal tocável").toBeGreaterThanOrEqual(44);
    const alturaResumo = await page.locator(".mobile-app-detalhes summary").first().evaluate((el) => el.getBoundingClientRect().height);
    expect(alturaResumo, "resumo dos detalhes tocável").toBeGreaterThanOrEqual(44);
    const largura = await page.locator(".mobile-app-status").evaluate((el) => el.getBoundingClientRect().width);
    const viewport = page.viewportSize().width;
    expect(largura, "cartão de estado dentro da tela").toBeLessThanOrEqual(viewport);
  });
}
