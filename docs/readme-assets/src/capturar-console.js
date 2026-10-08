#!/usr/bin/env node
// Captures docs/readme-assets/screenshots/console-updates.png with the isolated Console of
// e2e/harness/console-harness.js; CAPTURA_SAIDA=<folder> writes it elsewhere.
//
//   cd remoteifes-server && npm ci && cd .. && cd e2e && npm ci && cd ..   # once
//   node docs/readme-assets/src/capturar-console.js
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { acabamento, otimizar, abrirNavegador } = require("./capturar");

const RAIZ = path.resolve(__dirname, "..", "..", "..");
const H = require(path.join(RAIZ, "e2e", "harness", "console-harness.js"));
const SAIDA = path.resolve(process.env.CAPTURA_SAIDA || path.join(__dirname, "..", "screenshots"));
const OPERADOR = "operador";
const SENHA = "senha-de-captura-12345";

async function main() {
  const portaApp = await H.portaLivre();
  const app = spawn(process.execPath, [path.join(RAIZ, "e2e", "harness", "api-server.js")], { env: { ...process.env, E2E_API_PORT: String(portaApp) }, stdio: "ignore" });
  const gh = await H.servidorGitHub();
  const amb = H.prepararAmbiente({ portaAplicacao: portaApp, instalado: true });
  let consoleUi = null;
  let navegador = null;
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${portaApp}/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    H.criarOperador(amb, OPERADOR, SENHA);
    consoleUi = await H.subirConsole(amb, { githubApi: gh.url });
    navegador = await abrirNavegador();
    const contexto = await navegador.newContext({ viewport: { width: 1120, height: 1000 }, deviceScaleFactor: 2, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
    const page = await contexto.newPage();
    await page.goto(`${consoleUi.url}/`);
    await page.fill("#loginNome", OPERADOR);
    await page.fill("#loginSenha", SENHA);
    await page.click("#formLogin button[type=submit]");
    await page.waitForSelector("#telaConsole:not([hidden])");
    await page.goto(`${consoleUi.url}/#/atualizacoes/remoteifes`);
    const painel = page.locator('[data-subpainel="remoteifes"]');
    await painel.getByRole("button", { name: "Procurar atualizações" }).click();
    await painel.getByText(amb.assuntoNovo).waitFor();
    await page.waitForTimeout(800);
    // The Console's CSP refuses injected style tags; the floating buttons are hidden through the CSSOM.
    await page.evaluate(() => document.querySelectorAll(".flutuantes, .toasts").forEach((n) => (n.style.visibility = "hidden")));
    const fim = await painel.locator(".cartao").nth(1).boundingBox();
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1120, height: Math.ceil(fim.y + fim.height + 12) } });
    fs.mkdirSync(SAIDA, { recursive: true });
    const arquivo = path.join(SAIDA, "console-updates.png");
    fs.writeFileSync(arquivo, await acabamento(navegador, png, 1400));
    otimizar(arquivo);
    console.log(`${path.relative(RAIZ, arquivo)}  ${(fs.statSync(arquivo).size / 1024).toFixed(0)} KiB`);
  } finally {
    if (navegador) await navegador.close();
    if (consoleUi) await consoleUi.encerrar();
    await gh.fechar();
    app.kill();
    H.limparAmbiente(amb);
  }
}

main().catch((erro) => {
  console.error(erro.message || erro);
  process.exitCode = 1;
});
