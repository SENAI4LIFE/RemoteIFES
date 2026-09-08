const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

const GRUPOS = {
  gestao: { rotulo: "Gestão", subs: ["usuarios", "relatos"] },
  dispositivos: { rotulo: "Dispositivos", subs: ["macs", "esp32", "notificacoes"] },
  sistema: { rotulo: "Sistema", subs: ["logs", "status", "config"] },
};

const SUPERADMIN_ONLY = ["relatos", "macs", "esp32", "config"];
const TODAS_AS_FUNCOES = Object.values(GRUPOS).flatMap((g) => g.subs);

const ABAS = {
  usuarios: [["contas", "Contas"], ["proprietarios", "Proprietários de sala"]],
  logs: [
    ["comandos", "Comandos"], ["acesso", "Acessos"], ["dispositivos", "Dispositivos"],
    ["sessoes", "Sessões"], ["auditoria", "Auditoria"],
  ],
  status: [["ativos", "Usuários ativos"], ["mapa", "Mapa"], ["sistema", "Sistema"]],
};
const ABAS_SUPERADMIN_ONLY = { logs: ["auditoria"], status: ["sistema"] };

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
      itens: Array.from(grupo.querySelectorAll(".admin-subtab-btn")).map((btn) => ({
        sub: btn.dataset.sub,
        rotulo: btn.querySelector(".admin-subtab-label").textContent.trim(),
        oculto: btn.classList.contains("hidden"),
      })),
    }))
  );
}

function abas(page, sub) {
  return page.$$eval(`#adminSub-${sub} .admin-inner-tab-btn`, (els) =>
    els.map((e) => ({ aba: e.dataset.aba, rotulo: e.textContent.trim(), oculto: e.classList.contains("hidden") }))
  );
}

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

test("Gestão reúne Usuários e Relatos de problemas", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const gestao = (await estrutura(page)).find((g) => g.grupo === "gestao");
  expect(gestao.itens.map((i) => i.rotulo)).toEqual(["Usuários", "Relatos de problemas"]);
  expect(gestao.itens.map((i) => i.sub)).toEqual(["usuarios", "relatos"]);
});

test("Dispositivos reúne Cadastro, Firmware / OTA e Alertas", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const dispositivos = (await estrutura(page)).find((g) => g.grupo === "dispositivos");
  expect(dispositivos.itens.map((i) => i.rotulo)).toEqual(["Cadastro", "Firmware / OTA", "Alertas"]);
  expect(dispositivos.itens.map((i) => i.sub)).toEqual(["macs", "esp32", "notificacoes"]);
});

test("Sistema reúne Logs, Status e Configurações", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const sistema = (await estrutura(page)).find((g) => g.grupo === "sistema");
  expect(sistema.itens.map((i) => i.rotulo)).toEqual(["Logs", "Status", "Configurações"]);
  expect(sistema.itens.map((i) => i.sub)).toEqual(["logs", "status", "config"]);
});

test("as funções movidas deixaram de ser itens da navegação de Administração", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  const rotulos = await page.$$eval(".admin-subtab-btn .admin-subtab-label", (els) => els.map((e) => e.textContent.trim()));
  for (const obsoleto of [
    "Proprietários de sala", "Sessões", "Ativos", "Mapa", "Histórico",
    "Notificações", "Auditoria", "Monitoramento", "ESP32 / MACs", "Saúde do sistema",
  ]) {
    expect(rotulos, `rótulo obsoleto "${obsoleto}" ainda listado como função`).not.toContain(obsoleto);
  }
  for (const sub of ["proprietarios", "sessoes", "ativos", "mapa", "dispositivos", "monitoramento", "auditoria", "acessos"]) {
    await expect(page.locator(`.admin-subtab-btn[data-sub="${sub}"]`), `função ${sub}`).toHaveCount(0);
    await expect(page.locator(`#adminSub-${sub}`), `painel ${sub}`).toHaveCount(0);
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

for (const [sub, definicoes] of Object.entries(ABAS)) {
  test(`as abas internas de ${sub} têm a ordem e os rótulos previstos`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await abrirAdmin(page, context, "superadmin", `/admin/${sub}`);
    expect(await abas(page, sub)).toEqual(definicoes.map(([aba, rotulo]) => ({ aba, rotulo, oculto: false })));

    for (const [indice, [aba]] of definicoes.entries()) {
      await page.locator(`#adminSub-${sub} .admin-inner-tab-btn[data-aba="${aba}"]`).click();
      await expect(page.locator(`#${sub}Aba-${aba}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`#adminSub-${sub} .admin-inner-tab-btn[data-aba="${aba}"]`)).toHaveAttribute("aria-selected", "true");
      const outras = definicoes.filter(([outra]) => outra !== aba);
      for (const [outra] of outras) await expect(page.locator(`#${sub}Aba-${outra}`)).toBeHidden();
      const esperado = indice === 0 ? `#/admin/${sub}` : `#/admin/${sub}/${aba}`;
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(esperado);
    }
  });
}

test("as abas internas são visualmente distintas da navegação de grupo e função", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin", "/admin/logs");
  const dentroDaBarra = await page.$$eval(".admin-subtabs .admin-inner-tab-btn", (els) => els.length);
  expect(dentroDaBarra, "abas internas não podem morar na barra de navegação").toBe(0);

  const estilos = await page.evaluate(() => {
    const ler = (el) => {
      const s = getComputedStyle(el);
      return { fundo: s.backgroundColor, borda: s.borderTopWidth, raio: s.borderTopLeftRadius };
    };
    return {
      funcao: ler(document.querySelector('.admin-subtab-btn[data-sub="logs"]')),
      aba: ler(document.querySelector('#adminSub-logs .admin-inner-tab-btn[data-aba="comandos"]')),
      dentroDoConteudo: !!document.querySelector(".admin-content #adminSub-logs .admin-inner-tabs"),
    };
  });
  expect(estilos.dentroDoConteudo).toBe(true);
  expect(estilos.aba.borda).not.toBe(estilos.funcao.borda);
  expect(estilos.aba.raio).not.toBe(estilos.funcao.raio);
});

test("Contas e Proprietários de sala convivem dentro de Usuários", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/usuarios");
  await expect(page.locator("#usuariosAba-contas")).toBeVisible();
  await expect(page.locator("#usuariosList")).toBeVisible();
  await expect(page.locator("#criarUsuarioBtn")).toBeVisible();
  await expect(page.locator("#usuariosAba-proprietarios")).toBeHidden();

  await page.locator('#adminSub-usuarios .admin-inner-tab-btn[data-aba="proprietarios"]').click();
  await expect(page.locator("#usuariosAba-proprietarios")).toBeVisible();
  await expect(page.locator("#proprietariosSala")).toBeVisible();
  await expect(page.locator("#proprietariosConcederDonoBtn")).toBeVisible();
  await expect(page.locator("#proprietariosAcessoRestritoCheck")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/usuarios/proprietarios");
});

test("Logs mantém filtros e exclusão de cada aba migrada", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs/acesso");
  await expect(page.locator("#acessosFiltroData")).toBeVisible();
  await expect(page.locator("#acessosApagarData")).toBeVisible();
  await expect(page.locator("#acessosApagarTudo")).toBeVisible();

  await page.locator('#adminSub-logs .admin-inner-tab-btn[data-aba="dispositivos"]').click();
  await expect(page.locator("#logsAba-dispositivos")).toContainText("conexão e desconexão");
  await expect(page.locator("#dispositivosFiltroData")).toBeVisible();
  await expect(page.locator("#dispositivosList")).toBeVisible();

  await page.locator('#adminSub-logs .admin-inner-tab-btn[data-aba="sessoes"]').click();
  await expect(page.locator("#sessoesFiltroData")).toBeVisible();
  await expect(page.locator("#sessoesApagarData")).toBeVisible();
  await expect(page.locator("#sessoesApagarTudo")).toBeVisible();
  await expect(page.locator("#sessoesList li").first()).toBeVisible({ timeout: 15_000 });
});

test("Status mantém a presença em tempo real e o mapa operacional", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/status");
  await expect(page.locator("#statusAba-ativos")).toContainText("tempo real");
  await expect(page.locator("#ativosList li").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#ativosList .session-timer").first()).toBeVisible();

  await page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="mapa"]').click();
  await expect(page.locator("#statusAba-mapa .mapa-legenda")).toBeVisible();
  await expect(page.locator("#mapaGrid .mapa-cell").first()).toBeVisible({ timeout: 15_000 });
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
  await expect(page.locator('.admin-subtab-btn[data-sub="usuarios"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="notificacoes"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="logs"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="status"]')).toBeVisible();
});

test("as abas internas exclusivas ficam ocultas para o admin comum", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs");
  for (const [sub, exclusivas] of Object.entries(ABAS_SUPERADMIN_ONLY)) {
    for (const aba of exclusivas) {
      await expect(page.locator(`#adminSub-${sub} .admin-inner-tab-btn[data-aba="${aba}"]`)).toBeHidden();
      await expect(page.locator(`#${sub}Aba-${aba}`)).toBeHidden();
    }
    const visiveis = (await abas(page, sub)).filter((a) => !a.oculto).map((a) => a.aba);
    expect(visiveis.length, `${sub} precisa manter abas para o admin`).toBeGreaterThan(0);
    expect(visiveis.filter((a) => exclusivas.includes(a))).toEqual([]);
  }
});

test("o admin comum não alcança Auditoria por link direto, mas continua em Logs", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs/auditoria");
  await expect(page.locator("#adminSub-logs")).toBeVisible();
  await expect(page.locator("#logsAba-auditoria")).toBeHidden();
  await expect(page.locator("#logsAba-comandos")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs");
});

test("o admin comum abre o Status sem alcançar a seção técnica do superadministrador", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/status/sistema");
  await expect(page.locator("#adminSub-status")).toBeVisible();
  await expect(page.locator("#statusAba-ativos")).toBeVisible();
  await expect(page.locator("#statusAba-sistema")).toBeHidden();
  await expect(page.locator("#monGrid")).toBeHidden();
  await expect(page.locator("#heatmapBloco")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/status");

  await page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="mapa"]').click();
  await expect(page.locator("#statusAba-mapa")).toBeVisible();
  await expect(page.locator("#statusAba-sistema")).toBeHidden();
});

test("o superadministrador alcança as abas internas exclusivas", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin", "/admin/logs/auditoria");
  await expect(page.locator("#logsAba-auditoria")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#auditFiltroTipo")).toBeVisible();
  await expect(page.locator("#auditFiltrarBtn")).toBeVisible();
  await expect(page.locator("#connectFiltrarBtn")).toBeVisible();
  await expect(page.locator("#auditRetentionCurrent")).toHaveText("7 dias");
  await expect(page.locator("#auditPageInfo")).toContainText("Página 1 de");
  await expect(page.locator("#connectPageInfo")).toContainText("Página 1 de");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/auditoria");

  await page.goto("/#/admin/status/sistema");
  await expect(page.locator("#statusAba-sistema")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#monGrid .mon-card").first()).toBeVisible({ timeout: 20_000 });
});

for (const [antiga, nova, painel] of [
  ["/admin/proprietarios", "#/admin/usuarios/proprietarios", "#usuariosAba-proprietarios"],
  ["/admin/sessoes", "#/admin/logs/sessoes", "#logsAba-sessoes"],
  ["/admin/dispositivos", "#/admin/logs/dispositivos", "#logsAba-dispositivos"],
  ["/admin/acessos", "#/admin/logs/acesso", "#logsAba-acesso"],
  ["/admin/ativos", "#/admin/status", "#statusAba-ativos"],
  ["/admin/mapa", "#/admin/status/mapa", "#statusAba-mapa"],
]) {
  test(`o endereço antigo ${antiga} resolve para ${nova}`, async ({ page, context }) => {
    await abrirAdmin(page, context, "admin", antiga);
    await expect(page.locator(painel)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(nova);
  });
}

for (const [antiga, nova, painel] of [
  ["/admin/auditoria", "#/admin/logs/auditoria", "#logsAba-auditoria"],
  ["/admin/monitoramento", "#/admin/status/sistema", "#statusAba-sistema"],
]) {
  test(`o endereço antigo ${antiga} resolve para ${nova} no superadministrador`, async ({ page, context }) => {
    await abrirAdmin(page, context, "superadmin", antiga);
    await expect(page.locator(painel)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(nova);
  });
}

test("uma aba interna sobrevive ao refresh e ao voltar do navegador", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/logs/sessoes");
  await expect(page.locator("#logsAba-sessoes")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.locator("#logsAba-sessoes")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-btn[data-sub="logs"]')).toHaveAttribute("aria-current", "page");

  await page.locator('#adminSub-logs .admin-inner-tab-btn[data-aba="comandos"]').click();
  await expect(page.locator("#logsAba-comandos")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#logsAba-sessoes")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/sessoes");

  await page.goForward();
  await expect(page.locator("#logsAba-comandos")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs");
});

test("voltar e avançar rápido entre abas internas mantém painel e endereço coerentes", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin", "/admin/status");
  for (const aba of ["mapa", "ativos", "mapa"]) {
    await page.locator(`#adminSub-status .admin-inner-tab-btn[data-aba="${aba}"]`).click();
    await expect(page.locator(`#statusAba-${aba}`)).toBeVisible();
  }

  await page.goBack();
  await page.goBack();
  await expect(page.locator("#statusAba-mapa")).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(page.locator("#statusAba-mapa")).toBeVisible();
  await expect(page.locator("#statusAba-ativos")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/status/mapa");
});

test("entrar no grupo Dispositivos abre Cadastro no superadministrador", async ({ page, context }) => {
  await abrirAdmin(page, context, "superadmin");
  await page.locator('.admin-group-btn[data-grupo="dispositivos"]').click();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"]')).toHaveClass(/is-active/);
  await expect(page.locator('.admin-subtab-group[data-grupo="gestao"]')).not.toHaveClass(/is-active/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/macs");
});

test("entrar no grupo Dispositivos abre Alertas quando Cadastro não é autorizado", async ({ page, context }) => {
  await abrirAdmin(page, context, "admin");
  await page.locator('.admin-group-btn[data-grupo="dispositivos"]').click();
  await expect(page.locator("#adminSub-notificacoes")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#adminSub-macs")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/notificacoes");
});

test("um usuário comum não alcança a Administração por link direto", async ({ page, context }) => {
  await abrirComum(page, context, "/admin/logs/auditoria");
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
    test.setTimeout(120_000);
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

    for (const sub of ["logs", "status"]) {
      await page.locator(`.admin-subtab-btn[data-sub="${sub}"]`).click();
      await expect(page.locator(`#adminSub-${sub}`)).toBeVisible({ timeout: 15_000 });
      const problemas = await page.evaluate((alvo) => {
        const achados = [];
        const painel = document.getElementById(`adminSub-${alvo}`);
        const area = painel.getBoundingClientRect();
        painel.querySelectorAll(".admin-inner-tab-btn:not(.hidden)").forEach((btn) => {
          const r = btn.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) achados.push(`aba sem tamanho: ${btn.dataset.aba}`);
          if (r.height < 44) achados.push(`alvo pequeno: ${btn.dataset.aba}`);
          if (btn.scrollWidth > btn.clientWidth + 1) achados.push(`aba cortada: ${btn.dataset.aba}`);
          if (r.right > area.right + 1 || r.left < area.left - 1) achados.push(`aba fora do painel: ${btn.dataset.aba}`);
        });
        return achados;
      }, sub);
      expect(problemas, `${sub} em ${nome}`).toEqual([]);
      expect(await semRolagemHorizontal(page), `${sub} sem rolagem horizontal`).toBe(true);
    }

    await page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]').click();
    await expect(page.locator("#statusAba-sistema")).toBeVisible({ timeout: 15_000 });
    expect(await semRolagemHorizontal(page), "Status > Sistema sem rolagem horizontal").toBe(true);
  });
}
