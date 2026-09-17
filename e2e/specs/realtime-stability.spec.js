const { test, expect, irParaSala, injetarSessao, API_URL, tokenDe } = require("../harness/fixtures");

// Cada elemento observado recebe um identificador na primeira leitura; uma leitura posterior que
// devolva identificadores novos denuncia reconstrução do DOM, e retângulos diferentes denunciam
// movimento na tela. Os dados continuam mudando (as asserções de conteúdo provam isso).
const SONDA = `
  window.__seq = window.__seq || 0;
  window.__ler = (sel) => [...document.querySelectorAll(sel)].map((el) => {
    if (!el.__id) el.__id = ++window.__seq;
    const r = el.getBoundingClientRect();
    return { id: el.__id, chave: el.dataset.sala || el.id || null, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  window.__focoEm = () => { const a = document.activeElement; return a && a.__id ? a.__id : null; };
`;

function esperarEstavel(antes, depois) {
  expect(depois.map((e) => e.id), "os elementos são os mesmos nós, na mesma ordem").toEqual(antes.map((e) => e.id));
  expect(depois.map((e) => [e.x, e.y, e.w, e.h]), "nenhum elemento mudou de posição ou tamanho").toEqual(antes.map((e) => [e.x, e.y, e.w, e.h]));
}

async function comando(request, sala, cmd) {
  const r = await request.post(`${API_URL}/comando`, { headers: { Authorization: `Bearer ${tokenDe("user")}` }, data: { sala, cmd } });
  expect(r.ok()).toBeTruthy();
}

async function assentar(page) {
  await page.waitForTimeout(400);
  await page.evaluate(SONDA);
}

test("a grade de salas recebe atualizações em tempo real sem recriar os botões nem perder o foco do teclado", async ({ page, sessaoComo, request }) => {
  await sessaoComo("user");
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await page.locator('#simpleGridBloco .simple-tile[data-bloco="A"]').click();
  await page.locator('#simpleGridAndar .simple-tile[data-andar="1"]').click();
  const tile = page.locator('.simple-tile-sala[data-sala="A-108"]');
  await expect(tile).toHaveClass(/is-desligado/, { timeout: 15_000 });
  await assentar(page);
  await tile.focus();
  const antes = await page.evaluate(() => ({ tiles: window.__ler(".simple-tile-sala"), foco: window.__focoEm() }));
  expect(antes.foco).not.toBeNull();

  await comando(request, "A-108", "ligar");
  await expect(tile).toHaveClass(/is-ligado/);
  await comando(request, "A-108", "desligar");
  await expect(tile).toHaveClass(/is-desligado/);
  await comando(request, "A-108", "ligar");
  await expect(tile).toHaveClass(/is-ligado/);

  const depois = await page.evaluate(() => ({ tiles: window.__ler(".simple-tile-sala"), foco: window.__focoEm() }));
  esperarEstavel(antes.tiles, depois.tiles);
  expect(depois.foco, "o botão focado continua focado").toBe(antes.foco);
  await comando(request, "A-108", "desligar");
});

test("a lista de salas mantém a ordem exibida mesmo quando os dados chegam em outra ordem, e só uma sala nova altera o layout", async ({ page, sessaoComo, request }) => {
  await sessaoComo("user");
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await page.locator("#simpleListBtn").click();
  await page.locator('#blocoChoices .choice-btn[data-bloco="A"]').click();
  await page.locator('#andarChoices .choice-btn[data-andar="1"]').click();
  await page.locator("#verSalasBtn").click();
  const item = page.locator('#roomList li[data-sala="A-108"]');
  await expect(item.locator(".status-badge")).toHaveText("online", { timeout: 15_000 });
  await assentar(page);
  await item.focus();
  const antes = await page.evaluate(() => ({ itens: window.__ler("#roomList li"), nomes: window.__ler("#roomList .room-name"), badges: window.__ler("#roomList .status-badge"), foco: window.__focoEm() }));

  await comando(request, "A-108", "ligar");
  await expect(item.locator(".room-sub")).toContainText("· ligado");
  await comando(request, "A-108", "desligar");
  await expect(item.locator(".room-sub")).not.toContainText("· ligado");

  // A mesma lista entregue de trás para a frente (o que o servidor manda pelo WebSocket é a lista
  // de salas; a ordem de chegada não pode reordenar o que já está na tela).
  await page.evaluate(async () => {
    const salas = await Api.listarSalas({ bloco: "A", andar: "1" });
    renderRooms([...salas].reverse());
  });
  const depois = await page.evaluate(() => ({ itens: window.__ler("#roomList li"), nomes: window.__ler("#roomList .room-name"), badges: window.__ler("#roomList .status-badge"), foco: window.__focoEm() }));
  esperarEstavel(antes.itens, depois.itens);
  esperarEstavel(antes.nomes, depois.nomes);
  expect(depois.badges.map((b) => b.id)).toEqual(antes.badges.map((b) => b.id));
  expect(depois.foco).toBe(antes.foco);
  await expect(page.locator("#roomList li").first()).toHaveAttribute("data-sala", antes.itens[0].chave);

  // Uma sala realmente nova entra na posição relativa recebida, sem mover as que vêm antes dela.
  const codigos = antes.itens.map((e) => e.chave);
  const posicaoNova = 3;
  await page.evaluate(async ({ posicaoNova }) => {
    const salas = await Api.listarSalas({ bloco: "A", andar: "1" });
    const modelo = salas[0];
    salas.splice(posicaoNova, 0, { ...modelo, sala: "A-999", nome: "Sala de teste", online: false, ligado: false, agendadaAgora: false });
    renderRooms(salas);
  }, { posicaoNova });
  const comNova = await page.evaluate(() => window.__ler("#roomList li"));
  expect(comNova.map((e) => e.chave)).toEqual([...codigos.slice(0, posicaoNova), "A-999", ...codigos.slice(posicaoNova)]);
  expect(comNova.filter((e) => e.chave !== "A-999").map((e) => e.id)).toEqual(antes.itens.map((e) => e.id));
  expect(comNova.slice(0, posicaoNova).map((e) => [e.x, e.y, e.w, e.h])).toEqual(antes.itens.slice(0, posicaoNova).map((e) => [e.x, e.y, e.w, e.h]));

  // A lista real (sem a sala inventada) volta a valer na próxima atualização.
  await page.evaluate(async () => renderRooms(await Api.listarSalas({ bloco: "A", andar: "1" })));
  await expect(page.locator('#roomList li[data-sala="A-999"]')).toHaveCount(0);
  expect((await page.evaluate(() => window.__ler("#roomList li"))).map((e) => e.id)).toEqual(antes.itens.map((e) => e.id));
});

test("o painel da sala atualiza os valores no lugar: nada é recriado nem sai do lugar ao ligar, confirmar e desligar", async ({ page, sessaoComo, request }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await assentar(page);
  const sel = "#screen-panel .ac-remote-display, #screen-panel .ac-remote-display-top, #screen-panel .ac-remote-display-bottom, #tempTarget, #tempValue, #modoValue, #conexaoValue, #btnPower, #btnTurbo, #tempUp, #tempDown, #lockBanner, #panelSomenteLeitura";
  await page.locator("#btnTurbo").focus();
  const antes = await page.evaluate((s) => ({ els: window.__ler(s), foco: window.__focoEm() }), sel);

  await request.post(`${API_URL}/__e2e/silenciar-dispositivo/on`);
  await comando(request, "A-108", "ligar");
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "false");
  await request.post(`${API_URL}/__e2e/silenciar-dispositivo/off`);
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");
  await comando(request, "A-108", "desligar");
  await expect(page.locator("#statusValue")).toHaveText("desligado");

  const depois = await page.evaluate((s) => ({ els: window.__ler(s), foco: window.__focoEm() }), sel);
  esperarEstavel(antes.els, depois.els);
  expect(depois.foco).toBe(antes.foco);
});

test("os cartões de ESP32 e a tela de status absorvem telemetria e consultas periódicas sem reconstruir o DOM", async ({ page, context, request }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/esp32");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  const cartao = page.locator('#esp32DeviceList li[data-sala="A-108"]');
  await expect(cartao).toBeVisible({ timeout: 20_000 });
  await expect(cartao.locator(".esp32-badge-row .esp32-conn-badge").nth(1)).toHaveText("Servidor conectado", { timeout: 15_000 });
  await assentar(page);
  await cartao.locator(".reset-wifi-btn").focus();
  const sel = "#esp32DeviceList li, #esp32DeviceList .esp32-metric-value, #esp32DeviceList button";
  const antes = await page.evaluate((s) => ({ els: window.__ler(s), foco: window.__focoEm() }), sel);
  expect(antes.foco).not.toBeNull();
  const estadoDesejado = cartao.locator(".esp32-metric").filter({ hasText: "Estado desejado" }).locator(".esp32-metric-value");
  await expect(estadoDesejado).toHaveText("confirmado pela placa");

  // Consulta periódica (o mesmo caminho do intervalo de 20 s) com a placa em silêncio...
  await request.post(`${API_URL}/__e2e/silenciar-dispositivo/on`);
  await comando(request, "A-108", "ligar");
  await page.evaluate(() => Esp32Admin.aoAbrir());
  await expect(estadoDesejado).toHaveText("ainda não confirmado pela placa");
  // ...e telemetria pelo WebSocket quando ela volta a falar.
  await request.post(`${API_URL}/__e2e/silenciar-dispositivo/off`);
  await expect(estadoDesejado).toHaveText("confirmado pela placa", { timeout: 15_000 });
  await page.waitForTimeout(9_000);
  await comando(request, "A-108", "desligar");
  await expect(estadoDesejado).toHaveText("confirmado pela placa");

  const depois = await page.evaluate((s) => ({ els: window.__ler(s), foco: window.__focoEm() }), sel);
  expect(depois.els.map((e) => e.id), "cartões, métricas e botões são os mesmos nós").toEqual(antes.els.map((e) => e.id));
  expect(depois.els.filter((e) => e.chave).map((e) => [e.x, e.y, e.w, e.h]), "os cartões não saem do lugar").toEqual(antes.els.filter((e) => e.chave).map((e) => [e.x, e.y, e.w, e.h]));
  expect(depois.foco, "o botão focado continua focado depois da telemetria").toBe(antes.foco);

  await page.goto("/#/admin/monitoramento");
  await expect(page.locator("#monGrid .mon-card")).not.toHaveCount(0, { timeout: 20_000 });
  await assentar(page);
  const selM = "#monGrid .mon-card, #monGrid .mon-row";
  const a2 = await page.evaluate((s) => window.__ler(s), selM);
  const ordemAntes = await page.$$eval("#monGrid .mon-card h4", (hs) => hs.map((h) => h.firstChild.textContent));
  await page.evaluate(() => Monitoramento.aoAbrir());
  await page.evaluate(() => Monitoramento.aoAbrir());
  const d2 = await page.evaluate((s) => window.__ler(s), selM);
  esperarEstavel(a2, d2);
  expect(await page.$$eval("#monGrid .mon-card h4", (hs) => hs.map((h) => h.firstChild.textContent))).toEqual(ordemAntes);
});
