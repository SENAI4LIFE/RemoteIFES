const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RAIZ = __dirname;
const CONFIG = path.join(RAIZ, "config.xml");
const WWW = path.join(RAIZ, "www");

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log(`  ok  ${mensagem}`);
  } else {
    falhas.push(mensagem);
    console.log(`  X   ${mensagem}`);
  }
}

function contar(texto, regex) {
  return (texto.match(regex) || []).length;
}

console.log("config.xml — estrutura");
const original = fs.readFileSync(CONFIG, "utf8");
checar(original.startsWith("<?xml"), "declaração XML presente");
checar(contar(original, /<widget\b/g) === 1 && contar(original, /<\/widget>/g) === 1, "exatamente um elemento <widget>");
checar(contar(original, /<platform\b/g) === contar(original, /<\/platform>/g), "tags <platform> balanceadas");
checar(/<content src="index\.html" \/>/.test(original), "<content src=\"index.html\" /> presente");
checar(/<preference name="Orientation" value="default" \/>/.test(original), "Orientation = default (retrato e paisagem)");
checar(/<platform name="android">/.test(original) && /<platform name="ios">/.test(original), "plataformas android e ios declaradas");

console.log("harden-config.js — reversibilidade");
try {
  execFileSync("node", [path.join(RAIZ, "harden-config.js"), "https://exemplo.ifes.edu.br"], { stdio: "pipe" });
  const endurecido = fs.readFileSync(CONFIG, "utf8");
  checar(!/origin="\*"/.test(endurecido) && !/href="\*"/.test(endurecido), "endurecimento remove curingas de rede");
  checar(/origin="https:\/\/exemplo\.ifes\.edu\.br\/\*"/.test(endurecido), "endurecimento fixa a origem de produção");
  execFileSync("node", [path.join(RAIZ, "harden-config.js"), "--dev"], { stdio: "pipe" });
  const restaurado = fs.readFileSync(CONFIG, "utf8");
  checar(restaurado === original, "--dev restaura config.xml byte a byte");
} catch (erro) {
  falhas.push(`harden-config.js falhou: ${erro.message}`);
  console.log(`  X   harden-config.js falhou: ${erro.message}`);
} finally {
  fs.writeFileSync(CONFIG, original);
}

console.log("sync-www.js — geração de www/");
try {
  execFileSync("node", [path.join(RAIZ, "sync-www.js")], { stdio: "pipe" });
  checar(fs.existsSync(path.join(WWW, "index.html")), "www/index.html gerado");
  checar(fs.existsSync(path.join(WWW, "js", "config.js")), "www/js/config.js gerado");
  checar(!fs.existsSync(path.join(WWW, "sw.js")), "www/ não inclui sw.js (service worker é só da PWA)");
  checar(!fs.existsSync(path.join(WWW, "manifest.webmanifest")), "www/ não inclui manifest.webmanifest");
} catch (erro) {
  falhas.push(`sync-www.js falhou: ${erro.message}`);
  console.log(`  X   sync-www.js falhou: ${erro.message}`);
}

if (falhas.length) {
  console.error(`\n${falhas.length} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nCordova: configuração válida.");
