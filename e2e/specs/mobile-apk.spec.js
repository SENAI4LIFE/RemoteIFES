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

// Simula o app empacotado: o build instalado é gravado no bundle no mesmo build do APK,
// então só a versão empacotada consegue afirmar o que está instalado no aparelho.
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

test("o aplicativo publicado é anunciado com versão, data, novidades e ação de download", async ({ page, context, request }) => {
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

test("os detalhes técnicos ficam fora do fluxo principal, mas continuam disponíveis", async ({ page, context, request }) => {
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

test("no navegador a página mostra a versão disponível sem afirmar o que está instalado", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await abrirAplicativo(page, context);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-navegador/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Versão disponível");
  await expect(status).toContainText("não dá para saber qual versão está instalada");
  await expect(page.locator(".mobile-app-download-btn")).toContainText("Baixar aplicativo");
});

test("o aplicativo instalado na versão publicada aparece como atualizado", async ({ page, context, request }) => {
  const meta = await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  await comoAplicativoInstalado(page, meta.build, meta.version);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-atualizada/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Atualizado");
  await expect(status).toContainText(`build ${meta.build}`);
  await expect(status).toContainText("Não é preciso fazer nada");
});

test("um build instalado mais antigo aparece como atualização disponível", async ({ page, context, request }) => {
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

test("sem a versão instalada o app diz isso em vez de adivinhar", async ({ page, context, request }) => {
  await publicarApkFixture(request);
  await abrirAplicativo(page, context);
  await comoAplicativoInstalado(page, null);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-desconhecida/);
  await expect(status.locator(".mobile-app-selo")).toHaveText("Versão instalada indisponível");
  await expect(page.locator(".mobile-app-download-btn")).toBeVisible();
});

test("sem release publicada a página oferece a PWA e não promete download", async ({ page, context }) => {
  await abrirAplicativo(page, context);

  const status = page.locator(".mobile-app-status");
  await expect(status).toHaveClass(/is-indisponivel/);
  await expect(page.locator(".mobile-app-unavailable")).toBeVisible();
  await expect(page.locator(".mobile-app-download-btn")).toHaveCount(0);
  await expect(page.locator(".mobile-app-card.is-recommended h3")).toHaveText("Instalar como PWA");
});

test("uma release publicada enquanto a página está aberta aparece ao voltar ao primeiro plano", async ({ page, context, request }) => {
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

test("baixar o aplicativo publicado confirma a integridade pelo SHA-256 anunciado", async ({ page, context, request }) => {
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

test("um APK adulterado em trânsito é recusado pela verificação de integridade no cliente", async ({ page, context, request }) => {
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

test("o endpoint de download entrega exatamente os bytes cujo hash é anunciado", async ({ request, tokens }) => {
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
  test(`a página do aplicativo cabe na tela e mantém alvos tocáveis (${nome})`, async ({ page, context, request }) => {
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
