// Ensaio de carga do servidor central: sobe uma instância isolada, conecta N ESP32
// simulados pelo protocolo real (credencial por dispositivo) e mede o custo da operação.
// Nunca toca no banco de produção — usa um diretório temporário descartado ao final.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const WebSocket = require("ws");

const SALAS = numero(argumento("--salas"), 86, 1, 500);
const MINUTOS = numero(argumento("--minutos"), 2, 1, 120);
const NAVEGADORES = numero(argumento("--navegadores"), 4, 0, 50);
const TELEMETRIA_MS = numero(argumento("--telemetria-ms"), 10000, 1000, 600000);
const SENHA = "carga-remoteifes-senha-temporaria";

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function numero(valor, padrao, min, max) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : padrao;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, ms, passo = 200) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await dormir(passo);
  }
  return false;
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function criarEsp(base, sala, credencial) {
  const esp = { sala, aberto: false, conexoes: 0, comandos: 0, ws: null, timer: null, parado: false };
  esp.telemetria = () => {
    if (!esp.ws || esp.ws.readyState !== WebSocket.OPEN) return;
    esp.ws.send(
      JSON.stringify({
        tipo: "telemetria",
        temp: Math.round((23 + Math.random() * 2) * 10) / 10,
        hum: 55,
        rssi: -60,
        modo: "operation",
        ligado: !!esp.ligado,
        fw: "carga",
      })
    );
  };
  esp.conectar = () => {
    if (esp.parado) return;
    const ws = new WebSocket(`${base.ws}/ws/dispositivo`, {
      headers: { "x-device-id": credencial.deviceId, "x-device-secret": credencial.segredo },
    });
    esp.ws = ws;
    ws.on("open", () => {
      esp.aberto = true;
      esp.conexoes += 1;
      esp.telemetria();
      esp.timer = setInterval(esp.telemetria, TELEMETRIA_MS);
      esp.timer.unref();
    });
    ws.on("message", (dados) => {
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch {
        return;
      }
      if (msg && msg.tipo === "send_known_state") {
        esp.comandos += 1;
        esp.ligado = msg.power === true;
        setTimeout(esp.telemetria, 30).unref();
      }
    });
    ws.on("close", () => {
      esp.aberto = false;
      if (esp.timer) clearInterval(esp.timer);
      if (!esp.parado) setTimeout(esp.conectar, 5000).unref();
    });
    ws.on("error", () => {
      try {
        ws.close();
      } catch {}
    });
  };
  esp.parar = () => {
    esp.parado = true;
    if (esp.timer) clearInterval(esp.timer);
    try {
      if (esp.ws) esp.ws.close();
    } catch {}
  };
  return esp;
}

async function main() {
  const porta = await portaLivre();
  const base = { http: `http://127.0.0.1:${porta}`, ws: `ws://127.0.0.1:${porta}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-carga-"));
  const servidor = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORTA: String(porta),
      BIND_ADDR: "127.0.0.1",
      NODE_ENV: "development",
      SERVIR_FRONTEND: "false",
      REMOTEIFES_DATA_DIR: dir,
      SENHA_ADMIN_INICIAL: SENHA,
      BACKUP_AUTOMATICO: "false",
    },
  });
  let erros = "";
  servidor.stderr.on("data", (d) => {
    erros += d.toString();
  });

  const chamar = async (metodo, rota, corpo, token) => {
    const inicio = process.hrtime.bigint();
    const resp = await fetch(`${base.http}${rota}`, {
      method: metodo,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    let json = null;
    try {
      json = await resp.json();
    } catch {}
    return { status: resp.status, corpo: json, ms: Number(process.hrtime.bigint() - inicio) / 1e6 };
  };

  try {
    const subiu = await ate(async () => {
      try {
        return (await (await fetch(`${base.http}/health`)).json()).ok === true;
      } catch {
        return false;
      }
    }, 40000);
    if (!subiu) throw new Error(`o servidor de ensaio não respondeu em /health. ${erros.slice(0, 400)}`);

    const login = await chamar("POST", "/login", { usuario: "superadmin", senha: SENHA });
    const token = login.corpo && login.corpo.token;
    if (!token) throw new Error(`não foi possível autenticar no servidor de ensaio (${login.status})`);

    const listagem = await chamar("GET", "/salas", null, token);
    const disponiveis = (Array.isArray(listagem.corpo) ? listagem.corpo : listagem.corpo.salas).map((s) => s.sala);
    const salas = disponiveis.slice(0, SALAS);
    if (salas.length < SALAS) console.log(`Aviso: o banco tem ${disponiveis.length} salas; o ensaio usará todas elas.`);

    process.stdout.write(`Provisionando credenciais para ${salas.length} salas... `);
    const credenciais = {};
    for (const sala of salas) {
      const r = await chamar("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {}, token);
      if (r.status !== 200 || !r.corpo || !r.corpo.segredo) throw new Error(`falha ao provisionar ${sala} (${r.status})`);
      credenciais[sala] = r.corpo;
      await chamar("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 1 }, token);
    }
    console.log("ok");

    const navegadores = [];
    for (let i = 0; i < NAVEGADORES; i += 1) {
      const ws = new WebSocket(`${base.ws}/ws`, [token]);
      const nav = { ws, mensagens: 0, bytes: 0 };
      ws.on("message", (d) => {
        nav.mensagens += 1;
        nav.bytes += d.length;
      });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ tipo: "observar", sala: salas[i % salas.length] }));
      navegadores.push(nav);
    }

    process.stdout.write(`Conectando ${salas.length} ESP32 simulados... `);
    const esps = salas.map((sala) => criarEsp(base, sala, credenciais[sala]));
    const inicioConexao = Date.now();
    esps.forEach((esp, i) => setTimeout(() => esp.conectar(), i * 20).unref());
    const conectaram = await ate(async () => esps.every((e) => e.aberto), 90000, 250);
    const msConexao = Date.now() - inicioConexao;
    console.log(conectaram ? `ok em ${(msConexao / 1000).toFixed(1)} s` : "INCOMPLETO");

    const marco = { mensagens: navegadores.map((n) => n.mensagens), bytes: navegadores.map((n) => n.bytes) };
    const latencias = [];
    const amostra = setInterval(async () => {
      const r = await chamar("GET", "/salas", null, token);
      latencias.push(r.ms);
    }, 5000);
    amostra.unref();

    let comandosOk = 0;
    let comandosFalha = 0;
    const comandos = setInterval(async () => {
      const sala = salas[Math.floor(Math.random() * salas.length)];
      const esp = esps.find((e) => e.sala === sala);
      const antes = esp ? esp.comandos : 0;
      const r = await chamar("POST", "/comando", { sala, cmd: "ligar" }, token);
      if (r.status === 200 && (await ate(async () => esp && esp.comandos > antes, 5000, 50))) comandosOk += 1;
      else comandosFalha += 1;
    }, 6000);
    comandos.unref();

    console.log(`Ensaio em andamento por ${MINUTOS} min...`);
    await dormir(MINUTOS * 60000);
    clearInterval(amostra);
    clearInterval(comandos);

    const monitoramento = await chamar("GET", "/admin/monitoramento", null, token);
    const servico = monitoramento.corpo && monitoramento.corpo.monitoramento && monitoramento.corpo.monitoramento.servico;
    const segundos = MINUTOS * 60;
    latencias.sort((a, b) => a - b);
    const finais = (await chamar("GET", "/salas", null, token)).corpo;
    const listaFinal = Array.isArray(finais) ? finais : (finais && finais.salas) || [];
    const online = listaFinal.filter((s) => s.online).length;

    console.log("\n--- Resultado do ensaio de carga ---");
    console.log(`ESP32 simulados............ ${salas.length} (telemetria a cada ${TELEMETRIA_MS / 1000} s)`);
    console.log(`Conexões abertas ao final.. ${esps.filter((e) => e.aberto).length}`);
    console.log(`Salas online no banco...... ${online || "n/d"}`);
    console.log(`Reconexões não solicitadas. ${esps.reduce((a, e) => a + (e.conexoes - 1), 0)}`);
    console.log(`Comandos entregues......... ${comandosOk} ok / ${comandosFalha} falha`);
    if (latencias.length) {
      console.log(
        `Latência de GET /salas..... p50 ${latencias[Math.floor(latencias.length / 2)].toFixed(0)} ms / ` +
          `máx ${latencias[latencias.length - 1].toFixed(0)} ms`
      );
    }
    navegadores.forEach((nav, i) => {
      const msgs = nav.mensagens - marco.mensagens[i];
      console.log(
        `Navegador ${i + 1}................ ${(msgs / segundos).toFixed(1)} msg/s, ` +
          `${((nav.bytes - marco.bytes[i]) / 1024 / segundos).toFixed(1)} kB/s`
      );
    });
    if (servico) {
      console.log(`Memória do servidor........ ${servico.memoriaRssMB} MB (uptime ${servico.uptimeSegundos} s)`);
      console.log(`Carga média do host (1min). ${servico.cargaMedia1min}`);
    }
    const erroCritico = /uncaught-exception|unhandled-rejection/.test(erros);
    console.log(`Exceções não tratadas...... ${erroCritico ? "SIM (ver log abaixo)" : "nenhuma"}`);
    if (erroCritico) console.log(erros.slice(-1500));

    navegadores.forEach((n) => n.ws.close());
    esps.forEach((e) => e.parar());
    await dormir(300);
  } finally {
    servidor.kill();
    await dormir(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((erro) => {
  console.error(`Ensaio interrompido: ${erro.message}`);
  process.exit(1);
});
