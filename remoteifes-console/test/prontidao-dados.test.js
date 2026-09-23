const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

/**
 * Roda um runner do console sem bloquear o laço de eventos. `execFileSync` travaria o processo
 * de teste e, com ele, a aplicação falsa — o runner veria um /health mudo por artefato do
 * harness, e não porque a aplicação parou de verdade.
 */
function rodarRunner(script, args, env) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(ajuda.RAIZ, "bin", script), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolve({ codigo, saida }));
  });
}
const ajuda = require("./ajuda");

// Avaliação de impacto antes de interromper, e segurança da restauração de banco.

function checkoutComDados({ porta }) {
  const raiz = ajuda.dirTemporario("console-dados-");
  const servidor = path.join(raiz, "remoteifes-server");
  fs.mkdirSync(path.join(servidor, "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(servidor, "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(servidor, ".env"), `PORTA=${porta}
`);

  // O runner de restauração reusa o backupService real do checkout, de propósito: é ele que
  // garante snapshot consistente, integrity_check, cópia pré-restauração e rollback. O checkout
  // de teste recebe exatamente esses arquivos, sem o resto do servidor.
  const origem = path.join(ajuda.RAIZ, "..", "remoteifes-server");
  for (const relativo of [
    ["src", "config", "paths.js"],
    ["src", "utils", "logger.js"],
    ["src", "services", "backupService.js"],
  ]) {
    const destino = path.join(servidor, ...relativo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(origem, ...relativo), destino);
  }
  return raiz;
}

/** Aplicação falsa: responde /health e /manutencao/prontidao como a real. */
function aplicacaoFalsa(prontidao, { saudavel = true } = {}) {
  let token = null;
  const servidor = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(saudavel ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: saudavel, banco: "ok", ambiente: "production", commit: "a".repeat(40), uptimeSegundos: 120 }));
    }
    if (req.url === "/manutencao/prontidao") {
      if (prontidao === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false }));
      }
      const header = req.headers.authorization || "";
      if (token && header !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, em: new Date().toISOString(), ...prontidao }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () =>
      resolve({
        porta: servidor.address().port,
        definirToken: (t) => {
          token = t;
        },
        fechar: () => new Promise((r) => servidor.close(() => r())),
      })
    );
  });
}

test("o segredo do contrato de prontidão é criado com permissão restrita", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0 }, ota: { ativos: 0, porFase: {} }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const token = amb.prontidao.garantirTokenProntidao();
  assert.ok(token.length >= 32);
  const arquivo = amb.prontidao.caminhoTokenProntidao();
  assert.ok(fs.existsSync(arquivo));
  assert.ok(!path.resolve(arquivo).includes("remoteifes-console"), "o segredo fica no data/ da aplicação, que é quem o lê");
  // Chamar de novo não troca o segredo (trocar invalidaria a leitura da aplicação em voo).
  assert.equal(amb.prontidao.garantirTokenProntidao(), token);
});

test("aplicação sem o contrato de prontidão gera 'desconhecido', nunca zero", async (t) => {
  const app = await aplicacaoFalsa(null);
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const desconhecido = avaliacao.avisos.find((a) => a.titulo === "Atividade dos ESP32 desconhecida");
  assert.ok(desconhecido, "a ausência do contrato precisa virar aviso explícito");
  assert.match(desconhecido.detalhe, /trate como desconhecido, não como zero/);
  assert.equal(avaliacao.contexto.prontidaoObservavel, false);
});

test("OTA na fase validando bloqueia a interrupção", async (t) => {
  const app = await aplicacaoFalsa({
    dispositivos: { conectados: 3, canaisDeComando: 2, salas: [] },
    // `validando` é exatamente a fase que monitoramentoService deixa de fora ao contar
    // otaEmAndamento; aqui ela precisa contar.
    ota: { ativos: 1, porFase: { ofertado: 0, baixando: 0, gravado: 0, reiniciando: 0, validando: 1 }, salas: ["A-101"] },
    rollout: null,
  });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  assert.equal(avaliacao.pronto, false);
  const bloqueio = avaliacao.bloqueios.find((b) => b.titulo === "Atualização de firmware em andamento");
  assert.ok(bloqueio, "OTA em validando tem de bloquear");
  assert.match(bloqueio.detalhe, /validando: 1/);
});

test("rollout pausado com pendências vira aviso; ativo vira bloqueio", async (t) => {
  const pausado = await aplicacaoFalsa({
    dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: { ativo: false, estado: "pausado", pausado: true, versao: "4.1.0", pendentes: 7 },
  });
  const checkout = checkoutComDados({ porta: pausado.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await pausado.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const aviso = avaliacao.avisos.find((a) => a.titulo.includes("pausada com trabalho pendente"));
  assert.ok(aviso, "rollout pausado com pendências não pode desaparecer da avaliação");
  assert.match(aviso.detalhe, /7 pendente/);
  assert.match(aviso.detalhe, /volta a mexer nos dispositivos/);
});

test("rollout pausado com dispositivo ainda em voo bloqueia, não apenas avisa", async (t) => {
  // Pausar o rollout não recolhe quem já está gravando: um ESP32 em "atualizando",
  // "reiniciando" ou "validando" continua em voo. Reiniciar o serviço nesse instante é o
  // caminho para um dispositivo que não volta, então isso bloqueia.
  const pausado = await aplicacaoFalsa({
    dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: { ativo: false, estado: "pausado", pausado: true, versao: "4.1.0", pendentes: 0, emAndamento: 2 },
  });
  const checkout = checkoutComDados({ porta: pausado.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await pausado.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const bloqueio = avaliacao.bloqueios.find((b) => b.titulo.includes("em atualização"));
  assert.ok(bloqueio, `dispositivo em voo tem de bloquear. Avaliação: ${JSON.stringify(avaliacao)}`);
  assert.match(bloqueio.detalhe, /2 em voo/);
  assert.match(bloqueio.detalhe, /Espere os dispositivos em voo terminarem/);
});

test("canal de comandos é distinguido de presença no hub", async (t) => {
  const app = await aplicacaoFalsa({
    dispositivos: { conectados: 10, canaisDeComando: 4, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: null,
  });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const info = avaliacao.informacoes.find((i) => i.titulo.includes("canal de comandos"));
  assert.ok(info);
  assert.match(info.detalhe, /4 de 10 presentes/);
  assert.match(info.detalhe, /reconectam sozinhos/);
});

test("uma operação em andamento bloqueia outra", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(amb.estadoDir, "trabalhos.json"),
    JSON.stringify({ trabalhos: [{ id: "x", acao: "atualizacao.aplicar", rotulo: "Atualizar", estado: "executando", iniciadoEm: new Date().toISOString(), pid: process.pid }] })
  );
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  assert.equal(avaliacao.pronto, false);
  assert.ok(avaliacao.bloqueios.some((b) => b.titulo === "Operação do console em andamento"));
});

test("sessões de usuário são descritas como atividade recente, não contagem exata", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const sessoes = avaliacao.informacoes.find((i) => i.titulo.toLowerCase().includes("sessõe"));
  assert.ok(sessoes);
  assert.match(sessoes.detalhe, /desconhecid|não a contagem exata/i);
});

// --- Backup e restauração -------------------------------------------------------------------

function criarBancoDeTeste(caminho, { usuarios = 1 } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, usuario TEXT, nivel INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS salas (id INTEGER PRIMARY KEY, sala TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS agendamentos (id INTEGER PRIMARY KEY, ativo INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS relatos (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE IF NOT EXISTS sessoes (id INTEGER PRIMARY KEY, usuarioId INTEGER, logout TEXT)");
  for (let i = 0; i < usuarios; i += 1) {
    db.prepare("INSERT INTO usuarios (usuario, nivel) VALUES (?, ?)").run(`u${i}`, 3);
  }
  db.close();
}

test("um candidato corrompido é recusado antes de tocar no banco atual", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const backupService = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "src", "services", "backupService"));
  const dir = ajuda.dirTemporario("console-bkp-");
  const ruim = path.join(dir, "remoteifes-20260101-010101-abcdef.db");
  fs.writeFileSync(ruim, "isto não é um banco SQLite");

  assert.throws(() => backupService.verificarArquivoBackup(ruim), /.+/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("um backup sem usuários é recusado (banco vazio é indício de corrupção)", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const backupService = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "src", "services", "backupService"));
  const dir = ajuda.dirTemporario("console-bkp-");
  const vazio = path.join(dir, "remoteifes-20260101-010101-abcdef.db");
  criarBancoDeTeste(vazio, { usuarios: 0 });

  assert.throws(() => backupService.verificarArquivoBackup(vazio), /nenhum usuário/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("o runner de restauração recusa identificador com travessia antes de qualquer efeito", (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");
  criarBancoDeTeste(path.join(dados, "remoteifes.db"), { usuarios: 2 });
  const antes = fs.readFileSync(path.join(dados, "remoteifes.db"));

  const barra = String.fromCharCode(92);
  for (const ruim of ["../../../etc/passwd", "/etc/passwd", "remoteifes-x.db; rm -rf /", `..${barra}..${barra}x.db`]) {
    let saida = "";
    let codigo = 0;
    try {
      saida = execFileSync(process.execPath, [path.join(ajuda.RAIZ, "bin", "restaurar.js"), ruim], {
        encoding: "utf8",
        env: { ...process.env, CONSOLE_CHECKOUT_DIR: checkout, CONSOLE_ESTADO_DIR: amb.estadoDir, CONSOLE_SEM_PRIVILEGIO: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (erro) {
      saida = `${erro.stdout || ""}${erro.stderr || ""}`;
      codigo = erro.status;
    }
    assert.equal(codigo, 2, `deveria recusar ${ruim} como argumento inválido`);
    assert.match(saida, /recusado|não encontrado/i);
  }
  assert.deepEqual(fs.readFileSync(path.join(dados, "remoteifes.db")), antes, "nada pode ser tocado numa recusa de argumento");
});

test("a restauração exige quiescência: com a aplicação no ar ela não instala nada", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");
  const banco = path.join(dados, "remoteifes.db");
  criarBancoDeTeste(banco, { usuarios: 2 });
  const antes = fs.readFileSync(banco);

  criarBancoDeTeste(path.join(dados, "backups", "remoteifes-20260101-010101-abcdef.db"), { usuarios: 1 });

  const { codigo, saida } = await rodarRunner("restaurar.js", ["remoteifes-20260101-010101-abcdef.db"], {
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_ESTADO_DIR: amb.estadoDir,
    CONSOLE_SEM_PRIVILEGIO: "1",
  });

  assert.equal(codigo, 1, `sem conseguir parar a aplicação, a restauração tem de falhar. Saída:
${saida}`);
  // Sem controle de ciclo de vida nesta plataforma e com a aplicação respondendo, a restauração
  // recusa em vez de presumir que o silêncio do /health prova ausência de escritor.
  assert.match(saida, /continua respondendo e o console não tem como pará-la/);
  assert.ok(!/Instalando o backup/.test(saida), "nada pode ser instalado sem quiescência comprovada");
  assert.deepEqual(fs.readFileSync(banco), antes, "o banco atual não pode ser tocado quando a quiescência falha");
  assert.ok(!fs.existsSync(`${banco}.incoming-`), "nenhum arquivo intermediário pode sobrar");
});

test("observar o banco não cria nem altera arquivo no diretório de dados", (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");

  // Sem banco: observar não pode criá-lo.
  const semBanco = amb.coleta.espiarBanco();
  assert.equal(semBanco.existe, false);
  assert.ok(!fs.existsSync(path.join(dados, "remoteifes.db")), "observar não pode criar o banco");

  criarBancoDeTeste(path.join(dados, "remoteifes.db"), { usuarios: 3 });
  // O criador fechou a conexão; -shm e -wal não ficam para trás.
  const antes = fs.readdirSync(dados).sort();

  // Com a aplicação parada (padrão), a leitura de conteúdo é recusada de propósito: abrir um
  // banco WAL criaria -shm/-wal a partir de um processo que só deveria observar.
  const espiada = amb.coleta.espiarBanco();
  assert.equal(espiada.existe, true);
  assert.equal(espiada.lido, false);
  assert.match(espiada.erro, /criaria arquivos auxiliares/);
  assert.equal(espiada.bytes > 0, true, "os metadados do arquivo continuam disponíveis");
  assert.deepEqual(fs.readdirSync(dados).sort(), antes, "nenhum arquivo novo pode aparecer");

  // Com a aplicação no ar o console lê o conteúdo: aí o banco já está aberto por outro processo.
  const comPermissao = amb.coleta.espiarBanco({ permitirLeitura: true });
  assert.equal(comPermissao.lido, true);
  assert.equal(comPermissao.usuarios, 3);
});

test("o escopo dos backups é declarado com honestidade", async (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/backups", { cookie: sessao.cookie, origem: s.base });
  assert.equal(r.status, 200);
  assert.match(r.json.escopo, /Não incluem \.env/);
  assert.match(r.json.escopo, /credenciais de dispositivo/);
});
