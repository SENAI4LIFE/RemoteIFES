const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const H = require("../harness/console-harness");

const OPERADOR = "operador";
const SENHA = "senha-de-teste-12345";
const PORTA_APP = Number(process.env.E2E_API_PORT || 8791);
// /api/programa probes the platform's tools; on hosted Windows runners that alone can take minutes.
const PROGRAMA_MS = 120_000;

test.describe.configure({ mode: "serial" });

async function entrar(page, url) {
  await page.goto(`${url}/`);
  await page.locator("#loginNome").fill(OPERADOR);
  await page.locator("#loginSenha").fill(SENHA);
  await page.locator("#formLogin button[type=submit]").click();
  await expect(page.locator("#telaConsole")).toBeVisible();
}

async function semRolagemHorizontal(page) {
  const [largura, janela] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(largura).toBeLessThanOrEqual(janela);
}

async function confirmarSenha(page) {
  await expect(page.locator("#dlgElevacao")).toBeVisible();
  await page.locator("#elevSenha").fill(SENHA);
  await page.locator("#formElevacao button[type=submit]").click();
  await expect(page.locator("#dlgElevacao")).toBeHidden();
}

async function confirmarSenhaSePedida(page, seguinte) {
  const elevacao = page.locator("#dlgElevacao");
  await expect.poll(async () => (await elevacao.isVisible()) || (await seguinte.first().isVisible()), { timeout: 30_000 }).toBe(true);
  if (await elevacao.isVisible()) await confirmarSenha(page);
}

test.describe("first access", () => {
  let amb;
  let consoleUi;

  test.beforeAll(async () => {
    amb = H.prepararAmbiente({ portaAplicacao: PORTA_APP });
    consoleUi = await H.subirConsole(amb);
  });

  test.afterAll(async () => {
    if (consoleUi) await consoleUi.encerrar();
    if (amb) H.limparAmbiente(amb);
  });

  test("the installation secret creates the first operator, who then signs in", async ({ page }) => {
    const segredo = H.gravarSegredoDeInstalacao(amb);
    await page.goto(`${consoleUi.url}/`);
    await expect(page.locator("#entradaTitulo")).toHaveText("Primeiro acesso ao console");
    await page.locator("#paSegredo").fill(segredo);
    await page.locator("#paNome").fill(OPERADOR);
    await page.locator("#paSenha").fill(SENHA);
    await page.locator("#formPrimeiroAcesso button[type=submit]").click();
    await expect(page.locator("#entradaAviso")).toContainText("Operador criado");
    await expect(page.locator("#formLogin")).toBeVisible();
    expect(fs.existsSync(path.join(amb.estado, "bootstrap-token"))).toBe(false);
    await page.locator("#loginNome").fill(OPERADOR);
    await page.locator("#loginSenha").fill(SENHA);
    await page.locator("#formLogin button[type=submit]").click();
    await expect(page.locator("#tituloInicio")).toHaveText(`Olá, ${OPERADOR}`);
  });
});

test.describe("installed console", () => {
  let amb;
  let gh;
  let consoleUi;

  test.beforeAll(async () => {
    gh = await H.servidorGitHub();
    amb = H.prepararAmbiente({ portaAplicacao: PORTA_APP, instalado: true });
    H.criarOperador(amb, OPERADOR, SENHA);
    consoleUi = await H.subirConsole(amb, { githubApi: gh.url });
  });

  test.afterAll(async () => {
    if (consoleUi) await consoleUi.encerrar();
    if (gh) await gh.fechar();
    if (amb) H.limparAmbiente(amb);
  });

  test("every area renders on desktop and on a phone without horizontal scrolling", async ({ page }) => {
    test.setTimeout(300_000);
    const erros = [];
    page.on("pageerror", (e) => erros.push(e.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await entrar(page, consoleUi.url);
    const areas = ["inicio", "servico", "atualizacoes/remoteifes", "atualizacoes/console", "dados", "rede", "aplicativos/web", "aplicativos/android", "aplicativos/ios", "aplicativos/ci", "aplicativos/credenciais", "console", "seguranca"];
    for (const largura of [1280, 390]) {
      await page.setViewportSize({ width: largura, height: largura > 500 ? 900 : 844 });
      for (const area of areas) {
        await page.goto(`${consoleUi.url}/#/${area}`);
        const painel = page.locator(`[data-painel="${area.split("/")[0]}"]`);
        await expect(painel).toBeVisible();
        await expect(painel.locator(".cartao:visible").first()).toBeVisible();
        await semRolagemHorizontal(page);
      }
    }
    await expect(page.locator(".abas-inferiores")).toBeVisible();
    await expect(page.locator(".lateral")).toBeHidden();
    await page.locator("#abaMais").click();
    await page.locator("#maisLista").getByRole("button", { name: "Backups e recuperação" }).click();
    await expect(page).toHaveURL(/#\/dados$/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".lateral")).toBeVisible();
    await expect(page.locator('.nav-item[data-area="dados"]')).toHaveAttribute("aria-current", "page");
    expect(erros).toEqual([]);
  });

  test("RemoteIFES and Console updates are separate, and the Console update carries its version", async ({ page }) => {
    test.setTimeout(240_000);
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/atualizacoes/remoteifes`);
    const remoteifes = page.locator('[data-subpainel="remoteifes"]');
    await expect(remoteifes.getByRole("button", { name: /Atualizar o Console/ })).toHaveCount(0);
    await remoteifes.getByRole("button", { name: "Procurar atualizações" }).click();
    await expect(remoteifes).toContainText("1 commit novo em origin/main");
    await expect(remoteifes).toContainText(amb.assuntoNovo);
    await remoteifes.getByRole("button", { name: /^Atualizar para / }).click();
    await expect(page.locator("#dlgAcao")).toBeVisible();
    await expect(page.locator("#dlgAcaoCorpo")).toContainText('digite "atualizar"');
    await page.locator("#dlgAcao").getByRole("button", { name: "Cancelar" }).click();

    await page.getByRole("tab", { name: /Console de Operações/ }).click();
    const consolePainel = page.locator('[data-subpainel="console"]');
    await expect(consolePainel).toContainText("Console 1.1.0 disponível", { timeout: PROGRAMA_MS });
    await expect(consolePainel.getByRole("button", { name: /^Atualizar para / })).toHaveCount(0);
    const preparo = page.waitForRequest((r) => r.url().endsWith("/api/acoes/console.atualizar/preparar"));
    await consolePainel.getByRole("button", { name: "Atualizar o Console para 1.1.0" }).click();
    expect(JSON.parse((await preparo).postData()).argumentos).toEqual({ versao: "1.1.0" });
    await expect(page.locator("#dlgAcaoCorpo")).toContainText("O RemoteIFES não é afetado");
    await page.locator("#dlgAcao").getByRole("button", { name: "Cancelar" }).click();
    await expect(consolePainel.getByRole("button", { name: "Reverter o Console para 0.9.0" })).toBeVisible();
  });

  test("the GitHub credential is stored with the operator's password and never shown back", async ({ page }) => {
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/aplicativos/ci`);
    await expect(page.locator('[data-subpainel="ci"]')).toContainText("Credencial do GitHub não configurada");
    await page.goto(`${consoleUi.url}/#/aplicativos/credenciais`);
    const token = "github_pat_e2e0000000000000000000000000";
    await page.locator("#githubToken").fill(token);
    await page.getByRole("button", { name: "Gravar credencial" }).click();
    await page.locator("#dlgAcaoConfirmar").click();
    await confirmarSenha(page);
    await expect(page.locator("#toasts")).toContainText("Credencial gravada e acesso conferido");
    const painel = page.locator('[data-subpainel="credenciais"]');
    await expect(painel).toContainText("configurada");
    expect(await page.content()).not.toContain(token);
    await painel.getByRole("button", { name: "Conferir acesso" }).click();
    await expect(painel).toContainText("Acesso confirmado");
  });

  test("CI runs are dispatched, followed, repeated and their artifacts downloaded from the Console", async ({ page }) => {
    test.setTimeout(90_000);
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/aplicativos/ci`);
    const ci = page.locator('[data-subpainel="ci"]');
    await expect(ci).toContainText("CI #813");
    await ci.getByRole("button", { name: /Acompanhar a execução 813/ }).click();
    const dlg = page.locator("#dlgRun");
    await expect(dlg).toContainText("Android / Native smoke (API 36)");
    await expect(dlg.locator("details.job[open]", { hasText: "Native smoke" })).toContainText("Run reactivecircus/android-emulator-runner");
    await dlg.getByRole("button", { name: "Repetir falhas" }).click();
    await page.locator("#dlgAcaoConfirmar").click();
    await confirmarSenhaSePedida(page, page.locator("#toasts .toast"));
    await expect.poll(() => gh.chamadas.some((c) => c.metodo === "POST" && c.caminho.endsWith("/runs/9101/rerun-failed-jobs"))).toBe(true);
    await dlg.getByRole("button", { name: "Fechar" }).last().click();

    await page.goto(`${consoleUi.url}/#/aplicativos/android`);
    const android = page.locator('[data-subpainel="android"]');
    await android.locator("#androidMatrizAmpla").check();
    await android.getByRole("button", { name: "Gerar build de validação" }).click();
    await expect(page.locator("#dlgAcaoCorpo")).toContainText("APIs 24, 29, 34 e 36");
    await page.locator("#dlgAcaoConfirmar").click();
    await confirmarSenhaSePedida(page, dlg);
    await expect(dlg).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toContainText("Android APK #");
    const disparo = gh.chamadas.find((c) => c.metodo === "POST" && c.caminho.endsWith("/workflows/android.yml/dispatches"));
    expect(JSON.parse(disparo.corpo)).toEqual({ ref: "main", inputs: { broad_matrix: true }, return_run_details: true });
    await dlg.getByRole("button", { name: "Fechar" }).last().click();

    await android.getByRole("button", { name: /Acompanhar a execução 44 / }).click();
    const download = page.waitForEvent("download");
    await dlg.getByRole("link", { name: "Baixar android-validation-apks" }).click();
    const arquivo = await download;
    expect(arquivo.suggestedFilename()).toBe("android-validation-apks.zip");
    expect(fs.statSync(await arquivo.path()).size).toBe(2048);
  });

  test("the published APK is downloaded and its integrity checked", async ({ page }) => {
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/aplicativos/android`);
    const android = page.locator('[data-subpainel="android"]');
    await expect(android).toContainText("1.4.0 (build 12)");
    await android.getByRole("button", { name: "Conferir integridade" }).click();
    await expect(android).toContainText("Integridade conferida");
    const download = page.waitForEvent("download");
    await android.getByRole("link", { name: "Baixar APK" }).click();
    const arquivo = await download;
    expect(arquivo.suggestedFilename()).toBe("RemoteIFES-1.4.0-12.apk");
    expect(fs.statSync(await arquivo.path()).size).toBe(48 * 1024);
  });

  test("help opens the manual of the current area, the manual searches, and accessibility persists across logout", async ({ page }) => {
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/dados`);
    await page.locator("#btnAjuda").click();
    await expect(page.locator("#painelAjuda")).toBeVisible();
    await page.locator("#btnAjudaArea").click();
    await expect(page.locator("#manual")).toBeVisible();
    await expect(page.locator('#manualSumario button[aria-current="true"]')).toHaveText("Backups, restauração e recuperação de conta");
    await page.locator("#manualBusca").fill("túnel");
    await expect(page.locator("#manualTexto mark").first()).toBeVisible();
    await expect(page.locator("#manualTexto .manual-secao")).not.toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#manual")).toBeHidden();

    await page.locator("#btnA11y").click();
    await page.getByRole("button", { name: "Aumentar a fonte" }).click();
    await page.getByRole("button", { name: "Alto contraste" }).click();
    await expect(page.locator("body")).toHaveClass(/a11y-contraste/);
    const tamanho = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(await tamanho()).toBe("17.6px");
    await page.keyboard.press("Escape");
    await page.locator("#btnConta").click();
    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page.locator("#formLogin")).toBeVisible();
    await page.reload();
    await expect(page.locator("#formLogin")).toBeVisible();
    expect(await tamanho()).toBe("17.6px");
    await expect(page.locator("body")).toHaveClass(/a11y-contraste/);
    await page.evaluate(() => localStorage.clear());
  });

  test("uninstalling removes only the Console, keeps operators and audit, and the page says so", async ({ page }) => {
    test.skip(process.platform !== "linux", "the Console runs the uninstaller itself only for user installations on Linux and macOS; the CI exercises it on Linux");
    test.setTimeout(90_000);
    await entrar(page, consoleUi.url);
    await page.goto(`${consoleUi.url}/#/console`);
    const area = page.locator('[data-painel="console"]');
    await expect(area).toContainText("Remove apenas o Console de Operações", { timeout: PROGRAMA_MS });
    await area.getByRole("button", { name: "Desinstalar o Console…" }).click();
    const dlg = page.locator("#dlgAcao");
    await expect(dlg).toContainText("O RemoteIFES NÃO é removido");
    await page.locator("#dlgAcaoConfirmar").click();
    await expect(page.locator("#toasts")).toContainText('Digite exatamente "desinstalar"');
    await page.locator("#campoConfirmacao").fill("desinstalar");
    await page.locator("#dlgAcaoConfirmar").click();
    await confirmarSenhaSePedida(page, page.locator("#dlgTrabalho"));
    await expect(page.locator("#telaEncerrado")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#encerradoConteudo")).toContainText("O RemoteIFES continua funcionando");
    await expect.poll(() => fs.existsSync(amb.raizInstalacao), { timeout: 30_000 }).toBe(false);
    expect(fs.existsSync(path.join(amb.estado, "operadores.json"))).toBe(true);
    expect(fs.existsSync(path.join(amb.estado, "auditoria.log"))).toBe(true);
    expect(fs.existsSync(path.join(amb.checkout, "remoteifes-server", "package.json"))).toBe(true);
    await expect.poll(() => consoleUi.processo.exitCode !== null || consoleUi.processo.signalCode !== null, { timeout: 15_000 }).toBe(true);
    expect((await fetch(`http://127.0.0.1:${PORTA_APP}/health`)).ok).toBe(true);
  });
});
