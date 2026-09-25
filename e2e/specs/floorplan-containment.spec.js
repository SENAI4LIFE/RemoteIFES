const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// The floor plan screen: the fitted plan fits the wrapper's content box (not over the padding and
// not clipped), the wrapper fits the page column, and the page gains no horizontal scroll. Zoom
// still scrolls inside the wrapper.

const LARGURAS = {
  "mobile-compact": VIEWPORTS["mobile-compact"],
  "mobile-portrait": VIEWPORTS["mobile-portrait"],
  "mobile 430": { width: 430, height: 932 },
  "699 (antes do ponto de 700)": { width: 699, height: 900 },
  "700": { width: 700, height: 900 },
  "939 (antes do ponto de 940)": { width: 939, height: 900 },
  "940": { width: 940, height: 900 },
  "desktop curto 1024x600": { width: 1024, height: 600 },
  "1299": { width: 1299, height: 800 },
  "1300": { width: 1300, height: 800 },
  notebook: VIEWPORTS.notebook,
  desktop: VIEWPORTS.desktop,
};

async function abrirPlanta(page, context, tamanho) {
  await injetarSessao(context, "user");
  await page.setViewportSize(tamanho);
  await page.goto("/#/salas/planta/a-terreo");
  await expect(page.locator("#screen-floorplan")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const plan = document.querySelector("#fpScaleInner .fp-section:not(.hidden) .plan");
    return !!(plan && plan.style.transform);
  });
  // The page column animates its width when switching screens; the plan is refitted during the
  // animation, so wait for the scale to settle before measuring.
  await page.waitForFunction(() => new Promise((resolve) => {
    const plan = document.querySelector("#fpScaleInner .fp-section:not(.hidden) .plan");
    const antes = plan.style.transform;
    setTimeout(() => resolve(plan.style.transform === antes), 350);
  }));
}

function medirPlanta() {
  const secao = document.querySelector("#fpScaleInner .fp-section:not(.hidden)");
  const wrap = secao.querySelector(".plan-wrap");
  const plan = secao.querySelector(".plan");
  const rw = wrap.getBoundingClientRect();
  const cs = getComputedStyle(wrap);
  const conteudo = {
    left: rw.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    right: rw.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
    top: rw.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    bottom: rw.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
  };
  const rp = plan.getBoundingClientRect();
  let vazamentoDaPlanta = 0;
  for (const el of secao.querySelectorAll(".room, .corridor")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    vazamentoDaPlanta = Math.max(vazamentoDaPlanta, r.right - rp.right, r.bottom - rp.bottom, rp.left - r.left, rp.top - r.top);
  }
  const app = document.getElementById("app");
  const ra = app.getBoundingClientRect();
  const ca = getComputedStyle(app);
  const outer = document.querySelector("#screen-floorplan .fp-scale-outer").getBoundingClientRect();
  return {
    rolaDentro: wrap.classList.contains("fp-zoomed"),
    plantaDentroDoConteudo: rp.left >= conteudo.left - 0.5 && rp.top >= conteudo.top - 0.5 && rp.right <= conteudo.right + 0.5 && rp.bottom <= conteudo.bottom + 0.5,
    plantaComecaDentro: rp.left >= conteudo.left - 0.5 && rp.top >= conteudo.top - 0.5,
    vazamentoDaPlanta,
    invólucroDentroDaColuna: outer.right <= ra.right - parseFloat(ca.paddingRight) + 0.5 && outer.left >= ra.left + parseFloat(ca.paddingLeft) - 0.5,
    escala: parseFloat((plan.style.transform.match(/scale\(([^)]+)\)/) || [])[1]),
  };
}

for (const [nome, tamanho] of Object.entries(LARGURAS)) {
  test(`the floor plan stays contained without horizontal page scroll at ${nome}`, async ({ page, context }) => {
    await abrirPlanta(page, context, tamanho);
    expect(await semRolagemHorizontal(page), "page without horizontal scroll").toBe(true);
    const medida = await page.evaluate(medirPlanta);
    expect(medida.invólucroDentroDaColuna, "the floor plan wrapper fits the page column").toBe(true);
    expect(medida.vazamentoDaPlanta, "rooms and corridors stay inside the plan").toBeLessThanOrEqual(0.5);
    expect(medida.escala).toBeGreaterThan(0);
    if (medida.rolaDentro) {
      // Below the minimum legible scale the plan scrolls inside the wrapper: it starts inside the
      // content box and its end is reachable by inner scrolling.
      expect(medida.plantaComecaDentro).toBe(true);
      const fimAlcancavel = await page.evaluate(() => {
        const secao = document.querySelector("#fpScaleInner .fp-section:not(.hidden)");
        const wrap = secao.querySelector(".plan-wrap");
        const plan = secao.querySelector(".plan");
        wrap.scrollLeft = wrap.scrollWidth;
        wrap.scrollTop = wrap.scrollHeight;
        const rp = plan.getBoundingClientRect();
        const rw = wrap.getBoundingClientRect();
        wrap.scrollLeft = 0;
        wrap.scrollTop = 0;
        return rp.right <= rw.right + 1 && rp.bottom <= rw.bottom + 1;
      });
      expect(fimAlcancavel, "the end of the plan is reachable by scrolling the wrapper").toBe(true);
    } else {
      expect(medida.plantaDentroDoConteudo, "the fitted plan does not overlap the wrapper's padding").toBe(true);
    }
  });
}

test("zooming the plan scrolls inside the wrapper and restoring fits again, without page scroll", async ({ page, context }) => {
  await abrirPlanta(page, context, VIEWPORTS.notebook);
  const antes = await page.evaluate(medirPlanta);
  expect(antes.rolaDentro).toBe(false);

  await page.locator("#floorplanZoomInBtn").click();
  await page.locator("#floorplanZoomInBtn").click();
  const ampliada = await page.evaluate(() => {
    const secao = document.querySelector("#fpScaleInner .fp-section:not(.hidden)");
    const wrap = secao.querySelector(".plan-wrap");
    const plan = secao.querySelector(".plan");
    const rp = plan.getBoundingClientRect();
    const rw = wrap.getBoundingClientRect();
    wrap.scrollLeft = wrap.scrollWidth;
    const fim = plan.getBoundingClientRect();
    wrap.scrollLeft = 0;
    return { rolaDentro: wrap.classList.contains("fp-zoomed"), maiorQueOInvolucro: rp.width > rw.width, fimAlcancavel: fim.right <= rw.right + 1 };
  });
  expect(ampliada.rolaDentro).toBe(true);
  expect(ampliada.maiorQueOInvolucro).toBe(true);
  expect(ampliada.fimAlcancavel).toBe(true);
  expect(await semRolagemHorizontal(page), "the page stays without horizontal scroll when zoomed").toBe(true);

  await page.locator("#floorplanZoomResetBtn").click();
  const depois = await page.evaluate(medirPlanta);
  expect(depois.rolaDentro).toBe(false);
  expect(depois.escala).toBeCloseTo(antes.escala, 3);
  expect(depois.plantaDentroDoConteudo).toBe(true);
});

// The CORREDOR label has the size of the room codes and stays inside the corridor band, without
// touching a room or legend, on every floor plan.
for (const [nome, tamanho] of [["mobile-portrait", VIEWPORTS["mobile-portrait"]], ["mobile-landscape", VIEWPORTS["mobile-landscape"]], ["notebook", VIEWPORTS.notebook]]) {
  test(`the CORREDOR label is legible and stays inside the corridor band at ${nome}`, async ({ page, context }) => {
    await abrirPlanta(page, context, tamanho);
    for (const secao of ["a-terreo", "a-2pav", "a-3pav", "b-terreo", "b-2pav", "b-3pav"]) {
      await page.goto(`/#/salas/planta/${secao}`);
      await expect(page.locator(`#fp-${secao}`)).toBeVisible();
      await page.waitForFunction((s) => {
        const plan = document.querySelector(`#fp-${s} .plan`);
        return !!(plan && plan.style.transform);
      }, secao);
      const medida = await page.evaluate((s) => {
        const plan = document.querySelector(`#fp-${s} .plan`);
        const corredor = Array.from(plan.querySelectorAll(".corridor")).find((el) => el.textContent.trim());
        const faixa = document.createRange();
        faixa.selectNodeContents(corredor);
        const texto = faixa.getBoundingClientRect();
        const caixa = corredor.getBoundingClientRect();
        const encosta = Array.from(plan.querySelectorAll(".room, .lbl, .deco, .ext"))
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.left < texto.right && r.right > texto.left && r.top < texto.bottom && r.bottom > texto.top; })
          .map((el) => el.textContent.trim().slice(0, 24) || el.className);
        const codigo = plan.querySelector(".room.code");
        return {
          fonte: parseFloat(getComputedStyle(corredor).fontSize),
          fonteDoCodigo: codigo ? parseFloat(getComputedStyle(codigo).fontSize) : null,
          textoDentroDaFaixa: texto.left >= caixa.left - 0.5 && texto.right <= caixa.right + 0.5 && texto.top >= caixa.top - 0.5 && texto.bottom <= caixa.bottom + 0.5,
          encosta,
        };
      }, secao);
      expect(medida.fonte, `${secao}: the label is not smaller than the room codes`).toBeGreaterThanOrEqual(medida.fonteDoCodigo || 12);
      expect(medida.textoDentroDaFaixa, `${secao}: the text stays inside the corridor band`).toBe(true);
      expect(medida.encosta, `${secao}: the text does not touch a room or legend`).toEqual([]);
      expect(await semRolagemHorizontal(page), `${secao}: page without horizontal scroll`).toBe(true);
    }
  });
}
