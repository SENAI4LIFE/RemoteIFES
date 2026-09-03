const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

const GRUPOS = {
  gestao: { rotulo: "Gestão", subs: ["usuarios", "proprietarios", "sessoes", "ativos", "mapa", "relatos"] },
  dispositivos: { rotulo: "Dispositivos", subs: ["macs", "dispositivos", "notificacoes", "esp32"] },
  sistema: { rotulo: "Sistema", subs: ["logs", "monitoramento", "config", "auditoria"] },
};

const SUPERADMIN_ONLY = ["relatos", "macs", "esp32", "monitoramento", "config", "auditoria"];
const TODAS_AS_FUNCOES = Object.values(GRUPOS).flatMap((g) => g.subs);

async function abrirAdmin(page, context, papel, rota = "/admin/usuarios", tamanho) {
  await injetarSessao(context, papel);
  if (tamanho) await page.setViewportSize(tamanho);
  await page.goto(`/#${rota}`);
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
}

async function abrirComum(page, context, rota) {
  await injetarSessao(context, "user");
  await page.goto(`/#${rota}`);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

function estrutura(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".admin-subtabs > .admin-subtab-group")).map((grupo) => ({
      grupo: grupo.dataset.grupo,
      rotulo: grupo.querySelector(".admin-group-btn .admin-group-label").textContent.trim(),
      visivel: grupo.offsetParent !== null || getComputedStyle(grupo).display === "contents",
      itens: Array.from(grupo.querySelectorAll(".admin-subtab-btn")).map((btn) => ({
        sub: btn.dataset.sub,
        rotulo: btn.querySelector(".admin-subtab-label").textContent.trim(),
        oculto: btn.classList.contains("hidden"),
      })),
    }))
  );
}

test("Dispositivos reúne Cadastro, Histórico, Notificações e Firmware / OTA", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const grupos = await estrutura(page);
  const dispositivos = grupos.find((g) => g.grupo === "dispositivos");

  expect(dispositivos.rotulo).toBe("Dispositivos");
  expect(dispositivos.itens.map((i) => i.rotulo)).toEqual(["Cadastro", "Histórico", "Notificações", "Firmware / OTA"]);
  expect(dispositivos.itens.map((i) => i.sub)).toEqual(["macs", "dispositivos", "notificacoes", "esp32"]);
});

test("a Administração tem três grupos, sem grupo vazio e sem função duplicada", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const grupos = await estrutura(page);

  expect(grupos.map((g) => g.rotulo)).toEqual(["Gestão", "Dispositivos", "Sistema"]);
  grupos.forEach((g) => {
    expect(g.itens.length, `grupo ${g.grupo} não pode estar vazio`).toBeGreaterThan(0);
    expect(g.itens.every((i) => !i.oculto), `grupo ${g.grupo} completo para superadmin`).toBe(true);
  });

  const subs = grupos.flatMap((g) => g.itens.map((i) => i.sub));
  expect(subs.sort()).toEqual([...TODAS_AS_FUNCOES].sort());
  expect(new Set(subs).size).toBe(subs.length);
});

test("os rótulos antigos de Administração não aparecem mais na navegação", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const rotulos = await page.$$eval(".admin-subtab-btn .admin-subtab-label", (els) => els.map((e) => e.textContent.trim()));
  for (const obsoleto of ["ESP32", "ESP32 / MACs", "Dispositivos", "Notificações de dispositivos", "Monitoramento", "Saúde do sistema", "Acessos ESP32"]) {
    expect(rotulos, `rótulo obsoleto "${obsoleto}" ainda listado`).not.toContain(obsoleto);
  }
});

test("toda função administrativa continua alcançável pela navegação agrupada", async ({ page, context }) => {
  test.setTimeout(120_000);
  await abrirAdmin(page, context, "superadmin");
  for (const [chave, grupo] of Object.entries(GRUPOS)) {
    for (const sub of grupo.subs) {
      const botao = page.locator(`.admin-subtab-btn[data-sub="${sub}"]`);
      await expect(botao).toBeVisible();
      await botao.click();
      await expect(page.locator(`#adminSub-${sub}`)).toBeVisible({ timeout: 15_000 });
      await expect(botao).toHaveAttribute("aria-current", "page");
      await expect(page.locator(`.admin-subtab-group[data-grupo="${chave}"]`)).toHaveClass(/is-active/);
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/admin/${sub}`);
    }
  }
});

test("entrar no grupo Dispositivos abre Cadastro no superadministrador", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  await page.locator('.admin-group-btn[data-grupo="dispositivos"]').click();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"]')).toHaveClass(/is-active/);
  await expect(page.locator('.admin-subtab-group[data-grupo="gestao"]')).not.toHaveClass(/is-active/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/macs");
});

test("o admin comum vê os três grupos apenas com as funções que seu nível autoriza", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin");
  const grupos = await estrutura(page);

  for (const grupo of grupos) {
    const visiveis = grupo.itens.filter((i) => !i.oculto).map((i) => i.sub);
    expect(visiveis.length, `grupo ${grupo.grupo} não pode ficar vazio para o admin`).toBeGreaterThan(0);
    expect(visiveis.filter((sub) => SUPERADMIN_ONLY.includes(sub))).toEqual([]);
  }

  for (const sub of SUPERADMIN_ONLY) {
    await expect(page.locator(`.admin-subtab-btn[data-sub="${sub}"]`)).toBeHidden();
  }
  await expect(page.locator('.admin-subtab-btn[data-sub="dispositivos"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="notificacoes"]')).toBeVisible();
});

test("entrar no grupo Dispositivos abre Histórico quando Cadastro não é autorizado", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin");
  await page.locator('.admin-group-btn[data-grupo="dispositivos"]').click();
  await expect(page.locator("#adminSub-dispositivos")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#adminSub-macs")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/dispositivos");
});

test("Gestão reúne Usuários, Proprietários, Sessões, Ativos, Mapa e Relatos", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const grupos = await estrutura(page);
  const gestao = grupos.find((g) => g.grupo === "gestao");
  expect(gestao.itens.map((i) => i.rotulo)).toEqual([
    "Usuários", "Proprietários de sala", "Sessões", "Ativos", "Mapa", "Relatos de problemas",
  ]);
});

test("Sistema reúne Logs, Status, Configurações e Auditoria", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const grupos = await estrutura(page);
  const sistema = grupos.find((g) => g.grupo === "sistema");
  expect(sistema.itens.map((i) => i.rotulo)).toEqual(["Logs", "Status", "Configurações", "Auditoria"]);
  expect(sistema.itens.map((i) => i.sub)).toEqual(["logs", "monitoramento", "config", "auditoria"]);
});

test("Acesso é uma aba interna de Logs, não uma função da Administração", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs");
  await expect(page.locator('.admin-subtab-btn[data-sub="acessos"]')).toHaveCount(0);
  await expect(page.locator("#adminSub-acessos")).toHaveCount(0);

  const abas = page.locator("#adminSub-logs .admin-inner-tab-btn");
  await expect(abas).toHaveCount(2);
  await expect(abas.nth(0)).toHaveText("Comandos");
  await expect(abas.nth(1)).toHaveText("Acesso");
  await expect(page.locator("#logsAba-comandos")).toBeVisible();
  await expect(page.locator("#logsAba-acesso")).toBeHidden();

  await abas.nth(1).click();
  await expect(page.locator("#logsAba-acesso")).toBeVisible();
  await expect(page.locator("#logsAba-comandos")).toBeHidden();
  await expect(page.locator("#acessosFiltroData")).toBeVisible();
  await expect(page.locator("#acessosApagarData")).toBeVisible();
  await expect(page.locator("#acessosApagarTudo")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/acesso");
});

test("Logs > Acesso sobrevive ao refresh e ao voltar do navegador", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs/acesso");
  await expect(page.locator("#logsAba-acesso")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.locator("#logsAba-acesso")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-btn[data-sub="logs"]')).toHaveAttribute("aria-current", "page");

  await page.locator('#adminSub-logs .admin-inner-tab-btn[data-log-aba="comandos"]').click();
  await expect(page.locator("#logsAba-comandos")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#logsAba-acesso")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/acesso");
});

test("o endereço antigo /admin/acessos resolve para Logs > Acesso", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/acessos");
  await expect(page.locator("#adminSub-logs")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#logsAba-acesso")).toBeVisible();
  await expect(page.locator('.admin-subtab-group[data-grupo="sistema"]')).toHaveClass(/is-active/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/acesso");
});

test("um usuário comum não alcança Logs > Acesso por link direto", async ({ page, context }) => {
  await abrirComum(page, context, "/admin/acessos");
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
});

test("um grupo sem nenhuma função autorizada não é exibido", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin");
  const exibido = await page.evaluate(() => {
    const grupo = document.querySelector('.admin-subtab-group[data-grupo="sistema"]');
    grupo.querySelectorAll(".admin-subtab-btn").forEach((btn) => btn.classList.add("hidden"));
    return getComputedStyle(grupo).display !== "none";
  });
  expect(exibido, "grupo sem função visível deve sumir da navegação").toBe(false);
});

test("link direto para uma função abre o grupo certo e sobrevive ao refresh", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin", "/admin/esp32");
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"]')).toHaveClass(/is-active/);

  await page.reload();
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"]')).toHaveClass(/is-active/);
  await expect(page.locator('.admin-subtab-btn[data-sub="esp32"]')).toHaveAttribute("aria-current", "page");
});

test("voltar do navegador devolve o grupo anterior", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin", "/admin/usuarios");
  await page.locator('.admin-subtab-btn[data-sub="macs"]').click();
  await expect(page.locator("#adminSub-macs")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#adminSub-usuarios")).toBeVisible();
  await expect(page.locator('.admin-subtab-group[data-grupo="gestao"]')).toHaveClass(/is-active/);
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"]')).not.toHaveClass(/is-active/);
});

for (const nome of ["mobile-compact", "mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook", "desktop"]) {
  test(`a navegação agrupada cabe e permanece alcançável em ${nome}`, async ({ page, context }) => {
    await abrirAdmin(page, context, "superadmin", "/admin/usuarios", VIEWPORTS[nome]);
    expect(await semRolagemHorizontal(page), "Administração sem rolagem horizontal").toBe(true);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const medidas = await page.evaluate(() => {
      const barra = document.querySelector(".admin-subtabs");
      const area = barra.getBoundingClientRect();
      const tabbar = document.querySelector(".tabbar").getBoundingClientRect();
      return {
        cobertaPelaTabbar: area.bottom > tabbar.top + 1 && area.right > tabbar.left && area.left < tabbar.right,
        grupos: Array.from(barra.querySelectorAll(".admin-group-btn")).map((btn) => {
          const r = btn.getBoundingClientRect();
          return { texto: btn.textContent.trim(), largura: r.width, altura: r.height, cortado: btn.scrollWidth > btn.clientWidth + 1 };
        }),
      };
    });

    expect(medidas.cobertaPelaTabbar, "a navegação não pode ficar sob a barra inferior").toBe(false);
    expect(medidas.grupos.map((g) => g.texto)).toEqual(["Gestão", "Dispositivos", "Sistema"]);
    medidas.grupos.forEach((g) => {
      expect(g.largura, `${g.texto} com largura`).toBeGreaterThan(0);
      expect(g.altura, `${g.texto} com altura`).toBeGreaterThan(0);
      expect(g.cortado, `${g.texto} não pode ficar cortado`).toBe(false);
    });

    await page.locator('.admin-subtab-btn[data-sub="auditoria"]').click();
    await expect(page.locator("#adminSub-auditoria")).toBeVisible({ timeout: 15_000 });
    expect(await semRolagemHorizontal(page), "Auditoria sem rolagem horizontal").toBe(true);
  });
}
