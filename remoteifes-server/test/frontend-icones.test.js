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

test("o botão Power usa o ícone SVG local, não um glifo Unicode dependente de fonte", () => {
  const botao = index.match(/<button id="btnPower"[\s\S]*?<\/button>/);
  assert.ok(botao, "botão Power não encontrado no index.html");
  const marcacao = botao[0];

  assert.match(marcacao, /<use href="#i-power">/, "o Power precisa referenciar o símbolo #i-power do sprite");
  assert.ok(simbolosDoSprite().has("i-power"), "o sprite precisa definir o símbolo i-power");

  assert.doesNotMatch(marcacao, /&#9211;|&#x23fb;/i, "o glifo U+23FB não renderiza de forma confiável na WebView do Android");
  assert.doesNotMatch(marcacao, /[⏻⏼⏽⭘]/u, "o Power não pode voltar a depender de um caractere de energia do sistema");

  assert.match(marcacao, /aria-label="Ligar ou desligar o ar-condicionado"/, "o nome acessível do Power precisa continuar no botão");
  assert.match(marcacao, /<span class="ac-remote-control-label">Power<\/span>/, "o rótulo visível Power precisa continuar");
});

test("todo ícone referenciado existe no sprite e todo símbolo do sprite é usado", () => {
  const simbolos = simbolosDoSprite();
  assert.ok(simbolos.size > 0, "sprite de ícones ausente no index.html");

  const referenciados = new Set();
  for (const arquivo of arquivosDoFrontend()) {
    const texto = fs.readFileSync(arquivo, "utf8");
    for (const m of texto.matchAll(/href="#(i-[a-z0-9-]+)"/g)) referenciados.add(m[1]);
    for (const m of texto.matchAll(/Icones\.markup\("([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
    for (const m of texto.matchAll(/Icones\.aplicar\([^,()]+,\s*"([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
    for (const m of texto.matchAll(/icon(?:e)?: "([a-z0-9-]+)"/g)) referenciados.add(`i-${m[1]}`);
  }

  const semSimbolo = [...referenciados].filter((id) => !simbolos.has(id));
  assert.deepEqual(semSimbolo, [], `ícones referenciados sem símbolo no sprite: ${semSimbolo.join(", ")}`);

  const semUso = [...simbolos].filter((id) => !referenciados.has(id));
  assert.deepEqual(semUso, [], `símbolos do sprite que ninguém usa: ${semUso.join(", ")}`);
});

test("nenhum emoji ou pictograma volta a ser usado como ícone funcional", () => {
  const pictograma = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}]|&#(?:9\d{3}|1\d{4});/u;
  const ofensas = [];
  for (const arquivo of arquivosDoFrontend()) {
    fs.readFileSync(arquivo, "utf8").split(/\r?\n/).forEach((linha, i) => {
      if (pictograma.test(linha)) ofensas.push(`${path.relative(WEB_ROOT, arquivo)}:${i + 1}: ${linha.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(ofensas, [], `use o sprite SVG em vez de emoji:\n${ofensas.join("\n")}`);
});

test("os ícones do sprite são decorativos e não substituem o nome acessível", () => {
  const svgsDeIcone = [...index.matchAll(/<svg class="icone[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(svgsDeIcone.length > 0, "nenhum ícone do sprite encontrado no index.html");
  svgsDeIcone.forEach((svg) => assert.match(svg, /aria-hidden="true"/, `ícone sem aria-hidden: ${svg}`));

  const sprite = index.match(/<svg class="icone-sprite"[^>]*>/);
  assert.ok(sprite, "bloco do sprite ausente");
  assert.match(sprite[0], /aria-hidden="true"/, "o sprite precisa ficar fora da árvore de acessibilidade");
});

test("fontes do frontend não contêm controles de texto usados como glifos", () => {
  for (const arquivo of arquivosDoFrontend()) {
    assert.doesNotMatch(fs.readFileSync(arquivo, "utf8"), /[\x00-\x08\x0b\x0c\x0e-\x1f]/, path.relative(WEB_ROOT, arquivo));
  }
});
