#!/usr/bin/env node
// Renders the composed README figures (docs/readme-assets/src/<name>.html) to
// docs/readme-assets/composed/<name>-light.png and <name>-dark.png.
//
//   cd e2e && npm ci                       # once: Playwright comes from the e2e dependencies
//   node docs/readme-assets/src/compor.js  # every figure
//   node docs/readme-assets/src/compor.js device-networking
//
// Playwright's own Chromium is used when installed (npx playwright install chromium); otherwise
// the system Edge or Chrome. COMPOR_CANAL=msedge|chrome forces a channel. Text is real text, so a
// different OS font may shift glyph widths slightly: review the PNGs before committing.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..", "..", "..");
const SRC = __dirname;
const SAIDA = path.join(__dirname, "..", "composed");
const ESCALA = 2;

const { chromium } = require(require.resolve("@playwright/test", { paths: [path.join(RAIZ, "e2e")] }));

// Extra glyphs in the style of the app sprite (24x24, filled), for concepts the app has no icon for.
const ICONES_EXTRA = `
  <symbol id="x-olho" viewBox="0 0 24 24"><path d="M12 5.2c-5 0-8.8 3.6-10.2 6.8 1.4 3.2 5.2 6.8 10.2 6.8s8.8-3.6 10.2-6.8C20.8 8.8 17 5.2 12 5.2Zm0 11.1a4.3 4.3 0 1 1 0-8.6 4.3 4.3 0 0 1 0 8.6Zm0-6.6a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z"/></symbol>
  <symbol id="x-terminal" viewBox="0 0 24 24"><path d="M3.4 3.6h17.2c.9 0 1.6.7 1.6 1.6v13.6c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V5.2c0-.9.7-1.6 1.6-1.6Zm.4 2v12.8h16.4V5.6Zm2.1 2.7 1.4-1.4 4.3 4.3-4.3 4.3-1.4-1.4 2.9-2.9Zm6.1 5.4h6v2h-6Z"/></symbol>
  <symbol id="x-ajuste" viewBox="0 0 24 24"><path d="M3 6h9.2a3 3 0 0 1 5.6 0H21v2h-3.2a3 3 0 0 1-5.6 0H3Zm12 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM3 16h3.2a3 3 0 0 1 5.6 0H21v2h-9.2a3 3 0 0 1-5.6 0H3Zm6 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></symbol>
  <symbol id="x-atualizar" viewBox="0 0 24 24"><path d="M12 4.2a7.8 7.8 0 0 1 6.7 3.8V5.4h2v6h-6v-2h2.8A5.8 5.8 0 0 0 6.2 12h-2A7.8 7.8 0 0 1 12 4.2Zm-7.8 8.4h6v2H7.4a5.8 5.8 0 0 0 10.4-2.6h2a7.8 7.8 0 0 1-13.6 4.4v2.2h-2Z"/></symbol>
  <symbol id="x-banco" viewBox="0 0 24 24"><path d="M12 2.6c4.4 0 8 1.4 8 3.2v12.4c0 1.8-3.6 3.2-8 3.2s-8-1.4-8-3.2V5.8c0-1.8 3.6-3.2 8-3.2Zm6 6.1c-1.4.8-3.6 1.3-6 1.3s-4.6-.5-6-1.3v2.9c.3.6 2.6 1.6 6 1.6s5.7-1 6-1.6Zm0 6.1c-1.4.8-3.6 1.3-6 1.3s-4.6-.5-6-1.3v3.3c.3.6 2.6 1.6 6 1.6s5.7-1 6-1.6ZM12 4.6c-3.4 0-5.7 1-6 1.2.3.4 2.6 1.4 6 1.4s5.7-1 6-1.4c-.3-.2-2.6-1.2-6-1.2Z"/></symbol>
  <symbol id="x-rede" viewBox="0 0 24 24"><path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm6.7 5.8h-2.9a14.6 14.6 0 0 0-1.3-3.5 7.7 7.7 0 0 1 4.2 3.5ZM12 4.5c.8 1.1 1.4 2.3 1.8 3.7h-3.6c.4-1.4 1-2.6 1.8-3.7Zm-7.4 9.4a7.7 7.7 0 0 1 0-3.8h3.3a15.7 15.7 0 0 0 0 3.8Zm.7 1.9h2.9c.3 1.3.7 2.4 1.3 3.5a7.7 7.7 0 0 1-4.2-3.5Zm2.9-7.6H5.3a7.7 7.7 0 0 1 4.2-3.5c-.6 1.1-1 2.2-1.3 3.5ZM12 19.5c-.8-1.1-1.4-2.3-1.8-3.7h3.6c-.4 1.4-1 2.6-1.8 3.7Zm2.2-5.6H9.8a13.8 13.8 0 0 1 0-3.8h4.4a13.8 13.8 0 0 1 0 3.8Zm.3 5.4c.6-1.1 1-2.2 1.3-3.5h2.9a7.7 7.7 0 0 1-4.2 3.5Zm1.6-5.4a15.7 15.7 0 0 0 0-3.8h3.3a7.7 7.7 0 0 1 0 3.8Z"/></symbol>
  <symbol id="x-repassa" viewBox="0 0 24 24"><path d="M3 6.4h13.2L13.6 3.8 15 2.4l5 5-5 5-1.4-1.4 2.6-2.6H3Zm18 11.2H7.8l2.6 2.6L9 21.6l-5-5 5-5 1.4 1.4-2.6 2.6H21Z"/></symbol>
  <symbol id="x-wifi" viewBox="0 0 24 24"><path d="M12 5.4c3.9 0 7.4 1.5 10 4l-1.5 1.5A12 12 0 0 0 12 7.5c-3.3 0-6.3 1.3-8.5 3.4L2 9.4a14.2 14.2 0 0 1 10-4Zm0 4.4c2.7 0 5.1 1 6.9 2.8l-1.5 1.5A7.6 7.6 0 0 0 12 11.9c-2.1 0-4 .8-5.4 2.2l-1.5-1.5A9.7 9.7 0 0 1 12 9.8Zm0 4.4c1.5 0 2.8.6 3.8 1.5L12 19.6l-3.8-3.9c1-.9 2.3-1.5 3.8-1.5Z"/></symbol>
`;

function spriteDoApp() {
  const html = fs.readFileSync(path.join(RAIZ, "remoteifes-web", "index.html"), "utf8");
  const m = html.match(/<svg class="icone-sprite"[\s\S]*?<\/svg>/);
  if (!m) throw new Error("icon sprite not found in remoteifes-web/index.html");
  return m[0].replace("</svg>", `${ICONES_EXTRA}</svg>`);
}

async function abrirNavegador() {
  const canais = process.env.COMPOR_CANAL ? [process.env.COMPOR_CANAL] : [undefined, "msedge", "chrome"];
  let ultimo;
  for (const channel of canais) {
    try {
      return await chromium.launch({ channel });
    } catch (erro) {
      ultimo = erro;
    }
  }
  throw ultimo;
}

// Lossless recompression when Pillow is available; the render itself stays the source of truth.
function otimizar(arquivo) {
  try {
    execFileSync("python", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();im.save(sys.argv[1],optimize=True)", arquivo], { stdio: "ignore" });
  } catch {}
}

async function main() {
  const pedidos = process.argv.slice(2);
  const composicoes = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .filter((n) => !pedidos.length || pedidos.includes(n));
  if (!composicoes.length) throw new Error(`no composition matches: ${pedidos.join(", ")}`);

  const sprite = spriteDoApp();
  fs.mkdirSync(SAIDA, { recursive: true });
  const navegador = await abrirNavegador();
  try {
    for (const nome of composicoes) {
      for (const [tema, sufixo] of [["claro", "light"], ["escuro", "dark"]]) {
        const pagina = await navegador.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: ESCALA });
        await pagina.goto(pathToFileURL(path.join(SRC, `${nome}.html`)).href);
        await pagina.evaluate(
          ({ tema, sprite }) => {
            document.documentElement.dataset.tema = tema;
            document.body.insertAdjacentHTML("afterbegin", sprite);
          },
          { tema, sprite }
        );
        await pagina.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
          const faltando = [...document.images].filter((img) => !img.naturalWidth).map((img) => img.getAttribute("src"));
          if (faltando.length) throw new Error(`module not found: ${faltando.join(", ")}`);
          window.desenharConectores();
        });
        const arquivo = path.join(SAIDA, `${nome}-${sufixo}.png`);
        await pagina.locator("#tela").screenshot({ path: arquivo, omitBackground: true });
        await pagina.close();
        otimizar(arquivo);
        console.log(`${path.relative(RAIZ, arquivo)}  ${(fs.statSync(arquivo).size / 1024).toFixed(0)} KiB`);
      }
    }
  } finally {
    await navegador.close();
  }
}

main().catch((erro) => {
  console.error(erro.message || erro);
  process.exitCode = 1;
});
