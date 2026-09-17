const { test, expect, VIEWPORTS, injetarSessao, API_URL, tokenDe } = require("../harness/fixtures");

// Valores que os relatos da placa produzem nas métricas de texto do cartão, do mais curto ao mais
// longo que cabe em três linhas na célula mais estreita da grade.
const VALORES_RELATADOS = [
  "—",
  "nenhum ainda",
  "sem informação",
  "não gravado",
  "23°C · ligado",
  "23°C · desligado",
  "23°C · ligado · turbo · fan 3",
  "sinal bruto (raw) reenviado",
  "failsafe OFF pelo switch físico",
  "gravado · 137 pulsos",
  "gravado · 137 pulsos · protocolo #3",
  "confirmado pela placa",
  "ainda não confirmado pela placa",
];

async function comando(request, sala, cmd) {
  const r = await request.post(`${API_URL}/comando`, { headers: { Authorization: `Bearer ${tokenDe("user")}` }, data: { sala, cmd } });
  expect(r.ok()).toBeTruthy();
}

function medir(page) {
  return page.evaluate(() => {
    const cartao = document.querySelector('#esp32DeviceList li[data-sala="A-108"]');
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return {
      cartao: r(cartao),
      grade: r(cartao.querySelector(".esp32-metric-grid")),
      ota: r(cartao.querySelector(".esp32-ota")),
      credencial: r(cartao.querySelector(".esp32-cred")),
      resetWifi: r(cartao.querySelector(".reset-wifi-btn")),
      documento: document.documentElement.scrollHeight,
    };
  });
}

test.afterEach(async ({ request }) => {
  await request.post(`${API_URL}/__e2e/silenciar-dispositivo/off`);
  await request.post(`${API_URL}/__e2e/resetar-dispositivo`);
});

for (const [nome, tamanho] of [["celular", VIEWPORTS["mobile-portrait"]], ["notebook", VIEWPORTS.notebook]]) {
  test(`o cartão do ESP32 não muda de altura nem desloca o que vem abaixo quando a placa confirma, deixa de confirmar ou relata outro comando (${nome})`, async ({ page, context, request }) => {
    await request.post(`${API_URL}/__e2e/resetar-dispositivo`);
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(tamanho);
    await page.goto("/#/admin/esp32");
    const cartao = page.locator('#esp32DeviceList li[data-sala="A-108"]');
    await expect(cartao).toBeVisible({ timeout: 20_000 });
    await expect(cartao.locator(".esp32-badge-row .esp32-conn-badge").nth(1)).toHaveText("Servidor conectado", { timeout: 15_000 });
    const estadoDesejado = cartao.locator(".esp32-metric").filter({ hasText: "Estado desejado" }).locator(".esp32-metric-value");
    await expect(estadoDesejado).toHaveText("confirmado pela placa", { timeout: 15_000 });
    await page.waitForTimeout(400);
    const antes = await medir(page);

    // Comando sem resposta da placa: o texto fica mais longo (consulta periódica e WebSocket).
    await request.post(`${API_URL}/__e2e/silenciar-dispositivo/on`);
    await comando(request, "A-108", "ligar");
    await page.evaluate(() => Esp32Admin.aoAbrir());
    await expect(estadoDesejado).toHaveText("ainda não confirmado pela placa");
    expect(await medir(page)).toEqual(antes);

    await request.post(`${API_URL}/__e2e/silenciar-dispositivo/off`);
    await expect(estadoDesejado).toHaveText("confirmado pela placa", { timeout: 15_000 });
    expect(await medir(page)).toEqual(antes);

    await comando(request, "A-108", "desligar");
    await expect(estadoDesejado).toHaveText("confirmado pela placa");
    expect(await medir(page)).toEqual(antes);

    // Qualquer valor que a placa relate nas métricas de texto cabe no espaço já reservado.
    for (const metrica of ["Último comando IR", "Failsafe OFF na NVS", "Estado desejado"]) {
      const valor = cartao.locator(".esp32-metric").filter({ hasText: metrica }).locator(".esp32-metric-value");
      for (const texto of VALORES_RELATADOS) {
        await valor.evaluate((el, t) => { el.textContent = t; }, texto);
        expect(await medir(page), `${metrica}: "${texto}"`).toEqual(antes);
      }
    }
  });
}
