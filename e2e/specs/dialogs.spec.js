const { test, expect, API_URL, USERS } = require("../harness/fixtures");

test("diálogo de troca de senha é estilizado (não é prompt do navegador) e valida o tamanho", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="usuarios"]').click();

  const linha = page.locator('#usuariosList li').filter({ hasText: USERS.passwordTarget.usuario }).first();
  await expect(linha).toBeVisible();
  await linha.locator(".trocar-senha").click();

  const card = page.locator(".app-dialog-card");
  await expect(card).toBeVisible();
  await expect(card.locator("#appDlgPwd1")).toHaveAttribute("type", "password");
  await expect(card.locator("#appDlgPwd2")).toHaveAttribute("type", "password");
  await expect(card.locator(".app-dialog-note")).toContainText("A senha atual nunca é exibida");

  await card.locator("#appDlgPwd1").fill("curta");
  await card.locator("#appDlgPwd2").fill("curta");
  await card.locator(".app-dialog-actions .btn-on").click();
  await expect(card.locator(".app-dialog-error")).toBeVisible();
  await expect(card).toBeVisible();

  await card.locator("#appDlgPwd1").fill("nova-senha-forte-123");
  await card.locator("#appDlgPwd2").fill("nova-senha-forte-123");
  await card.locator(".app-dialog-actions .btn-on").click();
  await expect(page.locator(".app-dialog-card")).toBeHidden();

  const senhaAntiga = await page.request.post(`${API_URL}/login`, {
    data: { usuario: USERS.passwordTarget.usuario, senha: USERS.passwordTarget.senha },
  });
  expect(senhaAntiga.status()).toBe(401);

  const senhaNova = await page.request.post(`${API_URL}/login`, {
    data: { usuario: USERS.passwordTarget.usuario, senha: "nova-senha-forte-123" },
  });
  expect(senhaNova.status()).toBe(200);
});

test("relato de problema: envia um relato válido e ele aparece em 'meus relatos'", async ({ page, sessaoComo }) => {
  await sessaoComo("user");

  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await page.locator(".relatos-novo-btn").click();

  const card = page.locator(".app-dialog-card");
  await expect(card).toBeVisible();
  await expect(card.locator("#relatoContextoNota")).toContainText("Registrado automaticamente");

  await card.locator("#relatoTitulo").fill("no");
  await card.locator("#relatoDescricao").fill("curta");
  await card.locator(".app-dialog-actions .btn-on").click();
  await expect(card.locator(".app-dialog-error")).toBeVisible();

  const titulo = `Falha E2E ${Date.now()}`;
  await card.locator("#relatoTitulo").fill(titulo);
  await card.locator("#relatoDescricao").fill("O painel nao respondeu ao toque no botao de ligar durante o teste automatizado.");
  await card.locator(".app-dialog-actions .btn-on").click();
  await expect(page.locator(".app-dialog-card")).toBeHidden();

  await page.locator("#bugReportBtn").click();
  await expect(page.locator(`#relatosPanel .relato-lista li`).filter({ hasText: titulo })).toBeVisible();
});

test("usuário comum vê apenas os próprios relatos", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toContainText("Seus relatos enviados");
  await expect(page.locator("#relatosPanel .relato-filtros")).toHaveCount(0);
});

test("superadmin vê a caixa global de relatos com chips de filtro", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel .relato-filtros")).toBeAttached();
  await expect(page.locator("#relatosPanel .relato-chip").first()).toBeVisible({ timeout: 10_000 });
});
