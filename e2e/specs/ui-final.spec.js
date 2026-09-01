const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// Ajustes de acessibilidade no maximo suportado (a11y.js: fonte 2x, entrelinha 3, espacamento .25em).
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
  // Um goto que so troca o fragmento nao recarrega o documento, e os init scripts
  // (sessao e ajustes de acessibilidade) nao chegariam a rodar.
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// ---------------------------------------------------------------- titulos centralizados

const TITULOS = {
  "#/salas/planta": { tela: "#screen-floorplan", texto: "Plantas baixas" },
  "#/agenda": { tela: "#screen-agenda", texto: "Agendamentos" },
  "#/grade": { tela: "#screen-grade", texto: "Grade do dia" },
  "#/admin": { tela: "#screen-admin", texto: "Administração" },
};

for (const [rota, alvo] of Object.entries(TITULOS)) {
  test(`o título "${alvo.texto}" fica centralizado na própria área de conteúdo`, async ({ page, context }) => {
    await abrir(page, context, "superadmin", rota, VIEWPORTS.notebook);
    const cabecalho = page.locator(`${alvo.tela} .screen-head-centralizado`).first();
    await expect(cabecalho.locator("h1")).toHaveText(alvo.texto);

    const medida = await cabecalho.evaluate((head) => {
      const h1 = head.querySelector("h1");
      const rh = head.getBoundingClientRect();
      const rt = h1.getBoundingClientRect();
      return {
        desvio: Math.abs((rt.left + rt.right) / 2 - (rh.left + rh.right) / 2),
        largura: rh.width,
        alinhamento: getComputedStyle(h1).textAlign,
      };
    });
    expect(medida.largura).toBeGreaterThan(0);
    expect(medida.desvio, `desvio do centro em ${alvo.texto}`).toBeLessThanOrEqual(2);
    expect(medida.alinhamento).toBe("center");
  });
}

test("o texto comum das páginas continua alinhado à esquerda", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/agenda", VIEWPORTS.notebook);
  const alinhamentos = await page.$$eval("#screen-agenda .hint, #screen-agenda label", (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => getComputedStyle(e).textAlign)
  );
  expect(alinhamentos.length).toBeGreaterThan(0);
  alinhamentos.forEach((a) => expect(["start", "left"]).toContain(a));
});

// ---------------------------------------------------------------- popovers exclusivos

test("Notificações e Relatar problema nunca ficam abertos ao mesmo tempo", async ({ page, context }) => {
  await abrir(page, context, "admin", "#/inicio", VIEWPORTS.notebook);
  const notif = page.locator("#notifPanel");
  const relatos = page.locator("#relatosPanel");

  // Sino primeiro, depois o cartão de relato: o sino precisa fechar.
  await page.locator("#notifBellBtn").click();
  await expect(notif).toBeVisible();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "true");

  await page.locator('.hub-card[data-hub-card="relatos"]').click();
  await expect(relatos).toBeVisible();
  await expect(notif).toBeHidden();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#bugReportBtn")).toHaveAttribute("aria-expanded", "true");

  // Caminho inverso: abrir o sino fecha o painel de relatos.
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

  // Escape fecha e devolve o foco ao disparador.
  await page.keyboard.press("Escape");
  await expect(page.locator("#relatosPanel")).toBeHidden();
  await expect(page.locator("#bugReportBtn")).toBeFocused();

  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await page.locator("#bugReportBtn").click();
  await expect(page.locator("#relatosPanel")).toBeHidden();
});

// ---------------------------------------------------------------- planta baixa

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
      // A escala do mapa e uniforme: a razao renderizada tem de bater com a razao das medidas base.
      razaoLargura: s.width / v.width,
      razaoAltura: s.height / v.height,
    };
  });

  expect(medida.codigo).toBe("B-207");
  expect(medida.inline).toContain("left:160px");
  expect(medida.inline).toContain("top:90px");
  expect(medida.inline).toContain("width:100px");
  expect(medida.inline).toContain("height:190px");
  // B-206 tem 170x180 na planta: a razao renderizada precisa reproduzir 100/170 e 190/180.
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

// ---------------------------------------------------------------- controles flutuantes

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
  // O alvo de toque continua o mesmo e continua acessivel.
  expect(ampliado.alvoAjuda).toBe(padrao.alvoAjuda);
  expect(ampliado.alvoA11y).toBe(padrao.alvoA11y);
  expect(ampliado.alvoAjuda).toBeGreaterThanOrEqual(44);
});

// ---------------------------------------------------------------- reflow com fonte maxima

const SUBABAS = ["usuarios", "notificacoes", "monitoramento", "energia", "config", "esp32", "macs", "auditoria"];

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
        // Conteudo tem de caber no proprio componente, sem transbordar o painel.
        painel.querySelectorAll(".card, .mon-card, .energy-summary-card").forEach((el) => {
          const r = el.getBoundingClientRect();
          const p = painel.getBoundingClientRect();
          if (r.right > p.right + 2) achados.push(`transborda: ${el.className}`);
          if (el.scrollHeight > el.clientHeight + 2) achados.push(`texto cortado: ${el.className}`);
        });
        // Rotulos das sub-abas nao podem virar coluna de uma letra.
        document.querySelectorAll(".admin-subtab-btn:not(.hidden) .admin-subtab-label").forEach((el) => {
          const r = el.getBoundingClientRect();
          const linhas = Math.round(r.height / parseFloat(getComputedStyle(el).fontSize));
          if (r.width > 0 && linhas > el.textContent.trim().split(/\s+/).length + 3) {
            achados.push(`rótulo quebrado letra a letra: ${el.textContent.trim()}`);
          }
        });
        // Botoes precisam manter rotulo visivel.
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

test("Energia e Monitoramento não cortam conteúdo à direita na fonte máxima", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "#/admin/energia", VIEWPORTS.notebook, true);
  await expect(page.locator("#adminSub-energia")).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Tabela larga rola dentro do proprio componente, nao na pagina.
  const tabela = await page.locator(".energy-table-wrap").evaluate((el) => ({
    rolaNoComponente: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).overflowX,
  }));
  expect(tabela.overflow).toBe("auto");
  expect(await semRolagemHorizontal(page)).toBe(true);
  expect(tabela.rolaNoComponente).toBe(true);

  await page.locator('.admin-subtab-btn[data-sub="monitoramento"]').click();
  await expect(page.locator("#adminSub-monitoramento")).toBeVisible();
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
