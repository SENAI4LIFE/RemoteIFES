const { test, expect, API_URL } = require("../harness/fixtures");
test("first load with the server available enables login without a persistent overlay", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await page.locator('.portal-option[data-tipo="normal"]').click();
  await expect(page.locator("#screen-login")).toBeVisible();
  await expect(page.locator("#username")).toBeEditable();
  await expect(page.locator("#password")).toBeEditable();
  await expect(page.locator("#screen-server-status")).toBeHidden();
});

test("a network failure on the first connection recovers login without reloading", async ({ page, context }) => {
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

test("the WebSocket connection delivers the room list in real time after the session", async ({ page, context }) => {
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

test("a network drop shows the connection notice and the app recovers when it returns", async ({ page, sessaoComo, context, request, browserName }) => {
  test.skip(browserName === "webkit", "a emulação offline do Playwright não interrompe WebSockets no WebKit, então a queda de rede não é reproduzível nesse motor");
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

test("a session invalidated during reconnection returns to login without looping", async ({ page, context, request }) => {
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
  test(`a temporary drop for ${papel} keeps only the automatic reconnection`, async ({ page, sessaoComo, context, request, browserName }) => {
    test.skip(browserName === "webkit", "a emulação offline do Playwright não interrompe WebSockets no WebKit, então a queda de rede não é reproduzível nesse motor");
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

async function tokenInvalidado(request) {
  const login = await request.post(`${API_URL}/login`, { data: { usuario: "e2e_user", senha: "e2e-user-pass-123" } });
  expect(login.ok()).toBe(true);
  const token = (await login.json()).token;
  const logout = await request.post(`${API_URL}/logout`, { headers: { Authorization: `Bearer ${token}` } });
  expect(logout.ok()).toBe(true);
  return token;
}

test("a saved token the server no longer accepts leads to the portal with the connection active, without getting stuck on the notice", async ({ page, context, request }) => {
  const token = await tokenInvalidado(request);
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("remoteifes_token", t);
    } catch (e) {}
  }, token);

  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("remoteifes_token"))).toBeNull();
  await expect.poll(() => page.evaluate(() => ServerStatus.estaConectado()), { timeout: 10_000 }).toBe(true);

  await page.waitForTimeout(1500);
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await page.locator('.portal-option[data-tipo="normal"]').click();
  await expect(page.locator("#screen-login")).toBeVisible();
  await expect(page.locator("#username")).toBeEditable();
});

const FALHAS_TRANSITORIAS_ME = {
  "queda de rede": (route) => route.abort("failed"),
  "resposta truncada": (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":tr' }),
  "erro 502 do proxy": (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad Gateway</h1>" }),
};

for (const [falha, responder] of Object.entries(FALHAS_TRANSITORIAS_ME)) {
  test(`${falha} while restoring the session neither ends the server session nor discards the token`, async ({ page, context, request }) => {
    const login = await request.post(`${API_URL}/login`, { data: { usuario: "e2e_user", senha: "e2e-user-pass-123" } });
    expect(login.ok()).toBe(true);
    const token = (await login.json()).token;
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem("remoteifes_token", t);
      } catch (e) {}
    }, token);

    const chamadasLogout = [];
    await page.route(`${API_URL}/logout`, (route) => {
      chamadasLogout.push(route.request().url());
      return route.continue();
    });
    let primeiraChamada = true;
    await page.route(`${API_URL}/me`, (route) => {
      if (!primeiraChamada) return route.continue();
      primeiraChamada = false;
      return responder(route);
    });

    await page.goto("/");
    await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#screen-server-status")).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(chamadasLogout, "nenhum logout é enviado por uma falha transitória").toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("remoteifes_token"))).toBe(token);

    const me = await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.ok(), "a sessão continua válida no servidor").toBe(true);

    await page.reload();
    await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#userTag")).toContainText("Usuário E2E");
  });
}

test("an isolated HTTP failure does not offer infrastructure reconfiguration", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.route(`${API_URL}/salas`, (route) => route.abort("failed"));
  const resultado = await page.evaluate(async () => Api.listarSalas());
  expect(resultado.ok).toBe(false);
  await expect(page.locator("#screen-server-status")).toBeHidden();
  await expect(page.locator("#screen-server-config")).toBeHidden();
  await expect(page.getByText("Configurar endereço do servidor", { exact: true })).toHaveCount(0);
});

test("Cordova without an origin uses a dedicated, working initial configuration", async ({ page, context }) => {
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

test("reloading the page restores the session without a new login", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-portal")).toBeHidden();
  await expect(page.locator("#userTag")).toContainText("Usuário E2E");
});

test("a session bootstrap failure does not leave the connection overlay stuck", async ({ page, context }) => {
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

// A device that suspends, switches networks or loses the server can leave the socket OPEN with
// nothing arriving and no close event. Without a liveness check on resume, the app would keep
// showing old rooms and telemetry as if they were current.
test("a half-open socket is detected on resume and reconnected", async ({ page, context, sessaoComo }) => {
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

test("in the packaged app (Cordova) the PWA service worker is not registered; on the website it still is", async ({ page, context }) => {
  await context.addInitScript(() => {
    window.__swRegistros = [];
    if (navigator.serviceWorker) {
      const registrar = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = (url, opcoes) => {
        window.__swRegistros.push(String(url));
        return registrar(url, opcoes);
      };
    }
  });
  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__swRegistros.length), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__swRegistros[0])).toContain("sw.js");

  await context.addInitScript(() => {
    window.cordova = {};
  });
  const empacotada = await context.newPage();
  await empacotada.goto("/");
  await expect(empacotada.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  expect(await empacotada.evaluate(() => window.RemoteIFESConfig.empacotado)).toBe(true);
  await empacotada.waitForTimeout(1500);
  expect(await empacotada.evaluate(() => window.__swRegistros), "nenhum registro de sw.js no contexto empacotado").toEqual([]);
  await empacotada.close();
});
