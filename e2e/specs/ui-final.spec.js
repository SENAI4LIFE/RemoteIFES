const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

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
  test(`o título "${alvo.texto}" mantém o alinhamento natural à esquerda`, async ({ page, context }) => {
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

test("subtítulos, seleções e rótulos de formulário permanecem à esquerda", async ({ page, context }) => {
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
  await expect(page.locator("#adminSub-usuarios h2")).toHaveCSS("text-align", /^(start|left)$/);
  await expect(page.locator("#adminSub-usuarios > .hint")).toHaveCSS("text-align", /^(start|left)$/);
});

test("o alinhamento padrão é à esquerda e uma preferência salva é preservada", async ({ page, context }) => {
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

test("o acesso mantém o botão centralizado e o título à esquerda com acessibilidade máxima", async ({ page, context }) => {
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

test("Notificações e Relatar problema nunca ficam abertos ao mesmo tempo", async ({ page, context }) => {
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

test("o menu rápido de ajuda e o botão de inseto usam o mesmo estado dos painéis", async ({ page, context }) => {
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

test("a geometria de B-207 corresponde à planta baixa original e escala junto com o mapa", async ({ page, context }) => {
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

test("os identificadores de sala mantêm o hífen original", async ({ page, context }) => {
  await abrirPlantaB2(page, context);
  const codigos = await page.$$eval("#fpScaleInner .room.selectable[data-sala]", (els) => els.map((e) => e.dataset.sala));
  expect(codigos).toContain("B-207");
  expect(codigos).toContain("B-201");
  const texto = await page.locator('#fpScaleInner .fp-section[data-fp-section="b-2pav"]').innerText();
  expect(texto).toContain("B-207");
  expect(texto).not.toMatch(/\bB 20\d\b/);
});

test("acessibilidade e ajuda ficam próximos, sem sobreposição, com alvos de 44px", async ({ page, context }) => {
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

test("os glifos dos controles fixos não crescem com a ampliação do texto", async ({ page, context }) => {
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

const SUBABAS = ["usuarios", "notificacoes", "monitoramento", "config", "esp32", "macs", "auditoria"];

for (const tamanhoNome of ["mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
  test(`Administração continua utilizável na fonte máxima em ${tamanhoNome}`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await abrir(page, context, "superadmin", "#/admin", VIEWPORTS[tamanhoNome], true);

    for (const sub of SUBABAS) {
      await page.locator(`.admin-subtab-btn[data-sub="${sub}"]`).click();
      await expect(page.locator(`#adminSub-${sub}`)).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

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
      expect(semOverflow, `${sub} em ${tamanhoNome} sem rolagem horizontal da página: ${ofensores.join(" | ")}`).toBe(true);

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
        return achados;
      }, sub);
      expect(problemas, `${sub} em ${tamanhoNome}`).toEqual([]);
    }
  });
}

test("Monitoramento não corta conteúdo à direita na fonte máxima", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/admin/monitoramento", VIEWPORTS.notebook, true);
  await expect(page.locator("#adminSub-monitoramento")).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await semRolagemHorizontal(page)).toBe(true);
  await expect.poll(async () => page.locator("#monGrid .mon-card").count(), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await semRolagemHorizontal(page)).toBe(true);
  const cortados = await page.$$eval("#monGrid .mon-card .mon-row", (els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.textContent.trim())
  );
  expect(cortados).toEqual([]);
});

test("no ajuste padrão a interface permanece como antes", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/admin", VIEWPORTS.notebook);
  const escala = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim());
  expect(escala === "" || escala === "1").toBe(true);
  const largura = await page.locator(".admin-subtabs").evaluate((el) => el.getBoundingClientRect().width);
  expect(largura).toBeGreaterThan(200);
  expect(largura).toBeLessThanOrEqual(241);
  expect(await semRolagemHorizontal(page)).toBe(true);
});
