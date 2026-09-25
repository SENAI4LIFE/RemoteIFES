const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { verificar: verificarVersao } = require("./android-version");

function exigir(nome) {
  const valor = String(process.env[nome] || "").trim();
  if (!valor) throw new Error(`Defina ${nome}.`);
  return valor;
}

// Each newly published artifact must advance the versionCode. Reinstalling the same version on
// Android is allowed, but does not identify a new release for clients.
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

  // Verify the bytes being published, including the embedded origin and package ID.
  const inspected = require('./inspect-apk').inspect(apk, { origin: serverOrigin });
  const previousMetadata = path.join(destino, 'release.json');
  if (fs.existsSync(previousMetadata)) {
    const previous = JSON.parse(fs.readFileSync(previousMetadata, 'utf8'));
    if (!previous.certificateSha256 || previous.certificateSha256.toLowerCase() !== inspected.certificateSha256.toLowerCase()) {
      throw new Error('O certificado difere da assinatura publicada; a atualização não preservaria a identidade do aplicativo.');
    }
  }

  const minSdk = inspected.minSdk;
  const targetSdk = inspected.targetSdk;

  const bytes = fs.readFileSync(apk);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const nome = `RemoteIFES-${version}-${build}.apk`;
  fs.mkdirSync(destino, { recursive: true });
  conferirAvanco(destino, build, sha256);

  // The file is written in full before the metadata: until release.json is atomically replaced, the
  // server keeps announcing the previous publication, never a half-written release.
  const apkTemporario = path.join(destino, `.${nome}.tmp`);
  const metaTemporario = path.join(destino, ".release.json.tmp");
  fs.copyFileSync(apk, apkTemporario);
  fs.renameSync(apkTemporario, path.join(destino, nome));
  fs.writeFileSync(metaTemporario, JSON.stringify({
    file: nome,
    version,
    build,
    sha256,
    certificateSha256: inspected.certificateSha256.toLowerCase(),
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
