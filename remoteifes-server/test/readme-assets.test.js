// Contracts between the README, its image assets and the code they describe. They check facts that
// drift silently (a missing file, an unpaired dark figure, a tab added to the interface), not prose.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..", "..");
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");
const existe = (rel) => fs.existsSync(path.join(RAIZ, rel));

const README = ler("README.md");
const NOTA = ler("docs/readme-assets/README.md");
const ASSETS = "docs/readme-assets";
// Code blocks hold commands and folder trees, not links.
const semCodigo = (texto) => texto.replace(/```[\s\S]*?```/g, "");

function imagensLocais(texto) {
  const corpo = semCodigo(texto);
  const imgs = [...corpo.matchAll(/<img\b[^>]*>/g)].map((m) => ({
    tag: m[0],
    src: (m[0].match(/\ssrc="([^"]+)"/) || [])[1],
    alt: (m[0].match(/\salt="([^"]*)"/) || [])[1],
  }));
  const srcsets = [...corpo.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1]);
  const markdown = [...corpo.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return { imgs, srcsets, markdown };
}

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, -1, -2 for repeats.
function ancoras(texto) {
  const vistos = new Map();
  const saida = new Set();
  for (const [, titulo] of semCodigo(texto).matchAll(/^#{1,6} (.+)$/gm)) {
    const base = titulo
      .replace(/<[^>]+>/g, "")
      .replace(/`/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = vistos.get(base) || 0;
    vistos.set(base, n + 1);
    saida.add(n ? `${base}-${n}` : base);
  }
  return saida;
}

test("every local README image exists and has descriptive alt text", () => {
  const { imgs, srcsets, markdown } = imagensLocais(README);
  assert.ok(imgs.length > 0);
  for (const img of imgs) {
    assert.ok(img.src, `image without src: ${img.tag.slice(0, 80)}`);
    if (/^https?:/.test(img.src)) continue;
    assert.ok(existe(img.src), `missing image: ${img.src}`);
    assert.ok(img.alt && img.alt.trim().length >= 20, `missing or too short alt text: ${img.src}`);
  }
  for (const src of [...srcsets, ...markdown].filter((s) => !/^https?:/.test(s))) {
    assert.ok(existe(src), `missing image: ${src}`);
  }
});

test("composed figures exist in light and dark, and the README picks the dark one by theme", () => {
  const composicoes = fs.readdirSync(path.join(RAIZ, ASSETS, "src")).filter((f) => f.endsWith(".html"));
  assert.ok(composicoes.length > 0);
  for (const html of composicoes) {
    const nome = html.replace(/\.html$/, "");
    for (const tema of ["light", "dark"]) {
      assert.ok(existe(`${ASSETS}/composed/${nome}-${tema}.png`), `${html} has no rendered ${tema} figure`);
    }
  }
  for (const png of fs.readdirSync(path.join(RAIZ, ASSETS, "composed"))) {
    assert.match(png, /-(light|dark)\.png$/, `composed figure outside the light/dark pair: ${png}`);
    assert.ok(composicoes.includes(png.replace(/-(light|dark)\.png$/, ".html")), `composed figure without a source: ${png}`);
  }

  const pictures = [...semCodigo(README).matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1]);
  for (const bloco of pictures) {
    const claro = (bloco.match(/<img\b[^>]*\ssrc="[^"]*composed\/([\w-]+)-light\.png"/) || [])[1];
    assert.ok(claro, `picture without a light composed figure: ${bloco.slice(0, 80)}`);
    assert.ok(bloco.includes(`media="(prefers-color-scheme: dark)" srcset="docs/readme-assets/composed/${claro}-dark.png"`),
      `${claro}: the picture must offer the dark variant`);
  }
  for (const { src } of imagensLocais(README).imgs) {
    if (/composed\/[\w-]+-light\.png$/.test(src || "")) {
      assert.ok(pictures.some((b) => b.includes(src)), `${src} is used outside a <picture>, so dark mode never sees its pair`);
    }
  }
});

test("the asset note documents every screenshot, and capturar.js produces the ones it claims", () => {
  const capturas = fs.readdirSync(path.join(RAIZ, ASSETS, "screenshots")).filter((f) => f.endsWith(".png"));
  for (const png of capturas) {
    assert.ok(NOTA.includes(`\`${png}\``), `screenshot not documented in docs/readme-assets/README.md: ${png}`);
  }
  for (const [, png] of NOTA.matchAll(/^\| `([\w-]+\.png)` \|/gm)) {
    assert.ok(capturas.includes(png), `documented screenshot does not exist: ${png}`);
  }
  const script = ler(`${ASSETS}/src/capturar.js`);
  const nomes = [...script.matchAll(/^\s+nome: "([\w-]+)",$/gm)].map((m) => m[1]);
  assert.ok(nomes.length > 0, "no capture found in capturar.js");
  for (const nome of nomes) {
    assert.ok(capturas.includes(`${nome}.png`), `capturar.js produces ${nome}.png, which is not committed`);
  }
});

test("repository paths cited by the asset note and the README exist", () => {
  const prefixos = /^(remoteifes-(server|web|console|esp32|cordova)|e2e|docs|\.github)\//;
  // Created at run time or by a build, and ignored by Git.
  const gerados = /\/(data|www|platforms|plugins|build|node_modules|\.pio)\//;
  // Files the operator creates: the server's .env and the optional GitHub Pages custom domain.
  const doOperador = new Set(["remoteifes-server/.env", "remoteifes-web/CNAME"]);
  const citados = new Set();
  for (const texto of [README, NOTA]) {
    for (const [, token] of semCodigo(texto).matchAll(/`([^`\s]+)`/g)) {
      const caminho = token.replace(/[.,;:]+$/, "");
      if (!prefixos.test(caminho) || /[<>*{}]/.test(caminho) || gerados.test(`/${caminho}`) || doOperador.has(caminho)) continue;
      citados.add(caminho);
    }
  }
  assert.ok(citados.size > 10);
  const faltando = [...citados].filter((c) => !existe(c));
  assert.deepEqual(faltando, [], `cited paths that do not exist: ${faltando.join(", ")}`);
});

test("README relative links and heading anchors resolve", () => {
  for (const [nome, texto] of [["README.md", README], ["docs/readme-assets/README.md", NOTA]]) {
    const base = path.dirname(nome);
    const validas = ancoras(texto);
    for (const [, alvo] of semCodigo(texto).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(alvo)) continue;
      const [arquivo, ancora] = alvo.split("#");
      if (arquivo) {
        assert.ok(existe(path.join(base, decodeURI(arquivo))), `${nome}: broken link ${alvo}`);
      } else if (ancora) {
        assert.ok(validas.has(decodeURIComponent(ancora)), `${nome}: broken anchor #${ancora}`);
      }
    }
  }
});

test("every npm script the README runs is defined in a package", () => {
  const scripts = new Set();
  for (const pacote of ["remoteifes-server", "remoteifes-console", "remoteifes-cordova", "e2e"]) {
    Object.keys(JSON.parse(ler(`${pacote}/package.json`)).scripts || {}).forEach((s) => scripts.add(s));
  }
  const usados = new Set([...README.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1]));
  assert.ok(usados.size > 10);
  for (const s of usados) assert.ok(scripts.has(s), `README runs "npm run ${s}", which no package defines`);
});

test("the README lists every inner tab the Administration interface has", () => {
  const html = ler("remoteifes-web/index.html");
  const linhas = { usuarios: "Gestão > Usuários", logs: "Sistema > Logs", status: "Sistema > Status" };
  for (const [prefixo, funcao] of Object.entries(linhas)) {
    const abas = [...html.matchAll(new RegExp(`aria-controls="${prefixo}Aba-[a-z]+">([^<]+)<`, "g"))].map((m) => m[1].trim());
    assert.ok(abas.length > 1, `no inner tabs found for ${funcao}`);
    const linha = README.split("\n").find((l) => l.startsWith(`| **${funcao}** |`));
    assert.ok(linha, `README row missing for ${funcao}`);
    for (const aba of abas) assert.ok(linha.includes(`**${aba}**`), `README row for ${funcao} does not list the ${aba} tab`);
  }
});

test("the OTA publish example uses the firmware version that is compiled", () => {
  const platformio = ler("remoteifes-esp32/platformio.ini");
  const versao = platformio.match(/-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/)[1];
  const exemplo = README.match(/npm run firmware -- \S+firmware\.bin (\S+)/);
  assert.ok(exemplo, "README must show how to publish a firmware image");
  // A lower number is refused by the board as a downgrade, and a different one never validates.
  assert.equal(exemplo[1], versao);
});

test("retired claims stay out of the maintained documentation", () => {
  const casos = [
    ["README.md", [/senha aleatória no arquivo local/, /Sessões inativas por mais de 24h/, /interface local de status/, /gitignored fora de commits/]],
    // The Console only lists CI runs (GET /api/mobile/ci); no route dispatches a workflow.
    ["remoteifes-console/ARQUITETURA.md", [/disparo/i, /Modo LAN explícito/]],
    ["remoteifes-console/web/app.js", [/disparar a CI/]],
    ["remoteifes-console/src/mobile.js", [/disparar workflows/]],
  ];
  for (const [arquivo, proibidos] of casos) {
    const texto = ler(arquivo);
    for (const padrao of proibidos) assert.ok(!padrao.test(texto), `${arquivo} still says: ${padrao}`);
  }
  const rotasMobile = [...ler("remoteifes-console/src/servidor.js").matchAll(/caminho === "\/api\/mobile[^"]*" && metodo === "(\w+)"/g)].map((m) => m[1]);
  assert.ok(rotasMobile.length > 0);
  assert.ok(rotasMobile.every((metodo) => metodo === "GET"), "a mutating /api/mobile route exists: update the documentation that calls the CI view read-only");
});
