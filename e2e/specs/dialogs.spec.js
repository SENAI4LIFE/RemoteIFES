const { test, expect, API_URL, USERS, tokenDe } = require("../harness/fixtures");

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

test("o painel de envio do superadmin não contém a gestão de relatos", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toContainText("Seus relatos enviados");
  await expect(page.locator("#relatosPanel .relato-filtros")).toHaveCount(0);
  await expect(page.locator("#relatosPanel .relatos-gestao-btn")).toBeVisible();
});

test("superadmin gerencia relatos na aba Administração › Relatos de problemas (sem formulário de envio)", async ({ page, sessaoComo, request }) => {
  const criado = await request.post(`${API_URL}/relatos`, {
    headers: { Authorization: `Bearer ${tokenDe("user")}` },
    data: { titulo: "Relato para gestão superadmin", descricao: "Descrição longa o suficiente para passar na validação.", categoria: "interface" },
  });
  expect(criado.ok()).toBeTruthy();

  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="relatos"]').click();
  await expect(page.locator("#adminSub-relatos")).toBeVisible();
  await expect(page.locator("#adminRelatosFiltros .relato-chip")).toHaveCount(5);
  await expect(page.locator("#adminSub-relatos .relatos-novo-btn")).toHaveCount(0);

  const item = page.locator("#adminRelatosLista li").filter({ hasText: "Relato para gestão superadmin" });
  await expect(item).toBeVisible();
  await item.click();
  const card = page.locator(".app-dialog-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Marcar como resolvido" }).click();
  await expect(card).toBeHidden();

  await page.locator('#adminRelatosFiltros .relato-chip[data-status="resolvido"]').click();
  await expect(page.locator("#adminRelatosLista li").filter({ hasText: "Relato para gestão superadmin" })).toBeVisible();
});

test("superadmin exclui um relato enviado, com confirmação explícita", async ({ page, sessaoComo, request }) => {
  const titulo = `Relato para exclusão E2E ${Date.now()}`;
  const criado = await request.post(`${API_URL}/relatos`, {
    headers: { Authorization: `Bearer ${tokenDe("user")}` },
    data: { titulo, descricao: "Descrição longa o suficiente para passar na validação do backend.", categoria: "interface" },
  });
  expect(criado.ok()).toBeTruthy();
  const { relato } = await criado.json();

  await sessaoComo("superadmin");
  await page.goto("/#/admin/relatos");
  await expect(page.locator("#adminSub-relatos")).toBeVisible({ timeout: 20_000 });

  const item = page.locator("#adminRelatosLista li").filter({ hasText: titulo });
  await expect(item).toBeVisible();
  await item.click();

  const card = page.locator(".app-dialog-card");
  await expect(card).toContainText(`Relato #${relato.id}`);
  await card.locator(".relato-excluir-btn").click();
  await expect(card.locator(".relato-detalhe-perigo-aviso")).toContainText("não pode ser desfeita");
  await card.locator(".relato-excluir-confirmar").click();

  await expect(page.locator(".app-dialog-card")).toHaveCount(0);
  await expect(page.locator("#adminRelatosLista li").filter({ hasText: titulo })).toHaveCount(0);

  const depois = await request.get(`${API_URL}/superadmin/relatos/${relato.id}`, {
    headers: { Authorization: `Bearer ${tokenDe("superadmin")}` },
  });
  expect(depois.status()).toBe(404);
});

test("a exclusão de relato é barrada no backend para quem não é superadmin", async ({ request }) => {
  const anon = await request.delete(`${API_URL}/superadmin/relatos/1`);
  expect(anon.status()).toBe(401);
  const comum = await request.delete(`${API_URL}/superadmin/relatos/1`, {
    headers: { Authorization: `Bearer ${tokenDe("admin")}` },
  });
  expect(comum.status()).toBe(403);
});
