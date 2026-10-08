// Isolated Operations Console for the browser tests and the README capture: a clone of this
// repository one commit behind its own local origin, temporary state, HOME and installation, and a
// fake GitHub Actions API.
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const ORIGEM_CONSOLE = path.join(RAIZ, "remoteifes-console");
const VERSAO_CONSOLE = JSON.parse(fs.readFileSync(path.join(ORIGEM_CONSOLE, "package.json"), "utf8")).version;
const ASSUNTO_NOVO = "Mostrar a próxima limpeza automática na agenda";
const ORIGEM_PUBLICA = "https://remoteifes.campus.example";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Equipe RemoteIFES", GIT_AUTHOR_EMAIL: "equipe@example.invalid", GIT_COMMITTER_NAME: "Equipe RemoteIFES", GIT_COMMITTER_EMAIL: "equipe@example.invalid" },
  }).toString().trim();
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const porta = s.address().port;
      s.close(() => resolve(porta));
    });
  });
}

function copiarPayload(destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const nome of ["console.js", "launcher.js", "package.json", "src", "bin", "web", "instalacao", "helper", "systemd"]) {
    fs.cpSync(path.join(ORIGEM_CONSOLE, nome), path.join(destino, nome), { recursive: true });
  }
}

// HOME points inside `base` too, so the uninstaller never sees the developer's own shortcuts.
function prepararAmbiente({ portaAplicacao, instalado = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "console-ui-"));
  const origem = path.join(base, "origem");
  const checkout = path.join(base, "checkout");
  git(base, "clone", "--quiet", "--shared", RAIZ, origem);
  git(origem, "checkout", "--quiet", "-B", "main");
  fs.appendFileSync(path.join(origem, "remoteifes-web", "version.json"), "\n");
  git(origem, "commit", "--quiet", "-am", ASSUNTO_NOVO);
  git(base, "clone", "--quiet", "--shared", origem, checkout);
  git(checkout, "reset", "--quiet", "--hard", "HEAD~1");

  const servidor = path.join(checkout, "remoteifes-server");
  fs.writeFileSync(path.join(servidor, ".env"), `PORTA=${portaAplicacao}\nCORS_ORIGIN=${ORIGEM_PUBLICA}\n`);
  const releases = path.join(servidor, "data", "releases", "mobile");
  fs.mkdirSync(releases, { recursive: true });
  const apk = crypto.randomBytes(48 * 1024);
  fs.writeFileSync(path.join(releases, "RemoteIFES-1.4.0-12.apk"), apk);
  fs.writeFileSync(path.join(releases, "release.json"), JSON.stringify({
    file: "RemoteIFES-1.4.0-12.apk",
    version: "1.4.0",
    build: 12,
    sha256: crypto.createHash("sha256").update(apk).digest("hex"),
    certificateSha256: crypto.createHash("sha256").update("certificado de teste").digest("hex"),
    artifactType: "release",
    signed: true,
    debuggable: false,
    minSdk: 24,
    targetSdk: 36,
    releaseDate: new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10),
    serverOrigin: ORIGEM_PUBLICA,
  }, null, 2));
  const backups = path.join(servidor, "data", "backups");
  fs.mkdirSync(backups, { recursive: true });
  const cabecalho = Buffer.concat([Buffer.from("SQLite format 3\0"), crypto.randomBytes(4080)]);
  for (const [nome, horasAtras] of [["remoteifes-20261005-020000-a1b2c3-automatico.db", 30], ["remoteifes-20261006-020000-d4e5f6-automatico.db", 6]]) {
    const arquivo = path.join(backups, nome);
    fs.writeFileSync(arquivo, cabecalho);
    const quando = new Date(Date.now() - horasAtras * 3600_000);
    fs.utimesSync(arquivo, quando, quando);
  }

  const estado = path.join(base, "estado");
  const home = path.join(base, "home");
  fs.mkdirSync(estado, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, ".local", "share", "applications"), { recursive: true });

  let raizInstalacao = null;
  let payload = ORIGEM_CONSOLE;
  if (instalado) {
    raizInstalacao = path.join(base, "programa");
    payload = path.join(raizInstalacao, "versoes", VERSAO_CONSOLE);
    copiarPayload(payload);
    fs.mkdirSync(path.join(raizInstalacao, "versoes", "0.9.0"), { recursive: true });
    fs.copyFileSync(path.join(ORIGEM_CONSOLE, "instalacao", "console-bootstrap.js"), path.join(raizInstalacao, "console-bootstrap.js"));
    fs.writeFileSync(path.join(raizInstalacao, "estado-instalacao.json"), JSON.stringify({
      versaoAtiva: VERSAO_CONSOLE,
      versaoAnterior: "0.9.0",
      transacao: null,
      atualizadoEm: new Date().toISOString(),
      escopo: "usuario",
      estado,
      porta: 0,
    }, null, 2));
    fs.writeFileSync(path.join(estado, "observacao-release.json"), JSON.stringify({
      versao: "1.1.0",
      canal: "estável",
      observadoEm: new Date(Date.now() - 20 * 60_000).toISOString(),
      alvos: [],
    }));
  }
  return { base, origem, checkout, estado, home, raizInstalacao, payload, versaoConsole: VERSAO_CONSOLE, assuntoNovo: ASSUNTO_NOVO };
}

function limparAmbiente(amb) {
  try {
    fs.rmSync(amb.base, { recursive: true, force: true });
  } catch {}
}

function ambienteDoConsole(amb, { porta, githubApi }) {
  return {
    ...process.env,
    HOME: amb.home,
    USERPROFILE: amb.home,
    CONSOLE_ESTADO_DIR: amb.estado,
    CONSOLE_CHECKOUT_DIR: amb.checkout,
    CONSOLE_SEM_PRIVILEGIO: "1",
    CONSOLE_PORTA: String(porta),
    CONSOLE_OCIOSIDADE_S: "0",
    CONSOLE_GITHUB_API: githubApi || "http://127.0.0.1:9",
    CONSOLE_RELEASE_BASE: "http://127.0.0.1:9",
    ...(amb.raizInstalacao ? { CONSOLE_RAIZ_INSTALACAO: amb.raizInstalacao } : {}),
  };
}

function criarOperador(amb, nome, senha) {
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(amb.payload, "src", "auth.js"))}).criarOperador(process.argv[1], process.argv[2])`, nome, senha], {
    env: ambienteDoConsole(amb, { porta: 1 }),
    stdio: "ignore",
  });
}

function gravarSegredoDeInstalacao(amb) {
  const segredo = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(path.join(amb.estado, "bootstrap-token"), `${segredo}\n`, { mode: 0o600 });
  return segredo;
}

async function subirConsole(amb, { githubApi } = {}) {
  const porta = await portaLivre();
  const processo = spawn(process.execPath, [path.join(amb.payload, "console.js")], {
    env: ambienteDoConsole(amb, { porta, githubApi }),
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let erros = "";
  processo.stderr.on("data", (d) => {
    erros = (erros + d).slice(-4000);
  });
  const url = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    if (processo.exitCode !== null) throw new Error(`o console saiu (código ${processo.exitCode}): ${erros}`);
    try {
      if ((await fetch(`${url}/api/sessao`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
    if (i === 99) throw new Error(`o console não respondeu em ${url}: ${erros}`);
  }
  return {
    url,
    porta,
    processo,
    encerrar: () =>
      new Promise((resolve) => {
        if (processo.exitCode !== null || processo.signalCode) return resolve();
        processo.once("exit", () => resolve());
        processo.kill();
        setTimeout(resolve, 3000).unref();
      }),
  };
}

const REPO = "/repos/SENAI4LIFE/RemoteIFES";
const ARQUIVOS = { ci: "ci.yml", android: "android.yml", ios: "ios.yml", pages: "pages.yml", console: "console-release.yml" };
const NOMES = { ci: "CI", android: "Android APK", ios: "iOS app", pages: "Pages", console: "Console release" };

function servidorGitHub() {
  const agora = Date.now();
  const iso = (minutosAtras) => new Date(agora - minutosAtras * 60_000).toISOString();
  const sha = (n) => crypto.createHash("sha1").update(String(n)).digest("hex");
  const chamadas = [];
  let proximoId = 9900;
  const run = (id, chave, numero, status, conclusao, minutos, titulo, evento = "push", ramo = "main") => ({
    id, name: NOMES[chave], path: `.github/workflows/${ARQUIVOS[chave]}`, display_title: titulo, status, conclusion: conclusao,
    head_sha: sha(id), head_branch: ramo, run_number: numero, run_attempt: 1, event: evento,
    created_at: iso(minutos), updated_at: iso(Math.max(0, minutos - 6)), run_started_at: iso(minutos),
    html_url: `https://github.com/SENAI4LIFE/RemoteIFES/actions/runs/${id}`,
  });
  const runs = {
    ci: [
      run(9102, "ci", 814, "in_progress", null, 4, "Install the Android smoke APK with a streamed install"),
      run(9101, "ci", 813, "completed", "failure", 70, "Limit, queue and group toast notifications"),
      run(9100, "ci", 812, "completed", "success", 190, "Open the Operations Console browser reliably"),
    ],
    android: [run(9201, "android", 44, "completed", "success", 300, "Android APK", "workflow_dispatch")],
    ios: [run(9301, "ios", 12, "completed", "success", 1500, "iOS app", "workflow_dispatch")],
    pages: [run(9401, "pages", 96, "completed", "success", 185, "Pages"), run(9400, "pages", 95, "completed", "skipped", 65, "Pages")],
    console: [run(9501, "console", 7, "completed", "success", 4000, "console-v1.0.0", "push", "console-v1.0.0")],
  };
  const jobs = {
    9101: [
      job(1, "Select checks", "completed", "success", ["Set up job", "Select jobs for the changed files"]),
      job(2, "Browser E2E (ubuntu-latest, chromium, 1/4)", "completed", "success", ["Set up job", "npx playwright test"]),
      job(3, "Android / APK build and inspection", "completed", "success", ["npm ci", "npm run build-android"]),
      job(4, "Android / Native smoke (API 36)", "completed", "failure", ["Enable KVM on the disposable runner", "Run reactivecircus/android-emulator-runner"], 1),
      job(5, "CI result", "completed", "failure", ["Verify every selected job passed"], 0),
    ],
    9102: [
      job(6, "Select checks", "completed", "success", ["Set up job", "Select jobs for the changed files"]),
      job(7, "Android / Native smoke (API 36)", "in_progress", null, ["Enable KVM on the disposable runner", "Run reactivecircus/android-emulator-runner"]),
    ],
  };
  const artefatos = {
    9201: [
      { id: 77001, name: "android-validation-apks", size_in_bytes: 2048, expired: false, expires_at: iso(-7 * 1440), created_at: iso(300), digest: `sha256:${sha("apks")}${sha("apks").slice(0, 24)}` },
      { id: 77002, name: "android-runtime-api-36", size_in_bytes: 1024, expired: false, expires_at: iso(-7 * 1440), created_at: iso(290) },
    ],
    9101: [{ id: 77003, name: "playwright-report-ubuntu-latest-chromium-1", size_in_bytes: 512, expired: true, expires_at: iso(60), created_at: iso(70) }],
  };
  function job(id, nome, status, conclusao, etapas, falha = -1) {
    return {
      id, name: nome, status, conclusion: conclusao, started_at: iso(10), completed_at: status === "completed" ? iso(5) : null, html_url: `https://github.com/SENAI4LIFE/RemoteIFES/actions/runs/0/job/${id}`,
      steps: etapas.map((n, i) => ({ number: i + 1, name: n, status: status === "completed" || i < etapas.length - 1 ? "completed" : "in_progress", conclusion: i === falha ? "failure" : status === "completed" || i < etapas.length - 1 ? "success" : null })),
    };
  }
  const todos = () => Object.values(runs).flat();
  const responder = (res, status, corpo, cabecalhos = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "x-ratelimit-remaining": "4987", "x-ratelimit-reset": String(Math.round(agora / 1000) + 3600), ...cabecalhos });
    res.end(corpo === undefined ? "" : JSON.stringify(corpo));
  };
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let corpo = "";
    req.on("data", (d) => (corpo += d));
    req.on("end", () => {
      chamadas.push({ metodo: req.method, caminho: url.pathname, corpo, autorizado: !!req.headers.authorization });
      if (!url.pathname.startsWith("/blob/") && !req.headers.authorization) return responder(res, 401, { message: "Requires authentication" });
      const p = url.pathname;
      let m;
      if (req.method === "GET" && p === REPO) return responder(res, 200, { full_name: "SENAI4LIFE/RemoteIFES", private: false }, { "x-oauth-scopes": "" });
      if (req.method === "GET" && p === `${REPO}/actions/workflows`) return responder(res, 200, { total_count: 7, workflows: [] });
      if (req.method === "GET" && (m = /^\/repos\/SENAI4LIFE\/RemoteIFES\/actions\/workflows\/([a-z-]+\.yml)\/runs$/.exec(p))) {
        const chave = Object.keys(ARQUIVOS).find((k) => ARQUIVOS[k] === m[1]);
        let lista = runs[chave] || [];
        if (url.searchParams.get("event")) lista = lista.filter((r) => r.event === url.searchParams.get("event"));
        const criado = (url.searchParams.get("created") || "").replace(/^>=/, "");
        if (criado) lista = lista.filter((r) => Date.parse(r.created_at) >= Date.parse(criado));
        return responder(res, 200, { total_count: lista.length, workflow_runs: lista.slice(0, Number(url.searchParams.get("per_page") || 30)) });
      }
      if (req.method === "POST" && (m = /^\/repos\/SENAI4LIFE\/RemoteIFES\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(p))) {
        const chave = Object.keys(ARQUIVOS).find((k) => ARQUIVOS[k] === m[1]);
        const novo = run(++proximoId, chave, 900 + proximoId - 9900, "queued", null, 0, NOMES[chave], "workflow_dispatch");
        novo.created_at = new Date().toISOString();
        runs[chave].unshift(novo);
        jobs[novo.id] = [job(proximoId * 10, "Preparar", "queued", null, ["Set up job"])];
        if (JSON.parse(corpo || "{}").return_run_details) return responder(res, 200, { workflow_run_id: novo.id, run_url: `${REPO}/actions/runs/${novo.id}`, html_url: novo.html_url });
        return responder(res, 204);
      }
      if ((m = /^\/repos\/SENAI4LIFE\/RemoteIFES\/actions\/runs\/(\d+)(\/[a-z-]+)?$/.exec(p))) {
        const alvo = todos().find((r) => r.id === Number(m[1]));
        if (!alvo) return responder(res, 404, { message: "Not Found" });
        if (req.method === "GET" && !m[2]) return responder(res, 200, alvo);
        if (req.method === "GET" && m[2] === "/jobs") return responder(res, 200, { total_count: (jobs[alvo.id] || []).length, jobs: jobs[alvo.id] || [] });
        if (req.method === "GET" && m[2] === "/artifacts") return responder(res, 200, { total_count: (artefatos[alvo.id] || []).length, artifacts: artefatos[alvo.id] || [] });
        if (req.method === "POST" && (m[2] === "/rerun-failed-jobs" || m[2] === "/rerun")) {
          Object.assign(alvo, { status: "queued", conclusion: null, run_attempt: alvo.run_attempt + 1 });
          return responder(res, 201, {});
        }
        if (req.method === "POST" && m[2] === "/cancel") {
          Object.assign(alvo, { status: "completed", conclusion: "cancelled" });
          return responder(res, 202, {});
        }
      }
      if (req.method === "GET" && (m = /^\/repos\/SENAI4LIFE\/RemoteIFES\/actions\/artifacts\/(\d+)\/zip$/.exec(p))) {
        res.writeHead(302, { Location: `http://127.0.0.1:${servidor.address().port}/blob/${m[1]}` });
        return res.end();
      }
      if (req.method === "GET" && (m = /^\/blob\/(\d+)$/.exec(p))) {
        const meta = Object.values(artefatos).flat().find((a) => a.id === Number(m[1]));
        res.writeHead(200, { "Content-Type": "application/zip" });
        return res.end(Buffer.alloc(meta ? meta.size_in_bytes : 0, 0x50));
      }
      responder(res, 404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${servidor.address().port}`,
        chamadas,
        runs,
        concluir(id, conclusao) {
          const alvo = todos().find((r) => r.id === id);
          if (alvo) Object.assign(alvo, { status: "completed", conclusion: conclusao });
        },
        fechar: () => new Promise((r) => servidor.close(() => r())),
      });
    });
  });
}

module.exports = { prepararAmbiente, limparAmbiente, subirConsole, criarOperador, gravarSegredoDeInstalacao, servidorGitHub, portaLivre, VERSAO_CONSOLE };
