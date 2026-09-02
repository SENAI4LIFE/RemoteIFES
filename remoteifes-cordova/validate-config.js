const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { caminhoCordova } = require("./build-android-release");

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

function tolera(fn) {
  try {
    fn();
    return true;
  } catch (erro) {
    return false;
  }
}

console.log("config.xml — estrutura");
const original = fs.readFileSync(CONFIG, "utf8");
checar(original.startsWith("<?xml"), "declaração XML presente");
checar(contar(original, /<widget\b/g) === 1 && contar(original, /<\/widget>/g) === 1, "exatamente um elemento <widget>");
checar(contar(original, /<platform\b/g) === contar(original, /<\/platform>/g), "tags <platform> balanceadas");
checar(/<content src="index\.html" \/>/.test(original), "<content src=\"index.html\" /> presente");
checar(/<preference name="Orientation" value="default" \/>/.test(original), "Orientation = default (retrato e paisagem)");
checar(/<platform name="android">/.test(original) && /<platform name="ios">/.test(original), "plataformas android e ios declaradas");
checar(fs.existsSync(caminhoCordova()), "launcher do build de release usa o Cordova local");
const releaseScript = fs.readFileSync(path.join(RAIZ, "build-android-release.js"), "utf8");
checar(releaseScript.includes("REMOTEIFES_ANDROID_KEYSTORE") && releaseScript.includes("REMOTEIFES_ANDROID_STORE_PASSWORD"), "build de release exige keystore e credenciais de assinatura");
checar(releaseScript.includes("fixarServidorNoBundle") && releaseScript.includes("REMOTEIFES_SERVER_URL"), "build de release fixa a origem de produção no bundle");
checar(releaseScript.includes("fs.mkdtempSync") && releaseScript.includes("fs.rmSync(temporario"), "configuração temporária de assinatura é removida após o build");
const publishScript = fs.readFileSync(path.join(RAIZ, "publish-android-release.js"), "utf8");
checar(publishScript.includes('"verify", "--verbose"') && publishScript.includes('"manifest", "debuggable"'), "publicação verifica assinatura e rejeita APK depurável");
checar(publishScript.includes('"manifest", "version-name"') && publishScript.includes('"manifest", "version-code"'), "publicação confere versão e build no manifesto do APK");
checar(publishScript.includes('"manifest", "min-sdk"') && publishScript.includes('"manifest", "target-sdk"'), "publicação confere minSdk e targetSdk no manifesto do APK");
checar(publishScript.includes('localhost') && releaseScript.includes('localhost'), "build e publicação recusam origem loopback para APK de produção");
checar(publishScript.includes("conferirAvanco"), "publicação recusa um build que não avança sobre o já publicado");
checar(releaseScript.includes("fixarVersaoNoBundle"), "build de release grava a versão Android no bundle para o app saber a própria versão");

console.log("versão Android — fonte única");
const { problemas: problemasVersao, dados: versaoAndroid } = require("./android-version").verificar();
problemasVersao.forEach((p) => console.log(`      ${p}`));
checar(problemasVersao.length === 0, "config.xml e android-release.json declaram a mesma versão e o mesmo versionCode");
checar(versaoAndroid.versionCode >= require("./android-version").codigoDerivado(versaoAndroid.versionName), "versionCode não é anterior ao derivado da versão");
checar(!publishScript.includes("REMOTEIFES_ANDROID_VERSION") && !publishScript.includes("REMOTEIFES_ANDROID_BUILD"), "publicação lê a versão da fonte única, sem repetir versão/build no ambiente");
const { codigoDerivado, proximoCodigo } = require("./android-version");
checar(codigoDerivado("1.0.0") === 10000 && codigoDerivado("1.2.3") === 10203 && codigoDerivado("2.0.0") === 20000, "versionCode derivado da versão é previsível (1.2.3 -> 10203)");
checar(proximoCodigo("1.0.1", 10000) === 10001 && proximoCodigo("1.1.0", 10005) === 10100, "uma versão nova adota o código derivado dela");
checar(proximoCodigo("1.0.0", 10000) === 10001 && proximoCodigo("1.0.1", 10050) === 10051, "recompilar a mesma versão avança o versionCode em vez de repeti-lo");
checar([["1.0.0", 0], ["9.9.9", 0]].every(([v, base]) => proximoCodigo(v, base) > base), "o versionCode sempre cresce sobre o anterior");

console.log("publicação — consistência da release");
const { conferirAvanco, limparSuperados } = require("./publish-android-release");
const temporario = fs.mkdtempSync(path.join(require("os").tmpdir(), "remoteifes-release-check-"));
try {
  const metadados = path.join(temporario, "release.json");
  const publicado = { file: "RemoteIFES-1.0.0-10000.apk", build: "10000", sha256: "a".repeat(64) };
  fs.writeFileSync(metadados, JSON.stringify(publicado));
  checar(tolera(() => conferirAvanco(temporario, "10001", "b".repeat(64))), "um build maior pode ser publicado");
  checar(!tolera(() => conferirAvanco(temporario, "10000", "b".repeat(64))), "o mesmo build com outro arquivo é recusado");
  checar(!tolera(() => conferirAvanco(temporario, "9999", "b".repeat(64))), "um build anterior ao publicado é recusado");
  checar(tolera(() => conferirAvanco(temporario, "10000", "a".repeat(64))), "republicar o mesmo artefato é aceito");

  fs.writeFileSync(path.join(temporario, "RemoteIFES-1.0.0-10000.apk"), "antigo");
  fs.writeFileSync(path.join(temporario, "RemoteIFES-1.0.1-10001.apk"), "novo");
  fs.writeFileSync(path.join(temporario, ".sobra.tmp"), "parcial");
  limparSuperados(temporario, "RemoteIFES-1.0.1-10001.apk");
  const restantes = fs.readdirSync(temporario).sort();
  checar(restantes.join(",") === "RemoteIFES-1.0.1-10001.apk,release.json", "publicar remove APKs superados e sobras parciais");
} finally {
  fs.rmSync(temporario, { recursive: true, force: true });
}

console.log("harden-config.js — reversibilidade");
try {
  execFileSync("node", [path.join(RAIZ, "harden-config.js"), "https://exemplo.ifes.edu.br"], { stdio: "pipe" });
  const endurecido = fs.readFileSync(CONFIG, "utf8");
  checar(!/origin="\*"/.test(endurecido) && !/href="\*"/.test(endurecido), "endurecimento remove curingas de rede");
  checar(/origin="https:\/\/exemplo\.ifes\.edu\.br\/\*"/.test(endurecido), "endurecimento fixa a origem de produção");
  checar(/usesCleartextTraffic="false"/.test(endurecido), "endurecimento HTTPS bloqueia cleartext explicitamente");
  execFileSync("node", [path.join(RAIZ, "harden-config.js"), "--dev"], { stdio: "pipe" });
  const restaurado = fs.readFileSync(CONFIG, "utf8");
  if (restaurado !== original) {
    const antes = original.split(/\r?\n/);
    const depois = restaurado.split(/\r?\n/);
    const indice = antes.findIndex((linha, i) => linha !== depois[i]);
    if (indice >= 0) {
      console.log(`      primeira diferença na linha ${indice + 1}:`);
      console.log(`      original: ${JSON.stringify(antes[indice])}`);
      console.log(`      restaurado: ${JSON.stringify(depois[indice])}`);
    } else {
      let caractere = 0;
      while (caractere < original.length && original[caractere] === restaurado[caractere]) caractere += 1;
      console.log(`      primeira diferença no byte ${caractere}: original=${JSON.stringify(original.slice(caractere, caractere + 12))}, restaurado=${JSON.stringify(restaurado.slice(caractere, caractere + 12))}`);
    }
  }
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
  checar(fs.readFileSync(path.join(WWW, "index.html"), "utf8").includes('<script src="cordova.js"></script>'), "www/index.html carrega cordova.js");
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
