// Disaster-recovery drill on an isolated server, with the production tools:
//
//   working system → verified backup (backup-db.js) → loss or corruption → restore
//   (restore-backup.js) → restart → /health → the data is checked
//
// Scenarios: the database deleted; the database corrupted (quarantined, never deleted); invalid
// backups refused with the current data untouched; the restore marker keeping the server from
// opening the database mid-restore, and a stale marker not keeping it down.
//
// Nothing here touches a real installation: the server runs on a temporary data directory, removed
// at the end.
//
//   node ensaio-recuperacao.js [--json resultado.json]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { iniciarServidorIsolado, RAIZ_SERVIDOR } = require("./test/support/servidor-isolado");
const { Bancada } = require("./test/support/bancada-dispositivos");

const SENHA_USUARIO = "usuario-do-ensaio-de-recuperacao";

function hash(arquivo) {
  return crypto.createHash("sha256").update(fs.readFileSync(arquivo)).digest("hex");
}

/** Runs a production command-line tool against the isolated server's data directory. */
function cli(servidor, script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: RAIZ_SERVIDOR, env: servidor.ambiente, encoding: "utf8", timeout: 120_000 });
  return { codigo: r.status, saida: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * What must survive: accounts, room configuration, device credentials and firmware records,
 * settings, schedules and the command history. Read from the database file with the server stopped.
 */
function impressao(caminho, salas) {
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    const todas = (sql, ...p) => db.prepare(sql).all(...p);
    return {
      usuarios: todas("SELECT usuario, nivel, podeControlar, ativo FROM usuarios ORDER BY usuario"),
      salas: todas(`SELECT sala, irProtocolo, mac, fwVersao FROM salas WHERE sala IN (${salas.map(() => "?").join(",")}) ORDER BY sala`, ...salas),
      credenciais: todas(`SELECT sala, deviceId, revogadoEm FROM esp_credenciais WHERE sala IN (${salas.map(() => "?").join(",")}) ORDER BY sala`, ...salas),
      configuracoes: todas("SELECT chave, valor FROM configuracoes ORDER BY chave"),
      agendamentos: todas("SELECT sala, data, horaInicio, horaFim FROM agendamentos ORDER BY id"),
      comandos: todas("SELECT sala, cmd FROM comandos_log WHERE origem = 'manual' ORDER BY id"),
    };
  } finally {
    db.close();
  }
}

function horaBrasilia(deslocamentoMin = 0) {
  const d = new Date(Date.now() + deslocamentoMin * 60_000 - 3 * 3600_000);
  return { data: d.toISOString().slice(0, 10), hora: d.toISOString().slice(11, 16) };
}

async function prepararSistema(servidor, bancada) {
  const lista = (await servidor.api("GET", "/salas")).corpo;
  const salas = (Array.isArray(lista) ? lista : lista.salas).slice(0, 2).map((s) => s.sala);
  const credenciais = {};
  for (const sala of salas) {
    const c = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {});
    if (c.status !== 200) throw new Error(`provisionar ${sala}: ${c.status}`);
    credenciais[sala] = { deviceId: c.corpo.deviceId, segredo: c.corpo.segredo };
    await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 });
  }
  const u = await servidor.api("POST", "/admin/usuarios", { usuario: "ensaio.operador", senha: SENHA_USUARIO, nome: "Operador do ensaio", podeControlar: true });
  if (u.status !== 200) throw new Error(`criar usuário: ${u.status} ${JSON.stringify(u.corpo)}`);
  const cfg = await servidor.api("PATCH", "/admin/configuracoes", { retencaoAuditoriaDias: 123 });
  if (cfg.status !== 200) throw new Error(`configurações: ${cfg.status}`);
  // A reservation later today (the API only accepts today's date), when the day still has room.
  const inicio = horaBrasilia(60);
  const fim = horaBrasilia(90);
  let agendamento = null;
  if (inicio.data === horaBrasilia().data && fim.data === inicio.data) {
    const a = await servidor.api("POST", "/agendamentos", { sala: salas[0], data: inicio.data, horaInicio: inicio.hora, horaFim: fim.hora, temperatura: 23, modo: "reserva" });
    agendamento = a.status === 200 ? a.corpo.agendamento : null;
  }
  // A board connects (MAC, firmware and online records) and a command goes through.
  const placa = bancada.placa({ credencial: credenciais[salas[1]], sala: salas[1], mac: "AA:D1:00:00:00:01", fw: "4.3.0" });
  await placa.conectar();
  const r = await servidor.api("POST", "/comando", { sala: salas[1], cmd: "ligar" });
  if (r.status !== 200) throw new Error(`comando: ${r.status}`);
  await placa.aguardar((m) => m.tipo === "send_known_state" && m.restauracao !== true);
  await placa.fechar();
  return { salas, credenciais, agendamento: !!agendamento };
}

/** After a restart: health, the accounts log in, and a board with a restored credential connects. */
async function verificarEmFuncionamento(servidor, bancada, sistema) {
  const saude = await (await fetch(`${servidor.base}/health`)).json();
  if (saude.ok !== true) throw new Error(`/health: ${JSON.stringify(saude)}`);
  servidor.token = null;
  await servidor.api("GET", "/salas");
  const login = await fetch(`${servidor.base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usuario: "ensaio.operador", senha: SENHA_USUARIO }) });
  if (login.status !== 200) throw new Error(`o usuário restaurado não entra (${login.status})`);
  const sala = sistema.salas[1];
  const placa = bancada.placa({ credencial: sistema.credenciais[sala], sala, mac: "AA:D1:00:00:00:01", fw: "4.3.0" });
  await placa.conectar();
  await placa.fechar();
  return { saude: saude.ok, loginSuperadmin: true, loginUsuario: true, credencialRestaurada: true };
}

function invalidos(dir, backupValido) {
  const casos = {};
  const escrever = (nome, conteudo) => {
    const arquivo = path.join(dir, nome);
    fs.writeFileSync(arquivo, conteudo);
    return arquivo;
  };
  const bytes = fs.readFileSync(backupValido);
  casos.truncado = escrever("truncado.db", bytes.subarray(0, Math.floor(bytes.length / 2)));
  casos.bytesAleatorios = escrever("aleatorio.db", crypto.randomBytes(64 * 1024));
  casos.arquivoDeTexto = escrever("texto.db", "isto não é um banco SQLite\n");
  casos.vazio = escrever("vazio.db", "");
  // A valid SQLite file that is not a RemoteIFES database.
  const outro = path.join(dir, "outro-sqlite.db");
  const d1 = new DatabaseSync(outro);
  d1.exec("CREATE TABLE qualquer (x)");
  d1.close();
  casos.outroBancoSqlite = outro;
  // The right schema with inconsistent contents: no account at all, and a dangling reference.
  for (const [nome, sql] of [
    ["sem-usuarios.db", "PRAGMA foreign_keys = OFF; DELETE FROM usuarios"],
    ["referencia-quebrada.db", "PRAGMA foreign_keys = OFF; INSERT INTO sala_acessos (sala, usuarioId) VALUES ((SELECT sala FROM salas LIMIT 1), 999999)"],
  ]) {
    const arquivo = path.join(dir, nome);
    fs.copyFileSync(backupValido, arquivo);
    const d = new DatabaseSync(arquivo);
    d.exec(sql);
    d.close();
    casos[nome.replace(".db", "")] = arquivo;
  }
  casos.diretorio = dir;
  casos.inexistente = path.join(dir, "nao-existe.db");
  return casos;
}

function sobras(dirDados) {
  return fs.readdirSync(dirDados).filter((n) => /\.incoming-|\.rollback-|^\.tmp-/.test(n));
}

async function executarEnsaio({ log = () => {} } = {}) {
  const inicio = Date.now();
  const servidor = await iniciarServidorIsolado();
  const bancada = new Bancada({ porta: servidor.porta });
  const cenarios = [];
  const cenario = async (nome, fn) => {
    const t0 = Date.now();
    try {
      const detalhe = await fn();
      cenarios.push({ nome, ok: true, duracaoMs: Date.now() - t0, detalhe });
      log(`ok     ${nome}`);
    } catch (erro) {
      cenarios.push({ nome, ok: false, duracaoMs: Date.now() - t0, erro: erro.message });
      log(`FALHOU ${nome}: ${erro.message}`);
    }
  };

  try {
    const db = servidor.caminhoBanco;
    const dirBackups = path.join(servidor.dir, "backups");
    const sistema = await prepararSistema(servidor, bancada);

    let backup;
    let esperado;
    await cenario("backup verificado com o servidor em funcionamento", async () => {
      const r = cli(servidor, "backup-db.js", ["ensaio"]);
      if (r.codigo !== 0) throw new Error(r.saida);
      backup = fs.readdirSync(dirBackups).find((n) => n.endsWith("-ensaio.db"));
      if (!backup) throw new Error("o backup não foi criado");
      backup = path.join(dirBackups, backup);
      await servidor.parar();
      esperado = impressao(db, sistema.salas);
      if (JSON.stringify(impressao(backup, sistema.salas)) !== JSON.stringify(esperado)) throw new Error("o backup não reflete o banco em uso");
      await servidor.subir();
      return { arquivo: path.basename(backup), bytes: fs.statSync(backup).size, agendamento: sistema.agendamento };
    });
    if (!backup) throw new Error("sem backup verificado não há o que restaurar");

    await cenario("perda do banco: restauração, reinício e dados conferidos", async () => {
      await servidor.parar();
      for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${db}${s}`, { force: true });
      const r = cli(servidor, "restore-backup.js", [backup, "--sim"]);
      if (r.codigo !== 0) throw new Error(r.saida);
      if (JSON.stringify(impressao(db, sistema.salas)) !== JSON.stringify(esperado)) throw new Error("os dados restaurados divergem do backup");
      await servidor.subir();
      return verificarEmFuncionamento(servidor, bancada, sistema);
    });

    await cenario("banco corrompido: recusado por padrão, quarentenado e substituído sob pedido explícito", async () => {
      await servidor.parar();
      const fd = fs.openSync(db, "r+");
      fs.writeSync(fd, Buffer.alloc(100, 0), 0, 100, 0);
      fs.closeSync(fd);
      const corrompido = hash(db);
      const recusa = cli(servidor, "restore-backup.js", [backup, "--sim"]);
      if (recusa.codigo === 0) throw new Error("a restauração sobre um banco corrompido deveria exigir --recuperar-corrompido");
      if (hash(db) !== corrompido) throw new Error("a recusa alterou o banco atual");
      // The refusal happened after the marker was published: it must not keep the server down.
      if (fs.existsSync(`${db}.restauracao`)) throw new Error("a restauração recusada deixou o marcador para trás");
      const r = cli(servidor, "restore-backup.js", [backup, "--sim", "--recuperar-corrompido"]);
      if (r.codigo !== 0) throw new Error(r.saida);
      const quarentena = fs.readdirSync(servidor.dir).filter((n) => n.includes(".corrompido-"));
      if (!quarentena.some((n) => !/-(wal|shm)$/.test(n) && hash(path.join(servidor.dir, n)) === corrompido)) {
        throw new Error("o banco danificado não ficou preservado em quarentena");
      }
      if (JSON.stringify(impressao(db, sistema.salas)) !== JSON.stringify(esperado)) throw new Error("os dados restaurados divergem do backup");
      await servidor.subir();
      return { quarentena, ...(await verificarEmFuncionamento(servidor, bancada, sistema)) };
    });

    await cenario("backups inválidos são recusados e o banco atual fica intacto", async () => {
      await servidor.parar();
      const antes = hash(db);
      const dirInvalidos = fs.mkdtempSync(path.join(servidor.dir, "invalidos-"));
      const resultados = {};
      for (const [nome, arquivo] of Object.entries(invalidos(dirInvalidos, backup))) {
        const r = cli(servidor, "restore-backup.js", [arquivo, "--sim"]);
        resultados[nome] = r.codigo;
        if (r.codigo === 0) throw new Error(`${nome} foi aceito como backup`);
        if (hash(db) !== antes) throw new Error(`${nome} alterou o banco atual`);
      }
      const restos = sobras(servidor.dir);
      if (restos.length) throw new Error(`arquivos temporários deixados para trás: ${restos.join(", ")}`);
      await servidor.subir();
      await verificarEmFuncionamento(servidor, bancada, sistema);
      return { codigosDeSaida: resultados };
    });

    await cenario("a restauração é recusada com o servidor em funcionamento", async () => {
      // The server is up here: swapping its database under it would lose what it writes next.
      const r = cli(servidor, "restore-backup.js", [backup, "--sim"]);
      if (r.codigo === 0) throw new Error("a restauração foi feita com o servidor no ar");
      if (!/está respondendo/.test(r.saida)) throw new Error(`a recusa não disse por quê: ${r.saida.slice(-300)}`);
      if (fs.existsSync(`${db}.restauracao`)) throw new Error("a recusa deixou o marcador de restauração");
      return verificarEmFuncionamento(servidor, bancada, sistema);
    });

    await cenario("o marcador de restauração impede o servidor de abrir o banco, e um marcador órfão não", async () => {
      await servidor.parar();
      const marcador = `${db}.restauracao`;
      // A live process holds the restore (this drill's own process).
      fs.writeFileSync(marcador, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
      let subiu = true;
      try {
        await servidor.subir();
      } catch {
        subiu = false;
      }
      if (subiu) throw new Error("o servidor abriu o banco durante uma restauração em andamento");
      if (!/restaura[çc][ãa]o do banco em andamento/.test(servidor.saida)) throw new Error("o servidor não disse por que não subiu");
      // The restoring process died without removing its marker.
      const efemero = spawn(process.execPath, ["-e", ""]);
      await new Promise((r) => efemero.once("exit", r));
      fs.writeFileSync(marcador, JSON.stringify({ pid: efemero.pid, desde: new Date().toISOString() }));
      await servidor.subir();
      fs.rmSync(marcador, { force: true });
      return verificarEmFuncionamento(servidor, bancada, sistema);
    });
  } finally {
    await bancada.encerrar().catch(() => {});
    await servidor.encerrar().catch(() => {});
  }
  return { ok: cenarios.length >= 6 && cenarios.every((c) => c.ok), duracaoS: Math.round((Date.now() - inicio) / 1000), cenarios };
}

if (require.main === module) {
  const i = process.argv.indexOf("--json");
  const json = i >= 0 ? process.argv[i + 1] : null;
  console.log("--- Simulado de recuperação de desastre (instância isolada, ferramentas de produção) ---");
  executarEnsaio({ log: (l) => console.log(l) })
    .then((r) => {
      console.log(r.ok ? `Resultado: recuperação comprovada em ${r.cenarios.length} cenários (${r.duracaoS} s).` : "Resultado: FALHOU");
      if (json) fs.writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`);
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((erro) => {
      console.error(`Simulado interrompido: ${erro.stack || erro.message}`);
      process.exitCode = 1;
    });
}

module.exports = { executarEnsaio };
