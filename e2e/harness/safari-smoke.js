// Smoke do frontend no Safari nativo (macOS) ou no Safari do iOS Simulator, via safaridriver (WebDriver).
// Usa os mesmos servidores do harness Playwright; não depende de pacote npm.
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const API_PORT = Number(process.env.E2E_API_PORT || 8791);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 8790);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const DRIVER_PORT = Number(process.env.SAFARIDRIVER_PORT || 4444);
const DRIVER_URL = `http://127.0.0.1:${DRIVER_PORT}`;
const IOS = process.env.SAFARI_PLATFORM === "ios";
const SALA = "A-108";
const CONTA = { usuario: process.env.SAFARI_TEST_USER || "superadmin", senha: process.env.SAFARI_TEST_PASSWORD || "admin" };

const filhos = [];
const relatorio = { plataforma: IOS ? "ios-simulator" : "macos", passos: [], erros: [] };

function iniciar(comando, args, env) {
  const filho = spawn(comando, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  filho.stdout.on("data", (dados) => process.stderr.write(`[${path.basename(comando)}] ${dados}`));
  filho.stderr.on("data", (dados) => process.stderr.write(`[${path.basename(comando)}] ${dados}`));
  filho.on("error", (erro) => relatorio.erros.push(`${path.basename(comando)}: ${erro.message}`));
  filhos.push(filho);
  return filho;
}

async function esperarHttp(url, tentativas = 120) {
  for (let i = 0; i < tentativas; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch (erro) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`${url} não respondeu`);
}

async function subirServidores() {
  let apiPronta = false;
  try {
    apiPronta = (await fetch(`${API_URL}/health`)).ok;
  } catch (erro) {}
  if (!apiPronta) {
    iniciar(process.execPath, [path.join(__dirname, "api-server.js")], { E2E_API_PORT: String(API_PORT) });
    iniciar(process.execPath, [path.join(__dirname, "static-server.js")], { E2E_WEB_PORT: String(WEB_PORT) });
  }
  await esperarHttp(`${API_URL}/health`);
  await esperarHttp(`${WEB_URL}/`);
}

// O safaridriver não espera um simulador frio inicializar e fala com o Safari do iPhone pelo Simulator.app.
function prepararSimulador() {
  const simctl = (...args) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
  const nomeDesejado = process.env.SAFARI_IOS_DEVICE;
  const candidatos = Object.entries(JSON.parse(simctl("list", "devices", "available", "-j")).devices)
    .filter(([runtime]) => /iOS/.test(runtime))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap(([runtime, aparelhos]) => aparelhos.filter((d) => d.isAvailable && /^iPhone/.test(d.name)).map((d) => ({ ...d, runtime })));
  const aparelho = nomeDesejado ? candidatos.find((d) => d.name === nomeDesejado) : candidatos[0];
  if (!aparelho) throw new Error(nomeDesejado ? `simulador "${nomeDesejado}" indisponível` : "nenhum iPhone disponível no iOS Simulator");
  if (aparelho.state !== "Booted") simctl("boot", aparelho.udid);
  simctl("bootstatus", aparelho.udid, "-b");
  execFileSync("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", aparelho.udid]);
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      simctl("launch", aparelho.udid, "com.apple.mobilesafari");
      break;
    } catch (erro) {
      if (tentativa >= 6) throw erro;
      execFileSync("sleep", ["5"]);
    }
  }
  simctl("terminate", aparelho.udid, "com.apple.mobilesafari");
  relatorio.simulador = { nome: aparelho.name, runtime: aparelho.runtime, udid: aparelho.udid };
  return aparelho.udid;
}

async function wd(metodo, caminho, corpo) {
  const resposta = await fetch(`${DRIVER_URL}${caminho}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const json = await resposta.json();
  if (!resposta.ok) throw new Error(`WebDriver ${metodo} ${caminho}: ${json.value && json.value.error} — ${json.value && json.value.message}`);
  return json.value;
}

function sessao(id) {
  const raiz = `/session/${id}`;
  const executar = (script, ...args) => wd("POST", `${raiz}/execute/sync`, { script, args });
  const elemento = async (seletor) => {
    const el = await wd("POST", `${raiz}/element`, { using: "css selector", value: seletor });
    return el["element-6066-11e4-a52e-4f735466cecf"];
  };
  return {
    ir: (url) => wd("POST", `${raiz}/url`, { url }),
    executar,
    clicar: async (seletor) => {
      if (IOS && (await executar("const ativo = document.activeElement; if (!ativo || ativo === document.body) return false; ativo.blur(); return true;"))) {
        await new Promise((res) => setTimeout(res, 800));
      }
      relatorio.ultimoClique = await executar(`const el = document.querySelector(${JSON.stringify(seletor)}); const r = el.getBoundingClientRect(); const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { seletor: ${JSON.stringify(seletor)}, retangulo: [r.left, r.top, r.width, r.height].map(Math.round), sobreposto: alvo && alvo !== el && !el.contains(alvo) ? alvo.tagName + "#" + alvo.id + "." + alvo.className : null };`);
      const el = await elemento(seletor);
      if (!IOS) return wd("POST", `${raiz}/element/${el}/click`, {});
      // No iOS Simulator o "Element Click" do safaridriver não gera o clique; um toque pela Actions API gera,
      // desde que o teclado (fora do DOM) não cubra o alvo — por isso o campo ativo é desfocado antes.
      const origem = { "element-6066-11e4-a52e-4f735466cecf": el };
      await wd("POST", `${raiz}/actions`, { actions: [{ type: "pointer", id: "dedo", parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, origin: origem, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 60 }, { type: "pointerUp", button: 0 }] }] });
      await wd("DELETE", `${raiz}/actions`);
    },
    digitar: async (seletor, texto) => {
      if (!IOS) return wd("POST", `${raiz}/element/${await elemento(seletor)}/value`, { text: texto });
      // No iOS Simulator o "Element Send Keys" do safaridriver não digita; o valor é definido no DOM com os eventos de entrada.
      return executar(`const el = document.querySelector(${JSON.stringify(seletor)}); el.focus(); el.value = ${JSON.stringify(texto)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));`);
    },
    async esperar(descricao, script, tempoMs = 15000) {
      const fim = Date.now() + tempoMs;
      let ultimo;
      while (Date.now() < fim) {
        ultimo = await executar(script);
        if (ultimo === true) return;
        await new Promise((res) => setTimeout(res, 250));
      }
      relatorio.diagnostico = await executar(ESTADO_DA_PAGINA);
      throw new Error(`${descricao}: condição não satisfeita em ${tempoMs}ms (último valor: ${JSON.stringify(ultimo)})`);
    },
    encerrar: () => wd("DELETE", raiz),
  };
}

const visivel = (seletor) => `const el = document.querySelector(${JSON.stringify(seletor)}); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";`;
const oculto = (seletor) => `const el = document.querySelector(${JSON.stringify(seletor)}); return !el || el.getClientRects().length === 0;`;
const texto = (seletor, esperado) => `const el = document.querySelector(${JSON.stringify(seletor)}); return !!el && el.textContent.trim() === ${JSON.stringify(esperado)};`;
const ESTADO_DA_PAGINA = `const visiveis = Array.from(document.querySelectorAll("section[id^='screen-'], #mainApp, #navegador-incompativel")).filter((el) => el.getClientRects().length > 0).map((el) => el.id); const ativo = document.activeElement; const campos = Object.fromEntries(Array.from(document.querySelectorAll("#username, #password")).map((el) => [el.id, el.value.length])); const toasts = Array.from(document.querySelectorAll(".toast, [class*='toast']")).map((el) => el.textContent.trim()).filter(Boolean); return { hash: location.hash, visiveis, ativo: ativo ? ativo.tagName + "#" + ativo.id : null, rolagem: [scrollX, scrollY], campos, toasts, erros: window.__errosSmoke || null };`;
const SEM_ROLAGEM_HORIZONTAL = "return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;";
const COLETOR_DE_ERROS = `window.__errosSmoke = []; addEventListener("error", (e) => window.__errosSmoke.push(String(e.message))); addEventListener("unhandledrejection", (e) => window.__errosSmoke.push(String(e.reason)));`;

async function passo(nome, fn) {
  const inicio = Date.now();
  try {
    await fn();
    relatorio.passos.push({ nome, ok: true, ms: Date.now() - inicio });
  } catch (erro) {
    relatorio.passos.push({ nome, ok: false, ms: Date.now() - inicio, erro: erro.message });
    throw erro;
  }
}

async function fluxo(s) {
  await passo("carrega o portal com o servidor configurado", async () => {
    await s.ir(`${WEB_URL}/`);
    await s.executar(`localStorage.setItem("remoteifes_server_url", ${JSON.stringify(API_URL)});`);
    await s.ir(`${WEB_URL}/`);
    await s.esperar("portal visível", visivel("#screen-portal"), 20000);
    await s.esperar("tela de servidor oculta", oculto("#screen-server-status"));
    await s.esperar("sem aviso de navegador desatualizado", oculto("#navegador-incompativel"));
    await s.executar(COLETOR_DE_ERROS);
    relatorio.userAgent = await s.executar("return navigator.userAgent;");
    relatorio.viewport = await s.executar("return { largura: innerWidth, altura: innerHeight };");
    if (!(await s.executar(SEM_ROLAGEM_HORIZONTAL))) throw new Error("o portal tem rolagem horizontal");
  });

  await passo("faz login pela interface", async () => {
    await s.clicar('.portal-option[data-tipo="admin"]');
    await s.esperar("tela de login", visivel("#screen-login"));
    await s.digitar("#username", CONTA.usuario);
    await s.digitar("#password", CONTA.senha);
    await s.clicar("#loginForm button[type=submit]");
    await s.esperar("app principal", visivel("#mainApp"));
    await s.esperar("aba de salas", visivel('.tab-btn[data-tab="salas"]'));
    if (!(await s.executar(SEM_ROLAGEM_HORIZONTAL))) throw new Error("o app principal tem rolagem horizontal");
  });

  await passo("abre a sala com ESP32 simulado e recebe o estado por WebSocket", async () => {
    const reset = await fetch(`${API_URL}/__e2e/resetar-dispositivo`, { method: "POST" });
    if (!reset.ok) throw new Error(`não foi possível preparar o dispositivo E2E (HTTP ${reset.status})`);
    await s.executar(`location.hash = ${JSON.stringify(`#/sala/${SALA}`)};`);
    await s.esperar("painel da sala", visivel("#screen-panel"));
    await s.esperar("nome da sala", `return document.querySelector("#panelRoomName").textContent.includes(${JSON.stringify(SALA)});`);
    await s.esperar("dispositivo online", texto("#conexaoValue", "online"), 20000);
    await s.esperar("modo Off", texto("#modoValue", "Off"));
    if (!(await s.executar(SEM_ROLAGEM_HORIZONTAL))) throw new Error("o painel da sala tem rolagem horizontal");
  });

  await passo("liga e desliga o ar-condicionado", async () => {
    await s.clicar("#btnPower");
    await s.esperar("modo Cool", texto("#modoValue", "Cool"));
    await s.esperar("status ligado", texto("#statusValue", "ligado"));
    await s.clicar("#btnPower");
    await s.esperar("modo Off", texto("#modoValue", "Off"));
    await s.esperar("status desligado", texto("#statusValue", "desligado"));
  });

  await passo("navega até o status da administração", async () => {
    await s.executar('location.hash = "#/admin/status";');
    await s.esperar("sub-aba de status", visivel("#adminSub-status"));
    if (!(await s.executar(SEM_ROLAGEM_HORIZONTAL))) throw new Error("a administração tem rolagem horizontal");
  });

  await passo("sai da conta e volta ao portal", async () => {
    await s.clicar("#accountMenuBtn");
    await s.esperar("menu da conta", visivel("#accountMenu"));
    await s.clicar('[data-account-action="logout"]');
    await s.esperar("portal visível", visivel("#screen-portal"));
    await s.esperar("app principal oculto", oculto("#mainApp"));
  });

  await passo("nenhum erro de JavaScript durante o fluxo", async () => {
    const erros = await s.executar("return window.__errosSmoke || [];");
    if (erros.length) throw new Error(erros.join("; "));
  });
}

async function main() {
  await subirServidores();
  iniciar("safaridriver", ["-p", String(DRIVER_PORT), "--diagnose"]);
  await esperarHttp(`${DRIVER_URL}/status`, 60);

  const capacidades = { browserName: "Safari" };
  if (IOS) Object.assign(capacidades, { platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": prepararSimulador() });
  let criada;
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      criada = await wd("POST", "/session", { capabilities: { alwaysMatch: capacidades } });
      break;
    } catch (erro) {
      (relatorio.sessoesFalhas = relatorio.sessoesFalhas || []).push(erro.message);
      if (!IOS || tentativa >= 3) throw erro;
      await new Promise((res) => setTimeout(res, 10000));
    }
  }
  relatorio.capacidades = criada.capabilities;
  const s = sessao(criada.sessionId);
  try {
    await fluxo(s);
  } finally {
    await s.encerrar().catch(() => {});
  }
}

main()
  .catch((erro) => {
    relatorio.erros.push(erro.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const url of [API_URL, WEB_URL]) {
      await fetch(`${url}/__e2e/encerrar`, { method: "POST" }).catch(() => {});
    }
    for (const filho of filhos) filho.kill();
    console.log(JSON.stringify(relatorio, null, 2));
    process.exit(process.exitCode || 0);
  });
