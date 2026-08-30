const fs = require("fs");
const path = require("path");
const base = require("@playwright/test");

const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:8791";
const ARQUIVO_TOKENS = path.join(__dirname, ".tokens.json");

const USERS = {
  superadmin: { usuario: "superadmin", senha: "admin", tipo: "admin" },
  admin: { usuario: "e2e_admin", senha: "e2e-admin-pass-123", tipo: "admin" },
  user: { usuario: "e2e_user", senha: "e2e-user-pass-123", tipo: "normal" },
  readonly: { usuario: "e2e_readonly", senha: "e2e-readonly-123", tipo: "normal" },
  passwordTarget: { usuario: "e2e_password_target", senha: "e2e-password-old-123", tipo: "normal" },
};

const SALA_ONLINE = "A-108";

const VIEWPORTS = {
  "mobile-compact": { width: 360, height: 800 },
  "mobile-portrait": { width: 390, height: 844 },
  "mobile-large": { width: 414, height: 896 },
  "mobile-landscape": { width: 844, height: 390 },
  "tablet-compact": { width: 768, height: 1024 },
  "tablet-portrait": { width: 820, height: 1180 },
  "tablet-large": { width: 834, height: 1194 },
  "tablet-landscape": { width: 1180, height: 820 },
  notebook: { width: 1366, height: 768 },
  "desktop-compact": { width: 1440, height: 900 },
  desktop: { width: 1920, height: 1080 },
  "wide-desktop": { width: 2560, height: 1440 },
};

function lerTokens() {
  return JSON.parse(fs.readFileSync(ARQUIVO_TOKENS, "utf8"));
}

function tokenDe(role) {
  const t = lerTokens()[role];
  if (!t) throw new Error(`sem token de sessão para o papel "${role}" (global-setup rodou?)`);
  return t;
}

async function injetarSessao(context, role) {
  await context.addInitScript((token) => {
    try {
      window.localStorage.setItem("remoteifes_token", token);
    } catch (e) {}
  }, tokenDe(role));
}

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.addInitScript((apiUrl) => {
      try {
        window.localStorage.setItem("remoteifes_server_url", apiUrl);
      } catch (e) {}
    }, API_URL);
    await use(context);
  },

  appPage: async ({ page }, use) => {
    await page.goto("/");
    await base.expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
    await use(page);
  },

  loginComo: async ({ page }, use) => {
    async function loginComo(role) {
      const u = USERS[role];
      if (!u) throw new Error(`papel desconhecido: ${role}`);
      await base.expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
      await page.locator(`.portal-option[data-tipo="${u.tipo}"]`).click();
      await base.expect(page.locator("#screen-login")).toBeVisible();
      await page.fill("#username", u.usuario);
      await page.fill("#password", u.senha);
      await page.click("#loginForm button[type=submit]");
      await base.expect(page.locator("#mainApp")).toBeVisible({ timeout: 15_000 });
      await base.expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
    }
    await use(loginComo);
  },

  sessaoComo: async ({ page, context }, use) => {
    async function sessaoComo(role) {
      await injetarSessao(context, role);
      const reset = await page.request.post(`${API_URL}/__e2e/resetar-dispositivo`);
      if (!reset.ok()) throw new Error(`não foi possível preparar o estado do dispositivo E2E (HTTP ${reset.status()})`);
      await page.goto("/");
      await base.expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
      await base.expect(page.locator("#screen-server-status")).toBeHidden();
      await base.expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
    }
    await use(sessaoComo);
  },

  tokens: async ({}, use) => {
    await use(lerTokens());
  },
});

const expect = base.expect;

async function semRolagemHorizontal(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth <= doc.clientWidth + 1;
  });
}

async function publicarApkFixture(request) {
  const resp = await request.post(`${API_URL}/__e2e/publicar-apk`);
  if (!resp.ok()) {
    throw new Error(`/__e2e/publicar-apk falhou (HTTP ${resp.status()}): ${await resp.text()}`);
  }
  const corpo = await resp.json();
  if (!corpo || corpo.ok !== true) {
    throw new Error(`/__e2e/publicar-apk não confirmou a publicação: ${JSON.stringify(corpo)}`);
  }
  return corpo;
}

async function despublicarApkFixture(request) {
  const resp = await request.post(`${API_URL}/__e2e/despublicar-apk`);
  if (!resp.ok()) {
    throw new Error(`/__e2e/despublicar-apk falhou (HTTP ${resp.status()})`);
  }
}

async function irParaSala(page, sala, andar = "1") {
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-simple")).toBeVisible();
  await page.evaluate(() => {
    if (typeof SimpleWizard !== "undefined" && SimpleWizard.irParaBloco) SimpleWizard.irParaBloco();
  });
  await expect(page.locator("#simpleStepBloco")).toBeVisible();
  await page.locator(`#simpleGridBloco .simple-tile[data-bloco="${sala.charAt(0)}"]`).click();
  await page.locator(`#simpleGridAndar .simple-tile[data-andar="${andar}"]`).click();
  await expect(page.locator("#simpleStepSala")).toBeVisible();
  await page.locator(`.simple-tile-sala[data-sala="${sala}"]`).click();
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#panelRoomName")).toContainText(sala);
}

module.exports = {
  test,
  expect,
  API_URL,
  USERS,
  SALA_ONLINE,
  VIEWPORTS,
  lerTokens,
  tokenDe,
  injetarSessao,
  semRolagemHorizontal,
  irParaSala,
  publicarApkFixture,
  despublicarApkFixture,
};
