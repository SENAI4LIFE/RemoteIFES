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

/**
 * The constraints remoteifes-server/src/routes/mobileAppRoutes.js applies before offering an APK, so
 * the Console never offers what the application refuses. The origin is checked for form only: the
 * server compares it with the host of each request, which the Console does not see.
 */
function problemasDoManifesto(meta) {
  const problemas = [];
  if (!/^\d+\.\d+\.\d+$/.test(String(meta.version || ""))) problemas.push("version inválida");
  if (!/^\d+$/.test(String(meta.build || ""))) problemas.push("build inválido");
  if (!/^[a-f0-9]{64}$/.test(String(meta.sha256 || ""))) problemas.push("sha256 ausente ou inválido");
  if (!/^[a-f0-9]{64}$/.test(String(meta.certificateSha256 || ""))) problemas.push("certificateSha256 ausente ou inválido");
  if (meta.artifactType !== "release" || meta.signed !== true || meta.debuggable !== false) problemas.push("não é um APK de release assinado e sem depuração");
  if (meta.minSdk !== 24 || !Number.isInteger(meta.targetSdk) || meta.targetSdk < 35) problemas.push("minSdk ou targetSdk fora do exigido");
  if (meta.releaseDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(meta.releaseDate))) problemas.push("releaseDate inválida");
  if (meta.notes !== undefined && (!Array.isArray(meta.notes) || meta.notes.some((n) => typeof n !== "string"))) problemas.push("notes inválidas");
  if (typeof meta.serverOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(meta.serverOrigin)) problemas.push("serverOrigin inválida");
  if (typeof meta.file !== "string" || !meta.file || path.basename(meta.file) !== meta.file) {
    problemas.push("file precisa ser um nome de arquivo da pasta servida");
  } else {
    if (!meta.file.toLowerCase().endsWith(".apk")) problemas.push("file precisa terminar em .apk");
    if (/debug|unsigned/i.test(meta.file)) problemas.push("file não pode ser um APK de debug nem sem assinatura");
  }
  return problemas;
}

function origemLoopback(origem) {
  let host;
  try {
    host = new URL(origem).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return true;
  }
  // WHATWG URL rewrites IPv4-mapped IPv6 to hex groups (::ffff:7f00:1).
  const mapeado = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapeado) {
    const alto = parseInt(mapeado[1], 16);
    const baixo = parseInt(mapeado[2], 16);
    host = [alto >> 8, alto & 255, baixo >> 8, baixo & 255].join(".");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::" || /^0\.\d+\.\d+\.\d+$/.test(host)) return true;
  return config.enderecoLoopback(host);
}

/**
 * Origins this installation demonstrably serves: CORS_ORIGIN, the Nginx site names and this host's
 * own addresses. The application offers an APK only to requests from its embedded origin, so an APK
 * built for any other origin belongs to another deployment.
 */
function origensDestaInstalacao() {
  const origens = new Set();
  for (const origem of config.origensConfiguradas()) {
    try {
      origens.add(new URL(origem).origin);
    } catch {}
  }
  const site = require("./rede").nginx();
  for (const nome of (site.serverNames || []).flatMap((n) => n.split(/\s+/))) {
    if (nome && nome !== "_") origens.add(`${site.tls ? "https" : "http"}://${nome}`);
  }
  const porta = config.caminhosDaAplicacao().porta;
  for (const lista of Object.values(require("os").networkInterfaces())) {
    for (const i of lista || []) {
      if (i.internal || i.family !== "IPv4") continue;
      origens.add(`http://${i.address}:${porta}`);
      if (site.siteRemoteifes) origens.add(`http://${i.address}`);
    }
  }
  return [...origens].filter((o) => !origemLoopback(o));
}

function problemaDeOrigem(serverOrigin) {
  if (origemLoopback(serverOrigin)) return `o APK foi gerado para ${serverOrigin}, uma origem de loopback que a aplicação não oferece em produção`;
  const origens = origensDestaInstalacao();
  if (origens.includes(serverOrigin)) return null;
  return (
    `o APK foi gerado para ${serverOrigin}, que não é uma origem desta instalação (${origens.join(", ") || "nenhuma detectada"}); ` +
    "a aplicação só oferece o APK a quem acessa por essa origem. Se ela é mesmo deste servidor, declare-a em CORS_ORIGIN do .env"
  );
}

function releasePublicado() {
  const destino = destinoDeRelease();
  const arquivo = path.join(destino.servidoPor, "release.json");
  const meta = lerJson(arquivo);
  if (!meta) {
    return { publicado: false, destino, motivo: fs.existsSync(destino.servidoPor) ? "nenhum release.json na pasta servida" : "a pasta servida ainda não existe" };
  }
  const problemas = problemasDoManifesto(meta);
  if (!problemas.some((p) => p.startsWith("serverOrigin"))) {
    const origem = problemaDeOrigem(meta.serverOrigin);
    if (origem) problemas.push(origem);
  }
  const nome = typeof meta.file === "string" && meta.file && path.basename(meta.file) === meta.file ? meta.file : null;
  const apk = nome ? path.join(destino.servidoPor, nome) : null;
  const existe = apk && fs.existsSync(apk);
  return {
    publicado: true,
    valido: problemas.length === 0,
    problemas,
    destino,
    versao: meta.version || null,
    build: meta.build || null,
    sha256: meta.sha256 || null,
    serverOrigin: meta.serverOrigin || null,
    arquivo: nome,
    certificadoSha256: meta.certificateSha256 || null,
    apkPresente: !!existe,
    bytes: existe ? fs.statSync(apk).size : null,
    publicadoEm: meta.releaseDate || null,
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

const hashes = new Map();

function sha256DoArquivo(arquivo, { usarCache = true } = {}) {
  let info;
  try {
    info = fs.statSync(arquivo);
  } catch (erro) {
    return Promise.resolve({ erro: erro.message });
  }
  const chave = `${arquivo}|${info.dev}|${info.ino}|${info.mtimeMs}|${info.size}`;
  if (usarCache && hashes.has(chave)) return Promise.resolve(hashes.get(chave));
  return new Promise((resolve) => {
    const hash = require("crypto").createHash("sha256");
    let bytes = 0;
    fs.createReadStream(arquivo)
      .on("data", (d) => {
        bytes += d.length;
        hash.update(d);
      })
      .on("error", (erro) => resolve({ erro: erro.message }))
      .on("end", () => {
        const resultado = { sha256: hash.digest("hex"), bytes };
        hashes.clear();
        hashes.set(chave, resultado);
        resolve(resultado);
      });
  });
}

/**
 * The published APK only when the application would offer it too: a valid manifest, the file inside
 * the served folder and bytes matching the declared SHA-256.
 */
async function apkServivel({ usarCache = true } = {}) {
  const release = releasePublicado();
  if (!release.publicado) return { release, arquivo: null, erro: release.motivo };
  if (!release.valido) return { release, arquivo: null, erro: `a aplicação recusa este release.json: ${release.problemas.join("; ")}` };
  let arquivo = null;
  try {
    arquivo = release.apkPresente ? require("./processos").caminhoContidoEm(release.destino.servidoPor, release.arquivo) : null;
  } catch {}
  if (!arquivo || !fs.statSync(arquivo).isFile()) return { release, arquivo: null, erro: "o APK citado em release.json não está na pasta servida" };
  const h = await sha256DoArquivo(arquivo, { usarCache });
  if (h.erro) return { release, arquivo: null, erro: h.erro };
  if (h.sha256 !== String(release.sha256).toLowerCase()) {
    return { release, arquivo: null, sha256: h.sha256, bytes: h.bytes, erro: "o SHA-256 do arquivo não confere com release.json: o APK foi alterado ou truncado depois da publicação" };
  }
  return { release, arquivo, sha256: h.sha256, bytes: h.bytes, erro: null };
}

/**
 * Recomputes the SHA-256 now, without the cache. It proves the file was not truncated or replaced
 * after publication; the signature itself was verified by the publisher on the machine with the SDK.
 */
async function conferirApkPublicado() {
  const r = await apkServivel({ usarCache: false });
  return { ok: !!r.arquivo, sha256: r.sha256 || null, declarado: r.release.sha256 || null, bytes: r.bytes || null, erro: r.erro };
}

function situacaoWeb() {
  const url = config.urlDaAplicacao();
  let https = false;
  let pagina = null;
  try {
    const u = new URL(url);
    https = u.protocol === "https:";
    pagina = `${u.origin}/#/aplicativo`;
  } catch {}
  return {
    versao: coleta.versoesDeclaradas().frontend,
    url,
    paginaAplicativo: pagina,
    https,
    serviceWorker: fs.existsSync(path.join(config.DIR_WEB, "sw.js")),
    manifesto: fs.existsSync(path.join(config.DIR_WEB, "manifest.webmanifest")),
    instalacao: https
      ? "Abra o endereço no navegador do aparelho e use Instalar aplicativo (ou Adicionar à tela inicial). A PWA se atualiza sozinha quando o frontend muda."
      : "Os navegadores só oferecem instalar a PWA em HTTPS. Sem domínio com certificado, o RemoteIFES funciona no navegador, mas não como aplicativo instalado; " +
        "o HTTPS é configurado no terminal do servidor com https-setup.sh, porque ele instala pacotes e reescreve o Nginx e o .env.",
  };
}

function guiaDePublicacao(destino) {
  const origem = (() => {
    try {
      return new URL(config.urlDaAplicacao()).origin;
    } catch {
      return "https://<endereço-da-aplicação>";
    }
  })();
  return [
    {
      titulo: "Definir a versão",
      onde: "máquina com Android SDK, em remoteifes-cordova",
      comando: "npm run android-version -- --rebuild",
      detalhe: "Ou informe um versionName novo. Um APK só atualiza o instalado quando o versionCode cresce e a assinatura é a mesma.",
    },
    {
      titulo: "Gerar o APK assinado para esta instalação",
      onde: "máquina com Android SDK, com a chave de produção",
      comando: `REMOTEIFES_SERVER_URL=${origem} npm run build-android-release`,
      detalhe: "A origem fica embutida no APK; um APK gerado para outra origem não serve aqui.",
    },
    {
      titulo: "Verificar e publicar",
      onde: "máquina com Android SDK",
      comando:
        "REMOTEIFES_ANDROID_APK=platforms/android/app/build/outputs/apk/release/app-release.apk \\\n" +
        "REMOTEIFES_MOBILE_RELEASE_DIR=<pasta-de-saída> \\\n" +
        `REMOTEIFES_SERVER_URL=${origem} \\\n` +
        "npm run publish-android-release",
      detalhe: "Confere assinatura, certificado, origem, versão e SHA-256 com apksigner e apkanalyzer antes de gravar o APK e o release.json.",
    },
    {
      titulo: "Levar para este servidor",
      onde: "da máquina com SDK para este host",
      comando: `scp <pasta-de-saída>/* <usuário>@<este-host>:${destino.servidoPor}/`,
      detalhe: "Quando o SDK está neste mesmo host, aponte REMOTEIFES_MOBILE_RELEASE_DIR direto para a pasta servida.",
    },
  ];
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

const WORKFLOWS = [
  { chave: "ci", nome: "Validação (CI)", descricao: "Testes do servidor, do console, do site nos navegadores, do firmware e dos aplicativos.", dispara: true },
  { chave: "android", nome: "Build Android", descricao: "APK de validação, inspeção e smoke nativo em emulador. Não gera APK de produção.", dispara: true },
  { chave: "ios", nome: "Build iOS", descricao: "Build e teste em simulador macOS. Não gera IPA distribuível.", dispara: true },
  { chave: "pages", nome: "GitHub Pages", descricao: "Publica a demonstração do site no GitHub Pages. A produção é servida por este servidor.", dispara: true },
  { chave: "console", nome: "Release do Console", descricao: "Publica o Console de Operações a partir de uma etiqueta console-v<versão>; só acompanha.", dispara: false },
];

async function situacao() {
  const release = releasePublicado();
  const servivel = await apkServivel();
  return {
    coletadoEm: new Date().toISOString(),
    identidades: identidades(),
    web: situacaoWeb(),
    release: { ...release, baixavel: !!servivel.arquivo, impedimento: release.publicado ? servivel.erro : null },
    build: prontidaoDeBuild(),
    credencialGitHub: github.estadoDoToken(),
    repositorio: github.REPOSITORIO_PERMITIDO,
    workflows: Object.keys(github.WORKFLOWS_PERMITIDOS),
    workflows: WORKFLOWS,
    publicacao: {
      suportadaNoConsole: false,
      passos: guiaDePublicacao(release.destino),
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
      semCredencial: true,
      motivo: "nenhuma credencial do GitHub configurada no console",
      orientacao:
        "Grave um token com acesso a Actions do repositório em Credencial do GitHub. Sem ele o console continua " +
        "funcionando: a operação normal do RemoteIFES não depende do GitHub.",
    };
  }
  const limites = { ci: 6, android: 4, ios: 3, pages: 3, console: 3 };
  const listas = await Promise.all(WORKFLOWS.map((w) => github.listarRuns({ workflow: w.chave, limite: limites[w.chave], ramo: w.chave === "console" ? null : "main" })));
  const problema = listas.find((r) => !r.ok);
  const porChave = Object.fromEntries(WORKFLOWS.map((w, i) => [w.chave, listas[i].ok ? listas[i].runs : []]));
  return {
    disponivel: !problema,
    motivo: problema ? problema.erro : null,
    limite: (listas.find((r) => r.limite) || {}).limite || null,
    consultadoEm: new Date().toISOString(),
    ...porChave,
    estadosDistintos:
      "Sucesso do workflow, artefato disponível, verificação de produção, publicação e instalação bem-sucedida " +
      "são estados diferentes. Um workflow verde não significa APK publicado.",
    origemMobile:
      "Os builds Android e iOS disparados por mudanças no código rodam como jobs dentro do workflow CI. " +
      "As listas Android e iOS mostram apenas execuções disparadas manualmente desses workflows.",
  };
}

module.exports = { situacao, estadoCI, identidades, releasePublicado, destinoDeRelease, prontidaoDeBuild, apkServivel, conferirApkPublicado, WORKFLOWS };
