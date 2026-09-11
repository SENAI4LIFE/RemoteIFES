const { test, expect, API_URL, SALA_ONLINE, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

const MAXIMO_A11Y = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
  remoteifes_high_contrast: "1",
};

async function resetarProtocolos(request) {
  const resp = await request.post(`${API_URL}/__e2e/resetar-protocolos`);
  if (!resp.ok()) throw new Error(`/__e2e/resetar-protocolos falhou (HTTP ${resp.status()})`);
}

async function estadoEsp32(request) {
  const resp = await request.get(`${API_URL}/__e2e/esp32`);
  return (await resp.json()).esp32;
}

async function capturar(request, captura = {}) {
  const resp = await request.post(`${API_URL}/__e2e/capturar-ir`, { data: captura });
  expect(resp.ok()).toBe(true);
}

async function abrirProtocolos(page, context, papel = "superadmin", { tamanho, a11yMaximo } = {}) {
  await injetarSessao(context, papel);
  if (a11yMaximo) {
    await context.addInitScript((ajustes) => {
      try { Object.entries(ajustes).forEach(([k, v]) => window.localStorage.setItem(k, v)); } catch (e) {}
    }, MAXIMO_A11Y);
  }
  if (tamanho) await page.setViewportSize(tamanho);
  await page.goto("/#/admin/protocolos");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

async function definirClonador(page) {
  await page.locator("#protocolosIrClonadorSelect").selectOption(SALA_ONLINE);
  await page.locator("#protocolosIrSalvarClonadorBtn").click();
  await page.locator(".app-dialog-card .btn-on").click();
  await expect(page.locator("#protocolosIrClonadorStatus")).toContainText(`${SALA_ONLINE}`);
  await expect(page.locator("#protocolosIrClonadorStatus")).toContainText("conectado");
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toBeEnabled({ timeout: 10_000 });
}

async function entrarModoClone(page, request) {
  await page.locator("#protocolosIrToggleCloneBtn").click();
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toHaveText("Sair do modo clone", { timeout: 10_000 });
  await expect.poll(async () => (await estadoEsp32(request)).modo).toBe("config_clone");
}

test.beforeEach(async ({ request }) => {
  await resetarProtocolos(request);
});

test.afterAll(async ({ request }) => {
  await resetarProtocolos(request);
});

test("a função Protocolos IR é exclusiva do superadministrador e fica em Dispositivos", async ({ page, context }) => {
  await abrirProtocolos(page, context, "admin");
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="protocolos"]')).toBeHidden();
  await expect(page.locator("#adminSub-protocolos")).toBeHidden();
  await expect(page.locator("#adminSub-usuarios")).toBeVisible();
  const resp = await page.request.get(`${API_URL}/admin/protocolos-ir`, { headers: { Authorization: `Bearer ${require("../harness/fixtures").tokenDe("admin")}` } });
  expect(resp.status()).toBe(403);
});

test("superadministrador define a clonadora, entra no modo clone e vê a captura chegar em tempo real", async ({ page, context, request }) => {
  await abrirProtocolos(page, context);
  await expect(page.locator("#adminSub-protocolos")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/protocolos");
  await expect(page.locator('.admin-subtab-btn[data-sub="protocolos"] .admin-subtab-label')).toHaveText("Protocolos IR");
  await expect(page.locator('.admin-subtab-btn[data-sub="protocolos"] svg use')).toHaveAttribute("href", "#i-infravermelho");
  await expect(page.locator("#protocolosIrClonadorStatus")).toContainText("Nenhum clonador definido");
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toBeDisabled();

  await capturar(request);
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("Nenhuma captura recebida");

  await definirClonador(page);
  await expect.poll(async () => (await estadoEsp32(request)).role).toBe("cloner");
  await expect(page.locator("#protocolosIrClonadorSelect option:checked")).toContainText("clonador");

  await capturar(request);
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("Nenhuma captura recebida");

  await entrarModoClone(page, request);
  await expect(page.locator("#protocolosIrClonadorStatus")).toContainText("modo clone ativo");
  await capturar(request, { protocol: "COOLIX", hex: "0xB2BF40" });
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("protocolo reconhecido COOLIX", { timeout: 10_000 });
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("10 pulsos");
  await expect(page.locator("#protocolosIrSalvarCapturaBtn")).toBeEnabled();

  await page.locator("#protocolosIrDestinoSelect").selectOption(SALA_ONLINE);
  await page.locator("#protocolosIrTestarCapturaBtn").click();
  await expect.poll(async () => ((await estadoEsp32(request)).ultimoRaw || {}).raw?.length).toBe(10);

  await page.locator("#protocolosIrToggleCloneBtn").click();
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toHaveText("Entrar no modo clone", { timeout: 10_000 });
  await expect.poll(async () => (await estadoEsp32(request)).modo).toBe("operation");
});

test("biblioteca: salvar com nome, recusar duplicata, renomear, aplicar com failsafe, remover failsafe e excluir", async ({ page, context, request }) => {
  test.setTimeout(90_000);
  await abrirProtocolos(page, context);
  await definirClonador(page);
  await entrarModoClone(page, request);

  await capturar(request, { protocol: "COOLIX", hex: "0xB2BF40" });
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("COOLIX", { timeout: 10_000 });
  await page.locator("#protocolosIrLabelInput").fill("A");
  await page.locator("#protocolosIrSalvarCapturaBtn").click();
  await expect(page.locator(".toast-stack")).toContainText("ao menos 2 caracteres");
  await page.locator("#protocolosIrLabelInput").fill("Midea lab 1 - ligar");
  await page.locator("#protocolosIrLabelInput").press("Enter");
  const item = page.locator("#protocolosIrList .protocolos-ir-item");
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await expect(item.first().locator(".protocolos-ir-label")).toHaveText("Midea lab 1 - ligar");
  await expect(item.first()).toContainText("reconhecido · COOLIX");
  await expect(item.first()).toContainText("failsafe OFF não configurado");
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("Nenhuma captura recebida");
  await expect(page.locator("#protocolosIrEmpty")).toBeHidden();

  await capturar(request, { protocol: "COOLIX", hex: "0xB2BF40" });
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("COOLIX", { timeout: 10_000 });
  await page.locator("#protocolosIrLabelInput").fill("MIDEA LAB 1 - LIGAR");
  await page.locator("#protocolosIrSalvarCapturaBtn").click();
  await expect(page.locator(".toast-stack")).toContainText("já existe um protocolo");
  await expect(item).toHaveCount(1);
  await page.locator("#protocolosIrDescartarCapturaBtn").click();
  await expect(page.locator("#protocolosIrSalvarCapturaBtn")).toBeDisabled();

  await item.first().locator(".renomear-btn").click();
  await expect(page.locator("#appDlgTextoInput")).toHaveValue("Midea lab 1 - ligar");
  await page.locator("#appDlgTextoInput").fill("Midea laboratório 1");
  await page.locator(".app-dialog-card .btn-on").click();
  await expect(item.first().locator(".protocolos-ir-label")).toHaveText("Midea laboratório 1");

  await item.first().locator(".failsafe-btn").click();
  await page.locator(".app-dialog-card .btn-on").click();
  await expect(page.locator("#protocolosIrFailsafeAviso")).toBeVisible();
  await expect(page.locator("#protocolosIrFailsafeAviso")).toContainText("Midea laboratório 1");
  await capturar(request, { isKnown: false, protocol: "UNKNOWN", hex: "0x0", raw: [9100, 4450, 570, 550, 570, 1650] });
  await expect(item.first()).toContainText("failsafe OFF configurado · 6 pulsos", { timeout: 10_000 });
  await expect(page.locator("#protocolosIrFailsafeAviso")).toBeHidden();
  await expect(item.first().locator(".failsafe-btn")).toHaveText("recapturar failsafe OFF");
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("Nenhuma captura recebida");

  await page.locator("#protocolosIrDestinoSelect").selectOption(SALA_ONLINE);
  await item.first().locator(".aplicar-btn").click();
  await expect(page.locator(".app-dialog-card")).toContainText("gravado na memória persistente");
  await page.locator(".app-dialog-card .btn-on").click();
  await expect(item.first()).toContainText(`aplicado em ${SALA_ONLINE}`, { timeout: 10_000 });
  await expect.poll(async () => ((await estadoEsp32(request)).failsafe || {}).raw?.length).toBe(6);

  await page.locator('.admin-subtab-btn[data-sub="esp32"]').click();
  const cartao = page.locator(`.esp32-device-card[data-sala="${SALA_ONLINE}"]`);
  await expect(cartao).toBeVisible({ timeout: 15_000 });
  await expect(cartao).toContainText("clonador IR");
  await expect(cartao).toContainText("gravado · 6 pulsos", { timeout: 15_000 });
  await expect(cartao).toContainText("biblioteca #");
  await expect(cartao.locator(".entrar-config-btn")).toHaveCount(0);
  await expect(cartao.locator(".esp32-capture-list")).toHaveCount(0);

  await page.locator('.admin-subtab-btn[data-sub="protocolos"]').click();
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.first().locator(".remover-failsafe-btn").click();
  await page.locator(".app-dialog-card .btn-danger").click();
  await expect(item.first()).toContainText("failsafe OFF não configurado", { timeout: 10_000 });
  await expect.poll(async () => (await estadoEsp32(request)).failsafe).toBe(null);

  await item.first().locator(".excluir-btn").click();
  await page.locator(".app-dialog-card .btn-danger").click();
  await expect(item).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("#protocolosIrEmpty")).toBeVisible();

  await page.locator("#protocolosIrToggleCloneBtn").click();
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toHaveText("Entrar no modo clone", { timeout: 10_000 });
});

test("sinal RAW genérico é guardado e transmitido, mas não pode virar protocolo da sala", async ({ page, context, request }) => {
  await abrirProtocolos(page, context);
  await definirClonador(page);
  await entrarModoClone(page, request);
  await capturar(request, { isKnown: false, protocol: "UNKNOWN", hex: "0x0", raw: [100, 200, 300, 400] });
  await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("sinal RAW genérico", { timeout: 10_000 });
  await page.locator("#protocolosIrLabelInput").fill("Projetor - power");
  await page.locator("#protocolosIrSalvarCapturaBtn").click();
  const item = page.locator("#protocolosIrList .protocolos-ir-item").first();
  await expect(item).toContainText("RAW genérico", { timeout: 10_000 });
  await expect(item.locator(".aplicar-btn")).toHaveCount(0);
  await expect(item.locator(".failsafe-btn")).toHaveCount(0);
  await page.locator("#protocolosIrDestinoSelect").selectOption(SALA_ONLINE);
  await item.locator(".transmitir-btn").click();
  await expect.poll(async () => ((await estadoEsp32(request)).ultimoRaw || {}).raw?.length).toBe(4);
  await page.locator("#protocolosIrToggleCloneBtn").click();
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toHaveText("Entrar no modo clone", { timeout: 10_000 });
});

test("sair da tela encerra a observação e o modo clone é encerrado ao remover o clonador", async ({ page, context, request }) => {
  await abrirProtocolos(page, context);
  await definirClonador(page);
  await entrarModoClone(page, request);
  await page.locator("#protocolosIrClonadorSelect").selectOption("");
  await page.locator("#protocolosIrSalvarClonadorBtn").click();
  await page.locator(".app-dialog-card .btn-danger").click();
  await expect(page.locator("#protocolosIrClonadorStatus")).toContainText("Nenhum clonador definido");
  await expect(page.locator("#protocolosIrToggleCloneBtn")).toBeDisabled();
  await expect.poll(async () => (await estadoEsp32(request)).role).toBe("transmitter");
  await expect.poll(async () => (await estadoEsp32(request)).modo).toBe("operation");
});

for (const tamanhoNome of ["mobile-compact", "mobile-landscape", "tablet-portrait", "desktop"]) {
  test(`Protocolos IR permanece utilizável e sem rolagem horizontal em ${tamanhoNome} com acessibilidade máxima`, async ({ page, context, request }) => {
    test.setTimeout(90_000);
    await abrirProtocolos(page, context, "superadmin", { tamanho: VIEWPORTS[tamanhoNome], a11yMaximo: true });
    await expect(page.locator("#adminSub-protocolos")).toBeVisible({ timeout: 15_000 });
    await definirClonador(page);
    await entrarModoClone(page, request);
    await capturar(request, { protocol: "DAIKIN", hex: "0x11223344556677889900AABBCCDDEEFF", raw: new Array(300).fill(500) });
    await expect(page.locator("#protocolosIrCapturaAtual")).toContainText("DAIKIN", { timeout: 10_000 });
    await page.locator("#protocolosIrLabelInput").fill("Um nome bem comprido para testar a quebra de linha do item da biblioteca");
    await page.locator("#protocolosIrSalvarCapturaBtn").click();
    await expect(page.locator("#protocolosIrList .protocolos-ir-item")).toHaveCount(1, { timeout: 10_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await semRolagemHorizontal(page)).toBe(true);
    const medidas = await page.evaluate(() => {
      const limite = document.documentElement.clientWidth;
      const fora = [...document.querySelectorAll("#adminSub-protocolos *")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > limite + 1 || r.left < -1);
      }).map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
      const botoes = [...document.querySelectorAll("#adminSub-protocolos button")].filter((b) => b.offsetParent !== null);
      const pequenos = botoes.filter((b) => b.getBoundingClientRect().height < 24).map((b) => b.textContent.trim());
      return { fora, pequenos, contraste: document.body.classList.contains("a11y-high-contrast"), escala: getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim() };
    });
    expect(medidas.fora).toEqual([]);
    expect(medidas.pequenos).toEqual([]);
    expect(medidas.contraste).toBe(true);
    expect(medidas.escala).toBe("2");
    await page.locator("#protocolosIrToggleCloneBtn").click();
    await expect(page.locator("#protocolosIrToggleCloneBtn")).toHaveText("Entrar no modo clone", { timeout: 10_000 });
  });
}
