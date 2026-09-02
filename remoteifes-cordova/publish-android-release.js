const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { verificar: verificarVersao } = require("./android-version");

function executar(comando, argumentos) {
  const ehBat = process.platform === "win32" && /\.(bat|cmd)$/i.test(comando);
  const resultado = ehBat
    ? spawnSync("cmd.exe", ["/c", comando, ...argumentos], { encoding: "utf8" })
    : spawnSync(comando, argumentos, { encoding: "utf8" });
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

// A publicação anterior é a única referência de que o versionCode cresceu: o Android
// recusa instalar por cima um pacote que não avançou, e um servidor anunciando um build
// mais antigo deixaria os aparelhos sem caminho de atualização.
function conferirAvanco(destino, build, sha256) {
  const metadados = path.join(destino, "release.json");
  if (!fs.existsSync(metadados)) return;
  let publicado;
  try {
    publicado = JSON.parse(fs.readFileSync(metadados, "utf8"));
  } catch (erro) {
    return;
  }
  const anterior = Number(publicado.build);
  if (!Number.isInteger(anterior)) return;
  if (Number(build) > anterior) return;
  if (Number(build) === anterior && publicado.sha256 === sha256) return;
  throw new Error(
    `o servidor já publica o build ${anterior} e este APK traz ${build}: avance a versão com \`npm run android-version -- --rebuild\` (ou informe a nova versão), gere o APK de novo e publique.`
  );
}

function limparSuperados(destino, nomeAtual) {
  for (const nome of fs.readdirSync(destino)) {
    if (nome === nomeAtual || nome === "release.json") continue;
    if (!/\.apk$/i.test(nome) && !nome.startsWith(".")) continue;
    fs.rmSync(path.join(destino, nome), { force: true });
  }
}

function main() {
  const { dados, problemas } = verificarVersao();
  if (problemas.length) throw new Error(`${problemas.join("; ")}. Rode \`npm run android-version -- --verificar\`.`);
  const version = dados.versionName;
  const build = String(dados.versionCode);

  const apk = path.resolve(exigir("REMOTEIFES_ANDROID_APK"));
  const destino = path.resolve(exigir("REMOTEIFES_MOBILE_RELEASE_DIR"));
  const serverUrl = new URL(exigir("REMOTEIFES_SERVER_URL"));
  if (!["http:", "https:"].includes(serverUrl.protocol)) throw new Error("REMOTEIFES_SERVER_URL deve usar HTTP ou HTTPS.");
  if (serverUrl.username || serverUrl.password || serverUrl.pathname !== "/" || serverUrl.search || serverUrl.hash) throw new Error("REMOTEIFES_SERVER_URL deve conter somente a origem do servidor.");
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(serverUrl.hostname.toLowerCase())) throw new Error("Um APK de produção não pode ser publicado para localhost: no aparelho, localhost é o próprio Android.");
  const serverOrigin = serverUrl.origin;
  if (!fs.existsSync(apk) || !fs.statSync(apk).isFile() || !apk.toLowerCase().endsWith(".apk")) throw new Error("APK ausente ou inválido.");
  if (/debug|unsigned/i.test(path.basename(apk))) throw new Error("Artefatos debug ou unsigned não podem ser publicados.");

  const apksigner = exigir("ANDROID_APKSIGNER");
  const apkanalyzer = exigir("ANDROID_APKANALYZER");
  executar(apksigner, ["verify", "--verbose", apk]);
  const certificados = executar(apksigner, ["verify", "--print-certs", apk]);
  const cert = certificados.match(/certificate SHA-256 digest:\s*([a-f0-9]+)/i);
  if (!cert || cert[1].length !== 64) throw new Error("Não foi possível confirmar o certificado de assinatura do APK.");
  if (executar(apkanalyzer, ["manifest", "debuggable", apk]).toLowerCase() !== "false") throw new Error("O APK está marcado como depurável.");
  if (executar(apkanalyzer, ["manifest", "version-name", apk]) !== version) throw new Error(`O APK não foi gerado nesta versão: android-release.json declara ${version}.`);
  if (executar(apkanalyzer, ["manifest", "version-code", apk]) !== build) throw new Error(`O APK não foi gerado neste build: android-release.json declara ${build}.`);
  const minSdk = executar(apkanalyzer, ["manifest", "min-sdk", apk]);
  const targetSdk = executar(apkanalyzer, ["manifest", "target-sdk", apk]);
  if (minSdk !== "24") throw new Error("O APK deve declarar minSdk 24.");
  if (!/^\d+$/.test(targetSdk) || Number(targetSdk) < 35) throw new Error("O APK deve declarar targetSdk 35 ou posterior.");

  const bytes = fs.readFileSync(apk);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const nome = `RemoteIFES-${version}-${build}.apk`;
  fs.mkdirSync(destino, { recursive: true });
  conferirAvanco(destino, build, sha256);

  // O arquivo entra inteiro antes dos metadados: até a troca atômica do release.json o
  // servidor continua anunciando a publicação anterior, nunca uma release pela metade.
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
    releaseDate: dados.releaseDate,
    notes: dados.notes,
    artifactType: "release",
    signed: true,
    debuggable: false,
    minSdk: Number(minSdk),
    targetSdk: Number(targetSdk),
  }, null, 2));
  fs.renameSync(metaTemporario, path.join(destino, "release.json"));
  limparSuperados(destino, nome);
  console.log(`${nome} verificado e publicado em ${destino}`);
}

if (require.main === module) {
  try {
    main();
  } catch (erro) {
    console.error(`publish-android-release: ${erro.message}`);
    console.error("Nada foi publicado.");
    process.exit(1);
  }
}

module.exports = { conferirAvanco, limparSuperados };
