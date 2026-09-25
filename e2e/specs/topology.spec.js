const path = require("path");
const WebSocket = require("ws");
const { test, expect, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");
const { NoDeReferencia } = require(path.join(__dirname, "..", "..", "remoteifes-server", "test", "support", "mesh-reference.js"));

// Administração > Status > Topologia (superadministrator). The harness board (A-108) is on direct
// Wi-Fi; the mesh case drives a simulated gateway and a board behind it through the real protocol
// (reference implementation of the board side). No radio is involved.

function tokenSuperadmin() {
  const fs = require("fs");
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "harness", ".tokens.json"), "utf8")).superadmin;
}

async function abrirTopologia(page, context, tamanho = { width: 1280, height: 900 }) {
  await injetarSessao(context, "superadmin");
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/topologia");
  await expect(page.locator("#statusAba-topologia")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#topoAviso")).not.toHaveText("Carregando…", { timeout: 15_000 });
}

async function salasLivres(request) {
  const resp = await request.get(`${process.env.E2E_API_URL}/salas`, { headers: { Authorization: `Bearer ${tokenSuperadmin()}` } });
  const corpo = await resp.json();
  const lista = (Array.isArray(corpo) ? corpo : corpo.salas || []).map((s) => s.sala).filter((s) => s && s !== "A-108");
  return lista.slice(-2);
}

async function provisionar(request, sala) {
  const resp = await request.post(`${process.env.E2E_API_URL}/admin/esp32/${encodeURIComponent(sala)}/credencial`, {
    headers: { Authorization: `Bearer ${tokenSuperadmin()}` },
  });
  expect(resp.ok(), await resp.text()).toBe(true);
  return resp.json();
}

test("a direct-only installation shows the mesh as unused", async ({ page, context }) => {
  await abrirTopologia(page, context);
  await expect(page.locator("#topoAviso")).toContainText("Rede mesh não utilizada");
  await expect(page.locator('#topoSvg [data-id="direto:A-108"]')).toBeVisible();
});

test("a board behind a gateway appears with its route, diagnostics and highlighted path", async ({ page, context, request }) => {
  const [salaGateway, salaNo] = await salasLivres(request);
  const gw = await provisionar(request, salaGateway);
  const alvo = await provisionar(request, salaNo);
  const url = process.env.E2E_API_URL.replace(/^http/, "ws");
  const ws = new WebSocket(`${url}/ws/dispositivo`, { headers: { "x-device-id": gw.deviceId, "x-device-secret": gw.segredo } });
  const no = new NoDeReferencia({ deviceId: alvo.deviceId, segredo: alvo.segredo, gatewayDeviceId: gw.deviceId });
  const rota = { pai: "gateway", saltos: 1, rssi: -63 };
  ws.on("message", (dados) => {
    const msg = JSON.parse(dados.toString());
    if (msg.tipo !== "mesh" || msg.no !== alvo.deviceId) return;
    for (const quadro of no.receber(msg.quadro)) ws.send(JSON.stringify({ tipo: "mesh", no: alvo.deviceId, quadro, rota }));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  try {
    ws.send(JSON.stringify({ tipo: "mesh_evento", evento: "entrou", no: alvo.deviceId, rota }));
    await expect.poll(() => !!no.sessao, { timeout: 10_000 }).toBe(true);

    await abrirTopologia(page, context);
    await expect(page.locator("#topoAviso")).toContainText("1 gateway(s)", { timeout: 20_000 });
    const noSvg = page.locator(`#topoSvg [data-id="no:${alvo.deviceId}"]`);
    await expect(noSvg).toHaveAttribute("aria-label", new RegExp(`Sala ${salaNo}, pela malha, conectado, 1 salto`));
    await noSvg.click();
    await expect(page.locator("#topoDetalhe")).toContainText(`malha, pelo gateway da sala ${salaGateway}`);
    await expect(page.locator("#topoDetalhe")).toContainText("-63 dBm");
    await expect(page.locator("#topoDetalhe")).toContainText("indisponível pela malha");
    await expect(page.locator("#topoSvg .topo-rota")).toHaveCount(2);

    await page.locator("#topoFiltroTransporte").selectOption("mesh");
    await expect(page.locator('#topoSvg [data-id="direto:A-108"]')).toHaveCount(0);
    await expect(page.locator("#topoTabela tbody tr")).toHaveCount(2);

    await page.setViewportSize({ width: 360, height: 800 });
    expect(await semRolagemHorizontal(page)).toBe(true);
  } finally {
    ws.close();
    for (const sala of [salaGateway, salaNo]) {
      await request.delete(`${process.env.E2E_API_URL}/admin/esp32/${encodeURIComponent(sala)}/credencial`, {
        headers: { Authorization: `Bearer ${tokenSuperadmin()}` },
      });
    }
  }
});
