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
  // O item do menu de ajuda que abriu o manual já está escondido: o foco vai ao botão de ajuda.
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
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
  expect(rotas.filter((r) => !/^\/(inicio|salas|agenda|grade|config|aplicativo|admin\/[a-z0-9-]+(\/[a-z0-9-]+)?)$/.test(r))).toEqual([]);
  const linksQuebrados = await page.$$eval("#manualConteudo .manual-crosslink:not(.hidden)", (bs) =>
    bs.map((b) => b.dataset.sec).filter((id) => !document.getElementById(`manual-sec-${id}`))
  );
  expect(linksQuebrados).toEqual([]);
  await expect(page.locator("#manualToc .manual-toc-category")).not.toHaveCount(0);
});

test("Notificações do sistema está na Ajuda do administrador e leva à aba correta", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/notificacoes");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-notificacoes")).toContainText("Administração > Dispositivos > Alertas");
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
  await expect(page.locator("#helpModalTitle")).toContainText("Notificações do sistema");
  await page.locator("#helpModalManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/notificacoes");

  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#logsAba-auditoria")).toBeVisible({ timeout: 20_000 });
  await page.locator('#logsAba-auditoria .help-icon-btn').click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await expect(page.locator("#helpModalTitle")).toContainText("Auditoria");
});

// A ajuda de Status > Mapa e a de Logs > Sessões abrem tópicos cujo "Ver no app" volta à mesma
// aba, e não a um tópico vizinho (proprietários, usuários ativos).
test("a ajuda do Mapa e a do histórico de Sessões levam a tópicos próprios, que voltam à mesma aba", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  for (const [rota, painel, titulo, secao] of [
    ["/#/admin/status/mapa", "#statusAba-mapa", "Status > Mapa", "status-mapa"],
    ["/#/admin/logs/sessoes", "#logsAba-sessoes", "Logs > Sessões", "sessoes-historico"],
  ]) {
    await page.goto(rota);
    await expect(page.locator(painel)).toBeVisible({ timeout: 20_000 });
    await page.locator(`${painel} .help-icon-btn`).click();
    await expect(page.locator("#helpModalTitle")).toContainText(titulo);
    await page.locator("#helpModalManualBtn").click();
    await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/ajuda/${secao}`);
    await expect(page.locator(`#manualToc .manual-toc-link[data-sec="${secao}"]`)).toHaveClass(/is-active/);
    await page.locator(`#manual-sec-${secao} .manual-ver-app`).click();
    await expect(page.locator(painel)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(rota.slice(1));
  }
});

test("o manual do admin apresenta a Administração agrupada e o grupo Dispositivos", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/administracao");
  const secao = page.locator("#manual-sec-administracao");
  await expect(secao).toBeVisible({ timeout: 20_000 });

  for (const termo of [
    "Gestão", "Dispositivos", "Sistema", "Usuários", "Contas", "Proprietários de sala",
    "Cadastro", "Firmware / OTA", "Alertas", "Logs", "Acessos", "Sessões", "Auditoria",
    "Status", "Usuários ativos", "Mapa", "Configurações",
  ]) {
    await expect(secao, `manual precisa citar ${termo}`).toContainText(termo);
  }
  await expect(secao).not.toContainText("ESP32 / MACs");
  await expect(secao).not.toContainText("Saúde do sistema");
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

test("\"Ver no app\" das seções movidas abre a aba interna correspondente", async ({ page, context }) => {
  test.setTimeout(90_000);
  await injetarSessao(context, "superadmin");
  for (const [secao, painel, rota] of [
    ["proprietarios-admin", "#usuariosAba-proprietarios", "#/admin/usuarios/proprietarios"],
    ["ativos-sessoes", "#statusAba-ativos", "#/admin/status"],
    ["status-mapa", "#statusAba-mapa", "#/admin/status/mapa"],
    ["sessoes-historico", "#logsAba-sessoes", "#/admin/logs/sessoes"],
    ["logs-dispositivos", "#logsAba-comandos", "#/admin/logs"],
    ["auditoria", "#logsAba-auditoria", "#/admin/logs/auditoria"],
    ["monitoramento", "#statusAba-sistema", "#/admin/status/sistema"],
  ]) {
    await page.goto(`/#/ajuda/${secao}`);
    await expect(page.locator(`#manual-sec-${secao} .manual-ver-app`)).toBeVisible({ timeout: 20_000 });
    await page.locator(`#manual-sec-${secao} .manual-ver-app`).click();
    await expect(page.locator(painel), `${secao} → ${painel}`).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(rota);
  }
});

test("nenhum tópico visível do manual usa a navegação antiga de Administração", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  const texto = await page.locator("#manualConteudo").innerText();
  for (const obsoleto of [
    "Administração > ESP32",
    "Administração > Notificações de dispositivos",
    "Admin > ESP32",
    "Administração > Monitoramento",
    "Administração > Sistema > Sessões",
    "Administração > Gestão > Sessões",
    "Administração > Gestão > Ativos",
    "Administração > Gestão > Mapa",
    "Administração > Gestão > Proprietários de sala",
    "Administração > Dispositivos > Histórico",
    "Administração > Dispositivos > Notificações",
    "Administração > Sistema > Auditoria",
    "Acessos ESP32",
    "Saúde do sistema",
  ]) {
    expect(texto, `navegação obsoleta no manual: ${obsoleto}`).not.toContain(obsoleto);
  }
  expect(texto).toContain("Administração > Dispositivos > Cadastro");
  expect(texto).toContain("Administração > Dispositivos > Firmware / OTA");
  expect(texto).toContain("Administração > Dispositivos > Alertas");
  expect(texto).toContain("Administração > Gestão > Usuários > Proprietários de sala");
  expect(texto).toContain("Administração > Sistema > Logs > Sessões");
  expect(texto).toContain("Administração > Sistema > Logs > Dispositivos");
  expect(texto).toContain("Administração > Sistema > Logs > Auditoria");
  expect(texto).toContain("Administração > Sistema > Status > Usuários ativos");
  expect(texto).toContain("Administração > Sistema > Status > Mapa");
  expect(texto).toContain("Administração > Sistema > Status > Sistema");
});

test("reabrir o manual depois de uma busca sem resultado começa com o sumário completo e a busca limpa", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await page.fill("#manualBusca", "zzzz-nada-disso");
  await expect(page.locator("#manualTocVazio")).toBeVisible();
  await expect(page.locator("#manualConteudo .manual-secao:not(.hidden)")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#screen-manual")).toBeHidden();

  await abrirManualPeloFab(page);
  await expect(page.locator("#manualBusca")).toHaveValue("");
  await expect(page.locator("#manualTocVazio")).toBeHidden();
  const total = await page.locator("#manualConteudo .manual-secao").count();
  expect(total).toBeGreaterThan(0);
  await expect(page.locator("#manualConteudo .manual-secao:not(.hidden)")).toHaveCount(total);
  await expect(page.locator("#manualToc li:not(.hidden) .manual-toc-link")).toHaveCount(total);

  // Abrir um tópico específico também parte limpo, e vai ao tópico.
  await page.fill("#manualBusca", "zzzz-nada-disso");
  await page.keyboard.press("Escape");
  await page.evaluate(() => Router.ir("/ajuda/conta-sessao"));
  await expect(page.locator("#screen-manual")).toBeVisible();
  await expect(page.locator("#manualBusca")).toHaveValue("");
  await expect(page.locator('#manualToc .manual-toc-link[data-sec="conta-sessao"]')).toHaveClass(/is-active/);
});

// Sem service worker, para a rede de verdade decidir: um módulo público que não chega é avisado
// (com as seções que chegaram) e volta na próxima abertura; o registro falhando, nada é
// registrado duas vezes depois.
test("um módulo público que não carrega é avisado e recarregado na próxima abertura, sem seções duplicadas", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", baseURL: process.env.E2E_WEB_URL });
  await context.addInitScript((apiUrl) => { try { window.localStorage.setItem("remoteifes_server_url", apiUrl); } catch (e) {} }, API_URL);
  await injetarSessao(context, "user");
  const page = await context.newPage();
  const bloqueados = { "manual-content.js": true, "common-rooms.js": true };
  const interceptar = (route) => {
    const nome = route.request().url().split("/").pop().split("?")[0];
    if (bloqueados[nome]) return route.abort();
    return route.continue();
  };
  await page.route("**/js/manual-content.js*", interceptar);
  await page.route("**/js/manual/*", interceptar);
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  await abrirManualPeloFab(page);
  await expect(page.locator("#manualConteudo .manual-carga-falhou")).toContainText("O manual não pôde ser carregado");
  await expect(page.locator("#manualConteudo .manual-secao")).toHaveCount(0);
  await expect(page.locator("#manualTocVazio"), "sem busca, o aviso de busca vazia não aparece").toBeHidden();

  bloqueados["manual-content.js"] = false;
  await page.locator("#manualConteudo .manual-recarregar").click();
  await expect(page.locator("#manualConteudo .manual-carga-falhou")).toContainText("Parte do manual não pôde ser carregada");
  const parcial = await page.locator("#manualConteudo .manual-secao").count();
  expect(parcial).toBeGreaterThan(0);
  await expect(page.locator("#manual-sec-controlador")).toHaveCount(0);

  bloqueados["common-rooms.js"] = false;
  await page.keyboard.press("Escape");
  await abrirManualPeloFab(page);
  await expect(page.locator("#manualConteudo .manual-carga-falhou")).toHaveCount(0);
  await expect(page.locator("#manual-sec-controlador")).toHaveCount(1);
  const total = await page.locator("#manualConteudo .manual-secao").count();
  expect(total).toBeGreaterThan(parcial);
  const ids = await page.evaluate(() => [...document.querySelectorAll("#manualConteudo .manual-secao")].map((s) => s.id));
  expect(new Set(ids).size).toBe(ids.length);
  await context.close();
});

test("a documentação privilegiada não sobrevive ao logout, nem quando a resposta chega depois de sair", async ({ page, context }) => {
  await abrirApp(page, context, "superadmin");
  // O token do superadmin é compartilhado pelos demais testes: a saída é feita só no cliente,
  // que é onde o conteúdo privilegiado precisa ser descartado.
  await page.route(`${API_URL}/logout`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  let liberar = null;
  await page.route("**/documentation", async (route) => {
    await new Promise((resolve) => { liberar = resolve; });
    await route.continue();
  });
  const abrindo = page.locator("#helpFabToggleBtn").click();
  await expect.poll(() => liberar !== null, "a requisição da documentação está em voo").toBe(true);
  await page.locator("#accountMenuBtn").click();
  await page.locator('#accountMenu [data-account-action="logout"]').click();
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 10_000 });
  liberar();
  await abrindo;
  await expect.poll(() => page.evaluate(() => RoleDocumentation.secoes().length), "a resposta tardia é descartada").toBe(0);

  // Sem sessão, o manual mostra só o conteúdo público.
  await page.evaluate(() => Router.ir("/ajuda"));
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#manual-sec-operacao-admin")).toHaveCount(0);
  await expect(page.locator("#manual-sec-inicio")).toHaveCount(1);
});

// Acima de 760px o sumário fica ao lado e os passos dos fluxos ficam em linha: o texto de cada
// passo quebra dentro da caixa (inclusive "Superadministrador:" e o texto máximo), sem rolagem
// horizontal do artigo nem passo saindo da figura. A variante com fonte larga (Verdana, ou
// DejaVu Sans no Linux) reproduz em qualquer plataforma o que só as fontes do Linux mostravam:
// o rótulo dos comandos ("Resultado esperado") tomava a largura e o valor vazava do artigo.
for (const [nome, tamanho, ampliado, fonteLarga] of [
  ["761x900", { width: 761, height: 900 }, false, false],
  ["notebook com texto máximo", { width: 1366, height: 768 }, true, false],
  ["celular deitado com texto máximo", { width: 844, height: 390 }, true, false],
  ["celular deitado com texto máximo e fonte larga", { width: 844, height: 390 }, true, true],
]) {
  test(`os passos dos fluxos ficam dentro da figura e o artigo não rola na horizontal em ${nome}`, async ({ page, context }) => {
    if (ampliado) {
      await context.addInitScript(() => {
        localStorage.setItem("remoteifes_font_scale", "2");
        localStorage.setItem("remoteifes_line_height", "3");
        localStorage.setItem("remoteifes_letter_spacing", "0.25");
      });
    }
    await page.setViewportSize(tamanho);
    await injetarSessao(context, "superadmin");
    await page.goto("/#/ajuda/administracao");
    await expect(page.locator("#manual-sec-administracao .manual-flow")).toBeVisible({ timeout: 20_000 });
    if (fonteLarga) await page.addStyleTag({ content: '#manualConteudo, #manualConteudo * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
    const medida = await page.evaluate(() => {
      const artigo = document.getElementById("manualConteudo");
      const fora = [];
      for (const fluxo of artigo.querySelectorAll(".manual-flow")) {
        const caixa = fluxo.getBoundingClientRect();
        for (const item of fluxo.querySelectorAll(".manual-flow-item")) {
          const r = item.getBoundingClientRect();
          const texto = item.querySelector("span:last-child").getBoundingClientRect();
          if (r.right > caixa.right + 1 || texto.right > r.right + 1) fora.push(item.textContent.trim().slice(0, 40));
        }
      }
      return { fora, artigoRola: artigo.scrollWidth > artigo.clientWidth + 1 };
    });
    expect(medida.fora, "passos ou textos fora da própria caixa").toEqual([]);
    expect(medida.artigoRola, "o artigo do manual não ganha rolagem horizontal").toBe(false);
    expect(await semRolagemHorizontal(page)).toBe(true);
  });
}
