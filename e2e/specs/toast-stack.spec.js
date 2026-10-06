const { test, expect, VIEWPORTS } = require("../harness/fixtures");

const PI_7_POLEGADAS = { width: 800, height: 480 };
const FRACAO_MAXIMA_DA_TELA = 0.35;
const TOPO_DA_PILHA = 12;

const MAXIMO_A11Y = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
};

const AVISO_LONGO = "O comando não foi entregue ao ESP32: a placa foi vista há pouco, mas está sem canal de comandos agora. O estado foi salvo e será aplicado quando ela reconectar.";

async function abrir(page, tamanho, { relogio = false } = {}) {
  if (relogio) await page.clock.install();
  await page.setViewportSize(tamanho);
  await page.goto("/");
  await page.waitForFunction(() => typeof Toast === "object");
  if (relogio) await page.clock.pauseAt(Date.now() + 1_000);
}

function emitir(page, itens) {
  return page.evaluate((lista) => lista.forEach(([tipo, texto]) => Toast[tipo](texto)), itens);
}

function rajada(quantidade) {
  return Array.from({ length: quantidade }, (_, i) => [i % 3 === 2 ? "erro" : "aviso", `evento ${i + 1}`]);
}

function textosVisiveis(page) {
  return page.locator(".toast").evaluateAll((toasts) => toasts.map((t) => t.firstChild.data));
}

async function registrarOrdemDeExibicao(page) {
  await emitir(page, [["aviso", "aquecimento"]]);
  await page.locator(".toast").click();
  await page.evaluate(() => {
    window.__ordemDosToasts = [];
    new MutationObserver((mudancas) => mudancas.forEach((m) => m.addedNodes.forEach((no) => {
      if (no.classList && no.classList.contains("toast")) window.__ordemDosToasts.push(no.firstChild.data);
    }))).observe(document.querySelector(".toast-stack"), { childList: true });
  });
}

function medirPilha() {
  const raiz = document.documentElement;
  const toasts = Array.from(document.querySelectorAll(".toast"));
  return {
    base: Math.max(...toasts.map((t) => t.getBoundingClientRect().bottom)),
    alturaTela: innerHeight,
    rolagemHorizontal: raiz.scrollWidth > raiz.clientWidth,
    toastTransbordaNaHorizontal: toasts.some((t) => t.scrollWidth > t.clientWidth),
    toastForaDaTela: toasts.some((t) => {
      const r = t.getBoundingClientRect();
      return r.left < 0 || r.right > raiz.clientWidth;
    }),
  };
}

const LIMITES = [
  ["desktop 1920x1080", VIEWPORTS.desktop, 3],
  ["notebook 1366x768", VIEWPORTS.notebook, 2],
  ["phone 390x844", VIEWPORTS["mobile-portrait"], 2],
  ["phone 360x800", VIEWPORTS["mobile-compact"], 2],
  ["phone landscape 844x390", VIEWPORTS["mobile-landscape"], 1],
  ["Raspberry Pi panel 1024x600", VIEWPORTS["pi-display"], 1],
  ["Raspberry Pi 7-inch 800x480", PI_7_POLEGADAS, 1],
];

for (const [nome, tamanho, limite] of LIMITES) {
  test(`${nome}: a burst shows at most ${limite} toast(s) at the top, oldest first, within the height budget`, async ({ page }) => {
    await abrir(page, tamanho, { relogio: true });
    await emitir(page, rajada(12));

    await expect(page.locator(".toast")).toHaveCount(limite);
    expect(await textosVisiveis(page)).toEqual(rajada(limite).map(([, texto]) => texto));

    const medida = await page.evaluate(medirPilha);
    expect(medida.base).toBeLessThanOrEqual(TOPO_DA_PILHA + medida.alturaTela * FRACAO_MAXIMA_DA_TELA + 1);
    expect(medida.rolagemHorizontal).toBe(false);
    expect(medida.toastTransbordaNaHorizontal).toBe(false);
    expect(medida.toastForaDaTela).toBe(false);
  });
}

test("repeated notifications are grouped with an occurrence counter, separately per severity", async ({ page }) => {
  await abrir(page, VIEWPORTS.desktop, { relogio: true });
  await emitir(page, [
    ["erro", "não foi possível falar com o servidor"],
    ["erro", "não foi possível falar com o servidor"],
    ["aviso", "não foi possível falar com o servidor"],
    ["erro", "não foi possível falar com o servidor"],
  ]);

  await expect(page.locator(".toast")).toHaveCount(2);
  await expect(page.locator(".toast-erro .toast-contador")).toHaveText("3×");
  await expect(page.locator(".toast-erro")).toHaveAttribute("aria-atomic", "true");
  await expect(page.locator(".toast-aviso")).toHaveText("não foi possível falar com o servidor");
  expect(await textosVisiveis(page)).toEqual(["não foi possível falar com o servidor", "não foi possível falar com o servidor"]);
});

test("a repeat while visible keeps the toast for another full period; a repeat after it left starts a new one", async ({ page }) => {
  await abrir(page, VIEWPORTS.desktop, { relogio: true });
  await emitir(page, [["erro", "falha repetida"]]);
  await page.clock.runFor(5_000);
  await emitir(page, [["erro", "falha repetida"]]);
  await page.clock.runFor(5_500);
  await expect(page.locator(".toast-erro .toast-contador")).toHaveText("2×");
  await page.clock.runFor(600);
  await expect(page.locator(".toast")).toHaveCount(0);

  await emitir(page, [["erro", "falha repetida"]]);
  await expect(page.locator(".toast-erro")).toHaveText("falha repetida");
});

test("while others wait, a repeat renews the minimum reading time but never beyond the normal period", async ({ page }) => {
  await abrir(page, VIEWPORTS["pi-display"], { relogio: true });
  await emitir(page, [["erro", "falha recorrente"], ["aviso", "evento 1"], ["aviso", "evento 2"]]);
  await page.clock.runFor(3_900);
  await emitir(page, [["erro", "falha recorrente"]]);
  await page.clock.runFor(2_000);
  expect(await textosVisiveis(page)).toEqual(["falha recorrente"]);
  await expect(page.locator(".toast-contador")).toHaveText("2×");

  await page.clock.runFor(200);
  expect(await textosVisiveis(page)).toEqual(["evento 1"]);
});

test("an active state warning is never dropped from a full queue", async ({ page }) => {
  await abrir(page, VIEWPORTS["pi-display"], { relogio: true });
  await registrarOrdemDeExibicao(page);
  await page.evaluate(() => {
    Toast.aviso("em exibição");
    Toast.criarAvisoDeEstado("e2e-estado", "dispositivo offline")(true);
    ["evento 1", "evento 2", "evento 3", "evento 4"].forEach((texto) => Toast.erro(texto));
  });

  await page.clock.runFor(60_000);
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ordemDosToasts)).toEqual(["em exibição", "dispositivo offline", "evento 3", "evento 4"]);
});

test("a waiting queue drains in order and faster than the normal display time, then empties", async ({ page }) => {
  await abrir(page, VIEWPORTS.desktop, { relogio: true });
  await registrarOrdemDeExibicao(page);

  const avisos = Array.from({ length: 12 }, (_, i) => ["aviso", `sala ${i + 1}: firmware atualizado`]);
  await emitir(page, avisos);
  await expect(page.locator(".toast")).toHaveCount(3);

  await page.clock.runFor(3_100);
  expect(await textosVisiveis(page)).toEqual(["sala 4: firmware atualizado", "sala 5: firmware atualizado", "sala 6: firmware atualizado"]);

  await page.clock.runFor(15_400);
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ordemDosToasts)).toEqual(avisos.map(([, texto]) => texto));
});

test("beyond three rounds of waiting the oldest waiting notifications are dropped and the newest kept", async ({ page }) => {
  await abrir(page, VIEWPORTS["pi-display"], { relogio: true });
  await registrarOrdemDeExibicao(page);

  await emitir(page, rajada(8));
  await page.clock.runFor(30_000);
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ordemDosToasts)).toEqual(["evento 1", "evento 6", "evento 7", "evento 8"]);
});

test("dismissing a toast shows the next one in order, and its old timer does not remove a newer toast", async ({ page }) => {
  await abrir(page, VIEWPORTS.notebook, { relogio: true });
  await emitir(page, [["erro", "primeiro"], ["aviso", "segundo"], ["erro", "terceiro"]]);
  expect(await textosVisiveis(page)).toEqual(["primeiro", "segundo"]);

  await page.locator(".toast", { hasText: "primeiro" }).click();
  expect(await textosVisiveis(page)).toEqual(["segundo", "terceiro"]);

  await emitir(page, [["erro", "primeiro"]]);
  await page.locator(".toast", { hasText: "segundo" }).click();
  await page.locator(".toast", { hasText: "terceiro" }).click();
  await page.clock.runFor(5_900);
  expect(await textosVisiveis(page)).toEqual(["primeiro"]);
  await page.clock.runFor(200);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("shrinking the viewport returns the newest toasts to the queue and growing it brings them back in order, losing none", async ({ page }) => {
  await abrir(page, VIEWPORTS.desktop, { relogio: true });
  await registrarOrdemDeExibicao(page);
  await emitir(page, rajada(12));
  expect(await textosVisiveis(page)).toEqual(["evento 1", "evento 2", "evento 3"]);

  await page.setViewportSize(VIEWPORTS["pi-display"]);
  await expect(page.locator(".toast")).toHaveCount(1);
  expect(await textosVisiveis(page)).toEqual(["evento 1"]);

  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await expect(page.locator(".toast")).toHaveCount(2);
  expect(await textosVisiveis(page)).toEqual(["evento 1", "evento 2"]);

  await page.setViewportSize(VIEWPORTS.desktop);
  await expect(page.locator(".toast")).toHaveCount(3);
  expect(await textosVisiveis(page)).toEqual(["evento 1", "evento 2", "evento 3"]);

  await page.clock.runFor(60_000);
  await expect(page.locator(".toast")).toHaveCount(0);
  const primeiraExibicao = [...new Set(await page.evaluate(() => window.__ordemDosToasts))];
  expect(primeiraExibicao).toEqual(rajada(12).map(([, texto]) => texto));
});

test("long messages wrap between words on a narrow phone, and unbroken tokens never overflow", async ({ page }) => {
  await abrir(page, VIEWPORTS["mobile-compact"], { relogio: true });
  const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  await emitir(page, [["aviso", AVISO_LONGO], ["erro", `APK descartado: SHA-256 ${sha}`], ["aviso", AVISO_LONGO]]);

  await expect(page.locator(".toast-aviso .toast-contador")).toHaveText("2×");
  const palavrasQuebradas = await page.locator(".toast-aviso").evaluate((toast) => {
    const no = toast.firstChild;
    const quebradas = [];
    let inicio = 0;
    for (const palavra of no.data.split(" ")) {
      const faixa = document.createRange();
      faixa.setStart(no, inicio);
      faixa.setEnd(no, inicio + palavra.length);
      if (new Set(Array.from(faixa.getClientRects(), (r) => Math.round(r.top))).size > 1) quebradas.push(palavra);
      inicio += palavra.length + 1;
    }
    const contador = toast.querySelector(".toast-contador").getClientRects().length;
    return { quebradas, contador };
  });
  expect(palavrasQuebradas).toEqual({ quebradas: [], contador: 1 });
  await expect(page.locator(".toast-erro")).toContainText(sha);

  const medida = await page.evaluate(medirPilha);
  expect(medida.rolagemHorizontal).toBe(false);
  expect(medida.toastTransbordaNaHorizontal).toBe(false);
  expect(medida.toastForaDaTela).toBe(false);
});

test("with maximum text on the Raspberry Pi panel a single long toast stays within the height budget and scrolls inside", async ({ page, context }) => {
  await context.addInitScript((ajustes) => {
    try {
      Object.entries(ajustes).forEach(([k, v]) => window.localStorage.setItem(k, v));
    } catch (e) {}
  }, MAXIMO_A11Y);
  await abrir(page, VIEWPORTS["pi-display"], { relogio: true });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim())).toBe("2");
  await emitir(page, [["aviso", AVISO_LONGO], ["erro", "não foi possível enviar o comando"]]);

  await expect(page.locator(".toast")).toHaveCount(1);
  const medida = await page.evaluate(medirPilha);
  expect(medida.base).toBeLessThanOrEqual(TOPO_DA_PILHA + medida.alturaTela * FRACAO_MAXIMA_DA_TELA + 1);
  expect(medida.rolagemHorizontal).toBe(false);
  expect(medida.toastTransbordaNaHorizontal).toBe(false);
  expect(await page.locator(".toast").evaluate((t) => t.scrollHeight > t.clientHeight)).toBe(true);
});
