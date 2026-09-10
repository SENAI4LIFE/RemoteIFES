const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-rollout-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const otaService = require("../src/services/otaService");
const otaRolloutService = require("../src/services/otaRolloutService");

const VERSAO_PUBLICADA = "4.1.0";

let server;
let baseUrl;
let baseWsUrl;
let manifesto;
let tokenSuper;

const socketsAbertos = new Set();

function criarBinFake(bytes = 128 * 1024) {
  const buf = Buffer.alloc(bytes, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = i % 251;
  const alvo = path.join(RAIZ_TMP, "firmware-fake.bin");
  fs.writeFileSync(alvo, buf);
  return alvo;
}

function novaSala(sala, mac) {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'R', 1, ?)`).run(sala, `Sala ${sala}`, mac);
}

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

function authFetch(caminho, token, opcoes = {}) {
  return fetch(`${baseUrl}${caminho}`, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : undefined },
  });
}

async function abrirDispositivo(sala, mac) {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-sala": sala, "x-device-mac": mac } });
  socketsAbertos.add(ws);
  const mensagens = [];
  ws.on("message", (dados) => mensagens.push(JSON.parse(dados.toString())));
  ws.once("close", () => socketsAbertos.delete(ws));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { sala, mac, ws, mensagens, ofertas: () => mensagens.filter((m) => m.tipo === "ota_oferta") };
}

async function fechar(dispositivo) {
  const desconectado = aguardarEventoDoHub("conexao", ({ sala, conectado }) => sala === dispositivo.sala && !conectado, `desconexão de ${dispositivo.sala}`);
  dispositivo.ws.close();
  await desconectado;
}

function aguardarEventoDoHub(nome, predicado, rotulo, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let terminou = false;
    const encerrar = (fn, valor) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(temporizador);
      deviceHub.eventos.off(nome, ouvir);
      fn(valor);
    };
    const ouvir = (payload) => {
      if (predicado(payload)) encerrar(resolve, payload);
    };
    const temporizador = setTimeout(() => encerrar(reject, new Error(`tempo esgotado esperando ${rotulo}`)), timeoutMs);
    deviceHub.eventos.on(nome, ouvir);
  });
}

async function reportarVersao(dispositivo, fw) {
  const registrada = aguardarEventoDoHub(
    "telemetria",
    ({ sala }) => sala === dispositivo.sala && deviceHub.estadoPublico(sala).fwVersao === fw,
    `${dispositivo.sala} reportando ${fw}`
  );
  dispositivo.ws.send(JSON.stringify({ tipo: "telemetria", fw, modo: "operation" }));
  await registrada;
}

function aguardarEvento(nome, predicado, rotulo, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let terminou = false;
    const encerrar = (fn, valor) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(temporizador);
      deviceHub.eventos.off(nome, ouvir);
      fn(valor);
    };
    const ouvir = () => {
      const valor = predicado();
      if (valor) encerrar(resolve, valor);
    };
    const temporizador = setTimeout(() => encerrar(reject, new Error(`tempo esgotado esperando ${rotulo}`)), timeoutMs);
    deviceHub.eventos.on(nome, ouvir);
    ouvir();
  });
}

function ateRollout(predicado, rotulo) {
  return aguardarEvento("ota-rollout", () => {
    const atual = otaRolloutService.atual();
    return atual && predicado(atual) ? atual : null;
  }, rotulo);
}

function ateOta(sala, predicado, rotulo) {
  return aguardarEvento("ota", () => {
    const estado = otaService.estadoDaSala(sala);
    return predicado(estado) ? estado : null;
  }, rotulo);
}

function dispositivoDoRollout(rollout, sala) {
  return rollout.dispositivos.find((d) => d.sala === sala);
}

function ateEstadoDoDispositivo(sala, estado) {
  return ateRollout((r) => dispositivoDoRollout(r, sala) && dispositivoDoRollout(r, sala).estado === estado, `${sala} em ${estado}`);
}

async function gravarEValidar(dispositivo, versao = VERSAO_PUBLICADA) {
  dispositivo.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await ateOta(dispositivo.sala, (e) => e.fase === "gravado", `${dispositivo.sala} gravado`);
  await reportarVersao(dispositivo, versao);
  await ateOta(dispositivo.sala, (e) => e.fase === "concluido" || e.fase === "falhou", `${dispositivo.sala} finalizado`);
}

async function iniciarRollout(corpo) {
  const resp = await authFetch("/admin/esp32/rollout", tokenSuper, { method: "POST", body: JSON.stringify(corpo) });
  return { status: resp.status, corpo: await resp.json() };
}

test.before(async () => {
  manifesto = otaService.publicarFirmware({ origem: criarBinFake(), versao: VERSAO_PUBLICADA, notas: "rollout" });
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;

  const bcrypt = require("bcryptjs");
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'`).run(bcrypt.hashSync("superSenha123", 10));
  tokenSuper = await login("superadmin", "superSenha123");
});

test.after(async () => {
  for (const ws of socketsAbertos) {
    try {
      ws.terminate();
    } catch {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("preflight separa aptos de inaptos e escolhe o canário entre os aptos", async () => {
  novaSala("rol-pf-atualizado", "AA:BB:CC:F0:00:01");
  novaSala("rol-pf-novo", "AA:BB:CC:F0:00:02");
  novaSala("rol-pf-apto", "AA:BB:CC:F0:00:03");
  const atualizado = await abrirDispositivo("rol-pf-atualizado", "AA:BB:CC:F0:00:01");
  const novo = await abrirDispositivo("rol-pf-novo", "AA:BB:CC:F0:00:02");
  const apto = await abrirDispositivo("rol-pf-apto", "AA:BB:CC:F0:00:03");
  await reportarVersao(atualizado, VERSAO_PUBLICADA);
  await reportarVersao(novo, "9.0.0");

  const listagem = await (await authFetch("/admin/esp32/rollout", tokenSuper)).json();
  assert.equal(listagem.manifesto.versao, VERSAO_PUBLICADA);
  assert.equal(listagem.limites.maxSimultaneos, otaService.MAX_SIMULTANEOS);
  const porSala = Object.fromEntries(listagem.elegiveis.map((e) => [e.sala, e]));
  assert.equal(porSala["rol-pf-atualizado"].codigo, "ja-atualizado");
  assert.equal(porSala["rol-pf-novo"].codigo, "downgrade");
  assert.equal(porSala["rol-pf-apto"].elegivel, true);

  const { status, corpo } = await iniciarRollout({ salas: ["rol-pf-atualizado", "rol-pf-novo", "rol-pf-apto"] });
  assert.equal(status, 200);
  const rollout = corpo.rollout;
  assert.equal(dispositivoDoRollout(rollout, "rol-pf-apto").lote, 0, "o canário é o primeiro dispositivo apto");
  assert.equal(dispositivoDoRollout(rollout, "rol-pf-atualizado").estado, "ignorado");
  assert.match(dispositivoDoRollout(rollout, "rol-pf-atualizado").motivo, /versão publicada/);
  assert.equal(dispositivoDoRollout(rollout, "rol-pf-novo").estado, "ignorado");
  assert.match(dispositivoDoRollout(rollout, "rol-pf-novo").motivo, /downgrade/);
  assert.equal(atualizado.ofertas().length, 0, "dispositivo já atualizado não pode receber oferta");
  assert.equal(novo.ofertas().length, 0, "dispositivo com versão maior não pode receber oferta");
  assert.equal(apto.ofertas().length, 1);

  await gravarEValidar(apto);
  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  assert.equal(dispositivoDoRollout(fim, "rol-pf-apto").estado, "validado");
  await fechar(atualizado);
  await fechar(novo);
  await fechar(apto);
});

test("canário validado libera lotes, respeita o limite de simultâneas e conclui", async () => {
  const salas = ["rol-ok-1", "rol-ok-2", "rol-ok-3", "rol-ok-4", "rol-ok-5"];
  const dispositivos = [];
  for (let i = 0; i < salas.length; i += 1) {
    const mac = `AA:BB:CC:F1:00:0${i + 1}`;
    novaSala(salas[i], mac);
    dispositivos.push(await abrirDispositivo(salas[i], mac));
  }
  novaSala("rol-ok-fora", "AA:BB:CC:F1:00:09");
  const fora = await abrirDispositivo("rol-ok-fora", "AA:BB:CC:F1:00:09");

  const { status, corpo } = await iniciarRollout({ salas, tamanhoLote: 2 });
  assert.equal(status, 200);
  assert.equal(corpo.rollout.estado, "canario");
  assert.deepEqual(corpo.rollout.dispositivos.map((d) => d.lote), [0, 1, 1, 2, 2]);

  assert.equal(dispositivos[0].ofertas().length, 1, "só o canário recebe oferta na primeira etapa");
  assert.equal(dispositivos.slice(1).reduce((n, d) => n + d.ofertas().length, 0), 0);

  let maximoSimultaneo = 0;
  const observador = () => {
    const r = otaRolloutService.atual();
    if (!r) return;
    const emVoo = r.dispositivos.filter((d) => d.estado === "atualizando" || d.estado === "reiniciando").length;
    maximoSimultaneo = Math.max(maximoSimultaneo, emVoo);
  };
  deviceHub.eventos.on("ota-rollout", observador);

  await gravarEValidar(dispositivos[0]);
  await ateRollout((r) => r.loteAtual === 1, "lote 1 iniciado");
  await ateEstadoDoDispositivo("rol-ok-3", "atualizando");
  assert.equal(dispositivos[3].ofertas().length, 0, "o lote 2 não começa antes do lote 1 terminar");

  await gravarEValidar(dispositivos[1]);
  await gravarEValidar(dispositivos[2]);
  await ateRollout((r) => r.loteAtual === 2, "lote 2 iniciado");
  await gravarEValidar(dispositivos[3]);
  await gravarEValidar(dispositivos[4]);

  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  deviceHub.eventos.off("ota-rollout", observador);
  assert.ok(fim.dispositivos.every((d) => d.estado === "validado"), JSON.stringify(fim.dispositivos));
  assert.equal(fim.motivoParada, null);
  assert.ok(maximoSimultaneo <= otaService.MAX_SIMULTANEOS, `houve ${maximoSimultaneo} atualizações simultâneas`);
  dispositivos.forEach((d) => assert.equal(d.ofertas().length, 1, `${d.sala} recebeu ${d.ofertas().length} ofertas`));
  assert.equal(fora.ofertas().length, 0, "dispositivo fora da seleção não pode receber oferta");

  for (const d of dispositivos) await fechar(d);
  await fechar(fora);
});

test("canário que falha interrompe a distribuição sem ofertar aos demais", async () => {
  novaSala("rol-can-1", "AA:BB:CC:F2:00:01");
  novaSala("rol-can-2", "AA:BB:CC:F2:00:02");
  const canario = await abrirDispositivo("rol-can-1", "AA:BB:CC:F2:00:01");
  const seguinte = await abrirDispositivo("rol-can-2", "AA:BB:CC:F2:00:02");

  await iniciarRollout({ salas: ["rol-can-1", "rol-can-2"] });
  canario.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "erro", erro: "sha256 divergente" }));

  const fim = await ateRollout((r) => r.estado === "interrompido", "distribuição interrompida");
  assert.equal(dispositivoDoRollout(fim, "rol-can-1").estado, "falhou");
  assert.match(dispositivoDoRollout(fim, "rol-can-1").motivo, /sha256/);
  assert.equal(dispositivoDoRollout(fim, "rol-can-2").estado, "pendente");
  assert.match(fim.motivoParada, /canário/);
  assert.equal(seguinte.ofertas().length, 0);

  await fechar(canario);
  await fechar(seguinte);
});

test("queda de conexão durante a transferência falha o dispositivo e interrompe o lote", async () => {
  const salas = ["rol-tr-1", "rol-tr-2", "rol-tr-3"];
  const dispositivos = [];
  for (let i = 0; i < salas.length; i += 1) {
    const mac = `AA:BB:CC:F3:00:0${i + 1}`;
    novaSala(salas[i], mac);
    dispositivos.push(await abrirDispositivo(salas[i], mac));
  }

  await iniciarRollout({ salas, tamanhoLote: 2 });
  await gravarEValidar(dispositivos[0]);
  await ateEstadoDoDispositivo("rol-tr-2", "atualizando");
  await ateEstadoDoDispositivo("rol-tr-3", "atualizando");

  dispositivos[1].ws.send(JSON.stringify({ tipo: "ota_progresso", recebido: 65536, total: manifesto.tamanho }));
  await ateOta("rol-tr-2", (e) => e.fase === "baixando", "rol-tr-2 baixando");
  await fechar(dispositivos[1]);
  await ateEstadoDoDispositivo("rol-tr-2", "falhou");
  await gravarEValidar(dispositivos[2]);

  const fim = await ateRollout((r) => r.estado === "interrompido", "distribuição interrompida");
  assert.equal(dispositivoDoRollout(fim, "rol-tr-2").estado, "falhou");
  assert.match(dispositivoDoRollout(fim, "rol-tr-2").motivo, /conexão/);
  assert.equal(dispositivoDoRollout(fim, "rol-tr-3").estado, "validado", "falha parcial não invalida quem terminou bem");
  assert.match(fim.motivoParada, /lote 1/);

  await fechar(dispositivos[0]);
  await fechar(dispositivos[2]);
});

test("dispositivo que reconecta com a versão antiga é registrado como revertido", async () => {
  novaSala("rol-rb-1", "AA:BB:CC:F4:00:01");
  novaSala("rol-rb-2", "AA:BB:CC:F4:00:02");
  const canario = await abrirDispositivo("rol-rb-1", "AA:BB:CC:F4:00:01");
  const seguinte = await abrirDispositivo("rol-rb-2", "AA:BB:CC:F4:00:02");
  await reportarVersao(canario, "4.0.0");

  await iniciarRollout({ salas: ["rol-rb-1", "rol-rb-2"] });
  canario.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await ateEstadoDoDispositivo("rol-rb-1", "reiniciando");
  await fechar(canario);
  assert.equal(otaService.estadoDaSala("rol-rb-1").fase, "reiniciando");

  const reconectado = await abrirDispositivo("rol-rb-1", "AA:BB:CC:F4:00:01");
  await reportarVersao(reconectado, "4.0.0");

  const fim = await ateRollout((r) => r.estado === "interrompido", "distribuição interrompida");
  const revertido = dispositivoDoRollout(fim, "rol-rb-1");
  assert.equal(revertido.estado, "revertido");
  assert.equal(revertido.versaoAnterior, "4.0.0");
  assert.match(fim.motivoParada, /versão anterior/);
  assert.equal(seguinte.ofertas().length, 0);

  await fechar(reconectado);
  await fechar(seguinte);
});

test("dispositivo que não volta após gravar fica indeterminado, não como sucesso", async () => {
  novaSala("rol-ind-1", "AA:BB:CC:F5:00:01");
  const canario = await abrirDispositivo("rol-ind-1", "AA:BB:CC:F5:00:01");

  await iniciarRollout({ salas: ["rol-ind-1"] });
  canario.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await ateEstadoDoDispositivo("rol-ind-1", "reiniciando");
  await fechar(canario);

  const agoraReal = Date.now;
  Date.now = () => agoraReal() + 4 * 60 * 1000;
  try {
    otaService.verificarTimeouts();
  } finally {
    Date.now = agoraReal;
  }

  const fim = await ateRollout((r) => r.estado === "interrompido", "distribuição interrompida");
  const alvo = dispositivoDoRollout(fim, "rol-ind-1");
  assert.equal(alvo.estado, "indeterminado");
  assert.match(alvo.motivo, /não voltou a se conectar/);
});

test("pausar não aborta quem está atualizando e retomar segue no lote seguinte", async () => {
  const salas = ["rol-pa-1", "rol-pa-2", "rol-pa-3"];
  const dispositivos = [];
  for (let i = 0; i < salas.length; i += 1) {
    const mac = `AA:BB:CC:F6:00:0${i + 1}`;
    novaSala(salas[i], mac);
    dispositivos.push(await abrirDispositivo(salas[i], mac));
  }

  await iniciarRollout({ salas, tamanhoLote: 1 });
  await ateEstadoDoDispositivo("rol-pa-1", "atualizando");
  const pausa = await authFetch("/admin/esp32/rollout/pausar", tokenSuper, { method: "POST" });
  assert.equal(pausa.status, 200);
  assert.equal(otaRolloutService.atual().estado, "canario", "a pausa não derruba a atualização em andamento");

  await gravarEValidar(dispositivos[0]);
  const pausado = await ateRollout((r) => r.estado === "pausado", "distribuição pausada");
  assert.equal(dispositivoDoRollout(pausado, "rol-pa-1").estado, "validado");
  assert.equal(dispositivos[1].ofertas().length, 0, "nenhum dispositivo novo começa durante a pausa");

  const retomada = await authFetch("/admin/esp32/rollout/retomar", tokenSuper, { method: "POST" });
  assert.equal(retomada.status, 200);
  await ateEstadoDoDispositivo("rol-pa-2", "atualizando");
  assert.equal((await authFetch("/admin/esp32/rollout/pausar", tokenSuper, { method: "POST" })).status, 200);
  assert.equal(otaRolloutService.atual().pausaSolicitada, true);
  assert.equal(
    (await authFetch("/admin/esp32/rollout/retomar", tokenSuper, { method: "POST" })).status,
    200,
    "retomar desfaz uma pausa ainda pendente, sem esperar o dispositivo em andamento"
  );
  assert.equal(otaRolloutService.atual().pausaSolicitada, false);
  await gravarEValidar(dispositivos[1]);
  await gravarEValidar(dispositivos[2]);
  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  assert.ok(fim.dispositivos.every((d) => d.estado === "validado"));

  for (const d of dispositivos) await fechar(d);
});

test("pausar quando nada mais está pendente não impede a conclusão", async () => {
  novaSala("rol-pf2-1", "AA:BB:CC:FE:00:01");
  const canario = await abrirDispositivo("rol-pf2-1", "AA:BB:CC:FE:00:01");

  await iniciarRollout({ salas: ["rol-pf2-1"] });
  await ateEstadoDoDispositivo("rol-pf2-1", "atualizando");
  assert.equal((await authFetch("/admin/esp32/rollout/pausar", tokenSuper, { method: "POST" })).status, 200);

  await gravarEValidar(canario);
  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  assert.equal(dispositivoDoRollout(fim, "rol-pf2-1").estado, "validado");
  assert.equal(otaRolloutService.ativo(), false, "uma pausa sem trabalho restante não pode deixar a distribuição presa");

  await fechar(canario);
});

test("cancelar encerra apenas o trabalho ainda não iniciado", async () => {
  const salas = ["rol-ca-1", "rol-ca-2", "rol-ca-3"];
  const dispositivos = [];
  for (let i = 0; i < salas.length; i += 1) {
    const mac = `AA:BB:CC:F7:00:0${i + 1}`;
    novaSala(salas[i], mac);
    dispositivos.push(await abrirDispositivo(salas[i], mac));
  }

  await iniciarRollout({ salas, tamanhoLote: 1 });
  await ateEstadoDoDispositivo("rol-ca-1", "atualizando");
  const cancelamento = await authFetch("/admin/esp32/rollout/cancelar", tokenSuper, { method: "POST" });
  assert.equal(cancelamento.status, 200);
  const durante = otaRolloutService.atual();
  assert.equal(dispositivoDoRollout(durante, "rol-ca-1").estado, "atualizando", "o cancelamento não interrompe uma gravação em curso");
  assert.equal(dispositivoDoRollout(durante, "rol-ca-2").estado, "cancelado");
  assert.equal(dispositivoDoRollout(durante, "rol-ca-3").estado, "cancelado");

  await gravarEValidar(dispositivos[0]);
  const fim = await ateRollout((r) => r.estado === "cancelado", "distribuição cancelada");
  assert.equal(dispositivoDoRollout(fim, "rol-ca-1").estado, "validado");
  assert.equal(dispositivos[1].ofertas().length, 0);
  assert.equal(dispositivos[2].ofertas().length, 0);

  for (const d of dispositivos) await fechar(d);
});

test("dispositivo offline na sua vez espera e depois é ignorado, nunca dado como atualizado", async () => {
  novaSala("rol-off-1", "AA:BB:CC:F8:00:01");
  novaSala("rol-off-2", "AA:BB:CC:F8:00:02");
  const canario = await abrirDispositivo("rol-off-1", "AA:BB:CC:F8:00:01");

  await iniciarRollout({ salas: ["rol-off-1", "rol-off-2"] });
  await gravarEValidar(canario);
  const esperando = await ateRollout(
    (r) => r.loteAtual === 1 && dispositivoDoRollout(r, "rol-off-2").aguardandoDesde,
    "lote 1 aguardando o dispositivo offline"
  );
  assert.equal(dispositivoDoRollout(esperando, "rol-off-2").estado, "pendente");
  assert.match(dispositivoDoRollout(esperando, "rol-off-2").motivo, /não está conectado/);

  const agoraReal = Date.now;
  Date.now = () => agoraReal() + otaRolloutService.GRACA_ESPERA_MS + 1000;
  try {
    otaRolloutService.tick();
  } finally {
    Date.now = agoraReal;
  }

  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  const ignorado = dispositivoDoRollout(fim, "rol-off-2");
  assert.equal(ignorado.estado, "ignorado");
  assert.match(ignorado.motivo, /não está conectado/);
  assert.notEqual(ignorado.estado, "validado");

  await fechar(canario);
});

test("eventos de OTA duplicados ou atrasados não alteram um dispositivo já finalizado", async () => {
  novaSala("rol-dup-1", "AA:BB:CC:F9:00:01");
  const canario = await abrirDispositivo("rol-dup-1", "AA:BB:CC:F9:00:01");

  await iniciarRollout({ salas: ["rol-dup-1"] });
  await gravarEValidar(canario);
  const fim = await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  const instantaneo = JSON.stringify(fim);

  canario.ws.send(JSON.stringify({ tipo: "ota_progresso", recebido: 1024, total: manifesto.tamanho }));
  canario.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "erro", erro: "evento atrasado" }));
  await reportarVersao(canario, "4.0.0");

  assert.equal(JSON.stringify(otaRolloutService.atual()), instantaneo, "a distribuição encerrada não pode ser reaberta por eventos atrasados");
  assert.equal(otaService.estadoDaSala("rol-dup-1").fase, "concluido");
  assert.equal(canario.ofertas().length, 1);

  await fechar(canario);
});

test("reinício do servidor reconcilia o andamento sem reofertar o firmware", async () => {
  novaSala("rol-rs-1", "AA:BB:CC:FA:00:01");
  novaSala("rol-rs-2", "AA:BB:CC:FA:00:02");
  const canario = await abrirDispositivo("rol-rs-1", "AA:BB:CC:FA:00:01");
  const seguinte = await abrirDispositivo("rol-rs-2", "AA:BB:CC:FA:00:02");

  await iniciarRollout({ salas: ["rol-rs-1", "rol-rs-2"] });
  canario.ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await ateEstadoDoDispositivo("rol-rs-1", "reiniciando");
  const idAntes = otaRolloutService.atual().id;

  const script = `
    process.env.REMOTEIFES_DB_PATH = ':memory:';
    process.env.REMOTEIFES_FIRMWARE_DIR = ${JSON.stringify(process.env.REMOTEIFES_FIRMWARE_DIR)};
    process.env.NODE_ENV = 'test';
    const assert = require('node:assert/strict');
    const ota = require(${JSON.stringify(path.join(__dirname, "../src/services/otaService"))});
    const rollout = require(${JSON.stringify(path.join(__dirname, "../src/services/otaRolloutService"))});
    rollout.tick();
    const r = rollout.atual();
    assert.equal(r.id, ${JSON.stringify(idAntes)});
    assert.equal(r.estado, 'canario');
    const canario = r.dispositivos.find((d) => d.sala === 'rol-rs-1');
    const seguinte = r.dispositivos.find((d) => d.sala === 'rol-rs-2');
    assert.equal(canario.estado, 'reiniciando');
    assert.equal(seguinte.estado, 'pendente');
    assert.equal(ota.estadoDaSala('rol-rs-1').fase, 'gravado');
    assert.equal(ota.estadoDaSala('rol-rs-2').fase, 'ocioso');
    console.log('ok');
  `;
  const filho = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(filho.status, 0, filho.stderr || filho.stdout);

  assert.equal(canario.ofertas().length, 1, "o reinício não pode reenviar a oferta para quem já gravou");
  assert.equal(seguinte.ofertas().length, 0);

  await reportarVersao(canario, VERSAO_PUBLICADA);
  await ateEstadoDoDispositivo("rol-rs-1", "validado");
  await gravarEValidar(seguinte);
  await ateRollout((r) => r.estado === "concluido", "distribuição concluída");

  await fechar(canario);
  await fechar(seguinte);
});

test("republicar o firmware durante a distribuição interrompe o que ainda não começou", async () => {
  novaSala("rol-fw-1", "AA:BB:CC:FB:00:01");
  novaSala("rol-fw-2", "AA:BB:CC:FB:00:02");
  const canario = await abrirDispositivo("rol-fw-1", "AA:BB:CC:FB:00:01");
  const seguinte = await abrirDispositivo("rol-fw-2", "AA:BB:CC:FB:00:02");

  await iniciarRollout({ salas: ["rol-fw-1", "rol-fw-2"], tamanhoLote: 1 });
  await authFetch("/admin/esp32/rollout/pausar", tokenSuper, { method: "POST" });
  await gravarEValidar(canario);
  await ateRollout((r) => r.estado === "pausado", "distribuição pausada");

  otaService.publicarFirmware({ origem: criarBinFake(160 * 1024), versao: "4.2.0", notas: "troca" });
  await authFetch("/admin/esp32/rollout/retomar", tokenSuper, { method: "POST" });

  const fim = await ateRollout((r) => r.estado === "interrompido", "distribuição interrompida");
  assert.match(fim.motivoParada, /firmware publicado mudou/);
  assert.equal(seguinte.ofertas().length, 0);

  manifesto = otaService.publicarFirmware({ origem: criarBinFake(), versao: VERSAO_PUBLICADA, notas: "rollout" });
  await fechar(canario);
  await fechar(seguinte);
});

test("apenas o superadministrador comanda a distribuição", async () => {
  const usuariosService = require("../src/services/usuariosService");
  usuariosService.criar({ usuario: "rol-admin", senha: "senhaSegura123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "rol-user", senha: "senhaSegura123", nome: "Comum" }, { nivel: 3 });
  const tokenAdmin = await login("rol-admin", "senhaSegura123");
  const tokenUsuario = await login("rol-user", "senhaSegura123");

  for (const token of [tokenAdmin, tokenUsuario]) {
    assert.equal((await authFetch("/admin/esp32/rollout", token)).status, 403);
    assert.equal((await authFetch("/admin/esp32/rollout", token, { method: "POST", body: JSON.stringify({ salas: ["rol-pf-apto"] }) })).status, 403);
    assert.equal((await authFetch("/admin/esp32/rollout/pausar", token, { method: "POST" })).status, 403);
    assert.equal((await authFetch("/admin/esp32/rollout/cancelar", token, { method: "POST" })).status, 403);
  }
  assert.equal((await fetch(`${baseUrl}/admin/esp32/rollout`)).status, 401);
  assert.equal(otaRolloutService.ativo(), false, "tentativa não autorizada não pode criar distribuição");
});

test("seleção inválida e início repetido são recusados", async () => {
  novaSala("rol-val-1", "AA:BB:CC:FC:00:01");
  novaSala("rol-val-sem-mac", null);
  const canario = await abrirDispositivo("rol-val-1", "AA:BB:CC:FC:00:01");

  assert.equal((await iniciarRollout({ salas: [] })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["rol-val-1", "rol-val-1"] })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["sala-inexistente"] })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["rol-val-sem-mac"] })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["rol-val-1"], tamanhoLote: 0 })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["rol-val-1"], tamanhoLote: 99 })).status, 400);
  assert.equal((await iniciarRollout({ salas: ["rol-val-1"], canario: "rol-pf-apto" })).status, 400);
  assert.equal((await authFetch("/admin/esp32/rollout/retomar", tokenSuper, { method: "POST" })).status, 409);
  assert.equal((await authFetch("/admin/esp32/rollout/cancelar", tokenSuper, { method: "POST" })).status, 409);

  assert.equal((await iniciarRollout({ salas: ["rol-val-1"] })).status, 200);
  assert.equal((await iniciarRollout({ salas: ["rol-val-1"] })).status, 409, "não pode haver duas distribuições ao mesmo tempo");
  assert.equal(canario.ofertas().length, 1, "o pedido repetido não gera uma segunda oferta");

  await gravarEValidar(canario);
  await ateRollout((r) => r.estado === "concluido", "distribuição concluída");
  await fechar(canario);
});

test("a OTA avulsa continua funcionando de forma independente", async () => {
  novaSala("rol-avulsa-1", "AA:BB:CC:FD:00:01");
  const dispositivo = await abrirDispositivo("rol-avulsa-1", "AA:BB:CC:FD:00:01");

  const resp = await authFetch("/admin/esp32/rol-avulsa-1/ota", tokenSuper, { method: "POST" });
  assert.equal(resp.status, 200);
  assert.equal(dispositivo.ofertas().length, 1);
  assert.equal(otaRolloutService.ativo(), false, "a OTA avulsa não cria distribuição");

  const emRollout = await iniciarRollout({ salas: ["rol-avulsa-1"] });
  assert.equal(emRollout.status, 409, "a sala já em OTA avulsa não vira canário");

  await gravarEValidar(dispositivo);
  assert.equal(otaService.estadoDaSala("rol-avulsa-1").fase, "concluido");
  assert.equal(otaRolloutService.ativo(), false);

  await fechar(dispositivo);
});
