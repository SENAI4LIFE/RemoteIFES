const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function executar(comando, argumentos, opcoes = {}) {
  const resultado = spawnSync(comando, argumentos, { stdio: "inherit", ...opcoes });
  if (resultado.error) throw new Error(`Falha ao executar ${comando}: ${resultado.error.message}`);
  if (resultado.status !== 0) {
    const erro = new Error(`${comando} terminou com código ${resultado.status || 1}`);
    erro.exitCode = resultado.status || 1;
    throw erro;
  }
}

function caminhoCordova() { return require.resolve("cordova/bin/cordova"); }

function exigirAmbiente(nome) {
  const valor = String(process.env[nome] || "").trim();
  if (!valor) throw new Error(`Defina ${nome} para gerar uma versão Android de produção assinada.`);
  return valor;
}

function fixarServidorNoBundle(origem) {
  const arquivo = path.join(__dirname, "www", "js", "config.js");
  const atual = fs.readFileSync(arquivo, "utf8");
  const esperado = 'const serverUrl = salvo || (empacotado ? "" : servidorPadraoDoNavegador());';
  if (!atual.includes(esperado)) throw new Error("Não foi possível localizar a configuração de servidor do bundle Cordova.");
  fs.writeFileSync(arquivo, atual.replace(esperado, `const serverUrl = salvo || (empacotado ? ${JSON.stringify(origem)} : servidorPadraoDoNavegador());`));
}

function main() {
  let temporario = null;
  let endurecido = false;
  try {
    const origem = exigirAmbiente("REMOTEIFES_SERVER_URL");
    const keystore = path.resolve(exigirAmbiente("REMOTEIFES_ANDROID_KEYSTORE"));
    if (!fs.existsSync(keystore) || !fs.statSync(keystore).isFile()) throw new Error("O keystore de produção informado não existe.");
    const release = {
      keystore,
      storePassword: exigirAmbiente("REMOTEIFES_ANDROID_STORE_PASSWORD"),
      alias: exigirAmbiente("REMOTEIFES_ANDROID_KEY_ALIAS"),
      password: exigirAmbiente("REMOTEIFES_ANDROID_KEY_PASSWORD"),
      keystoreType: process.env.REMOTEIFES_ANDROID_KEYSTORE_TYPE || "jks",
      packageType: "apk",
    };
    temporario = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-android-release-"));
    const buildConfig = path.join(temporario, "build.json");
    fs.writeFileSync(buildConfig, JSON.stringify({ android: { release } }), { mode: 0o600 });
    executar(process.execPath, [path.join(__dirname, "sync-www.js")]);
    fixarServidorNoBundle(origem);
    executar(process.execPath, [path.join(__dirname, "harden-config.js"), origem]);
    endurecido = true;
    executar(process.execPath, [caminhoCordova(), "build", "android", "--release", `--buildConfig=${buildConfig}`]);
  } catch (erro) {
    console.error(erro.message);
    process.exitCode = erro.exitCode || 1;
  } finally {
    if (temporario) fs.rmSync(temporario, { recursive: true, force: true });
    if (endurecido) {
      try { executar(process.execPath, [path.join(__dirname, "harden-config.js"), "--dev"]); }
      catch (erro) { console.error(`Falha ao restaurar config.xml: ${erro.message}`); process.exitCode = erro.exitCode || 1; }
    }
  }
}

if (require.main === module) main();
module.exports = { caminhoCordova };
