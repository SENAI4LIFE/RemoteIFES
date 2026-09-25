const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..", "..", "remoteifes-web");
const index = fs.readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");

function arquivosDoFrontend() {
  const encontrados = [];
  (function varrer(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const alvo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) varrer(alvo);
      else if (/\.(html|js|css)$/.test(entrada.name)) encontrados.push(alvo);
    }
  })(WEB_ROOT);
  return encontrados;
}

function simbolosDoSprite() {
  return new Set([...index.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
}

test("the Power button uses the local SVG icon, not a font-dependent Unicode glyph", () => {
  const botao = index.match(/<button id="btnPower"[\s\S]*?<\/button>/);
  assert.ok(botao, "Power button not found in index.html");
  const marcacao = botao[0];

  assert.match(marcacao, /<use href="#i-power">/, "Power must reference the sprite's #i-power symbol");
  assert.ok(simbolosDoSprite().has("i-power"), "the sprite must define the i-power symbol");

  assert.doesNotMatch(marcacao, /&#9211;|&#x23fb;/i, "the U+23FB glyph does not render reliably in the Android WebView");
  assert.doesNotMatch(marcacao, /[⏻⏼⏽⭘]/u, "Power must not depend on a system power character again");

  assert.match(marcacao, /aria-label="Ligar ou desligar o ar-condicionado"/, "Power's accessible name must stay on the button");
  assert.match(marcacao, /<span class="ac-remote-control-label">Power<\/span>/, "the visible Power label must stay");
});

test("every referenced icon exists in the sprite and every sprite symbol is used", () => {
  const simbolos = simbolosDoSprite();
  assert.ok(simbolos.size > 0, "icon sprite missing from index.html");

  const referenciados = new Set();
  for (const arquivo of arquivosDoFrontend()) {
    const texto = fs.readFileSync(arquivo, "utf8");
    for (const m of texto.matchAll(/href="#(i-[a-z0-9-]+)"/g)) referenciados.add(m[1]);
    for (const m of texto.matchAll(/Icones\.markup\("([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
    for (const m of texto.matchAll(/Icones\.aplicar\([^,()]+,\s*"([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
    for (const m of texto.matchAll(/icon(?:e)?: "([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
  }

  const semSimbolo = [...referenciados].filter((id) => !simbolos.has(id));
  assert.deepEqual(semSimbolo, [], `icons referenced without a sprite symbol: ${semSimbolo.join(", ")}`);

  const semUso = [...simbolos].filter((id) => !referenciados.has(id));
  assert.deepEqual(semUso, [], `sprite symbols nobody uses: ${semUso.join(", ")}`);
});

test("no emoji or pictogram is used as a functional icon again", () => {
  const pictograma = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}]|&#(?:9\d{3}|1\d{4});/u;
  const ofensas = [];
  for (const arquivo of arquivosDoFrontend()) {
    fs.readFileSync(arquivo, "utf8").split(/\r?\n/).forEach((linha, i) => {
      if (pictograma.test(linha)) ofensas.push(`${path.relative(WEB_ROOT, arquivo)}:${i + 1}: ${linha.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(ofensas, [], `use o sprite SVG em vez de emoji:\n${ofensas.join("\n")}`);
});

test("sprite icons are decorative and do not replace the accessible name", () => {
  const svgsDeIcone = [...index.matchAll(/<svg class="icone[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(svgsDeIcone.length > 0, "no sprite icon found in index.html");
  svgsDeIcone.forEach((svg) => assert.match(svg, /aria-hidden="true"/, `icon without aria-hidden: ${svg}`));

  const sprite = index.match(/<svg class="icone-sprite"[^>]*>/);
  assert.ok(sprite, "bloco do sprite ausente");
  assert.match(sprite[0], /aria-hidden="true"/, "the sprite must stay out of the accessibility tree");
});

test("frontend sources contain no text control characters used as glyphs", () => {
  for (const arquivo of arquivosDoFrontend()) {
    assert.doesNotMatch(fs.readFileSync(arquivo, "utf8"), /[\x00-\x08\x0b\x0c\x0e-\x1f]/, path.relative(WEB_ROOT, arquivo));
  }
});
