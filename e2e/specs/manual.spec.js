const { test, expect, injetarSessao, semRolagemHorizontal, API_URL } = require("../harness/fixtures");

async function abrirApp(page, context, role) {
  if (role) await injetarSessao(context, role);
  await page.goto("/");
  await expect(page.locator(role ? "#mainApp" : "#screen-portal")).toBeVisible({ timeout: 20_000 });
}

async function abrirManualPeloFab(page) {
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await page.locator("#helpFabManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 10_000 });
}

test("\"Precisa de ajuda?\" abre o manual completo, não um popup", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#manualToc .manual-toc-link")).not.toHaveCount(0);
  const total = await page.locator("#manualConteudo .manual-secao").count();
  expect(total).toBeGreaterThanOrEqual(8);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/ajuda/);
});

test("o manual esconde as seções de administração de um usuário comum", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(0);
  await expect(page.locator("#manual-sec-administracao")).toHaveCount(0);
});

test("o manual mostra as seções de administração ao superadministrador", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/monitoramento");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(1);
  await expect(page.locator("#manual-sec-administracao")).toHaveCount(1);
  await expect(page.locator("#manual-sec-operacao-admin")).toHaveCount(1);
  await expect(page.locator("#manual-sec-android-release .manual-command")).not.toHaveCount(0);
});

test("admin herda o manual comum e administrativo, sem procedimentos Superadministrador", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/usuarios-admin");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-controlador")).toHaveCount(1);
  await expect(page.locator("#manual-sec-usuarios-admin")).toHaveCount(1);
  await expect(page.locator("#manual-sec-operacao-admin")).toHaveCount(0);
  await expect(page.locator("#manualConteudo .manual-command")).toHaveCount(0);
});

test("busca do manual filtra as seções", async ({ page, context }) => {
  await abrirApp(page, context, "admin");
  await abrirManualPeloFab(page);
  const total = await page.locator("#manualConteudo .manual-secao").count();
  await page.fill("#manualBusca", "agendamento");
  await expect
    .poll(() => page.locator("#manualConteudo .manual-secao:not(.hidden)").count())
    .toBeLessThan(total);
  await expect(page.locator("#manualConteudo .manual-secao:not(.hidden)")).not.toHaveCount(0);
});

test("\"Ver no app\" leva à tela correspondente e fecha o manual", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/esp32-cadastro");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await page.locator('#manual-sec-esp32-cadastro .manual-ver-app').click();
  await expect(page.locator("#screen-manual")).toBeHidden();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 10_000 });
});

test("o ícone de ajuda de uma tela leva à seção do manual", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-simple")).toBeVisible();
  await page.locator('#screen-simple .help-icon-btn').click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await page.locator("#helpModalManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/selecao-sala");
});

test("Esc fecha o manual e volta para a tela anterior", async ({ page, context }) => {
  await abrirApp(page, context, "admin");
  await page.locator("#gradeTabBtn").click();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await abrirManualPeloFab(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#screen-manual")).toBeHidden();
  await expect(page.locator("#screen-grade")).toBeVisible();
});

test("o manual não faz requisições externas e cabe no celular", async ({ page, context }) => {
  const externas = [];
  await page.route("**/*", (route) => {
    const u = route.request().url();
    const local = u.startsWith("data:") || u.startsWith("blob:") || u.startsWith(API_URL) ||
      u.startsWith("http://127.0.0.1:") || u.startsWith("ws://127.0.0.1:");
    if (!local) externas.push(u);
    route.continue();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await page.locator('.manual-toc-link').nth(3).click();
  expect(externas.filter((u) => !u.includes("cordova.js"))).toEqual([]);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

test("fluxos conceituais permanecem legíveis no celular com fonte ampliada", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("remoteifes_font_scale", "2");
    localStorage.setItem("remoteifes_line_height", "3");
    localStorage.setItem("remoteifes_letter_spacing", "0.25");
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await injetarSessao(context, "user");
  await page.goto("/#/ajuda/controlador");
  await expect(page.locator("#manual-sec-controlador .manual-flow")).toBeVisible({ timeout: 20_000 });
  const geometria = await page.locator("#manual-sec-controlador .manual-flow").evaluate((fluxo) => {
    const caixa = fluxo.getBoundingClientRect();
    return Array.from(fluxo.querySelectorAll(".manual-flow-item")).map((item) => {
      const r = item.getBoundingClientRect();
      return { dentro: r.left >= caixa.left - 1 && r.right <= caixa.right + 1, largura: r.width };
    });
  });
  expect(geometria.length).toBeGreaterThanOrEqual(4);
  expect(geometria.every((item) => item.dentro && item.largura > 0)).toBe(true);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

test("referência cruzada atualiza o deep link sem depender da posição visual", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/#/ajuda/papeis");
  await expect(page.locator("#manual-sec-papeis")).toBeVisible({ timeout: 20_000 });
  await page.locator('#manual-sec-papeis .manual-crosslink[data-sec="controle-acesso-sala"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/controle-acesso-sala");
});

test("a Ajuda pública cobre Início, conta, conexão, acessibilidade e PWA", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  for (const id of ["inicio", "inicio-acoes", "papeis", "conta-sessao", "conexao", "selecao-sala", "controlador", "relatos", "pwa-mobile", "acessibilidade", "solucao-problemas"]) {
    await expect(page.locator(`#manual-sec-${id}`), `seção ${id} da Ajuda`).toHaveCount(1);
  }
  await expect(page.locator("#manual-sec-inicio-acoes")).toContainText("Relatar problema");
  await expect(page.locator("#manual-sec-pwa-mobile")).toContainText("atualiza sozinha");
});

test("todo item do sumário da Ajuda aponta para uma seção existente", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  const orfas = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#manualToc .manual-toc-link"))
      .map((b) => b.dataset.sec)
      .filter((id) => !document.getElementById(`manual-sec-${id}`))
  );
  expect(orfas).toEqual([]);
  const rotas = await page.$$eval("#manualConteudo .manual-ver-app", (bs) => bs.map((b) => b.dataset.rota));
  expect(rotas.length).toBeGreaterThan(0);
  expect(rotas.filter((r) => !/^\/(inicio|salas|agenda|grade|config|aplicativo|admin\/[a-z0-9-]+)$/.test(r))).toEqual([]);
  const linksQuebrados = await page.$$eval("#manualConteudo .manual-crosslink:not(.hidden)", (bs) =>
    bs.map((b) => b.dataset.sec).filter((id) => !document.getElementById(`manual-sec-${id}`))
  );
  expect(linksQuebrados).toEqual([]);
  await expect(page.locator("#manualToc .manual-toc-category")).not.toHaveCount(0);
});

test("Notificações de dispositivos está na Ajuda do administrador e leva à aba correta", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/notificacoes");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-notificacoes")).toContainText("Administração");
  await expect(page.locator("#manual-sec-auditoria")).toHaveCount(0);
  await page.locator("#manual-sec-notificacoes .manual-ver-app").click();
  await expect(page.locator("#adminSub-notificacoes")).toBeVisible({ timeout: 15_000 });
});

test("Auditoria só aparece na Ajuda do superadministrador e Energia não existe mais", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/#/ajuda");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-auditoria")).toHaveCount(0);
  await expect(page.locator("#manual-sec-energia")).toHaveCount(0);
  await expect(page.locator("#manual-sec-notificacoes")).toHaveCount(0);

  await context.clearCookies();
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/auditoria");
  await page.reload();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-auditoria")).toContainText("retenção");
  await expect(page.locator("#manual-sec-energia")).toHaveCount(0);
  await expect(page.locator("#screen-manual")).not.toContainText("Energia estimada");
});

test("os ícones de ajuda das abas novas de Administração abrem a orientação correta", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/notificacoes");
  await expect(page.locator("#adminSub-notificacoes")).toBeVisible({ timeout: 20_000 });
  await page.locator('#adminSub-notificacoes .help-icon-btn').click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await expect(page.locator("#helpModalTitle")).toContainText("Notificações de dispositivos");
  await page.locator("#helpModalManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/notificacoes");

  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#adminSub-auditoria")).toBeVisible({ timeout: 20_000 });
  await page.locator('#adminSub-auditoria .help-icon-btn').click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await expect(page.locator("#helpModalTitle")).toContainText("Auditoria");
});

test("o manual do admin apresenta a Administração agrupada e o grupo Dispositivos", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/administracao");
  const secao = page.locator("#manual-sec-administracao");
  await expect(secao).toBeVisible({ timeout: 20_000 });

  for (const termo of ["Gestão", "Dispositivos", "Monitoramento", "Sistema", "Cadastro", "Histórico", "Notificações", "Firmware / OTA"]) {
    await expect(secao, `manual precisa citar ${termo}`).toContainText(termo);
  }
  await expect(secao).not.toContainText("ESP32 / MACs");
  await expect(secao).toContainText("Administração > Grupo > Função");
});

test("o manual do superadministrador documenta o cadastro imediato e cadastrado ≠ online", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/esp32-cadastro");
  const secao = page.locator("#manual-sec-esp32-cadastro");
  await expect(secao).toBeVisible({ timeout: 20_000 });

  await expect(secao).toContainText("Administração > Dispositivos > Cadastro");
  await expect(secao).toContainText("sem recarregar a página nem reabrir a aba");
  await expect(secao).toContainText("segunda sessão autorizada");
  await expect(secao).toContainText("costuma aparecer offline");
  await expect(secao).not.toContainText("Administração > ESP32 / MACs");

  await secao.locator(".manual-ver-app").click();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 15_000 });
});

test("nenhum tópico visível do manual usa a navegação antiga de Administração", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  const texto = await page.locator("#manualConteudo").innerText();
  for (const obsoleto of ["Administração > ESP32", "Administração > Notificações de dispositivos", "Admin > ESP32"]) {
    expect(texto, `navegação obsoleta no manual: ${obsoleto}`).not.toContain(obsoleto);
  }
  expect(texto).toContain("Administração > Dispositivos > Cadastro");
  expect(texto).toContain("Administração > Dispositivos > Firmware / OTA");
});
