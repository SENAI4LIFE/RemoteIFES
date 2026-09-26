// Central server load test: starts an isolated instance, connects N simulated ESP32 boards over the
// real protocol (per-device credentials) and measures the operating cost. Never touches the
// production database: it uses a temporary directory removed at the end.
//
// The boards are the same protocol-level simulation the fault-injection tests and the soak use
// (test/support/bancada-dispositivos.js); the server runs as a real process
// (test/support/servidor-isolado.js).
const WebSocket = require("ws");
const { iniciarServidorIsolado } = require("./test/support/servidor-isolado");
const { Bancada } = require("./test/support/bancada-dispositivos");

const SALAS = numero(argumento("--salas"), 86, 1, 500);
const MINUTOS = numero(argumento("--minutos"), 2, 1, 120);
const NAVEGADORES = numero(argumento("--navegadores"), 4, 0, 50);
const TELEMETRIA_MS = numero(argumento("--telemetria-ms"), 10000, 1000, 600000);

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

async function main() {
  const servidor = await iniciarServidorIsolado();
  const bancada = new Bancada({ porta: servidor.porta });
  const chamar = servidor.api;

  try {
    const listagem = await chamar("GET", "/salas");
    const disponiveis = (Array.isArray(listagem.corpo) ? listagem.corpo : listagem.corpo.salas).map((s) => s.sala);
    const salas = disponiveis.slice(0, SALAS);
    if (salas.length < SALAS) console.log(`Aviso: o banco tem ${disponiveis.length} salas; o ensaio usará todas elas.`);

    process.stdout.write(`Provisionando credenciais para ${salas.length} salas... `);
    const credenciais = {};
    for (const sala of salas) {
      const r = await chamar("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {});
      if (r.status !== 200 || !r.corpo || !r.corpo.segredo) throw new Error(`falha ao provisionar ${sala} (${r.status})`);
      credenciais[sala] = { deviceId: r.corpo.deviceId, segredo: r.corpo.segredo };
      // Without a supported IR protocol a command has nothing to send to the board.
      const p = await chamar("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 });
      if (p.status !== 200) throw new Error(`falha ao definir o protocolo IR de ${sala} (${p.status})`);
    }
    console.log("ok");

    const navegadores = [];
    for (let i = 0; i < NAVEGADORES; i += 1) {
      const ws = new WebSocket(`ws://127.0.0.1:${servidor.porta}/ws`, [servidor.token]);
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
    const esps = salas.map((sala) => {
      const placa = bancada.placa({ credencial: credenciais[sala], sala, telemetriaMs: TELEMETRIA_MS, reconectar: { atrasoMs: 5000 } });
      placa.comandos = 0;
      placa.on("mensagem", (m) => {
        if (m.tipo === "send_known_state") placa.comandos += 1;
      });
      return placa;
    });
    const inicioConexao = Date.now();
    esps.forEach((esp, i) => bancada.depois(i * 20, () => esp.conectar().catch(() => {})));
    const conectaram = await ate(async () => esps.every((e) => e.aberta()), 90000, 250);
    const msConexao = Date.now() - inicioConexao;
    console.log(conectaram ? `ok em ${(msConexao / 1000).toFixed(1)} s` : "INCOMPLETO");

    const marco = { mensagens: navegadores.map((n) => n.mensagens), bytes: navegadores.map((n) => n.bytes) };
    const latencias = [];
    const amostra = setInterval(async () => {
      const r = await chamar("GET", "/salas");
      latencias.push(r.ms);
    }, 5000);
    amostra.unref();

    let comandosOk = 0;
    let comandosFalha = 0;
    const comandos = setInterval(async () => {
      const sala = salas[Math.floor(Math.random() * salas.length)];
      const esp = esps.find((e) => e.sala === sala);
      const antes = esp ? esp.comandos : 0;
      const r = await chamar("POST", "/comando", { sala, cmd: "ligar" });
      if (r.status === 200 && (await ate(async () => esp && esp.comandos > antes, 5000, 50))) comandosOk += 1;
      else comandosFalha += 1;
    }, 6000);
    comandos.unref();

    console.log(`Ensaio em andamento por ${MINUTOS} min...`);
    await dormir(MINUTOS * 60000);
    clearInterval(amostra);
    clearInterval(comandos);

    const monitoramento = await chamar("GET", "/admin/monitoramento");
    const servico = monitoramento.corpo && monitoramento.corpo.monitoramento && monitoramento.corpo.monitoramento.servico;
    const segundos = MINUTOS * 60;
    latencias.sort((a, b) => a - b);
    const finais = (await chamar("GET", "/salas")).corpo;
    const listaFinal = Array.isArray(finais) ? finais : (finais && finais.salas) || [];
    const online = listaFinal.filter((s) => s.online).length;

    console.log("\n--- Resultado do ensaio de carga ---");
    console.log(`ESP32 simulados............ ${salas.length} (telemetria a cada ${TELEMETRIA_MS / 1000} s)`);
    console.log(`Conexões abertas ao final.. ${esps.filter((e) => e.aberta()).length}`);
    console.log(`Salas online no banco...... ${online || "n/d"}`);
    console.log(`Reconexões não solicitadas. ${esps.reduce((a, e) => a + Math.max(0, e.conexoes - 1), 0)}`);
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
    const erroCritico = /uncaught-exception|unhandled-rejection/.test(servidor.saida);
    console.log(`Exceções não tratadas...... ${erroCritico ? "SIM (ver log abaixo)" : "nenhuma"}`);
    if (erroCritico) console.log(servidor.saida.slice(-1500));

    navegadores.forEach((n) => n.ws.close());
  } finally {
    await bancada.encerrar();
    await servidor.encerrar();
  }
}

main().catch((erro) => {
  console.error(`Ensaio interrompido: ${erro.message}`);
  process.exit(1);
});
