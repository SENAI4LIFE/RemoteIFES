const { test, expect, irParaSala } = require("../harness/fixtures");

const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:8791";

test.beforeEach(async ({ request }) => {
  await request.post(`${API_URL}/__e2e/resetar-dispositivo`);
});

test("um comando cuja resposta nunca chega libera o painel após o prazo e reconcilia pelo estado do servidor", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#statusValue")).toHaveText("desligado");

  let retidas = 0;
  await page.route("**/comando", async (route) => {
    retidas += 1;
    await new Promise(() => {});
  });

  const inicio = Date.now();
  await page.locator("#btnPower").click();
  await expect(page.locator("#btnPower")).toBeDisabled();
  await expect(page.locator(".toast-erro")).toContainText("o servidor não respondeu em 15 s; o pedido pode ter sido aplicado", { timeout: 20_000 });
  expect(Date.now() - inicio).toBeGreaterThanOrEqual(14_000);
  expect(retidas).toBe(1);

  await expect(page.locator("#statusValue")).toHaveText("desligado");
  await expect(page.locator("#btnPower")).toBeEnabled();

  await page.unroute("**/comando");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("desligado");
});

test("uma mutação aplicada pelo servidor cuja resposta se perde não é dada como não feita: o estado autoritativo prevalece", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#statusValue")).toHaveText("desligado");

  await page.route("**/comando", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });

  await page.locator("#btnPower").click();
  await expect(page.locator(".toast-erro")).toContainText("o pedido pode ter sido aplicado — confira o estado antes de repetir");
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#btnPower")).toHaveClass(/is-on/);
  await expect(page.locator("#btnPower")).toBeEnabled();

  await page.unroute("**/comando");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("desligado");
});

test("quando nem a consulta de estado responde, o botão volta a ficar utilizável", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#statusValue")).toHaveText("desligado");

  await page.route("**/comando", (route) => route.abort("failed"));
  await page.route("**/status?**", async () => {
    await new Promise(() => {});
  });

  await page.locator("#btnPower").click();
  await expect(page.locator(".toast-erro")).toContainText("o pedido pode ter sido aplicado");
  await expect(page.locator("#btnPower")).toBeEnabled({ timeout: 20_000 });

  await page.unroute("**/comando");
  await page.unroute("**/status?**");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("desligado");
});

test("uma resposta aceita cujo corpo chega truncado não é dada como não feita: o painel avisa a incerteza e mostra o estado do servidor", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#statusValue")).toHaveText("desligado");

  await page.route("**/comando", async (route) => {
    const resposta = await route.fetch();
    const corpo = await resposta.text();
    await route.fulfill({ status: resposta.status(), headers: { "content-type": "application/json" }, body: corpo.slice(0, Math.floor(corpo.length / 2)) });
  });

  await page.locator("#btnPower").click();
  await expect(page.locator(".toast-erro")).toContainText("a resposta do servidor chegou incompleta (status 200); o pedido pode ter sido aplicado");
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#btnPower")).toHaveClass(/is-on/);
  await expect(page.locator("#btnPower")).toBeEnabled();

  await page.unroute("**/comando");
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("desligado");
});
