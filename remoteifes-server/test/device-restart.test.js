const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { iniciarServidorIsolado, RAIZ_SERVIDOR } = require("./support/servidor-isolado");
const { Bancada } = require("./support/bancada-dispositivos");

// Server restarts with simulated boards attached, on a real server process and a throwaway data
// directory: a graceful stop, a crash, and a restart in the middle of a firmware update, where the
// OTA state has to come back from disk. Protocol level only; no ESP32 hardware is involved.

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

async function estado(sala) {
  const r = await servidor.api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`);
  return r.corpo && r.corpo.dispositivo;
}

async function prepararSala(indice) {
  const lista = (await servidor.api("GET", "/salas")).corpo;
  const sala = (Array.isArray(lista) ? lista : lista.salas)[indice].sala;
  const credencial = (await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {})).corpo;
  assert.ok(credencial.segredo, "credential provisioned");
  assert.equal((await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 })).status, 200);
  return { sala, credencial: { deviceId: credencial.deviceId, segredo: credencial.segredo } };
}

const conectada = (sala) => ate(async () => (await estado(sala)).dispositivo.conectado, { descricao: `${sala} conectada` });

test.before(async () => {
  servidor = await iniciarServidorIsolado();
});

test.after(async () => {
  if (servidor) await servidor.encerrar();
});

test("boards reconnect after a graceful restart and after a crash of the server process", async (t) => {
  const b = new Bancada({ porta: servidor.porta });
  t.after(() => b.encerrar());
  const salas = [await prepararSala(0), await prepararSala(1)];
  const placas = salas.map((s) => b.placa({ credencial: s.credencial, mac: `AA:F2:00:00:00:0${salas.indexOf(s) + 1}`, reconectar: { atrasoMs: 200 } }));
  await Promise.all(placas.map((p) => p.conectar()));
  for (const s of salas) await conectada(s.sala);

  for (const sinal of ["SIGTERM", "SIGKILL"]) {
    const antes = placas.map((p) => p.conexoes);
    await servidor.reiniciar(sinal);
    for (const s of salas) await conectada(s.sala);
    placas.forEach((p, i) => assert.ok(p.conexoes > antes[i], `board ${i} reconnected after ${sinal}`));
  }
  // The intent is still delivered after the restarts: a command reaches the board and is confirmed.
  const marca = placas[0].totalRecebidas;
  const r = await servidor.api("POST", "/comando", { sala: salas[0].sala, cmd: "ligar" });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const comando = await placas[0].aguardar("send_known_state", { desde: marca, limiteMs: 5000 });
  assert.equal(comando.power, true);
  await ate(async () => (await estado(salas[0].sala)).dispositivo.estadoConfirmado === true, { descricao: "confirmation after restart" });
  const restos = await b.encerrar();
  assert.equal(restos.sockets + restos.timers + restos.esperas, 0);
});

test("an update written before a crash is validated after the server comes back", async (t) => {
  const b = new Bancada({ porta: servidor.porta });
  t.after(() => b.encerrar());
  const s = await prepararSala(2);

  // Firmware published into the isolated server's data directory, with the production CLI.
  const imagem = Buffer.alloc(96 * 1024, 0);
  imagem[0] = 0xe9;
  for (let i = 1; i < imagem.length; i += 1) imagem[i] = (i * 13) % 251;
  const origem = path.join(servidor.dir, "imagem-de-teste.bin");
  fs.writeFileSync(origem, imagem);
  const env = { ...process.env, REMOTEIFES_DATA_DIR: servidor.dir };
  delete env.REMOTEIFES_DB_PATH;
  delete env.REMOTEIFES_FIRMWARE_DIR;
  execFileSync(process.execPath, ["firmware-esp32.js", origem, "4.9.0"], { cwd: RAIZ_SERVIDOR, env, stdio: "pipe" });

  const placa = b.placa({ credencial: s.credencial, sala: s.sala, mac: "AA:F2:00:00:00:10", fw: "4.3.0" });
  placa.ota.baixar = true;
  placa.ota.reinicioManual = true;
  await placa.conectar();
  await ate(async () => (await estado(s.sala)).dispositivo.fwVersao === "4.3.0", { descricao: "firmware reported" });

  const gravada = new Promise((resolve) => placa.once("ota-gravada", resolve));
  const oferta = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(s.sala)}/ota`, {});
  assert.equal(oferta.status, 200, JSON.stringify(oferta.corpo));
  await gravada;
  await ate(async () => (await estado(s.sala)).dispositivo.ota.fase === "gravado", { descricao: "OTA written" });

  // The board goes down to reboot, and the server crashes before it comes back.
  await placa.fechar(1012);
  await ate(async () => (await estado(s.sala)).dispositivo.ota.fase === "reiniciando", { descricao: "OTA restarting" });
  await servidor.reiniciar("SIGKILL");
  assert.equal((await estado(s.sala)).dispositivo.ota.fase, "reiniciando", "the phase came back from disk");

  await placa.reiniciarAposOta();
  await ate(async () => (await estado(s.sala)).dispositivo.ota.fase === "concluido", { descricao: "OTA completed" });
  const final = (await estado(s.sala)).dispositivo;
  assert.equal(final.ota.evidencia, "boot");
  assert.equal(final.fwVersao, "4.9.0");
});
