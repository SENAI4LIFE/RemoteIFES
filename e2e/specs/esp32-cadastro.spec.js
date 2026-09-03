const { test, expect, API_URL, WEB_URL, injetarSessao, tokenDe } = require("../harness/fixtures");

const SALA = "B-309";
const MAC = "AA:BB:CC:E2:E2:09";

function cartao(page, sala = SALA) {
  return page.locator(`#macCard-${sala}`);
}

async function abrirCadastro(page, context) {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/macs");
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
  await expect(cartao(page)).toBeVisible({ timeout: 20_000 });
}

async function segundaSessao(browser) {
  const contexto = await browser.newContext({ baseURL: WEB_URL });
  await contexto.addInitScript((apiUrl) => {
    try {
      window.localStorage.setItem("remoteifes_server_url", apiUrl);
    } catch (e) {}
  }, API_URL);
  await injetarSessao(contexto, "superadmin");
  const pagina = await contexto.newPage();
  await pagina.goto("/#/admin/macs");
  await expect(pagina.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
  await expect(cartao(pagina)).toBeVisible({ timeout: 20_000 });
  return { contexto, pagina };
}

async function limparCadastro(request) {
  await request.patch(`${API_URL}/admin/salas/${SALA}/mac`, {
    headers: { Authorization: `Bearer ${tokenDe("superadmin")}` },
    data: { mac: null },
  });
}

test.beforeEach(async ({ request }) => {
  await limparCadastro(request);
});

test.afterEach(async ({ request }) => {
  await limparCadastro(request);
});

test("um ESP32 cadastrado aparece na hora em Dispositivos > Cadastro, sem recarregar", async ({ page, context }) => {
  await abrirCadastro(page, context);
  const cartaoSala = cartao(page);
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("sem ESP32 cadastrado");

  await cartaoSala.locator(".mac-input").fill(MAC);
  await cartaoSala.locator(".salvar-mac").click();

  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("ESP32 cadastrado", { timeout: 15_000 });
  await expect(cartaoSala.locator(".mac-error")).toBeHidden();
  await expect(cartaoSala.locator(".mac-input")).toHaveValue(MAC);
  await expect(page.locator(`#macCard-${SALA}`)).toHaveCount(1);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});

test("cadastrar não marca o dispositivo como online", async ({ page, context }) => {
  await abrirCadastro(page, context);
  const cartaoSala = cartao(page);
  await cartaoSala.locator(".mac-input").fill(MAC);
  await cartaoSala.locator(".salvar-mac").click();

  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("ESP32 cadastrado", { timeout: 15_000 });
  await expect(cartaoSala.locator(".mac-conexao-badge")).toHaveText("offline");
});

test("uma segunda sessão autorizada recebe o cadastro sem interagir", async ({ page, context, browser }) => {
  await abrirCadastro(page, context);
  const outra = await segundaSessao(browser);
  try {
    await expect(cartao(outra.pagina).locator(".mac-cadastro-badge")).toHaveText("sem ESP32 cadastrado");

    await cartao(page).locator(".mac-input").fill(MAC);
    await cartao(page).locator(".salvar-mac").click();

    await expect(cartao(outra.pagina).locator(".mac-cadastro-badge")).toHaveText("ESP32 cadastrado", { timeout: 20_000 });
    await expect(cartao(outra.pagina).locator(".mac-input")).toHaveValue(MAC);
    await expect(cartao(outra.pagina).locator(".mac-conexao-badge")).toHaveText("offline");
    await expect(outra.pagina.locator(`#macCard-${SALA}`)).toHaveCount(1);
    expect(await outra.pagina.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
  } finally {
    await outra.contexto.close();
  }
});

test("um cadastro recusado não aparece como cadastrado", async ({ page, context }) => {
  await abrirCadastro(page, context);
  const cartaoSala = cartao(page);

  await cartaoSala.locator(".mac-input").fill("mac-invalido");
  await cartaoSala.locator(".salvar-mac").click();

  await expect(cartaoSala.locator(".mac-error")).toBeVisible();
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("sem ESP32 cadastrado");
  await page.waitForTimeout(500);
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("sem ESP32 cadastrado");
});

test("o cadastro em tempo real não duplica nem troca a sala de um MAC já vinculado", async ({ page, context, request }) => {
  await abrirCadastro(page, context);
  const cartaoSala = cartao(page);

  await cartaoSala.locator(".mac-input").fill(MAC);
  await cartaoSala.locator(".salvar-mac").click();
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("ESP32 cadastrado", { timeout: 15_000 });

  await cartaoSala.locator(".salvar-mac").click();
  await page.waitForTimeout(500);
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveText("ESP32 cadastrado");
  await expect(page.locator(`#macCard-${SALA}`)).toHaveCount(1);
  await expect(cartaoSala.locator(".mac-cadastro-badge")).toHaveCount(1);

  const salas = await (await request.get(`${API_URL}/admin/salas`, {
    headers: { Authorization: `Bearer ${tokenDe("superadmin")}` },
  })).json();
  expect(salas.filter((s) => s.mac === MAC).map((s) => s.sala)).toEqual([SALA]);
});
