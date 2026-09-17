const { test, expect, VIEWPORTS, injetarSessao, API_URL, tokenDe } = require("../harness/fixtures");

// Valores que a operação normal produz nas métricas de texto do cartão (confirmação do estado,
// último comando de ligar/desligar e failsafe gravado): todos cabem nas três linhas reservadas,
// mesmo com as fontes mais largas dos sistemas sem Segoe UI/Roboto.
const VALORES_RELATADOS = [
  "—",
  "nenhum ainda",
  "sem informação",
  "não gravado",
  "23°C · ligado",
  "23°C · desligado",
  "23°C · ligado · turbo",
  "gravado · 137 pulsos",
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

    // Comando sem resposta da placa: o texto fica mais longo (consulta periódica e WebSocket). Se a
    // consulta periódica de 20 s estiver em andamento, a chamada direta é ignorada e vale a próxima.
    await request.post(`${API_URL}/__e2e/silenciar-dispositivo/on`);
    await comando(request, "A-108", "ligar");
    await page.evaluate(() => Esp32Admin.aoAbrir());
    await expect(estadoDesejado).toHaveText("ainda não confirmado pela placa", { timeout: 25_000 });
    expect(await medir(page)).toEqual(antes);

    await request.post(`${API_URL}/__e2e/silenciar-dispositivo/off`);
    await expect(estadoDesejado).toHaveText("confirmado pela placa", { timeout: 15_000 });
    expect(await medir(page)).toEqual(antes);

    await comando(request, "A-108", "desligar");
    await expect(estadoDesejado).toHaveText("confirmado pela placa");
    expect(await medir(page)).toEqual(antes);

    // Qualquer valor da operação normal cabe no espaço já reservado.
    for (const metrica of ["Último comando IR", "Failsafe OFF na NVS", "Estado desejado"]) {
      const valor = cartao.locator(".esp32-metric").filter({ hasText: metrica }).locator(".esp32-metric-value");
      for (const texto of VALORES_RELATADOS) {
        await valor.evaluate((el, t) => { el.textContent = t; }, texto);
        expect(await medir(page), `${metrica}: "${texto}"`).toEqual(antes);
      }
    }
  });
}
