const { test, expect, irParaSala } = require("../harness/fixtures");

test("turns the air conditioner of a room with a connected ESP32 on and off", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");

  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#modoValue")).toHaveText("Off");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#btnPower")).toHaveClass(/is-on/);
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#statusValue")).toHaveText("desligado");
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");
});

test("the desired state stays marked unconfirmed while the ESP32 does not echo it", async ({ page, sessaoComo, request }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");

  await request.post(`${process.env.E2E_API_URL}/__e2e/silenciar-dispositivo/on`);
  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "false");
  await expect(page.locator("#statusValue")).toHaveAttribute("title", /aguardando o ESP32/);

  await request.post(`${process.env.E2E_API_URL}/__e2e/silenciar-dispositivo/off`);
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");
  await expect(page.locator("#statusValue")).toHaveAttribute("title", "Estado do ar-condicionado");

  await page.locator("#btnPower").click();
  await expect(page.locator("#statusValue")).toHaveText("desligado");
  await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");
});

test("temperature adjustment respects the limits and updates the displayed target", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");
  await expect(page.locator("#btnPower")).toBeEnabled({ timeout: 15_000 });

  const alvo = page.locator("#tempTarget");
  const lerAlvo = async () => parseInt((await alvo.textContent()).replace(/\D/g, ""), 10);

  let atual = await lerAlvo();
  expect(atual).toBeGreaterThanOrEqual(23);
  expect(atual).toBeLessThanOrEqual(25);

  if (atual >= 25) {
    await expect(page.locator("#tempUp")).toBeDisabled();
  } else {
    await page.locator("#tempUp").click();
    await expect(alvo).toHaveText(`${atual + 1}°C`);
    atual += 1;
  }

  if (atual <= 23) {
    await expect(page.locator("#tempDown")).toBeDisabled();
  } else {
    await page.locator("#tempDown").click();
    await expect(alvo).toHaveText(`${atual - 1}°C`);
  }
});

test("a user without control permission sees the panel in read-only mode", async ({ page, sessaoComo }) => {
  await sessaoComo("readonly");
  await irParaSala(page, "A-108");

  await expect(page.locator("#panelSomenteLeitura")).toBeVisible();
  await expect(page.locator("#btnPower")).toBeDisabled();
  await expect(page.locator("#tempUp")).toBeDisabled();
  await expect(page.locator("#tempDown")).toBeDisabled();
});

// A board seen only through HTTP heartbeats (the firmware uses that path while the WebSocket is
// down) counts as present, but the server has no channel to deliver the command.
test.describe("presence without a command channel", () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${process.env.E2E_API_URL}/__e2e/so-heartbeat/off`);
    await request.post(`${process.env.E2E_API_URL}/__e2e/resetar-dispositivo`);
  });

  test("online only through heartbeat: the panel shows the missing channel, warns that the command was not delivered and returns to normal on reconnection", async ({ page, sessaoComo, request }) => {
    await sessaoComo("user");
    await irParaSala(page, "A-108");
    await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
    await expect(page.locator("#statusValue")).toHaveText("desligado");

    await request.post(`${process.env.E2E_API_URL}/__e2e/so-heartbeat/on`);
    await expect(page.locator("#conexaoValue")).toHaveText("online, sem comandos", { timeout: 15_000 });
    await expect(page.locator("#conexaoValue")).toHaveClass(/\boff\b/);

    await page.locator("#btnPower").click();
    await expect(page.locator(".toast-aviso").filter({ hasText: "não foi entregue ao ESP32" })).toBeVisible();
    await expect(page.locator("#statusValue")).toHaveText("ligado");
    await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "");
    await expect(page.locator("#conexaoValue")).toHaveText("online, sem comandos");

    await request.post(`${process.env.E2E_API_URL}/__e2e/so-heartbeat/off`);
    await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
    await expect(page.locator("#conexaoValue")).toHaveClass(/\bon\b/);
    await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true", { timeout: 15_000 });

    const avisos = await page.locator(".toast-aviso").count();
    await page.locator("#btnPower").click();
    await expect(page.locator("#statusValue")).toHaveText("desligado");
    await expect(page.locator("#statusValue")).toHaveAttribute("data-confirmado", "true");
    expect(await page.locator(".toast-aviso").count()).toBe(avisos);
  });
});
