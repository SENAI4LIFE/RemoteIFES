const { test, expect, API_URL, injetarSessao, tokenDe } = require("../harness/fixtures");

const SALA = "A-108";

function dataDeHojeEmBrasilia() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function comoAdmin() {
  return { Authorization: `Bearer ${tokenDe("admin")}` };
}

async function criarAgendamento(request, horaInicio, horaFim) {
  const resp = await request.post(`${API_URL}/agendamentos`, {
    headers: { ...comoAdmin(), "Content-Type": "application/json" },
    data: { sala: SALA, data: dataDeHojeEmBrasilia(), horaInicio, horaFim, temperatura: 23, modo: "reserva" },
  });
  const corpo = await resp.json();
  if (!corpo.ok) throw new Error(`não foi possível criar o agendamento de apoio: ${corpo.erro}`);
  return corpo.agendamento.id;
}

async function agendamentosNoServidor(request) {
  const resp = await request.get(`${API_URL}/agendamentos?sala=${SALA}`, { headers: comoAdmin() });
  return resp.json();
}

async function limparAgendamentos(request) {
  for (const ag of await agendamentosNoServidor(request)) {
    await request.delete(`${API_URL}/agendamentos/${ag.id}`, { headers: comoAdmin() });
  }
}

async function abrirAgendaComDois(page, context, request) {
  const manha = await criarAgendamento(request, "08:00", "09:00");
  const tarde = await criarAgendamento(request, "14:00", "15:00");
  await injetarSessao(context, "admin");
  await page.goto("/#/agenda");
  await expect(page.locator("#screen-agenda")).toBeVisible({ timeout: 20_000 });
  await page.selectOption("#agendaSala", SALA);
  await expect(page.locator("#agendaList li")).toHaveCount(2, { timeout: 10_000 });
  return { manha, tarde };
}

const ehListagem = (url) => url.pathname === "/agendamentos";
const ehRemocao = (id) => (url) => url.pathname === `/agendamentos/${id}`;

test.beforeEach(async ({ request }) => {
  await limparAgendamentos(request);
});

test.afterEach(async ({ request }) => {
  await limparAgendamentos(request);
});

test("a removed schedule leaves the list immediately, without depending on a new read", async ({ page, context, request }) => {
  await abrirAgendaComDois(page, context, request);

  let listagens = 0;
  await page.route(ehListagem, async (route) => {
    listagens += 1;
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });

  await page.locator("#agendaList li").nth(1).locator(".agenda-remover").click();

  await expect(page.locator("#agendaList li")).toHaveCount(1, { timeout: 2000 });
  await expect(page.locator("#agendaList")).toContainText("08:00–09:00");
  await expect(page.locator("#agendaList")).not.toContainText("14:00–15:00");
  expect(listagens, "removal does not trigger a re-read of the whole list").toBe(0);
  expect(await agendamentosNoServidor(request)).toHaveLength(1);
});

// A read issued before the removal still sees the deleted schedule. Arriving afterwards, it used to
// repaint the whole list and bring back an item the server no longer had.
test("a read issued before the removal does not bring the deleted schedule back", async ({ page, context, request }) => {
  const { tarde } = await abrirAgendaComDois(page, context, request);

  await page.route(ehListagem, async (route) => {
    const resposta = await route.fetch();
    const corpo = await resposta.body();
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ response: resposta, body: corpo });
  });
  await page.route(ehRemocao(tarde), async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });

  await page.evaluate(() => {
    document.querySelector("#agendaList li:nth-child(1) .agenda-toggle").click();
    document.querySelector("#agendaList li:nth-child(2) .agenda-remover").click();
  });

  await expect(page.locator("#agendaList li")).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator("#agendaList li")).toHaveCount(1);
  await expect(page.locator("#agendaList")).not.toContainText("14:00–15:00");
  await expect(page.locator("#agendaList .agenda-toggle")).toHaveText("ativar");
  expect(await agendamentosNoServidor(request), "server and screen agree on what remained").toHaveLength(1);
});

test("a schedule stays in the list when the server fails the removal", async ({ page, context, request }) => {
  const { tarde } = await abrirAgendaComDois(page, context, request);

  await page.route(ehRemocao(tarde), (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, erro: "sem permissão para remover" }) })
      : route.continue()
  );

  await page.locator("#agendaList li").nth(1).locator(".agenda-remover").click();

  await expect(page.locator(".toast")).toContainText("sem permissão para remover");
  await expect(page.locator("#agendaList li")).toHaveCount(2);
  await expect(page.locator("#agendaList")).toContainText("14:00–15:00");
  await expect(page.locator("#agendaEmpty")).toBeHidden();
});

test("removing the last schedule shows the empty-list message", async ({ page, context, request }) => {
  await criarAgendamento(request, "08:00", "09:00");
  await injetarSessao(context, "admin");
  await page.goto("/#/agenda");
  await expect(page.locator("#screen-agenda")).toBeVisible({ timeout: 20_000 });
  await page.selectOption("#agendaSala", SALA);
  await expect(page.locator("#agendaList li")).toHaveCount(1, { timeout: 10_000 });

  await page.locator("#agendaList .agenda-remover").click();

  await expect(page.locator("#agendaList li")).toHaveCount(0);
  await expect(page.locator("#agendaEmpty")).toBeVisible();
  expect(await agendamentosNoServidor(request)).toHaveLength(0);
});
