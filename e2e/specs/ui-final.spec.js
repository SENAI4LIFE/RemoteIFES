const { test, expect, VIEWPORTS, injetarSessao, irParaSala, semRolagemHorizontal } = require("../harness/fixtures");

const MAXIMO_A11Y = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
};

async function abrir(page, context, papel, rota, tamanho, a11yMaximo = false) {
  await injetarSessao(context, papel);
  if (a11yMaximo) {
    await context.addInitScript((ajustes) => {
      try {
        Object.entries(ajustes).forEach(([k, v]) => window.localStorage.setItem(k, v));
      } catch (e) {}
    }, MAXIMO_A11Y);
  }
  if (tamanho) await page.setViewportSize(tamanho);
  await page.goto(rota);
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const TITULOS = {
  "#/salas/planta": { tela: "#screen-floorplan", texto: "Plantas baixas" },
  "#/agenda": { tela: "#screen-agenda", texto: "Agendamentos" },
  "#/grade": { tela: "#screen-grade", texto: "Grade do dia" },
  "#/admin": { tela: "#screen-admin", texto: "Administração" },
};

for (const [rota, alvo] of Object.entries(TITULOS)) {
  test(`the title "${alvo.texto}" keeps its natural left alignment`, async ({ page, context }) => {
    await abrir(page, context, "superadmin", rota, VIEWPORTS.notebook);
    const cabecalho = page.locator(`${alvo.tela} .screen-head`).first();
    await expect(cabecalho.locator("h1")).toHaveText(alvo.texto);

    const medida = await cabecalho.evaluate((head) => {
      const h1 = head.querySelector("h1");
      const rh = head.getBoundingClientRect();
      const rt = h1.getBoundingClientRect();
      return {
        desvio: Math.abs(rt.left - rh.left),
        largura: rh.width,
        alinhamento: getComputedStyle(h1).textAlign,
      };
    });
    expect(medida.largura).toBeGreaterThan(0);
    expect(medida.desvio, `recuo inesperado em ${alvo.texto}`).toBeLessThanOrEqual(2);
    expect(["start", "left"]).toContain(medida.alinhamento);
  });
}

test("subtitles, selections and form labels stay left-aligned", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/agenda", VIEWPORTS.notebook);
  const alinhamentos = await page.$$eval("#screen-agenda > .screen-head + .hint, #screen-agenda label", (els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => getComputedStyle(el).textAlign)
  );
  expect(alinhamentos.length).toBeGreaterThan(0);
  alinhamentos.forEach((alinhamento) => expect(["start", "left"]).toContain(alinhamento));

  await page.goto("/#/salas");
  await expect(page.locator("#simpleScreenTitle")).toHaveText("Selecione o bloco");
  await expect(page.locator("#simpleScreenTitle")).toHaveCSS("text-align", /^(start|left)$/);

  await page.goto("/#/admin/usuarios");
  await expect(page.locator("#usuariosAba-contas h2")).toHaveCSS("text-align", /^(start|left)$/);
  await expect(page.locator("#usuariosAba-contas > .hint")).toHaveCSS("text-align", /^(start|left)$/);
  const alinhamentosAdmin = await page.$$eval("#adminSub-usuarios h2, #adminSub-usuarios .hint, #adminSub-usuarios label", (els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => getComputedStyle(el).textAlign)
  );
  expect(alinhamentosAdmin.length).toBeGreaterThan(0);
  alinhamentosAdmin.forEach((alinhamento) => expect(["start", "left"]).toContain(alinhamento));
});

test("the default alignment is left and a saved preference is preserved", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveClass(/a11y-align-left/);
  await expect(page.locator("#a11yAlignLeftBtn")).toHaveClass(/is-active/);
  await expect(page.locator("#a11yAlignLeftBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#a11yAlignLeftBtn")).toHaveText("Esquerda");
  expect(await page.evaluate(() => window.localStorage.getItem("remoteifes_text_align"))).toBeNull();

  await context.addInitScript(() => window.localStorage.setItem("remoteifes_text_align", "right"));
  await page.reload();
  await expect(page.locator("body")).toHaveClass(/a11y-align-right/);
  await expect(page.locator("#a11yAlignRightBtn")).toHaveClass(/is-active/);
  await expect(page.locator("#a11yAlignRightBtn")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.localStorage.getItem("remoteifes_text_align"))).toBe("right");
});

test("the access screen keeps the button centered and the title left-aligned with maximum accessibility", async ({ page, context }) => {
  await context.addInitScript((ajustes) => {
    Object.entries(ajustes).forEach(([chave, valor]) => window.localStorage.setItem(chave, valor));
  }, MAXIMO_A11Y);
  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await page.goto("/");
  await page.locator("#a11yToggleBtn").click();
  const painel = await page.locator("#a11yPanel").evaluate((el) => {
    const opcao = el.querySelector("#a11yAlignCenterBtn");
    const estilo = getComputedStyle(opcao);
    return {
      semOverflowHorizontal: el.scrollWidth <= el.clientWidth + 1 && opcao.scrollWidth <= opcao.clientWidth + 1,
      larguraOpcao: opcao.getBoundingClientRect().width,
      tamanhoFonte: parseFloat(estilo.fontSize),
    };
  });
  expect(painel.semOverflowHorizontal).toBe(true);
  expect(painel.larguraOpcao).toBeGreaterThan(painel.tamanhoFonte * 4);
  await page.locator("#a11yCloseBtn").click();
  await page.locator('.portal-option[data-tipo="admin"]').click();

  const medida = await page.locator("#loginVoltarBtn").evaluate((el) => {
    const estilo = getComputedStyle(el);
    const retangulo = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const texto = range.getBoundingClientRect();
    return {
      display: estilo.display,
      alinhamento: estilo.textAlign,
      desvioHorizontal: Math.abs((texto.left + texto.right) / 2 - (retangulo.left + retangulo.right) / 2),
      desvioVertical: Math.abs((texto.top + texto.bottom) / 2 - (retangulo.top + retangulo.bottom) / 2),
      dentro: texto.left >= retangulo.left - 1 && texto.right <= retangulo.right + 1 && texto.top >= retangulo.top - 1 && texto.bottom <= retangulo.bottom + 1,
    };
  });
  expect(medida.display).toContain("flex");
  expect(medida.alinhamento).toBe("center");
  expect(medida.desvioHorizontal).toBeLessThanOrEqual(2);
  expect(medida.desvioVertical).toBeLessThanOrEqual(2);
  expect(medida.dentro).toBe(true);
  await expect(page.locator("#loginTitulo")).toHaveCSS("text-align", /^(start|left)$/);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

test("Notificações and Relatar problema are never open at the same time", async ({ page, context }) => {
  await abrir(page, context, "admin", "#/inicio", VIEWPORTS.notebook);
  const notif = page.locator("#notifPanel");
  const relatos = page.locator("#relatosPanel");

  await page.locator("#notifBellBtn").click();
  await expect(notif).toBeVisible();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "true");

  await page.locator('.hub-card[data-hub-card="relatos"]').click();
  await expect(relatos).toBeVisible();
  await expect(notif).toBeHidden();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#bugReportBtn")).toHaveAttribute("aria-expanded", "true");

  await page.locator("#notifBellBtn").click();
  await expect(notif).toBeVisible();
  await expect(relatos).toBeHidden();
  await expect(page.locator("#bugReportBtn")).toHaveAttribute("aria-expanded", "false");
});

test("the quick help menu and the bug button share the panels' state", async ({ page, context }) => {
  await abrir(page, context, "admin", "#/inicio", VIEWPORTS.notebook);
  await page.locator("#notifBellBtn").click();
  await expect(page.locator("#notifPanel")).toBeVisible();

  await page.locator("#helpFabToggleBtn").click();
  await page.locator('#helpFabPrimaryLinks [data-help-action="report"]').click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await expect(page.locator("#notifPanel")).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.locator("#relatosPanel")).toBeHidden();
  await expect(page.locator("#bugReportBtn")).toBeFocused();

  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeHidden();
});

async function abrirPlantaB2(page, context) {
  await abrir(page, context, "user", "#/salas/planta", VIEWPORTS.desktop);
  await page.locator('#screen-floorplan .fp-tab-btn[data-fp-section="b-2pav"]').click();
  await expect(page.locator('#fpScaleInner .fp-section[data-fp-section="b-2pav"]')).toBeVisible();
}

test("the B-207 geometry matches the original floor plan and scales with the map", async ({ page, context }) => {
  await abrirPlantaB2(page, context);
  const medida = await page.evaluate(() => {
    const sala = document.querySelector('#fpScaleInner .fp-section[data-fp-section="b-2pav"] .room[data-sala="B-207"]');
    const vizinha = document.querySelector('#fpScaleInner .fp-section[data-fp-section="b-2pav"] .room[data-sala="B-206"]');
    const s = sala.getBoundingClientRect();
    const v = vizinha.getBoundingClientRect();
    return {
      inline: sala.getAttribute("style"),
      codigo: sala.querySelector(".num").textContent,
      razaoLargura: s.width / v.width,
      razaoAltura: s.height / v.height,
    };
  });

  expect(medida.codigo).toBe("B-207");
  expect(medida.inline).toContain("left:160px");
  expect(medida.inline).toContain("top:90px");
  expect(medida.inline).toContain("width:100px");
  expect(medida.inline).toContain("height:190px");
  expect(medida.razaoLargura).toBeCloseTo(100 / 170, 2);
  expect(medida.razaoAltura).toBeCloseTo(190 / 180, 2);
});

test("room identifiers keep the original hyphen", async ({ page, context }) => {
  await abrirPlantaB2(page, context);
  const codigos = await page.$$eval("#fpScaleInner .room.selectable[data-sala]", (els) => els.map((e) => e.dataset.sala));
  expect(codigos).toContain("B-207");
  expect(codigos).toContain("B-201");
  const texto = await page.locator('#fpScaleInner .fp-section[data-fp-section="b-2pav"]').innerText();
  expect(texto).toContain("B-207");
  expect(texto).not.toMatch(/\bB 20\d\b/);
});

test("accessibility and help stay close together, without overlap, with 44px targets", async ({ page, context }) => {
  for (const [nome, tamanho] of Object.entries({
    "mobile portrait": VIEWPORTS["mobile-portrait"],
    "mobile landscape": VIEWPORTS["mobile-landscape"],
    tablet: VIEWPORTS["tablet-portrait"],
    notebook: VIEWPORTS.notebook,
  })) {
    await abrir(page, context, "user", "#/inicio", tamanho);
    const medida = await page.evaluate(() => {
      const a = document.getElementById("a11yToggleBtn").getBoundingClientRect();
      const h = document.getElementById("helpFabToggleBtn").getBoundingClientRect();
      return { a: { t: a.top, b: a.bottom, l: a.left, r: a.right, w: a.width, h: a.height }, h: { t: h.top, b: h.bottom, l: h.left, r: h.right, w: h.width, h: h.height } };
    });
    const folga = medida.h.t - medida.a.b;
    expect(folga, `separação em ${nome}`).toBeGreaterThan(0);
    expect(folga, `proximidade em ${nome}`).toBeLessThanOrEqual(40);
    expect(Math.abs(medida.a.r - medida.h.r), `alinhamento horizontal em ${nome}`).toBeLessThanOrEqual(1);
    [medida.a, medida.h].forEach((c) => {
      expect(c.w).toBeGreaterThanOrEqual(44);
      expect(c.h).toBeGreaterThanOrEqual(44);
    });
  }
});

test("the glyphs of fixed controls do not grow with text enlargement", async ({ page, context }) => {
  const medir = () =>
    page.evaluate(() => {
      const ajuda = document.getElementById("helpFabToggleBtn");
      const a11y = document.getElementById("a11yToggleBtn");
      const svg = a11y.querySelector("svg").getBoundingClientRect();
      return {
        fonteAjuda: getComputedStyle(ajuda).fontSize,
        alvoAjuda: ajuda.getBoundingClientRect().width,
        alvoA11y: a11y.getBoundingClientRect().width,
        svg: Math.round(svg.width),
      };
    });

  await abrir(page, context, "user", "#/inicio", VIEWPORTS.notebook);
  const padrao = await medir();
  await abrir(page, context, "user", "#/inicio", VIEWPORTS.notebook, true);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim())).toBe("2");
  const ampliado = await medir();

  expect(ampliado.fonteAjuda).toBe(padrao.fonteAjuda);
  expect(ampliado.svg).toBe(padrao.svg);
  expect(ampliado.alvoAjuda).toBe(padrao.alvoAjuda);
  expect(ampliado.alvoA11y).toBe(padrao.alvoA11y);
  expect(ampliado.alvoAjuda).toBeGreaterThanOrEqual(44);
});

const SUBABAS = ["usuarios", "usuarios/proprietarios", "notificacoes", "status/sistema", "config", "esp32", "protocolos", "macs", "logs/auditoria"];

for (const tamanhoNome of ["mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
  test(`Administration stays usable at maximum font at ${tamanhoNome}`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await abrir(page, context, "superadmin", "#/admin", VIEWPORTS[tamanhoNome], true);

    for (const rota of SUBABAS) {
      const [sub, aba] = rota.split("/");
      await page.locator(`.admin-subtab-btn[data-sub="${sub}"]`).click();
      await expect(page.locator(`#adminSub-${sub}`)).toBeVisible({ timeout: 15_000 });
      if (aba) {
        await page.locator(`#adminSub-${sub} .admin-inner-tab-btn[data-aba="${aba}"]`).click();
        await expect(page.locator(`#${sub}Aba-${aba}`)).toBeVisible({ timeout: 15_000 });
      }
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(page.locator(`#adminSub-${sub} [aria-busy="true"]`)).toHaveCount(0);

      const semOverflow = await semRolagemHorizontal(page);
      const ofensores = semOverflow ? [] : await page.evaluate(() => {
        const limite = document.documentElement.clientWidth;
        const antes = document.documentElement.scrollWidth;
        const achados = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const display = el.style.display;
          el.style.display = "none";
          const depois = document.documentElement.scrollWidth;
          el.style.display = display;
          if (depois < antes) achados.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className} right=${Math.round(r.right)}/${limite}`);
          if (achados.length > 6) break;
        }
        return achados;
      });
      expect(semOverflow, `${rota} em ${tamanhoNome} sem rolagem horizontal da página: ${ofensores.join(" | ")}`).toBe(true);

      const problemas = await page.evaluate((subAtual) => {
        const achados = [];
        const painel = document.getElementById(`adminSub-${subAtual}`);
        painel.querySelectorAll(".card, .mon-card").forEach((el) => {
          const r = el.getBoundingClientRect();
          const p = painel.getBoundingClientRect();
          if (r.right > p.right + 2) achados.push(`transborda: ${el.className}`);
          const escondeVertical = getComputedStyle(el).overflowY === "hidden";
          if (escondeVertical && el.scrollHeight > el.clientHeight + 2) achados.push(`texto cortado: ${el.className}`);
        });
        document.querySelectorAll(".admin-subtab-btn:not(.hidden) .admin-subtab-label").forEach((el) => {
          const r = el.getBoundingClientRect();
          const linhas = Math.round(r.height / parseFloat(getComputedStyle(el).fontSize));
          if (r.width > 0 && linhas > el.textContent.trim().split(/\s+/).length + 3) {
            achados.push(`rótulo quebrado letra a letra: ${el.textContent.trim()}`);
          }
        });
        painel.querySelectorAll("button.btn:not(.hidden)").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && el.textContent.trim() && r.height < 20) achados.push(`botão sem rótulo visível: ${el.id || el.className}`);
        });
        painel.querySelectorAll(".admin-inner-tab-btn:not(.hidden)").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && el.scrollWidth > el.clientWidth + 1) achados.push(`aba interna cortada: ${el.dataset.aba}`);
        });
        painel.querySelectorAll(".mon-card h4, .status-chip").forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) achados.push(`status transborda: ${el.textContent.trim()}`);
        });
        return achados;
      }, sub);
      expect(problemas, `${rota} em ${tamanhoNome}`).toEqual([]);
    }
  });
}

test("Status > Sistema does not clip content on the right at maximum font", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/admin/status/sistema", VIEWPORTS.notebook, true);
  await expect(page.locator("#statusAba-sistema")).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await semRolagemHorizontal(page)).toBe(true);
  await expect.poll(async () => page.locator("#monGrid .mon-card").count(), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await semRolagemHorizontal(page)).toBe(true);
  const cortados = await page.$$eval("#monGrid .mon-card .mon-row", (els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.textContent.trim())
  );
  expect(cortados).toEqual([]);
});

test("with default settings the interface stays as before", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/admin", VIEWPORTS.notebook);
  const escala = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim());
  expect(escala === "" || escala === "1").toBe(true);
  const largura = await page.locator(".admin-subtabs").evaluate((el) => el.getBoundingClientRect().width);
  expect(largura).toBeGreaterThan(200);
  expect(largura).toBeLessThanOrEqual(241);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

const PAINEL_DUAS_COLUNAS = ["tablet-compact", "tablet-portrait", "tablet-large", "tablet-landscape", "notebook", "desktop-compact", "desktop", "wide-desktop"];

for (const tamanhoNome of PAINEL_DUAS_COLUNAS) {
  test(`Turbo and Temperatura − stay on the same row as the room control at ${tamanhoNome}`, async ({ page, context }) => {
    await injetarSessao(context, "user");
    await page.setViewportSize(VIEWPORTS[tamanhoNome]);
    await page.goto("/");
    await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
    await irParaSala(page, "A-108");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const m = await page.evaluate(() => {
      const centro = (id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return (b.top + b.bottom) / 2;
      };
      return {
        largo: window.matchMedia("(min-width: 700px) and (min-height: 560px)").matches,
        power: centro("btnPower"), turbo: centro("btnTurbo"), up: centro("tempUp"), down: centro("tempDown"),
      };
    });

    expect(m.largo, "o painel largo usa a grade de duas colunas").toBe(true);
    expect(Math.abs(m.turbo - m.down), "Turbo e Temperatura − compartilham a linha de baixo").toBeLessThanOrEqual(1);
    expect(Math.abs(m.power - m.up), "Power e Temperatura + compartilham a linha de cima").toBeLessThanOrEqual(1);
    expect(m.turbo, "a linha de baixo vem depois da de cima").toBeGreaterThan(m.power);
    expect(await semRolagemHorizontal(page), "painel sem rolagem horizontal").toBe(true);
  });
}

// Accessibility letter-spacing is also applied after the last glyph: a label centered by its text
// box sits half a spacing left of what is seen. The center of the "Power" glyphs must match the
// center of the circle in every layout and text setting.
const LAYOUTS_POWER = ["mobile-portrait", "mobile-landscape", "tablet-compact", "notebook", "desktop"];

for (const [ajusteNome, a11yMaximo] of [["ajuste padrão", false], ["texto máximo", true]]) {
  for (const tamanhoNome of LAYOUTS_POWER) {
    test(`the Power label is centered under the circle (${ajusteNome}, ${tamanhoNome})`, async ({ page, context }) => {
      await abrir(page, context, "user", "/", VIEWPORTS[tamanhoNome], a11yMaximo);
      await irParaSala(page, "A-108");
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      const m = await page.evaluate(() => {
        const botao = document.getElementById("btnPower");
        const circulo = botao.querySelector(".ac-remote-power-icon").getBoundingClientRect();
        const rotulo = botao.querySelector(".ac-remote-control-label");
        const faixa = document.createRange();
        faixa.selectNodeContents(rotulo);
        const texto = faixa.getBoundingClientRect();
        // The text box includes the space the browser adds after the last glyph.
        const espaco = parseFloat(getComputedStyle(rotulo).letterSpacing) || 0;
        return {
          circulo: (circulo.left + circulo.right) / 2,
          glifos: (texto.left + texto.right - espaco) / 2,
          espaco,
          larguraCirculo: circulo.width,
        };
      });

      expect(m.larguraCirculo, "o círculo do Power está visível").toBeGreaterThan(0);
      if (a11yMaximo) expect(m.espaco, "o espaçamento de letras chegou ao rótulo").toBeGreaterThan(0);
      expect(Math.abs(m.glifos - m.circulo), "centro do texto Power sob o centro do círculo").toBeLessThanOrEqual(1);
    });
  }
}
