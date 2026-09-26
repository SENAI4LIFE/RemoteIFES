#!/usr/bin/env node
// Captures the README screenshots (docs/readme-assets/screenshots/<name>.png) from the e2e
// harness: temporary database, simulated ESP32 boards and test accounts only.
//
//   cd e2e && npm ci                          # once: Playwright comes from the e2e dependencies
//   node docs/readme-assets/src/capturar.js   # every capture
//   node docs/readme-assets/src/capturar.js floorplan schedule
//
// The harness runs on ports 8891 (API) and 8890 (static), apart from the e2e defaults.
// CAPTURA_SAIDA=<folder> writes the PNGs elsewhere, for a trial run; CAPTURA_BRUTO=<folder> also
// saves each uncropped page there, for choosing a crop.
// The data is seeded here through the public API and the harness's own test endpoints; nothing
// is written into the database directly. Review every PNG before committing: no password, token,
// device secret, private address, host name or personal path may appear.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..", "..", "..");
const SAIDA = path.resolve(process.env.CAPTURA_SAIDA || path.join(__dirname, "..", "screenshots"));
const E2E = path.join(RAIZ, "e2e");
const { chromium } = require(require.resolve("@playwright/test", { paths: [E2E] }));
const WebSocket = require(require.resolve("ws", { paths: [E2E] }));

const PORTA_API = Number(process.env.CAPTURA_API_PORT || 8891);
const PORTA_WEB = Number(process.env.CAPTURA_WEB_PORT || 8890);
const API = `http://127.0.0.1:${PORTA_API}`;
const WEB = `http://127.0.0.1:${PORTA_WEB}`;
const BRUTO = process.env.CAPTURA_BRUTO || "";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- harness and API

const processos = [];

function subir(script, env) {
  const filho = spawn(process.execPath, [path.join(E2E, "harness", script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"],
  });
  processos.push(filho);
}

async function aguardar(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await esperar(500);
  }
  throw new Error(`no answer from ${url}`);
}

async function encerrarHarness() {
  // The harness removes its temporary directory on /__e2e/encerrar; killing it would leave it.
  for (const base of [API, WEB]) await fetch(`${base}/__e2e/encerrar`, { method: "POST" }).catch(() => {});
  await esperar(800);
  for (const p of processos) if (p.exitCode === null) p.kill();
}

async function api(token, metodo, rota, corpo) {
  const resp = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resp.text();
  if (!resp.ok) throw new Error(`${metodo} ${rota}: HTTP ${resp.status} ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

async function entrar(usuario, senha) {
  const resp = await api(null, "POST", "/login", { usuario, senha });
  if (!resp || !resp.token) throw new Error(`login failed for ${usuario}`);
  return resp.token;
}

function agoraBrasilia(deltaMin = 0) {
  const d = new Date(Date.now() + deltaMin * 60000);
  const data = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
  const hora = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { data, hora };
}

// ---------------------------------------------------------------- simulated boards

// A board speaking the device protocol the way firmware 4.3.0 does: it echoes the state version,
// reports the last IR command and the failsafe record, and answers role and clone-mode changes.
// It authenticates with the room's own credential, or by MAC when it has none.
function placa({ sala, mac, fw = "4.3.0", temp, hum, rssi, credencial = null }) {
  let ws = null;
  let parado = false;
  let modo = "operation";
  let versao = null;
  let ligado = null;
  let ultimoComando = null;
  let failsafe = null;

  const enviar = (msg) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const camposFailsafe = () => ({
    failsafeConfigurado: !!failsafe,
    failsafePulsos: failsafe ? failsafe.raw.length : 0,
    failsafeCarrierHz: failsafe ? failsafe.carrierHz : 0,
    failsafeProtocolRecordId: failsafe ? failsafe.protocolRecordId : -1,
    failsafeLatched: false,
    ...(versao === null ? {} : { versao }),
  });
  const telemetria = () =>
    enviar({
      tipo: "telemetria", rssi, modo, fw, temp, hum, ...camposFailsafe(),
      ...(ligado === null ? {} : { ligado }),
      ...(ultimoComando ? { ultimoComando: { ...ultimoComando, haQuantoTempoMs: 4000 } } : {}),
    });

  function conectar() {
    if (parado) return;
    const headers = { "x-device-mac": mac };
    if (credencial) Object.assign(headers, { "x-device-id": credencial.deviceId, "x-device-secret": credencial.segredo });
    else headers["x-device-sala"] = sala;
    ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/dispositivo`, { headers });
    ws.on("open", () => {
      enviar({ tipo: "info", fw, ...camposFailsafe() });
      telemetria();
    });
    ws.on("message", (dados) => {
      let msg;
      try {
        msg = JSON.parse(String(dados));
      } catch {
        return;
      }
      if (msg.tipo === "send_known_state" && Number.isInteger(msg.protocol) && msg.protocol >= 0) {
        if (Number.isInteger(msg.versao)) versao = msg.versao;
        ligado = msg.power === true;
        ultimoComando = { tipo: "known_state", protocol: msg.protocol, temp: msg.temp, power: !!msg.power, turbo: !!msg.turbo, swing: !!msg.swing };
        telemetria();
      } else if (msg.tipo === "failsafe_raw_set") {
        failsafe = { raw: msg.raw, carrierHz: msg.carrierHz, protocolRecordId: msg.protocolRecordId };
        enviar({ tipo: "failsafe_status", ...camposFailsafe() });
      } else if (msg.tipo === "failsafe_raw_clear") {
        failsafe = null;
        enviar({ tipo: "failsafe_status", ...camposFailsafe() });
      }
    });
    ws.on("close", () => !parado && setTimeout(conectar, 500));
    ws.on("error", () => {});
  }
  conectar();
  return { parar: () => { parado = true; if (ws) ws.close(); } };
}

// ---------------------------------------------------------------- seeded state

const PLACAS = [
  // room,   test MAC,             firmware, °C,   %,  dBm, credential
  ["A-110", "AA:BB:CC:E2:E2:10", "4.3.0", 24.2, 58, -61, true],
  ["A-109", "AA:BB:CC:E2:E2:09", "4.3.0", 25.1, 61, -66, true],
  ["A-107", "AA:BB:CC:E2:E2:07", "4.2.0", 23.4, 54, -57, true],
  ["A-106", "AA:BB:CC:E2:E2:06", "4.3.0", 24.6, 56, -63, false],
  ["A-104", "AA:BB:CC:E2:E2:04", "4.3.0", 26.0, 63, -71, false],
];

async function semear() {
  const senha = crypto.randomBytes(18).toString("base64url");
  let su = await entrar("superadmin", "admin");
  // A configured installation: without this the default-password notice covers the screens.
  await api(su, "PATCH", "/me/senha", { novaSenha: senha });
  su = await entrar("superadmin", senha);
  const admin = await entrar("e2e_admin", "e2e-admin-pass-123");
  const usuario = await entrar("e2e_user", "e2e-user-pass-123");

  const placas = [];
  for (const [sala, mac, fw, temp, hum, rssi, comCredencial] of PLACAS) {
    await api(su, "PATCH", `/admin/salas/${sala}/mac`, { mac });
    await api(su, "POST", `/admin/esp32/${sala}/protocolo-ir`, { protocolo: 15 });
    const credencial = comCredencial ? await api(su, "POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`) : null;
    placas.push(placa({ sala, mac, fw, temp, hum, rssi, credencial }));
  }
  await esperar(1500);

  // Rooms on: A-110 and A-106 by users, A-107 at 23 °C.
  await api(usuario, "POST", "/comando", { sala: "A-110", cmd: "ligar" });
  await api(admin, "POST", "/comando", { sala: "A-106", cmd: "ligar" });
  await api(admin, "POST", "/comando", { sala: "A-107", cmd: "ligar" });

  // A reservation in progress now (outlined on the floor plan).
  const agora = agoraBrasilia();
  const antes = agoraBrasilia(-50);
  const depois = agoraBrasilia(100);
  await api(admin, "POST", "/agendamentos", {
    sala: "A-109", data: agora.data, modo: "reserva", temperatura: 23,
    horaInicio: antes.data === agora.data ? antes.hora : "00:00",
    horaFim: depois.data === agora.data ? depois.hora : "23:59",
  });

  // A day of schedules for A-107 in the three modes, by two administrators.
  const dia = [
    [admin, { horaInicio: "07:00", horaFim: "08:50", temperatura: 23, modo: "ligar_completo" }],
    [su, { horaInicio: "09:20", horaFim: "11:20", temperatura: 24, modo: "ligar_intervalo", ligarInicio: "10:30", ligarFim: "11:20" }],
    [admin, { horaInicio: "13:00", horaFim: "14:50", temperatura: 23, modo: "reserva" }],
    [su, { horaInicio: "19:10", horaFim: "22:10", temperatura: 24, modo: "ligar_completo" }],
  ];
  for (const [token, ag] of dia) await api(token, "POST", "/agendamentos", { sala: "A-107", data: agora.data, ...ag });

  // Firmware 4.3.0 published: A-107 (4.2.0) and the harness board A-108 (4.0.0) can update.
  await api(null, "POST", "/__e2e/publicar-firmware?versao=4.3.0");

  // IR library: the harness board on A-108 is the official cloner. One captured protocol is
  // saved, gets a failsafe OFF and is applied to A-107; a new capture is left pending.
  await api(su, "PUT", "/admin/protocolos-ir/clonador", { sala: "A-108" });
  await esperar(400);
  await api(su, "POST", "/admin/protocolos-ir/clonador/modo-clone", { ativo: true });
  await esperar(400);
  const capturar = async (captura) => {
    await api(null, "POST", "/__e2e/capturar-ir", captura);
    await esperar(400);
    return (await api(su, "GET", "/admin/protocolos-ir")).capturas[0];
  };
  const liga = await capturar({ protocol: "COOLIX", protocolId: 15, hex: "0xB2BF40" });
  const protocolo = (await api(su, "POST", "/admin/protocolos-ir", { label: "Split COOLIX dos laboratórios", capturaId: liga.id })).protocolo;
  const desliga = await capturar({ isKnown: false, protocol: "UNKNOWN", hex: "0x0", raw: [4400, 4400, 550, 1600, 550, 550, 550, 1600, 550, 550, 550, 1600] });
  await api(su, "PUT", `/admin/protocolos-ir/${protocolo.id}/failsafe`, { capturaId: desliga.id });
  await api(su, "POST", `/admin/protocolos-ir/${protocolo.id}/aplicar/A-107`);
  await capturar({ protocol: "COOLIX", protocolId: 15, hex: "0xB2BF44" });

  // 26 hours of monitoring samples, from the harness's own history fixture.
  await api(null, "POST", "/__e2e/monitoramento-historico", { horas: 26 });
  await esperar(1500);

  return { tokens: { superadmin: su, admin, user: usuario }, placas };
}

// ---------------------------------------------------------------- captures

// Crop = union of the elements' boxes plus a margin, in CSS pixels.
async function caixaDe(page, seletores, margem = 12) {
  const caixas = [];
  for (const sel of seletores) {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`nothing to crop: ${sel}`);
    caixas.push(b);
  }
  const x0 = Math.min(...caixas.map((b) => b.x)) - margem;
  const y0 = Math.min(...caixas.map((b) => b.y)) - margem;
  const x1 = Math.max(...caixas.map((b) => b.x + b.width)) + margem;
  const y1 = Math.max(...caixas.map((b) => b.y + b.height)) + margem;
  return { x: Math.max(0, Math.floor(x0)), y: Math.max(0, Math.floor(y0)), width: Math.ceil(x1 - Math.max(0, x0)), height: Math.ceil(y1 - Math.max(0, y0)) };
}

const CAPTURAS = [
  {
    nome: "floorplan",
    conta: "admin",
    viewport: { width: 1100, height: 1200 },
    rota: "#/salas/planta/a-terreo",
    pronto: "#screen-floorplan .plan-wrap",
    recorte: (page) => caixaDe(page, ["#screen-floorplan .fp-legenda", "#screen-floorplan .plan-wrap", "#floorplanZoomControls"]),
    largura: 1600,
  },
  {
    nome: "schedule",
    conta: "admin",
    viewport: { width: 620, height: 2200 },
    rota: "#/agenda/A-107",
    pronto: "#agendaList li",
    recorte: (page) => caixaDe(page, ["#agendaList"]),
    largura: 790,
  },
  {
    nome: "schedule-grid",
    conta: "admin",
    viewport: { width: 620, height: 1600 },
    rota: `#/grade/A-107/${agoraBrasilia().data}`,
    pronto: "#gradeTabela tbody tr",
    recorte: (page) => caixaDe(page, ["#screen-grade .grade-legenda", "#screen-grade .grade-scroll"]),
    largura: 790,
  },
  {
    nome: "firmware-ota",
    conta: "superadmin",
    viewport: { width: 1280, height: 1400 },
    rota: "#/admin/esp32",
    pronto: '#esp32DeviceList li[data-sala="A-107"]',
    recorte: (page) => caixaDe(page, ['#esp32DeviceList li[data-sala="A-107"]']),
    largura: 1600,
  },
  {
    nome: "ir-protocols",
    conta: "superadmin",
    viewport: { width: 1280, height: 1400 },
    rota: "#/admin/protocolos",
    pronto: "#protocolosIrList li",
    preparar: (page) => page.selectOption("#protocolosIrDestinoSelect", "A-107"),
    recorte: (page) => caixaDe(page, ['section[aria-labelledby="protocolosIrClonadorTitulo"]', 'section[aria-labelledby="protocolosIrListaTitulo"]']),
    largura: 1600,
  },
  {
    nome: "system-monitoring",
    conta: "superadmin",
    viewport: { width: 1280, height: 1400 },
    rota: "#/admin/status/sistema",
    pronto: "#grEsp32 svg",
    recorte: (page) => caixaDe(page, ["#monGraficosBloco > summary", "#grEsp32", "#grFalhas"]),
    largura: 1600,
  },
];

async function capturar(navegador, estado, c) {
  const contexto = await navegador.newContext({
    viewport: c.viewport,
    deviceScaleFactor: 2,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  });
  await contexto.addInitScript(
    ([apiUrl, token]) => {
      try {
        localStorage.setItem("remoteifes_server_url", apiUrl);
        localStorage.setItem("remoteifes_token", token);
      } catch {}
    },
    [API, estado.tokens[c.conta]]
  );
  const page = await contexto.newPage();
  await page.goto(`${WEB}/${c.rota}`);
  await page.waitForSelector("#mainApp", { state: "visible", timeout: 20000 });
  await page.waitForSelector(c.pronto, { state: "visible", timeout: 20000 });
  if (c.preparar) await c.preparar(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
  if (BRUTO) await page.screenshot({ path: path.join(BRUTO, `${c.nome}.png`), fullPage: true });
  // The tab bar and the floating accessibility and help buttons are fixed to the viewport and
  // would float over the cropped area; they are not part of the screen being shown.
  await page.addStyleTag({ content: ".tabbar, .a11y-widget, .help-fab-widget { visibility: hidden !important; }" });
  const recorte = await c.recorte(page);
  const png = await page.screenshot({ clip: recorte, fullPage: true });
  await contexto.close();
  return acabamento(navegador, png, c.largura);
}

// Final finish shared by every capture: resized to 2x the README display width, 10 px corners
// and a 1 px #c8d1cb border at display size, transparent outside the corners.
async function acabamento(navegador, png, largura) {
  const page = await navegador.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  const url = await page.evaluate(
    async ({ dados, largura }) => {
      const bytes = Uint8Array.from(atob(dados), (c) => c.charCodeAt(0));
      const origem = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const altura = Math.round((origem.height * largura) / origem.width);
      const img = await createImageBitmap(origem, { resizeWidth: largura, resizeHeight: altura, resizeQuality: "high" });
      const canvas = document.createElement("canvas");
      canvas.width = largura;
      canvas.height = altura;
      const ctx = canvas.getContext("2d");
      const raio = 20;
      ctx.beginPath();
      ctx.roundRect(0, 0, largura, altura, raio);
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#c8d1cb";
      ctx.beginPath();
      ctx.roundRect(1, 1, largura - 2, altura - 2, raio - 1);
      ctx.stroke();
      return canvas.toDataURL("image/png");
    },
    { dados: png.toString("base64"), largura }
  );
  await page.close();
  return Buffer.from(url.split(",")[1], "base64");
}

// Lossless recompression when Pillow is available, as in compor.js.
function otimizar(arquivo) {
  try {
    execFileSync("python", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();im.save(sys.argv[1],optimize=True)", arquivo], { stdio: "ignore" });
  } catch {}
}

async function abrirNavegador() {
  const canais = process.env.COMPOR_CANAL ? [process.env.COMPOR_CANAL] : [undefined, "msedge", "chrome"];
  let ultimo;
  for (const channel of canais) {
    try {
      // Native date and time inputs follow the browser language, not the page locale.
      return await chromium.launch({ channel, args: ["--lang=pt-BR"] });
    } catch (erro) {
      ultimo = erro;
    }
  }
  throw ultimo;
}

async function main() {
  const pedidas = process.argv.slice(2);
  const lista = CAPTURAS.filter((c) => !pedidas.length || pedidas.includes(c.nome));
  if (!lista.length) throw new Error(`no capture matches: ${pedidas.join(", ")}`);

  subir("api-server.js", { E2E_API_PORT: String(PORTA_API) });
  subir("static-server.js", { E2E_WEB_PORT: String(PORTA_WEB) });
  await aguardar(`${API}/health`);
  await aguardar(WEB);

  const estado = await semear();
  const navegador = await abrirNavegador();
  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    for (const c of lista) {
      const arquivo = path.join(SAIDA, `${c.nome}.png`);
      fs.writeFileSync(arquivo, await capturar(navegador, estado, c));
      otimizar(arquivo);
      console.log(`${path.relative(RAIZ, arquivo)}  ${(fs.statSync(arquivo).size / 1024).toFixed(0)} KiB`);
    }
  } finally {
    await navegador.close();
    for (const p of estado.placas) p.parar();
  }
}

main()
  .catch((erro) => {
    console.error(erro.message || erro);
    process.exitCode = 1;
  })
  .finally(encerrarHarness);
