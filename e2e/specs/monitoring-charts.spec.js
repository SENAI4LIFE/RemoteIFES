const { test, expect, VIEWPORTS, API_URL, injetarSessao, tokenDe, semRolagemHorizontal } = require("../harness/fixtures");

const FIGURAS_HISTORICO = ["grEsp32", "grEventos", "grFalhas", "grComandos", "grRss", "grCpu", "grBancoMs", "grBancoBytes", "grDisco"];
const FIGURAS_ATUAIS = ["grEspAtual", "grCredAtual", "grOtaAtual", "grTabelasAtual"];
const A11Y_MAXIMA = { remoteifes_font_scale: "2", remoteifes_line_height: "3", remoteifes_letter_spacing: "0.25" };

async function semearHistorico(request, corpo = {}) {
  const resp = await request.post(`${API_URL}/__e2e/monitoramento-historico`, { data: corpo });
  if (!resp.ok()) throw new Error(`/__e2e/monitoramento-historico falhou (HTTP ${resp.status()})`);
  return resp.json();
}

async function limparHistorico(request) {
  const resp = await request.post(`${API_URL}/__e2e/monitoramento-historico/limpar`);
  if (!resp.ok()) throw new Error(`/__e2e/monitoramento-historico/limpar falhou (HTTP ${resp.status()})`);
}

async function abrirMonitoramento(page, context, papel = "superadmin", tamanho = VIEWPORTS.notebook, armazenamento = {}) {
  await injetarSessao(context, papel);
  await context.addInitScript((valores) => {
    for (const [chave, valor] of Object.entries(valores)) localStorage.setItem(chave, valor);
  }, armazenamento);
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/monitoramento");
  await page.reload();
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

async function esperarGraficos(page) {
  await expect(page.locator("#monGraficosBloco")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator("#monGraficosSeries svg").count(), { timeout: 20_000 }).toBe(FIGURAS_HISTORICO.length);
  await expect.poll(() => page.locator("#monGraficosAtual svg").count(), { timeout: 20_000 }).toBe(FIGURAS_ATUAIS.length);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

function medirFiguras(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const bloco = document.getElementById("monGraficosBloco").getBoundingClientRect();
    const figuras = [...document.querySelectorAll("#monGraficosBloco .gr")].map((el) => {
      const r = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      const s = svg ? svg.getBoundingClientRect() : r;
      const textos = svg ? [...svg.querySelectorAll("text")].map((t) => t.getBoundingClientRect()) : [];
      const cortados = textos.filter((t) => t.width > 0 && (t.left < r.left - 2 || t.right > r.right + 2)).length;
      const legenda = el.querySelector(".gr-legenda");
      return {
        id: el.id,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        svgWidth: Math.round(s.width),
        svgRight: Math.round(s.right),
        textos: textos.length,
        cortados,
        legendaDentro: !legenda || legenda.getBoundingClientRect().right <= r.right + 1,
        fonteTick: parseFloat(getComputedStyle(svg.querySelector(".gr-eixo") || svg).fontSize),
        largo: el.classList.contains("gr-largo"),
      };
    });
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, blocoRight: Math.round(bloco.right), blocoLeft: Math.round(bloco.left), figuras };
  });
}

test.beforeAll(async ({ request }) => {
  await semearHistorico(request);
});

test.afterAll(async ({ request }) => {
  await limparHistorico(request);
});

test("monitoring history is superadministrator-only and validates the range", async ({ page, context, request }) => {
  for (const [papel, status] of [["user", 403], ["admin", 403], ["superadmin", 200]]) {
    const resp = await request.get(`${API_URL}/admin/monitoramento/historico?faixa=24h`, {
      headers: { Authorization: `Bearer ${tokenDe(papel)}` },
    });
    expect(resp.status(), `HTTP para ${papel}`).toBe(status);
  }
  const invalida = await request.get(`${API_URL}/admin/monitoramento/historico?faixa=2h`, {
    headers: { Authorization: `Bearer ${tokenDe("superadmin")}` },
  });
  expect(invalida.status()).toBe(400);
  const semToken = await request.get(`${API_URL}/admin/monitoramento/historico`);
  expect(semToken.status()).toBe(401);

  await abrirMonitoramento(page, context, "admin");
  await expect(page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]')).toBeHidden();
  await expect(page.locator("#monGraficosBloco")).toBeHidden();
});

test("every chart has a title, a legend when there is more than one series, a text summary and a value table", async ({ page, context }) => {
  await abrirMonitoramento(page, context);
  await esperarGraficos(page);

  await expect(page.locator("#monGraficosMeta")).toContainText("Amostra a cada 60 s");
  await expect(page.locator("#monGraficosMeta")).toContainText("48 h");
  await expect(page.locator("#monGraficosMeta")).toContainText("30 dias");
  await expect(page.locator("#monGraficosVazio")).toBeHidden();
  await expect(page.locator("#monGraficosErro")).toBeHidden();

  for (const id of [...FIGURAS_HISTORICO, ...FIGURAS_ATUAIS]) {
    const fig = page.locator(`#${id}`);
    await expect(fig.locator(".gr-titulo"), id).not.toBeEmpty();
    await expect(fig.locator(".gr-resumo"), id).not.toBeEmpty();
    const descricao = await fig.locator("figure[role=group]").getAttribute("aria-describedby");
    expect(descricao, id).toMatch(/-resumo$/);
    await expect(page.locator(`#${descricao}`), id).not.toBeEmpty();
    await expect(fig.locator(".gr-plot"), id).toHaveAttribute("tabindex", "0");
    await expect(fig.locator(".gr-leitura"), id).toHaveAttribute("role", "status");
    expect(await fig.locator("svg").getAttribute("aria-hidden"), id).toBe("true");
  }

  const esp = page.locator("#grEsp32");
  await expect(esp.locator(".gr-legenda li")).toHaveCount(4);
  await expect(esp.locator(".gr-legenda")).toContainText("reinício do serviço");
  await expect(esp.locator(".gr-resumo")).toContainText("reinício");
  expect(await esp.locator(".gr-reinicio").count()).toBeGreaterThan(0);
  expect(await esp.locator(".gr-linha").count()).toBe(3);
  expect(await esp.locator(".gr-area").count()).toBe(1);

  await expect(page.locator("#grDisco .gr-legenda li")).toHaveCount(2);
  await expect(page.locator("#grEventos .gr-legenda")).toContainText("Reconexões");
  const eventos = (await page.locator("#grEventos .gr-resumo").innerText()).match(/(\d+) reconexões, (\d+) quedas/);
  expect(eventos, "resumo de reconexões e quedas").not.toBeNull();
  expect(Number(eventos[1])).toBeGreaterThanOrEqual(5);
  expect(Number(eventos[2])).toBeGreaterThanOrEqual(5);
  await expect(page.locator("#grFalhas .gr-resumo")).toContainText("2 credencial");
  await expect(page.locator("#grFalhas .gr-resumo")).toContainText("1 ota");
  expect(await page.locator("#grComandos .gr-coluna").count()).toBeGreaterThan(10);
  expect(await page.locator("#grEspAtual .gr-fatia").count()).toBeGreaterThan(0);
  await expect(page.locator("#grEspAtual .gr-legenda")).toContainText("Online");
  await expect(page.locator("#grOtaAtual .gr-resumo")).toContainText("Nenhuma atualização de firmware registrada");
  await expect(page.locator("#grTabelasAtual .gr-rotulo-categoria")).toHaveCount(10);
  await expect(page.locator("#grTabelasAtual .gr-resumo")).toContainText("próprio histórico de monitoramento");

  const tabela = page.locator("#grRss .gr-tabela");
  expect(await tabela.locator("table").count()).toBe(0);
  await tabela.locator("summary").click();
  await expect(tabela.locator("table thead th").first()).toHaveText("Intervalo");
  expect(await tabela.locator("tbody tr").count()).toBe(96);
  const linhaComDado = tabela.locator("tbody tr").filter({ hasText: /MB/ }).first();
  await expect(linhaComDado).toContainText("MB");
});

test("the time range is a single control above the charts: changing it queries once and updates the subtitles", async ({ page, context }) => {
  const chamadas = [];
  await page.route("**/admin/monitoramento/historico*", (rota) => {
    chamadas.push(new URL(rota.request().url()).searchParams.get("faixa"));
    return rota.continue();
  });
  await abrirMonitoramento(page, context);
  await esperarGraficos(page);
  expect(chamadas).toEqual(["24h"]);
  await expect(page.locator('.gr-faixa[data-faixa="24h"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("24 horas");
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("15 min");

  await page.locator('.gr-faixa[data-faixa="7d"]').click();
  await expect.poll(() => chamadas.length).toBe(2);
  expect(chamadas[1]).toBe("7d");
  await expect(page.locator('.gr-faixa[data-faixa="7d"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.gr-faixa[data-faixa="24h"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("7 dias");
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("1 h");
  await expect(page.locator("#monGraficosAviso")).toBeVisible();
  await expect(page.locator("#monGraficosAviso")).toContainText("Histórico disponível desde");

  await page.locator('.gr-faixa[data-faixa="7d"]').click();
  await page.waitForTimeout(500);
  expect(chamadas.length, "faixa repetida não consulta de novo").toBe(2);

  await page.locator('.gr-faixa[data-faixa="30d"]').click();
  await expect.poll(() => chamadas.length).toBe(3);
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("30 dias");
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("6 h");

  await page.locator('.gr-faixa[data-faixa="3h"]').click();
  await expect.poll(() => chamadas.length).toBe(4);
  await expect(page.locator("#grRss .gr-subtitulo")).toContainText("3 horas");
  await expect(page.locator("#monGraficosAviso")).toBeHidden();

  await page.locator("#monGraficosAtualizarBtn").click();
  await expect.poll(() => chamadas.length).toBe(5);
  expect(chamadas[4]).toBe("3h");
});

test("the 20 s card refresh neither reloads history nor redraws the charts", async ({ page, context }) => {
  const historico = [];
  const atual = [];
  await page.route("**/admin/monitoramento/historico*", (rota) => {
    historico.push(rota.request().url());
    return rota.continue();
  });
  await page.route("**/admin/monitoramento", (rota) => {
    atual.push(rota.request().url());
    return rota.continue();
  });
  await abrirMonitoramento(page, context);
  await esperarGraficos(page);
  expect(historico.length).toBe(1);
  const antesAtual = atual.length;
  await page.evaluate(() => {
    document.querySelectorAll("#monGraficosSeries svg").forEach((svg) => { svg.dataset.marca = "original"; });
  });
  await expect.poll(() => atual.length, { timeout: 30_000 }).toBeGreaterThan(antesAtual);
  await page.waitForTimeout(1500);
  expect(historico.length, "nenhuma nova consulta de histórico no refresh dos cartões").toBe(1);
  const preservados = await page.evaluate(() => [...document.querySelectorAll("#monGraficosSeries svg")].every((svg) => svg.dataset.marca === "original"));
  expect(preservados, "os SVGs do histórico continuam os mesmos nós após o refresh dos cartões").toBe(true);
  const composicao = await page.evaluate(() => document.querySelectorAll("#monGraficosAtual svg").length);
  expect(composicao).toBe(FIGURAS_ATUAIS.length);
});

test("layouts: single column on phones, balanced grid on desktop, no horizontal scroll and no clipped text", async ({ page, context }) => {
  for (const nome of ["mobile-compact", "mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
    await abrirMonitoramento(page, context, "superadmin", VIEWPORTS[nome]);
    await esperarGraficos(page);
    const medidas = await medirFiguras(page);
    expect(await semRolagemHorizontal(page), `rolagem horizontal em ${nome}`).toBe(true);
    expect(medidas.figuras.length).toBe(FIGURAS_HISTORICO.length + FIGURAS_ATUAIS.length);
    for (const f of medidas.figuras) {
      expect(f.right, `${f.id} dentro do bloco em ${nome}`).toBeLessThanOrEqual(medidas.blocoRight + 2);
      expect(f.svgRight, `svg de ${f.id} dentro da figura em ${nome}`).toBeLessThanOrEqual(f.right + 1);
      expect(f.svgWidth, `svg de ${f.id} ocupa a largura em ${nome}`).toBeGreaterThan(f.width * 0.6);
      expect(f.cortados, `texto cortado em ${f.id} (${nome})`).toBe(0);
      expect(f.legendaDentro, `legenda de ${f.id} dentro da figura em ${nome}`).toBe(true);
    }
    const esquerdas = new Set(medidas.figuras.filter((f) => !f.largo).map((f) => f.left));
    if (VIEWPORTS[nome].width <= 414) {
      expect(esquerdas.size, `coluna única em ${nome}`).toBe(1);
      expect(medidas.figuras[0].width, `figura ocupa a largura útil em ${nome}`).toBeGreaterThan(VIEWPORTS[nome].width * 0.7);
    } else if (VIEWPORTS[nome].width >= 1366) {
      expect(esquerdas.size, `duas ou mais colunas em ${nome}`).toBeGreaterThanOrEqual(2);
      const largos = medidas.figuras.filter((f) => f.largo);
      expect(largos.length).toBe(2);
      for (const l of largos) expect(l.width, `${l.id} ocupa a largura total em ${nome}`).toBeGreaterThan(medidas.figuras.find((f) => !f.largo).width * 1.8);
    }
  }
});

test("with maximum accessibility font the charts stay legible, without clipping or horizontal scroll", async ({ page, context }) => {
  for (const [nome, tipoFonte] of [["mobile-compact", "default"], ["mobile-compact", "dyslexic"], ["mobile-landscape", "serif"], ["notebook", "sans"]]) {
    await abrirMonitoramento(page, context, "superadmin", VIEWPORTS[nome], { ...A11Y_MAXIMA, remoteifes_font_type: tipoFonte });
    await esperarGraficos(page);
    const medidas = await medirFiguras(page);
    expect(await semRolagemHorizontal(page), `rolagem horizontal em ${nome}`).toBe(true);
    for (const f of medidas.figuras) {
      expect(f.right, `${f.id} dentro do bloco em ${nome}`).toBeLessThanOrEqual(medidas.blocoRight + 2);
      expect(f.cortados, `texto cortado em ${f.id} (${nome}, fonte ${tipoFonte})`).toBe(0);
      expect(f.fonteTick, `rótulos de eixo ampliados em ${f.id}`).toBeGreaterThanOrEqual(20);
      expect(f.legendaDentro, `legenda de ${f.id} dentro da figura em ${nome}`).toBe(true);
    }
    const colunas = await page.evaluate(() => {
      const el = document.getElementById("grEventos");
      const r = el.querySelector("svg").getBoundingClientRect();
      const barras = [...el.querySelectorAll(".gr-coluna")].map((b) => b.getBoundingClientRect());
      return { agrupamento: Number(el.dataset.grAgrupamento), barras: barras.length, dentro: barras.every((b) => b.left >= r.left - 1 && b.right <= r.right + 1), minLargura: Math.min(...barras.map((b) => b.width)) };
    });
    expect(colunas.barras).toBeGreaterThan(0);
    expect(colunas.dentro, `colunas dentro do gráfico em ${nome}`).toBe(true);
    expect(colunas.minLargura).toBeGreaterThanOrEqual(1);
    if (VIEWPORTS[nome].width <= 414) expect(colunas.agrupamento, "intervalos agrupados no celular").toBeGreaterThan(1);
    const controles = await page.locator("#monGraficosBloco .gr-faixa").evaluateAll((btns) => btns.map((b) => b.getBoundingClientRect().height));
    for (const h of controles) expect(h).toBeGreaterThanOrEqual(44);
  }
});

test("values are reachable by keyboard and touch, not only by hover", async ({ page, context }) => {
  await abrirMonitoramento(page, context, "superadmin", VIEWPORTS["mobile-portrait"]);
  await esperarGraficos(page);

  const plot = page.locator("#grEsp32 .gr-plot");
  await plot.focus();
  await expect(page.locator("#grEsp32 .gr-leitura")).toContainText("Online:");
  await page.keyboard.press("Home");
  const primeira = await page.locator("#grEsp32 .gr-leitura").innerText();
  await page.keyboard.press("ArrowRight");
  const segunda = await page.locator("#grEsp32 .gr-leitura").innerText();
  expect(segunda).not.toBe(primeira);
  await page.keyboard.press("End");
  await expect(page.locator("#grEsp32 .gr-leitura")).toContainText("amostra");
  expect(await page.locator("#grEsp32 .gr-cursor").getAttribute("visibility")).toBe("visible");
  await page.keyboard.press("Escape");
  await expect(page.locator("#grEsp32 .gr-leitura")).toHaveText("");

  const colunas = page.locator("#grEventos svg");
  const caixa = await colunas.boundingBox();
  await page.touchscreen.tap(caixa.x + caixa.width * 0.7, caixa.y + caixa.height * 0.5).catch(() => colunas.click({ position: { x: caixa.width * 0.7, y: caixa.height * 0.5 } }));
  await expect(page.locator("#grEventos .gr-leitura")).toContainText("Reconexões:");
  await expect(page.locator("#grEventos .gr-leitura")).toContainText("Quedas:");
  expect(await page.locator("#grEventos .gr-destaque").getAttribute("visibility")).toBe("visible");

  const rosca = page.locator("#grEspAtual svg");
  const rc = await rosca.boundingBox();
  await rosca.click({ position: { x: rc.width / 2, y: 8 } });
  await expect(page.locator("#grEspAtual .gr-leitura")).toContainText("de");

  const barras = page.locator("#grTabelasAtual .gr-plot");
  await barras.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#grTabelasAtual .gr-leitura")).toContainText("linhas");
});

test("empty history guides the superadministrator and keeps the current composition", async ({ page, context, request }) => {
  await limparHistorico(request);
  try {
    await abrirMonitoramento(page, context);
    await esperarGraficos(page);
    await expect(page.locator("#monGraficosVazio")).toBeVisible();
    await expect(page.locator("#monGraficosVazio")).toContainText("Ainda não há amostras");
    await expect(page.locator("#monGraficosAviso")).toBeHidden();
    await expect(page.locator("#grRss .gr-resumo")).toContainText("Sem amostras");
    await expect(page.locator("#grRss svg")).toContainText("Sem amostras neste período");
    await expect(page.locator("#grFalhas .gr-resumo")).toContainText("Nenhuma ocorrência");
    await expect(page.locator("#grFalhas svg")).toContainText("Nenhuma ocorrência no período");
    await expect(page.locator("#grEventos .gr-resumo")).not.toBeEmpty();
    await expect(page.locator("#grEspAtual .gr-legenda")).toContainText("Online");
    expect(await page.locator("#grTabelasAtual .gr-barra, #grTabelasAtual .gr-trilha").count()).toBeGreaterThan(0);
    expect(await semRolagemHorizontal(page)).toBe(true);
  } finally {
    await semearHistorico(request);
  }
});

test("high contrast switches the series palette and keeps borders and texts visible", async ({ page, context }) => {
  await abrirMonitoramento(page, context, "superadmin", VIEWPORTS.notebook, { remoteifes_high_contrast: "1" });
  await esperarGraficos(page);
  const cores = await page.evaluate(() => {
    const linha = document.querySelector("#grRss .gr-linha.gr-cor-1");
    const figura = document.querySelector("#grRss .gr-figura");
    const eixo = document.querySelector("#grRss .gr-eixo");
    const fatia = document.querySelector("#grEspAtual .gr-fatia.gr-ok");
    return {
      contraste: document.body.classList.contains("a11y-high-contrast"),
      linha: getComputedStyle(linha).stroke,
      borda: getComputedStyle(figura).borderColor,
      fundo: getComputedStyle(figura).backgroundColor,
      eixo: getComputedStyle(eixo).fill,
      fatia: fatia ? getComputedStyle(fatia).stroke : null,
    };
  });
  expect(cores.contraste).toBe(true);
  expect(cores.linha).toBe("rgb(57, 135, 229)");
  expect(cores.borda).toBe("rgb(255, 255, 255)");
  expect(cores.fundo).toBe("rgb(0, 0, 0)");
  expect(cores.eixo).toBe("rgb(230, 230, 230)");
  if (cores.fatia) expect(cores.fatia).toBe("rgb(0, 210, 106)");
});

test("the collapsed section does not query history, and the preference is remembered", async ({ page, context }) => {
  const chamadas = [];
  await page.route("**/admin/monitoramento/historico*", (rota) => {
    chamadas.push(rota.request().url());
    return rota.continue();
  });
  await abrirMonitoramento(page, context, "superadmin", VIEWPORTS.notebook, { remoteifes_mon_graficos: "0" });
  await expect(page.locator("#monGraficosBloco")).toBeVisible({ timeout: 15_000 });
  expect(await page.locator("#monGraficosBloco").evaluate((el) => el.open)).toBe(false);
  await expect(page.locator("#monGrid .mon-card").first()).toBeVisible();
  await page.waitForTimeout(2000);
  expect(chamadas, "nada consultado com a seção fechada").toEqual([]);

  const marcador = await page.locator("#monGraficosBloco > summary").evaluate((el) => {
    const css = getComputedStyle(el, "::after");
    return { content: css.content, border: css.borderRightWidth };
  });
  expect(marcador.content).toBe('""');
  expect(marcador.border).toBe("2px");
  await page.locator("#monGraficosBloco > summary").click();
  await esperarGraficos(page);
  expect(chamadas.length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("remoteifes_mon_graficos"))).toBe("1");

  await page.locator('.admin-subtab-btn[data-sub="usuarios"]').click();
  await expect(page.locator("#adminSub-usuarios")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(chamadas.length, "sair da aba não gera consultas").toBe(1);
});

test("the PWA shell stores the charts module together with the rest of the frontend", async ({ page }) => {
  const worker = await page.request.get("/sw.js");
  expect(worker.ok()).toBe(true);
  const texto = await worker.text();
  expect(texto).toContain('"js/charts.js"');
  const html = await (await page.request.get("/index.html")).text();
  const versao = html.match(/name="remoteifes-version" content="([^"]+)"/)[1];
  expect(html).toContain(`js/charts.js?v=${versao}`);
  expect(texto).toContain(`const FRONTEND_VERSION = "${versao}"`);
});

test("changing letter spacing or font family redraws chart geometry without changing width, preserving focus, selection and range", async ({ page, context }) => {
  await abrirMonitoramento(page, context, "superadmin", VIEWPORTS.notebook);
  await esperarGraficos(page);
  await page.locator("#monGraficosBloco .gr-faixa[data-faixa='24h']").click();
  await expect(page.locator("#monGraficosBloco .gr-faixa[data-faixa='24h']")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator("#monGraficosSeries svg").count(), { timeout: 20_000 }).toBe(FIGURAS_HISTORICO.length);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  await page.mouse.move(0, 0);
  const plot = page.locator("#grRss .gr-plot");
  await plot.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const leituraAntes = await page.locator("#grRss .gr-leitura").innerText();
  expect(leituraAntes).not.toBe("");

  const geometria = () => page.evaluate(() => {
    const el = document.getElementById("grRss");
    const svg = el.querySelector("svg");
    return {
      largura: Math.round(el.getBoundingClientRect().width),
      margemEsquerda: parseFloat(svg.querySelector(".gr-fundo").getAttribute("x")),
      marca: svg.dataset.marca || "",
      focado: document.activeElement === el.querySelector(".gr-plot"),
    };
  });
  const marcar = (marca) => page.evaluate((m) => { document.querySelectorAll("#monGraficosSeries svg").forEach((svg) => { svg.dataset.marca = m; }); }, marca);
  await marcar("original");
  const antes = await geometria();
  expect(antes.focado).toBe(true);

  await page.evaluate(() => document.documentElement.style.setProperty("--a11y-letter-spacing", "0.25em"));
  await expect.poll(async () => (await geometria()).marca, { timeout: 5_000 }).toBe("");
  const comEspacamento = await geometria();
  expect(comEspacamento.largura, "o contêiner não mudou de largura").toBe(antes.largura);
  expect(comEspacamento.margemEsquerda, "a margem dos rótulos do eixo cresce com o espaçamento").toBeGreaterThan(antes.margemEsquerda);
  expect(comEspacamento.focado, "o foco continua no gráfico").toBe(true);
  await expect(page.locator("#grRss .gr-leitura")).toHaveText(leituraAntes);
  expect(await page.locator("#grRss .gr-cursor").getAttribute("visibility")).toBe("visible");

  await marcar("espacado");
  const familiaAntes = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await page.locator("#a11yFontTypeDyslexicBtn").click();
  await expect.poll(async () => (await geometria()).marca, { timeout: 5_000 }).toBe("");
  const comFonte = await geometria();
  expect(comFonte.largura).toBe(antes.largura);
  const fontesDiferem = await page.evaluate((antes) => {
    const contexto = document.createElement("canvas").getContext("2d");
    const medir = (familia) => { contexto.font = `12px ${familia}`; return contexto.measureText("0123456789 MB").width; };
    return medir(antes) !== medir(getComputedStyle(document.body).fontFamily);
  }, familiaAntes);
  if (fontesDiferem) expect(comFonte.margemEsquerda).not.toBe(comEspacamento.margemEsquerda);
  await page.locator("#a11yCloseBtn").click();

  await expect(page.locator("#monGraficosBloco .gr-faixa[data-faixa='24h']")).toHaveAttribute("aria-pressed", "true");
  const medidas = await medirFiguras(page);
  for (const f of medidas.figuras) expect(f.cortados, `texto cortado em ${f.id}`).toBe(0);
  expect(await semRolagemHorizontal(page)).toBe(true);
});
