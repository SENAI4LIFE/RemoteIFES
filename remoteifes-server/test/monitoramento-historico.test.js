process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const monitoramentoService = require("../src/services/monitoramentoService");
const retencaoService = require("../src/services/retencaoService");
const usuariosService = require("../src/services/usuariosService");

let server;
let baseUrl;

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

function authGet(caminho, token) {
  return fetch(`${baseUrl}${caminho}`, { headers: { Authorization: token ? `Bearer ${token}` : undefined } });
}

function minutosAtras(min) {
  return db.prepare("SELECT datetime('now', ?) d").get(`-${min} minutes`).d;
}

function limparHistorico() {
  db.prepare("DELETE FROM monitoramento_amostras").run();
  db.prepare("DELETE FROM monitoramento_horas").run();
  monitoramentoService.limparCacheHistorico();
}

function soma(lista) {
  return lista.reduce((acc, v) => acc + (v || 0), 0);
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  usuariosService.criar({ usuario: "hist-comum", senha: "senhaSegura123", nome: "Comum", podeControlar: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "hist-admin", senha: "senhaSegura123", nome: "Admin", isAdmin: true }, { nivel: 3 });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("a migração cria as tabelas e o índice do histórico de monitoramento e é idempotente", () => {
  const { criarSchema } = require("../src/db/schema");
  criarSchema();
  criarSchema();
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'monitoramento_%' ORDER BY name").all().map((t) => t.name);
  assert.deepEqual(tabelas, ["monitoramento_amostras", "monitoramento_horas"]);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mon_amostras_criado'").get());
  const colunas = db.prepare("PRAGMA table_info(monitoramento_amostras)").all().map((c) => c.name);
  for (const coluna of ["criadoEm", "inicioProcesso", "rssMB", "cpuPercent", "bancoMs", "walBytes", "discoLivreBytes", "espOnline", "espWs", "telemetriaFalhas", "schedulerFalhas"]) {
    assert.ok(colunas.includes(coluna), `coluna ${coluna} ausente`);
  }
  assert.ok(retencaoService.LIMITES_LINHAS.monitoramento_amostras > 0);
  assert.ok(retencaoService.LIMITES_LINHAS.monitoramento_horas > 0);
});

test("amostrar() grava uma linha com gauges e converte contadores acumulados em deltas por intervalo", () => {
  limparHistorico();
  monitoramentoService.registrar("telemetriaFalha", { sala: "H-1" });
  monitoramentoService.registrar("telemetriaFalha", { sala: "H-1" });
  monitoramentoService.registrar("schedulerFalha", { tarefa: "teste" });
  monitoramentoService.amostrar();
  const primeira = db.prepare("SELECT * FROM monitoramento_amostras ORDER BY id DESC LIMIT 1").get();
  assert.equal(typeof primeira.rssMB, "number");
  assert.ok(primeira.rssMB > 0);
  assert.equal(typeof primeira.cpuPercent, "number");
  assert.ok(primeira.cpuPercent >= 0);
  assert.equal(typeof primeira.bancoMs, "number");
  assert.equal(typeof primeira.espComMac, "number");
  assert.equal(primeira.inicioProcesso.length, 19);
  assert.ok(primeira.telemetriaFalhas >= 2);
  assert.ok(primeira.schedulerFalhas >= 1);

  monitoramentoService.amostrar();
  const segunda = db.prepare("SELECT * FROM monitoramento_amostras ORDER BY id DESC LIMIT 1").get();
  assert.equal(segunda.telemetriaFalhas, 0, "sem novas falhas o delta do intervalo é zero, não o acumulado");
  assert.equal(segunda.schedulerFalhas, 0);

  monitoramentoService.registrar("telemetriaFalha", { sala: "H-2" });
  monitoramentoService.amostrar();
  const terceira = db.prepare("SELECT * FROM monitoramento_amostras ORDER BY id DESC LIMIT 1").get();
  assert.equal(terceira.telemetriaFalhas, 1);
});

test("a consolidação por hora resume as amostras (média, pico, mínimo, somas) e mantém a hora corrente crua", () => {
  limparHistorico();
  const boot = minutosAtras(500);
  for (let i = 0; i < 180; i += 1) {
    monitoramentoService.gravarAmostra({
      inicioProcesso: boot,
      rssMB: 40 + (i % 20),
      cpuPercent: i % 5,
      bancoMs: 0.4,
      walBytes: 1000 * (i % 3),
      discoLivreBytes: 5_000_000_000 - i * 1000,
      espComMac: 4,
      espOnline: 4 - (i % 3),
      espWs: 3,
      telemetriaFalhas: i % 30 === 0 ? 1 : 0,
    }, minutosAtras(240 - i));
  }
  const consolidadas = monitoramentoService.consolidarHoras();
  assert.ok(consolidadas >= 2 && consolidadas <= 4, `esperava 2 a 4 horas fechadas, obteve ${consolidadas}`);
  const horas = db.prepare("SELECT * FROM monitoramento_horas ORDER BY hora").all();
  assert.equal(horas.length, consolidadas);
  const cheia = horas.find((h) => h.amostras === 60) || horas[0];
  assert.ok(cheia.rssMB >= 40 && cheia.rssMB <= 60);
  assert.ok(cheia.rssMBMax >= cheia.rssMB);
  assert.ok(cheia.espOnlineMin <= cheia.espOnline);
  assert.ok(cheia.discoLivreBytesMin <= cheia.discoLivreBytes);
  assert.equal(soma(horas.map((h) => h.telemetriaFalhas)) + soma(db.prepare("SELECT telemetriaFalhas FROM monitoramento_amostras WHERE criadoEm >= strftime('%Y-%m-%d %H:00:00', 'now')").all().map((l) => l.telemetriaFalhas)), 6);
  const horaAtual = db.prepare("SELECT strftime('%Y-%m-%d %H:00:00', 'now') h").get().h;
  assert.equal(horas.some((h) => h.hora >= horaAtual), false, "a hora corrente nunca é fechada");
  assert.equal(monitoramentoService.consolidarHoras(), 0, "segunda chamada não reconsolida");
});

test("a retenção consolida antes de apagar, remove amostras cruas antigas e horas além de 30 dias", () => {
  limparHistorico();
  const bootAntigo = "2026-01-01 00:00:00";
  for (let i = 0; i < 30; i += 1) {
    monitoramentoService.gravarAmostra({ inicioProcesso: bootAntigo, rssMB: 70, espComMac: 1, espOnline: 1, espWs: 1 }, db.prepare("SELECT datetime('now', '-60 hours', ?) d").get(`+${i} minutes`).d);
  }
  monitoramentoService.gravarAmostra({ inicioProcesso: bootAntigo, rssMB: 70 }, minutosAtras(5));
  db.prepare("INSERT INTO monitoramento_horas (hora, amostras, rssMB) VALUES (datetime('now', '-40 days'), 60, 50)").run();
  db.prepare("INSERT INTO monitoramento_horas (hora, amostras, rssMB) VALUES (datetime('now', '-10 days'), 60, 50)").run();

  const resumo = retencaoService.executarLimpezaRetencao();
  assert.equal(resumo.monitoramento_amostras, 30, "as amostras com mais de 48 h saem");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitoramento_amostras").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitoramento_horas WHERE hora < datetime('now', '-30 days')").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM monitoramento_horas WHERE hora >= datetime('now', '-61 hours') AND hora <= datetime('now', '-59 hours')").get().n >= 1, "a hora antiga foi consolidada antes de as amostras cruas serem apagadas");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitoramento_horas WHERE hora >= datetime('now', '-11 days') AND hora <= datetime('now', '-9 days')").get().n, 1);
});

test("os limites de linhas do histórico valem para as duas tabelas", () => {
  limparHistorico();
  const limiteHoras = retencaoService.LIMITES_LINHAS.monitoramento_horas;
  const inserir = db.prepare("INSERT INTO monitoramento_horas (hora, amostras) VALUES (datetime('now', ?), 1)");
  for (let i = 0; i < limiteHoras + 25; i += 1) inserir.run(`-${i + 1} minutes`);
  const resumo = retencaoService.executarLimpezaRetencao();
  assert.equal(resumo.monitoramento_horas_excedente, 25);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitoramento_horas").get().n, limiteHoras);
  const maisRecente = db.prepare("SELECT MAX(hora) h FROM monitoramento_horas").get().h;
  assert.ok(maisRecente >= minutosAtras(61), "as horas mais recentes são preservadas");
});

test("historico() agrega em grade completa, deixa nulos onde não há amostra e soma contagens por período", () => {
  limparHistorico();
  db.prepare("DELETE FROM esp_eventos").run();
  db.prepare("DELETE FROM comandos_log").run();
  db.prepare("DELETE FROM notificacoes WHERE tipo IN ('esp32_ota_falha', 'esp32_ota_ok')").run();
  const boot = minutosAtras(200);
  for (let i = 0; i < 60; i += 1) {
    monitoramentoService.gravarAmostra({ inicioProcesso: boot, rssMB: 100, cpuPercent: 10, bancoMs: 1, espComMac: 5, espOnline: 3, espWs: 3, credencialFalhas: i === 10 ? 2 : 0 }, minutosAtras(180 - i));
  }
  for (let i = 0; i < 30; i += 1) {
    monitoramentoService.gravarAmostra({ inicioProcesso: boot, rssMB: 120, cpuPercent: 20, bancoMs: 2, espComMac: 5, espOnline: 5, espWs: 5 }, minutosAtras(40 - i));
  }
  const sala = db.prepare("SELECT sala FROM salas LIMIT 1").get().sala;
  db.prepare("INSERT INTO esp_eventos (sala, status, criadoEm) VALUES (?, 'offline', ?)").run(sala, minutosAtras(100));
  db.prepare("INSERT INTO esp_eventos (sala, status, criadoEm) VALUES (?, 'online', ?)").run(sala, minutosAtras(95));
  db.prepare("INSERT INTO esp_eventos (sala, status, criadoEm) VALUES (?, 'online', ?)").run(sala, minutosAtras(30));
  db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, origem, criadoEm) VALUES ('x', ?, 'ligar', 'manual', ?)").run(sala, minutosAtras(50));
  db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, origem, criadoEm) VALUES (NULL, ?, 'ligar', 'agendamento', ?)").run(sala, minutosAtras(50));
  db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, origem, criadoEm) VALUES (NULL, ?, 'desligar', 'esp32_local', ?)").run(sala, minutosAtras(20));
  db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, origem, criadoEm) VALUES (NULL, ?, 'desligar', 'desconhecida', ?)").run(sala, minutosAtras(20));
  db.prepare("INSERT INTO notificacoes (tipo, sala, mensagem, criadoEm) VALUES ('esp32_ota_falha', ?, 'falhou', ?)").run(sala, minutosAtras(70));
  db.prepare("INSERT INTO notificacoes (tipo, sala, mensagem, criadoEm) VALUES ('esp32_ota_ok', ?, 'ok', ?)").run(sala, minutosAtras(60));

  const h = monitoramentoService.historico("24h");
  assert.equal(h.faixa, "24h");
  assert.equal(h.bucketSegundos, 900);
  assert.equal(h.t.length, 96);
  assert.equal(h.n.length, 96);
  for (let i = 1; i < h.t.length; i += 1) assert.equal(h.t[i] - h.t[i - 1], 900 * 1000, "grade uniforme");
  assert.equal(soma(h.n), 90);
  const vazios = h.t.map((_, i) => i).filter((i) => h.n[i] === 0);
  assert.ok(vazios.length > 50);
  for (const i of vazios) {
    assert.equal(h.medidas.rssMB[i], null, "bucket sem amostra não interpola gauge");
    assert.equal(h.contagens.credencialFalhas[i], 0);
  }
  const cheios = h.t.map((_, i) => i).filter((i) => h.n[i] > 0);
  assert.ok(cheios.every((i) => h.medidas.rssMB[i] !== null));
  assert.ok(h.medidas.rssMB.some((v) => v === 100) && h.medidas.rssMB.some((v) => v === 120));
  assert.ok(h.medidas.cpuPercentMax.filter((v) => v !== null).every((v) => v === 10 || v === 20));
  assert.equal(h.medidas.espOnlineMin.filter((v) => v !== null).some((v) => v === 3), true);
  assert.equal(soma(h.contagens.credencialFalhas), 2);
  assert.equal(soma(h.contagens.reconexoes), 2);
  assert.equal(soma(h.contagens.quedas), 1);
  assert.equal(soma(h.contagens.comandosManual), 1);
  assert.equal(soma(h.contagens.comandosAgendamento), 1);
  assert.equal(soma(h.contagens.comandosEsp32), 1);
  assert.equal(soma(h.contagens.comandosOutros), 1);
  assert.equal(soma(h.contagens.otaFalhas), 1);
  assert.equal(soma(h.contagens.otaOk), 1);
  assert.equal(h.cobertura.amostras, 90);
  assert.equal(h.cobertura.completa, false, "histórico parcial: a primeira amostra é posterior ao início da janela");
  assert.ok(h.cobertura.desde);
  assert.deepEqual(h.faixas.map((f) => f.id), ["3h", "24h", "7d", "30d"]);
  assert.equal(h.amostragemSegundos, 60);
  assert.deepEqual(h.retencao, { amostrasHoras: 48, horasDias: 30 });
});

test("as faixas longas combinam horas consolidadas com a hora corrente crua e nunca mandam milhares de pontos", () => {
  limparHistorico();
  const boot = minutosAtras(15);
  const inserir = db.prepare(`INSERT INTO monitoramento_horas (hora, amostras, reinicios, rssMB, rssMBMax, cpuPercent, cpuPercentMax, bancoMs, bancoMsMax, espComMac, espOnline, espOnlineMin, espWs, telemetriaFalhas)
    VALUES (strftime('%Y-%m-%d %H:00:00', 'now', ?), 60, ?, 80, 90, 5, 12, 1, 3, 6, 5, 4, 5, ?)`);
  for (let i = 1; i <= 24 * 29; i += 1) inserir.run(`-${i} hours`, i === 48 ? 1 : 0, i % 24 === 0 ? 1 : 0);
  for (let i = 0; i < 20; i += 1) monitoramentoService.gravarAmostra({ inicioProcesso: boot, rssMB: 100, cpuPercent: 30, bancoMs: 2, espComMac: 6, espOnline: 6, espWs: 6, telemetriaFalhas: i === 0 ? 3 : 0 }, minutosAtras(20 - i));

  const h7 = monitoramentoService.historico("7d");
  assert.equal(h7.fonte, "horas");
  assert.equal(h7.t.length, 168);
  assert.equal(soma(h7.n), 167 * 60 + 20);
  assert.equal(h7.n[h7.n.length - 1], 20, "a hora corrente vem das amostras cruas");
  assert.equal(h7.medidas.rssMB[h7.medidas.rssMB.length - 1], 100);
  assert.ok(h7.medidas.rssMB.slice(0, -1).filter((v) => v !== null).every((v) => v === 80));
  assert.equal(soma(h7.contagens.telemetriaFalhas), 6 + 3);
  assert.equal(h7.reinicios.length, 2);
  assert.equal(h7.reinicios[0].exato, false, "reinício de hora consolidada é aproximado à hora");
  assert.equal(h7.reinicios[1].exato, true, "reinício da hora corrente tem instante exato");
  assert.equal(h7.cobertura.completa, true);

  const h30 = monitoramentoService.historico("30d");
  assert.equal(h30.t.length, 120);
  assert.equal(h30.bucketSegundos, 6 * 3600);
  assert.equal(soma(h30.n), 24 * 29 * 60 + 20);
  const medias = h30.medidas.rssMB.filter((v) => v !== null);
  assert.ok(medias.every((v) => v >= 80 && v <= 100));
  assert.ok(h30.medidas.rssMBMax.filter((v) => v !== null).every((v) => v === 90 || v === 100));
  assert.equal(soma(h30.contagens.telemetriaFalhas), 29 + 3);
  assert.equal(h30.cobertura.completa, false);

  const t0 = Date.now();
  monitoramentoService.limparCacheHistorico();
  monitoramentoService.historico("30d");
  monitoramentoService.limparCacheHistorico();
  monitoramentoService.historico("7d");
  assert.ok(Date.now() - t0 < 1500, "consultas longas continuam baratas");
  for (const faixa of ["3h", "24h", "7d", "30d"]) {
    monitoramentoService.limparCacheHistorico();
    assert.ok(monitoramentoService.historico(faixa).t.length <= 200, `${faixa} envia no máximo 200 pontos`);
  }
});

test("reinícios ficam visíveis: cada início de processo dentro da janela vira um marcador e deltas nunca ficam negativos", () => {
  limparHistorico();
  const bootA = minutosAtras(150);
  const bootB = minutosAtras(60);
  for (let i = 0; i < 80; i += 1) monitoramentoService.gravarAmostra({ inicioProcesso: bootA, rssMB: 90, telemetriaFalhas: 0 }, minutosAtras(150 - i));
  for (let i = 0; i < 55; i += 1) monitoramentoService.gravarAmostra({ inicioProcesso: bootB, rssMB: 40, telemetriaFalhas: i === 0 ? 4 : 0 }, minutosAtras(59 - i));
  const h = monitoramentoService.historico("3h");
  assert.equal(h.t.length, 60);
  assert.equal(h.reinicios.length, 2);
  assert.ok(h.reinicios.every((r) => r.exato));
  assert.equal(new Date(h.reinicios[1].em).getTime(), new Date(`${bootB.replace(" ", "T")}Z`).getTime());
  assert.ok(h.contagens.telemetriaFalhas.every((v) => v >= 0));
  assert.equal(soma(h.contagens.telemetriaFalhas), 4);
  const antesDoReinicio = h.medidas.rssMB.filter((v) => v === 90).length;
  const depoisDoReinicio = h.medidas.rssMB.filter((v) => v === 40).length;
  assert.ok(antesDoReinicio > 0 && depoisDoReinicio > 0);
});

test("histórico vazio responde com a grade completa, sem amostras e sem cobertura", () => {
  limparHistorico();
  const h = monitoramentoService.historico("3h");
  assert.equal(h.t.length, 60);
  assert.equal(soma(h.n), 0);
  assert.ok(h.medidas.rssMB.every((v) => v === null));
  assert.equal(h.cobertura.desde, null);
  assert.equal(h.cobertura.completa, false);
  assert.deepEqual(h.reinicios, []);
});

test("GET /admin/monitoramento/historico exige superadministrador, valida a faixa e não usa cache HTTP", async () => {
  assert.equal((await authGet("/admin/monitoramento/historico", null)).status, 401);
  assert.equal((await authGet("/admin/monitoramento/historico", await login("hist-comum", "senhaSegura123"))).status, 403);
  assert.equal((await authGet("/admin/monitoramento/historico", await login("hist-admin", "senhaSegura123"))).status, 403);
  const token = await login("superadmin", "admin");
  const ok = await authGet("/admin/monitoramento/historico?faixa=7d", token);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const corpo = await ok.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.faixa, "7d");
  assert.ok(Array.isArray(corpo.t) && Array.isArray(corpo.n));
  const padrao = await (await authGet("/admin/monitoramento/historico", token)).json();
  assert.equal(padrao.faixa, "24h");
  for (const invalida of ["1h", "abc", "%20", "24h;DROP"]) {
    const resp = await authGet(`/admin/monitoramento/historico?faixa=${invalida}`, token);
    assert.equal(resp.status, 400, `faixa ${invalida}`);
    assert.equal((await resp.json()).ok, false);
  }
  assert.equal((await authGet("/admin/monitoramento/historico?faixa=24h&faixa=7d", token)).status, 400);
});

test("GET /admin/monitoramento continua compatível e ganha composição de OTA e PM2 opcional", async () => {
  const token = await login("superadmin", "admin");
  const m = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento;
  assert.equal(m.banco.ok, true);
  assert.equal(typeof m.servico.memoriaRssMB, "number");
  assert.equal(typeof m.servico.cargaMedia1min, "number");
  assert.ok(m.servico.nucleos >= 1);
  assert.equal(m.servico.pm2, null, "sem PM2 o campo é nulo, nunca inventado");
  assert.deepEqual(Object.keys(m.esp32.otaPorFase), ["ofertado", "baixando", "gravado", "reiniciando", "concluido", "falhou"]);
  assert.equal(typeof m.esp32.otaComFalha, "number");
  assert.ok(m.banco.tabelas.monitoramento_amostras);
  assert.ok(m.banco.tabelas.monitoramento_horas);
  assert.equal(typeof m.banco.tabelas.monitoramento_amostras.limite, "number");
  assert.ok(Array.isArray(m.alertas));
});

test("com variáveis do PM2 presentes o serviço informa reinícios e modo, ignorando valores malformados", () => {
  const originais = { pm_id: process.env.pm_id, name: process.env.name, restart_time: process.env.restart_time, unstable_restarts: process.env.unstable_restarts, pm_uptime: process.env.pm_uptime, exec_mode: process.env.exec_mode };
  try {
    process.env.pm_id = "3";
    process.env.name = "remoteifes";
    process.env.restart_time = "7";
    process.env.unstable_restarts = "x";
    process.env.pm_uptime = String(Date.now() - 60000);
    process.env.exec_mode = "fork_mode";
    const pm2 = monitoramentoService.coletarPm2();
    assert.equal(pm2.id, 3);
    assert.equal(pm2.nome, "remoteifes");
    assert.equal(pm2.reinicios, 7);
    assert.equal(pm2.reiniciosInstaveis, null);
    assert.equal(pm2.modo, "fork_mode");
    assert.ok(new Date(pm2.iniciadoEm).getTime() <= Date.now());
    assert.equal(monitoramentoService.coletar().servico.pm2.reinicios, 7);
  } finally {
    for (const [chave, valor] of Object.entries(originais)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }
  assert.equal(monitoramentoService.coletarPm2(), null);
});
