const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function executar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, { encoding: "utf8" });
  if (resultado.error || resultado.status !== 0) {
    const detalhe = resultado.stderr || resultado.stdout || (resultado.error && resultado.error.message) || `${comando} terminou com código ${resultado.status}`;
    throw new Error(String(detalhe).trim());
  }
  return resultado.stdout.trim();
}

function exigir(nome) {
  const valor = String(process.env[nome] || "").trim();
  if (!valor) throw new Error(`Defina ${nome}.`);
  return valor;
}

const apk = path.resolve(exigir("REMOTEIFES_ANDROID_APK"));
const destino = path.resolve(exigir("REMOTEIFES_MOBILE_RELEASE_DIR"));
const version = exigir("REMOTEIFES_ANDROID_VERSION");
const build = exigir("REMOTEIFES_ANDROID_BUILD");
const serverUrl = new URL(exigir("REMOTEIFES_SERVER_URL"));
if (!["http:", "https:"].includes(serverUrl.protocol)) throw new Error("REMOTEIFES_SERVER_URL deve usar HTTP ou HTTPS.");
const serverOrigin = serverUrl.origin;
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+$/.test(build)) throw new Error("Versão ou build inválido.");
if (!fs.existsSync(apk) || !fs.statSync(apk).isFile() || !apk.toLowerCase().endsWith(".apk")) throw new Error("APK ausente ou inválido.");
if (/debug|unsigned/i.test(path.basename(apk))) throw new Error("Artefatos debug ou unsigned não podem ser publicados.");

const apksigner = exigir("ANDROID_APKSIGNER");
const apkanalyzer = exigir("ANDROID_APKANALYZER");
executar(apksigner, ["verify", "--verbose", apk]);
const certificados = executar(apksigner, ["verify", "--print-certs", apk]);
const cert = certificados.match(/certificate SHA-256 digest:\s*([a-f0-9]+)/i);
if (!cert || cert[1].length !== 64) throw new Error("Não foi possível confirmar o certificado de assinatura do APK.");
if (executar(apkanalyzer, ["manifest", "debuggable", apk]).toLowerCase() !== "false") throw new Error("O APK está marcado como depurável.");
if (executar(apkanalyzer, ["manifest", "version-name", apk]) !== version) throw new Error("A versão informada não corresponde ao AndroidManifest do APK.");
if (executar(apkanalyzer, ["manifest", "version-code", apk]) !== build) throw new Error("O build informado não corresponde ao AndroidManifest do APK.");

const bytes = fs.readFileSync(apk);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const nome = `RemoteIFES-${version}-${build}.apk`;
fs.mkdirSync(destino, { recursive: true });
const apkTemporario = path.join(destino, `.${nome}.tmp`);
const metaTemporario = path.join(destino, ".release.json.tmp");
fs.copyFileSync(apk, apkTemporario);
fs.renameSync(apkTemporario, path.join(destino, nome));
fs.writeFileSync(metaTemporario, JSON.stringify({
  file: nome,
  version,
  build,
  sha256,
  certificateSha256: cert[1].toLowerCase(),
  serverOrigin,
  artifactType: "release",
  signed: true,
  debuggable: false,
}, null, 2));
fs.renameSync(metaTemporario, path.join(destino, "release.json"));
console.log(`${nome} verificado e publicado em ${destino}`);
