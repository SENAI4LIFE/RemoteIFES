const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal, irParaSala, publicarApkFixture, despublicarApkFixture } = require("../harness/fixtures");

async function dentroDaViewport(locator) {
  const box = await locator.boundingBox();
  const vp = locator.page().viewportSize();
  expect(box, "elemento deve ter caixa visível").not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
}

async function abrirComoUsuario(page, context, tamanho) {
  await injetarSessao(context, "user");
  await page.setViewportSize(tamanho);
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
}

for (const [nome, tamanho] of Object.entries(VIEWPORTS)) {
  test(`layout ${nome} (${tamanho.width}x${tamanho.height}): no horizontal scroll and accessible controls`, async ({ page, context }) => {
    await abrirComoUsuario(page, context, tamanho);
    expect(await semRolagemHorizontal(page), "tela de salas sem rolagem horizontal").toBe(true);

    const abaSalas = page.locator('.tab-btn[data-tab="salas"]');
    await expect(abaSalas).toBeVisible();
    await dentroDaViewport(abaSalas);

    await irParaSala(page, "A-108");
    expect(await semRolagemHorizontal(page), "painel sem rolagem horizontal").toBe(true);

    for (const sel of ["#btnPower", "#tempUp", "#tempDown"]) {
      const ctrl = page.locator(sel);
      await expect(ctrl).toBeVisible();
      await dentroDaViewport(ctrl);
    }
    await page.locator("#btnPower").click();
    await expect(page.locator("#modoValue")).toHaveText("Cool", { timeout: 15_000 });
    await page.locator("#btnPower").click();
    await expect(page.locator("#modoValue")).toHaveText("Off");
  });
}

for (const nome of ["mobile-compact", "mobile-portrait", "mobile-large", "mobile-landscape", "tablet-compact", "tablet-portrait", "tablet-large", "notebook"]) {
  test(`the ESP32 registration floor plan does not overflow the screen (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/macs");
    await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#macsFpInner .room.selectable").first()).toBeVisible({ timeout: 10_000 });

    expect(await semRolagemHorizontal(page), "página sem rolagem horizontal").toBe(true);

    // Opening Administration animates the column (#app) width; the plan follows the wrapper through
    // ResizeObserver, delivered only on the next frame. Measure after the animation ends and a
    // frame is painted, which is the state the user sees.
    await page.evaluate(() => Promise.all(document.getElementById("app").getAnimations().map((a) => a.finished.catch(() => {}))));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const medida = await page.evaluate(() => {
      const outer = document.querySelector("#adminSub-macs .fp-scale-outer");
      const inner = document.getElementById("macsFpInner");
      const secao = inner && inner.querySelector(".fp-section:not(.hidden)");
      const plan = secao && secao.querySelector(".plan");
      const wrap = secao && secao.querySelector(".plan-wrap");
      if (!plan || !wrap || !outer) return null;
      const pr = plan.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const or = outer.getBoundingClientRect();
      const rolavel = wrap.classList.contains("fp-zoomed");
      let fimAlcancavel = true;
      if (rolavel) {
        wrap.scrollLeft = wrap.scrollWidth;
        fimAlcancavel = plan.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1;
        wrap.scrollLeft = 0;
      }
      return {
        vazaDireita: Math.round(pr.x + pr.width - (wr.x + wr.width)),
        rolavel,
        fimAlcancavel,
        involucroVazaDireita: Math.round(wr.right - or.right),
        seletorEscondeConteudo: outer.scrollWidth > outer.clientWidth + 1,
      };
    });
    expect(medida, "planta baixa renderizada").not.toBeNull();
    expect(medida.vazaDireita <= 1 || medida.rolavel, `planta cabe ou rola (${JSON.stringify(medida)})`).toBe(true);
    expect(medida.fimAlcancavel, `o fim da planta é alcançável rolando o invólucro (${JSON.stringify(medida)})`).toBe(true);
    expect(medida.involucroVazaDireita, `o invólucro da planta cabe no seletor (${JSON.stringify(medida)})`).toBeLessThanOrEqual(1);
    expect(medida.seletorEscondeConteudo, `nada fica escondido além da borda do seletor (${JSON.stringify(medida)})`).toBe(false);
  });
}

for (const nome of ["mobile-compact", "mobile-portrait", "mobile-large", "mobile-landscape", "tablet-compact", "tablet-portrait", "tablet-large"]) {
  test(`the app page with a published APK does not overflow the screen (${nome})`, async ({ page, context, request }) => {
    await publicarApkFixture(request);
    try {
      await injetarSessao(context, "user");
      await page.setViewportSize(VIEWPORTS[nome]);
      await page.goto("/#/aplicativo");
      const baixar = page.locator(".mobile-app-download-btn");
      await expect(baixar).toBeVisible({ timeout: 20_000 });
      expect(await semRolagemHorizontal(page), "página do aplicativo sem rolagem horizontal").toBe(true);

      const medidas = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const btn = document.querySelector(".mobile-app-download-btn").getBoundingClientRect();
        const hash = document.querySelector(".mobile-app-hash");
        const limite = hash.parentElement.getBoundingClientRect();
        const linhas = [...hash.getClientRects()];
        return {
          botaoVaza: Math.round(btn.x + btn.width - vw),
          hashLinhas: linhas.length,
          hashVaza: Math.round(Math.max(0, ...linhas.map((linha) => linha.right - limite.right))),
        };
      });
      expect(medidas.botaoVaza, "botão de download cabe na largura").toBeLessThanOrEqual(1);
      expect(medidas.hashLinhas, "SHA-256 renderizado").toBeGreaterThan(0);
      expect(medidas.hashVaza, "o SHA-256 quebra dentro do cartão").toBeLessThanOrEqual(1);
    } finally {
      await despublicarApkFixture(request);
    }
  });
}

test("portrait -> landscape rotation preserves the screen and the controller state", async ({ page, context }) => {
  await abrirComoUsuario(page, context, VIEWPORTS["mobile-portrait"]);
  await irParaSala(page, "A-108");
  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool", { timeout: 15_000 });

  await page.setViewportSize(VIEWPORTS["mobile-landscape"]);
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#btnPower")).toBeVisible();
  expect(await semRolagemHorizontal(page), "paisagem sem rolagem horizontal").toBe(true);

  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#modoValue")).toHaveText("Cool");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
});

// Top-bar dropdown panels are anchored to the button that opens them. The bell and bug buttons are
// not at the right edge, so on narrow screens a wide panel would leave through the left without
// creating horizontal scroll, and therefore without being caught by the measurements above.
for (const nome of ["mobile-compact", "mobile-portrait", "mobile-large", "tablet-compact"]) {
  test(`top-bar panels open fully inside the screen (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "admin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/");
    await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

    for (const [botao, painel, titulo] of [
      ["#notifBellBtn", "#notifPanel", "#notifPanel .notif-panel-head h3"],
      ["#bugReportBtn", "#relatosPanel", "#relatosPanel .relatos-panel-head h3"],
    ]) {
      await page.locator(botao).click();
      await expect(page.locator(painel)).toBeVisible();
      const medida = await page.evaluate(([sPainel, sTitulo]) => {
        const vw = document.documentElement.clientWidth;
        const p = document.querySelector(sPainel).getBoundingClientRect();
        const t = document.querySelector(sTitulo);
        const tr = t.getBoundingClientRect();
        return {
          painelEsquerda: Math.round(p.x),
          painelDireita: Math.round(vw - p.right),
          tituloEsquerda: Math.round(tr.x),
          tituloDireita: Math.round(vw - tr.right),
          tituloCortado: t.scrollWidth > t.clientWidth + 1,
        };
      }, [painel, titulo]);
      expect(medida.painelEsquerda, `${painel} não sai pela esquerda`).toBeGreaterThanOrEqual(-1);
      expect(medida.painelDireita, `${painel} não sai pela direita`).toBeGreaterThanOrEqual(-1);
      expect(medida.tituloEsquerda, `título de ${painel} inteiro à esquerda`).toBeGreaterThanOrEqual(-1);
      expect(medida.tituloDireita, `título de ${painel} inteiro à direita`).toBeGreaterThanOrEqual(-1);
      expect(medida.tituloCortado, `título de ${painel} não truncado`).toBe(false);
    }
  });
}

// The top bar wraps to more than one line when the font is enlarged. A panel pinned to a constant
// bar height covered the bell and bug buttons and swallowed taps, preventing a switch from
// Notificações to Relatar problema without first closing the open panel.
for (const nome of ["mobile-compact", "mobile-portrait"]) {
  test(`with the top bar on two lines an open panel does not cover the other buttons (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "admin");
    await context.addInitScript((ajustes) => {
      try {
        Object.entries(ajustes).forEach(([k, v]) => window.localStorage.setItem(k, v));
      } catch (e) {}
    }, { remoteifes_font_scale: "2", remoteifes_line_height: "3", remoteifes_letter_spacing: "0.25" });
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/inicio");
    await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });

    await page.locator("#notifBellBtn").click();
    await expect(page.locator("#notifPanel")).toBeVisible();

    const medida = await page.evaluate(() => {
      const barra = document.querySelector(".topbar").getBoundingClientRect();
      const painel = document.querySelector("#notifPanel").getBoundingClientRect();
      const botao = document.querySelector("#bugReportBtn").getBoundingClientRect();
      const noCentro = document.elementFromPoint(botao.x + botao.width / 2, botao.y + botao.height / 2);
      return {
        barraEmDuasLinhas: barra.height > 90,
        painelAbaixoDaBarra: Math.round(painel.top - barra.bottom),
        painelDentroDaTela: Math.round(window.innerHeight - painel.bottom),
        botaoRecebeToque: !!document.querySelector("#bugReportBtn").contains(noCentro),
      };
    });
    expect(medida.barraEmDuasLinhas, "a fonte ampliada realmente alarga a barra").toBe(true);
    expect(medida.painelAbaixoDaBarra, "o painel começa abaixo da barra real, não de uma altura fixa").toBeGreaterThanOrEqual(0);
    expect(medida.painelDentroDaTela, "o painel termina dentro da tela").toBeGreaterThanOrEqual(0);
    expect(medida.botaoRecebeToque, "o botão de relatar problema recebe o toque").toBe(true);

    await page.locator("#bugReportBtn").click();
    await expect(page.locator("#relatosPanel")).toBeVisible();
    await expect(page.locator("#notifPanel")).toBeHidden();
    await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "false");
  });
}
