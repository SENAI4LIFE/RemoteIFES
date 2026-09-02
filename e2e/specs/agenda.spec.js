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

test("agendamento removido sai da lista na hora, sem depender de uma nova leitura", async ({ page, context, request }) => {
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
  expect(listagens, "a remoção não dispara uma releitura da lista inteira").toBe(0);
  expect(await agendamentosNoServidor(request)).toHaveLength(1);
});

// Uma leitura emitida antes da remoção ainda enxerga o agendamento apagado. Chegando
// depois, ela repintava a lista inteira e trazia de volta um item que o servidor já não tinha.
test("leitura anterior à remoção não traz o agendamento apagado de volta", async ({ page, context, request }) => {
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
  expect(await agendamentosNoServidor(request), "servidor e tela concordam sobre o que sobrou").toHaveLength(1);
});

test("agendamento continua na lista quando a remoção falha no servidor", async ({ page, context, request }) => {
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

test("remover o último agendamento mostra a mensagem de lista vazia", async ({ page, context, request }) => {
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
