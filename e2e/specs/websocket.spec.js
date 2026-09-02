const { test, expect, API_URL } = require("../harness/fixtures");
test("primeiro carregamento com servidor disponível libera o login sem overlay persistente", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await page.locator('.portal-option[data-tipo="normal"]').click();
  await expect(page.locator("#screen-login")).toBeVisible();
  await expect(page.locator("#username")).toBeEditable();
  await expect(page.locator("#password")).toBeEditable();
  await expect(page.locator("#screen-server-status")).toBeHidden();
});

test("falha de rede na primeira conexão recupera o login sem recarregar", async ({ page, context }) => {
  await context.addInitScript(() => {
    const WebSocketNativo = window.WebSocket;
    window.__e2eTentativasWebSocket = 0;
    window.WebSocket = new Proxy(WebSocketNativo, {
      construct(Alvo, argumentos) {
        window.__e2eTentativasWebSocket += 1;
        if (window.__e2eTentativasWebSocket === 1) argumentos[0] = "ws://127.0.0.1:1/ws";
        return Reflect.construct(Alvo, argumentos);
      },
    });
  });

  await page.goto("/");
  await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#serverStatusDesc")).toHaveText("Reconectando automaticamente…");
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#screen-portal")).toBeVisible();
  expect(await page.evaluate(() => window.__e2eTentativasWebSocket)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});

test("a conexão WebSocket entrega a lista de salas em tempo real após a sessão", async ({ page, context }) => {
  const framesSalas = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (data) => {
      const payload = typeof data.payload === "string" ? data.payload : "";
      if (payload.includes('"tipo":"salas"')) framesSalas.push(payload);
    });
  });

  const { injetarSessao } = require("../harness/fixtures");
  await injetarSessao(context, "user");
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => framesSalas.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

test("queda de rede mostra o aviso de conexão e o app se recupera ao voltar", async ({ page, sessaoComo, context, request }) => {
  await sessaoComo("user");
  await expect(page.locator("#screen-server-status")).toBeHidden();

  await context.setOffline(true);
  const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
  expect(fechado.ok()).toBe(true);
  await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#serverStatusTitulo")).toContainText("Sem conexão");
  await expect(page.locator("#serverStatusDesc")).toHaveText("Reconectando automaticamente…");
  await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 25_000 });
  await expect(page.locator("#mainApp")).toBeVisible();
  await expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
});

test("sessão invalidada durante reconexão volta ao login sem loop", async ({ page, context, request }) => {
  const login = await request.post(`${API_URL}/login`, { data: { usuario: "e2e_user", senha: "e2e-user-pass-123" } });
  expect(login.ok()).toBe(true);
  const token = (await login.json()).token;
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("remoteifes_token", t);
    } catch (e) {}
  }, token);
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

  const logout = await request.post(`${API_URL}/logout`, { headers: { Authorization: `Bearer ${token}` } });
  expect(logout.ok()).toBe(true);
  const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
  expect(fechado.ok()).toBe(true);

  await expect(page.locator("#screen-login")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("remoteifes_token"))).toBeNull();
});

for (const papel of ["admin", "superadmin"]) {
  test(`queda temporária para ${papel} mantém somente a reconexão automática`, async ({ page, sessaoComo, context, request }) => {
    await sessaoComo(papel);
    await context.setOffline(true);
    const fechado = await request.post(`${API_URL}/__e2e/fechar-status`);
    expect(fechado.ok()).toBe(true);
    await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator("#serverStatusDesc")).toHaveText("Reconectando automaticamente…");
    await expect(page.locator("#screen-server-config")).toBeHidden();
    await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 25_000 });
  });
}

test("falha HTTP isolada não oferece reconfiguração de infraestrutura", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.route(`${API_URL}/salas`, (route) => route.abort("failed"));
  const resultado = await page.evaluate(async () => Api.listarSalas());
  expect(resultado.ok).toBe(false);
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await expect(page.locator("#screen-server-config")).toBeHidden();
  await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);
});

test("Cordova sem origem usa configuração inicial dedicada e funcional", async ({ page, context }) => {
  await context.addInitScript(() => {
    window.cordova = {};
    if (!window.sessionStorage.getItem("e2e_cordova_config_iniciado")) {
      window.localStorage.removeItem("remoteifes_server_url");
      window.sessionStorage.setItem("e2e_cordova_config_iniciado", "1");
    }
  });
  await page.goto("/");
  await expect(page.locator("#screen-server-config")).toBeVisible();
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await page.locator("#serverConfigUrl").fill("ftp://servidor-invalido");
  await page.locator("#serverConfigForm button[type=submit]").click();
  await expect(page.locator("#serverConfigError")).toBeVisible();
  await page.locator("#serverConfigUrl").fill(API_URL);
  await page.locator("#serverConfigForm button[type=submit]").click();
  await expect(page.locator("#screen-server-config")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
});

test("recarregar a página restaura a sessão sem novo login", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeHidden();
  await expect(page.locator("#userTag")).toContainText("Usuário E2E");
});

test("falha no bootstrap da sessão não deixa o overlay de conexão preso", async ({ page, context }) => {
  const { injetarSessao } = require("../harness/fixtures");
  await injetarSessao(context, "user");
  await context.addInitScript(() => {
    const WebSocketNativo = window.WebSocket;
    window.WebSocket = new Proxy(WebSocketNativo, {
      construct(Alvo, argumentos) {
        if (!window.__e2eLiberarWs) argumentos[0] = "ws://127.0.0.1:1/ws";
        return Reflect.construct(Alvo, argumentos);
      },
    });
  });

  await page.goto("/");
  await expect(page.locator("#screen-server-status")).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => {
    window.restaurarSessaoSalva = () => Promise.reject(new Error("falha simulada ao restaurar a sessão"));
    window.__e2eLiberarWs = true;
  });

  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 20_000 });
});

// Um aparelho que suspende, troca de rede ou perde o servidor pode deixar o socket em
// OPEN sem que nada chegue e sem evento de fechamento. Sem prova de vida ao retomar, o
// app seguiria mostrando salas e telemetria antigas como se fossem o estado atual.
test("socket que ficou meio-aberto é detectado ao retomar e reconectado", async ({ page, context, sessaoComo }) => {
  await context.addInitScript(() => {
    const WebSocketNativo = window.WebSocket;
    window.__e2eConexoes = 0;
    window.__e2eCongelar = null;
    window.WebSocket = new Proxy(WebSocketNativo, {
      construct(Alvo, argumentos) {
        window.__e2eConexoes += 1;
        const real = Reflect.construct(Alvo, argumentos);
        let congelado = false;
        // Reproduz o socket meio-aberto: continua reportando OPEN, mas nada entra e nada sai.
        const fantasma = new Proxy(real, {
          get(alvo, prop) {
            if (prop === "readyState") return congelado ? WebSocketNativo.OPEN : alvo.readyState;
            if (prop === "addEventListener") {
              return (tipo, fn, opcoes) =>
                alvo.addEventListener(tipo, (evento) => { if (!congelado) fn(evento); }, opcoes);
            }
            if (prop === "send") return (dados) => { if (!congelado) alvo.send(dados); };
            const valor = alvo[prop];
            return typeof valor === "function" ? valor.bind(alvo) : valor;
          },
          set(alvo, prop, valor) { alvo[prop] = valor; return true; },
        });
        window.__e2eCongelar = () => { congelado = true; real.close(); };
        return fantasma;
      },
    });
  });

  await sessaoComo("user");
  await expect.poll(() => page.evaluate(() => window.__e2eConexoes)).toBe(1);

  await page.evaluate(() => window.__e2eCongelar());
  expect(await page.evaluate(() => ServerStatus.estaConectado()), "o socket morto ainda se diz conectado").toBe(true);

  const definirVisibilidade = (estado) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => estado });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  await page.evaluate(definirVisibilidade, "hidden");
  await page.waitForTimeout(1500);
  await page.evaluate(definirVisibilidade, "visible");

  await expect.poll(() => page.evaluate(() => window.__e2eConexoes), { timeout: 20_000 }).toBeGreaterThan(1);
  await expect(page.locator("#mainApp")).toBeVisible();
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 20_000 });
});
