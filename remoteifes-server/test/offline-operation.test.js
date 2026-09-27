const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const WebSocket = require("ws");
const { iniciarServidorIsolado, RAIZ_SERVIDOR } = require("./support/servidor-isolado");
const { Bancada } = require("./support/bancada-dispositivos");

// RemoteIFES on a campus LAN with no Internet at all: the server process, and every command-line
// tool it runs, see a host with no route off it (support/sem-internet.js). Rooms, boards,
// commands, telemetry, the browser WebSocket, schedules and backups must all work, and nothing may
// even try to leave the host. Simulated boards; no ESP32 hardware is involved.

const SEM_INTERNET = path.join(__dirname, "support", "sem-internet.js");
const dirTeste = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-sem-internet-"));
const registro = path.join(dirTeste, "tentativas.jsonl");
const marca = path.join(dirTeste, "processos.txt");
let servidor;

async function ate(condicao, { limiteMs = 15_000, descricao = "condição" } = {}) {
  const limite = Date.now() + limiteMs;
  for (;;) {
    const valor = await condicao().catch(() => false);
    if (valor) return valor;
    if (Date.now() > limite) throw new Error(`tempo esgotado aguardando ${descricao}\n${servidor.saida.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function tentativas() {
  if (!fs.existsSync(registro)) return [];
  return fs.readFileSync(registro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function horaBrasilia(minutosAFrente = 0) {
  const d = new Date(Date.now() + minutosAFrente * 60_000 - 3 * 3600_000);
  return { data: d.toISOString().slice(0, 10), hora: d.toISOString().slice(11, 16) };
}

test.before(async () => {
  servidor = await iniciarServidorIsolado({
    // NODE_OPTIONS treats a backslash inside quotes as an escape: the path goes with forward slashes.
    env: {
      NODE_OPTIONS: `--require "${SEM_INTERNET.split(path.sep).join("/")}"`,
      SEM_INTERNET: "rota",
      SEM_INTERNET_REGISTRO: registro,
      SEM_INTERNET_MARCA: marca,
    },
  });
});

test.after(async () => {
  if (servidor) await servidor.encerrar();
  fs.rmSync(dirTeste, { recursive: true, force: true });
});

test("rooms, boards, commands, telemetry, WebSocket, schedules and backups work with no Internet", async (t) => {
  const saude = await (await fetch(`${servidor.base}/health`)).json();
  assert.equal(saude.ok, true, "/health reports a healthy server with no Internet");

  // A board of a provisioned room connects.
  const lista = (await servidor.api("GET", "/salas")).corpo;
  const sala = (Array.isArray(lista) ? lista : lista.salas)[0].sala;
  const credencial = (await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {})).corpo;
  assert.equal((await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 })).status, 200);
  const bancada = new Bancada({ porta: servidor.porta });
  t.after(() => bancada.encerrar());
  const placa = bancada.placa({ credencial: { deviceId: credencial.deviceId, segredo: credencial.segredo }, sala, mac: "AA:0F:F1:1E:00:01" });
  await placa.conectar();
  await ate(async () => (await servidor.api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`)).corpo.dispositivo.dispositivo.conectado, {
    descricao: "a placa conectada",
  });

  // A browser follows the room live.
  const navegador = new WebSocket(`ws://127.0.0.1:${servidor.porta}/ws`, [servidor.token]);
  t.after(() => navegador.close());
  const mensagens = [];
  navegador.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  await new Promise((r, f) => {
    navegador.once("open", r);
    navegador.once("error", f);
  });
  await ate(async () => mensagens.some((m) => m.tipo === "salas"), { descricao: "a lista de salas no WebSocket" });
  navegador.send(JSON.stringify({ tipo: "observar", sala }));

  // A command reaches the board, which confirms it, and the browser sees the room change.
  const comando = await servidor.api("POST", "/comando", { sala, cmd: "ligar" });
  assert.equal(comando.status, 200, JSON.stringify(comando.corpo));
  await placa.aguardar((m) => m.tipo === "send_known_state" && m.restauracao !== true);
  await ate(async () => (await servidor.api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`)).corpo.dispositivo.dispositivo.estadoConfirmado === true, {
    descricao: "a confirmação da placa",
  });
  await ate(async () => mensagens.some((m) => m.tipo !== "servidor" && m.tipo !== "salas" && JSON.stringify(m).includes(sala)), {
    descricao: "uma atualização da sala no WebSocket",
  });

  // Telemetry arrives and is recorded.
  placa.temp = 26.5;
  placa.telemetria();
  await ate(async () => {
    const d = (await servidor.api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`)).corpo.dispositivo.dispositivo;
    return d.ultimaTelemetria && d.ultimaTelemetria.temp === 26.5;
  }, {
    descricao: "a telemetria registrada",
  });

  // A schedule for later today (the API accepts only today's date), when the day still has room.
  const inicio = horaBrasilia(60);
  const fim = horaBrasilia(90);
  if (inicio.data === horaBrasilia().data && fim.data === inicio.data) {
    const a = await servidor.api("POST", "/agendamentos", { sala, data: inicio.data, horaInicio: inicio.hora, horaFim: fim.hora, temperatura: 23, modo: "reserva" });
    assert.equal(a.status, 200, JSON.stringify(a.corpo));
  }

  // A verified backup with the production tool, in the same no-Internet environment.
  const backup = spawnSync(process.execPath, ["backup-db.js", "offline"], { cwd: RAIZ_SERVIDOR, env: servidor.ambiente, encoding: "utf8", timeout: 120_000 });
  assert.equal(backup.status, 0, `${backup.stdout}${backup.stderr}`);

  assert.equal((await (await fetch(`${servidor.base}/health`)).json()).ok, true);
  // The simulation was loaded in the server and in the backup tool, so an empty record means
  // nothing tried, not that nothing was watching.
  const processos = fs.readFileSync(marca, "utf8");
  assert.match(processos, /server\.js/);
  assert.match(processos, /backup-db\.js/);
  assert.deepEqual(
    tentativas().map((x) => `${x.tipo} ${x.destino}`),
    [],
    "neither the server nor its tools tried to leave the host"
  );
});
