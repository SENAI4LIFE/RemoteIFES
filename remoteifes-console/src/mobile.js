const fs = require("fs");
const path = require("path");
const config = require("./config");
const coleta = require("./coleta");
const github = require("./github");

// Mobile lifecycle: version identities, published artifact and CI status.
//
// Distinct identities that are **not** the same thing and must not be presented as "the version":
//   server (package.json)  ·  frontend/PWA (version.json)  ·  Cordova package (package.json)
//   Android versionName/versionCode (config.xml)  ·  build source commit  ·  published APK
//
// Also: `validate-config.js` temporarily rewrites config.xml and regenerates `www/`, and
// `sync-www.js` recreates files. They are not status collectors and are not called here.

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where the APK is actually served. The publisher writes to REMOTEIFES_MOBILE_RELEASE_DIR and the
 * server reads from MOBILE_APP_RELEASE_DIR: two names for the same destination, which is why a
 * "successful" publication may not appear on the App page.
 */
function destinoDeRelease() {
  const app = config.caminhosDaAplicacao();
  const servidoPor = app.releasesMobile;
  const publicadoPara = app.releasesMobilePublicacao;
  const divergem = publicadoPara && path.resolve(publicadoPara) !== path.resolve(servidoPor);
  return {
    servidoPor,
    variavelDoServidor: "MOBILE_APP_RELEASE_DIR",
    publicadoPara: publicadoPara || null,
    variavelDaPublicacao: "REMOTEIFES_MOBILE_RELEASE_DIR",
    divergem: !!divergem,
    observacao: divergem
      ? "As duas variáveis apontam para pastas diferentes: o que for publicado não será servido pela página Aplicativo. Alinhe os caminhos antes de publicar."
      : "O destino da publicação e o que o servidor entrega coincidem.",
  };
}

function releasePublicado() {
  const destino = destinoDeRelease();
  const arquivo = path.join(destino.servidoPor, "release.json");
  const meta = lerJson(arquivo);
  if (!meta) {
    return { publicado: false, destino, motivo: fs.existsSync(destino.servidoPor) ? "nenhum release.json na pasta servida" : "a pasta servida ainda não existe" };
  }
  const apk = meta.arquivo ? path.join(destino.servidoPor, meta.arquivo) : null;
  const existe = apk && fs.existsSync(apk);
  return {
    publicado: true,
    destino,
    versao: meta.version || null,
    build: meta.build || null,
    sha256: meta.sha256 || null,
    serverOrigin: meta.serverOrigin || null,
    arquivo: meta.arquivo || null,
    apkPresente: !!existe,
    bytes: existe ? fs.statSync(apk).size : null,
    publicadoEm: meta.publishedAt || meta.publicadoEm || null,
    // `signed: true` in the manifest is the publisher's claim, not proof. The proof is the
    // apksigner/apkanalyzer verification done by publish-android-release.js on the machine with the
    // SDK. The Console shows the field and states exactly what it means.
    assinadoDeclarado: meta.signed === true,
    ressalvaAssinatura:
      "O campo `signed` do release.json é uma declaração de quem publicou. A verificação real de " +
      "assinatura, identidade do pacote, origem embutida e continuidade do certificado é feita por " +
      "publish-android-release.js na máquina com Android SDK, antes de copiar o arquivo.",
  };
}

function identidades() {
  const versoes = coleta.versoesDeclaradas();
  const release = releasePublicado();
  return {
    servidor: versoes.servidor,
    frontendPwa: versoes.frontend,
    pacoteCordova: versoes.cordova,
    android: versoes.android,
    firmware: versoes.firmware,
    apkPublicado: release.publicado ? { versao: release.versao, build: release.build, sha256: release.sha256 } : null,
    observacao:
      "Estas versões são independentes entre si nesta revisão: avançar uma não avança as outras. " +
      "O Android só é atualizado sobre a instalação existente quando o versionCode cresce e a assinatura é a mesma.",
  };
}

function prontidaoDeBuild() {
  const temSdk = !!(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
  const temJava = fs.existsSync("/usr/lib/jvm");
  const cordovaInstalado = fs.existsSync(path.join(config.DIR_CORDOVA, "node_modules", "cordova"));
  return {
    esteHost: {
      sdkAndroid: temSdk,
      jdk: temJava,
      dependenciasCordova: cordovaInstalado,
      arquitetura: process.arch,
    },
    politica:
      "Builds Android e iOS não rodam neste host e isso é decisão de arquitetura, não limitação temporária: " +
      "instalar SDK, JDK e Gradle num Raspberry Pi 3 com 1 GiB gastaria disco e memória para uma tarefa que " +
      "pertence à CI ou à máquina de desenvolvimento. O console dispara e acompanha a CI; a compilação acontece lá.",
    ios:
      "O fluxo iOS da CI faz preparação, build e teste em simulador macOS. Ele não produz IPA distribuível " +
      "nem pipeline de App Store, e Linux/Pi não executa o trabalho de macOS/Xcode.",
  };
}

async function situacao() {
  return {
    coletadoEm: new Date().toISOString(),
    identidades: identidades(),
    release: releasePublicado(),
    build: prontidaoDeBuild(),
    credencialGitHub: github.estadoDoToken(),
    repositorio: github.REPOSITORIO_PERMITIDO,
    workflows: Object.keys(github.WORKFLOWS_PERMITIDOS),
    publicacao: {
      suportadaNoConsole: false,
      motivo:
        "A publicação de produção exige inspeção do APK com apksigner/apkanalyzer (Android SDK) para conferir " +
        "identidade do pacote, origem embutida, progressão de versionCode e continuidade do certificado. " +
        "Esses controles não são enfraquecidos para caber no Pi: a publicação continua sendo feita com " +
        "`npm run publish-android-release` na máquina que tem o SDK.",
      artefatosDaCi:
        "A CI Android produz APK debug, unsigned e um APK assinado com certificado descartável apenas para " +
        "validação de runtime. Nenhum deles é artefato de produção, e a retenção de artefatos é limitada.",
    },
  };
}

async function estadoCI() {
  if (!github.temToken()) {
    return {
      disponivel: false,
      motivo: "nenhuma credencial do GitHub configurada no console",
      orientacao:
        "Um token com permissão de leitura de Actions (e de escrita apenas se quiser disparar workflows) pode ser " +
        "gravado em Avançado. Sem ele o console continua funcionando: a operação normal do RemoteIFES não depende do GitHub.",
    };
  }
  const [ci, android, ios] = await Promise.all([
    github.listarRuns({ workflow: "ci", limite: 5, ramo: "main" }),
    github.listarRuns({ workflow: "android", limite: 5, ramo: "main" }),
    github.listarRuns({ workflow: "ios", limite: 3, ramo: "main" }),
  ]);
  const problema = [ci, android, ios].find((r) => !r.ok);
  return {
    disponivel: !problema,
    motivo: problema ? problema.erro : null,
    limite: ci.limite || null,
    ci: ci.ok ? ci.runs : [],
    android: android.ok ? android.runs : [],
    ios: ios.ok ? ios.runs : [],
    estadosDistintos:
      "Sucesso do workflow, artefato disponível, verificação de produção, publicação e instalação bem-sucedida " +
      "são estados diferentes. Um workflow verde não significa APK publicado.",
    origemMobile:
      "Os builds Android e iOS disparados por mudanças no código rodam como jobs dentro do workflow CI. " +
      "As listas Android e iOS mostram apenas execuções disparadas manualmente desses workflows.",
  };
}

module.exports = { situacao, estadoCI, identidades, releasePublicado, destinoDeRelease, prontidaoDeBuild };
