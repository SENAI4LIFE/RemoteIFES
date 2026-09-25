#!/usr/bin/env node
// Console resource cost measurement.
//
// "The Console is light" is not verifiable by assertion. This script measures, on the host where it
// runs, the numbers that support (or refute) the architecture choice:
//
//   1. Console off                    -> Console processes and RSS: zero, by construction
//   2. Console on, no browser         -> process start and RSS right after startup
//   3. panel open and idle            -> cost of an open screen without interaction
//   4. status refresh                 -> cost per /api/painel request
//   5. log reading                    -> cost of one journal read
//   6. representative maintenance     -> cost of a real operation (backup)
//
// It does NOT extrapolate: it prints the real host where it measured. On a Raspberry Pi 3 the
// numbers will differ from a desktop's, and the report says so.
//
// Usage:  node test/measure-resources.js [--json]

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const RAIZ = path.join(__dirname, "..");
const JSON_SAIDA = process.argv.includes("--json");

// The state directory must be set before any require of src/, because config.js reads the
// environment at load time and is cached.
const ESTADO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "console-medicao-"));
process.env.CONSOLE_ESTADO_DIR = ESTADO_DIR;
process.env.CONSOLE_SEM_PRIVILEGIO = "1";

/**
 * Measures one scenario in isolation. A slow probe must not abort the whole measurement: a report
 * that dies because one read timed out says nothing about the other five, and "not measured,
 * because X" is information while a traceback is not.
 */
async function cenario(nome, fn) {
  try {
    return await fn();
  } catch (erro) {
    return { descricao: nome, medido: false, motivo: erro && erro.message ? erro.message : String(erro) };
  }
}

function agora() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/**
 * Resident memory of the process, on all three systems: /proc on Linux, `ps` on macOS, `tasklist`
 * on Windows (working set, the practical analog of RSS).
 */
function rssDe(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      return m ? Number(m[1]) * 1024 : null;
    }
    if (process.platform === "darwin") {
      const saida = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim();
      return saida ? Number(saida) * 1024 : null;
    }
    if (process.platform === "win32") {
      const saida = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 15_000 });
      // "node.exe","1234","Console","1","52.184 K"  — separador de milhar depende da locale.
      const m = /"([\d.,\u00a0 ]+) K"\s*$/m.exec(saida.trim());
      return m ? Number(m[1].replace(/[^\d]/g, "")) * 1024 : null;
    }
  } catch {}
  return null;
}

/**
 * Start cost of a Node process on this host, to separate what is ours from what is the runtime.
 */
function medirPartida(args) {
  const inicio = agora();
  try {
    execFileSync(process.execPath, args, { stdio: "ignore", timeout: 120_000, env: { ...process.env } });
  } catch {
    return null;
  }
  return Number((agora() - inicio).toFixed(1));
}

function pedir(porta, caminho, cabecalhos = {}, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const inicio = agora();
    const req = http.request(
      { host: "127.0.0.1", port: porta, path: caminho, method: "GET", headers: { Host: `127.0.0.1:${porta}`, ...cabecalhos }, timeout: timeoutMs },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (texto += d));
        res.on("end", () => resolve({ status: res.statusCode, ms: agora() - inicio, texto }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("tempo esgotado"));
    });
    req.on("error", reject);
    req.end();
  });
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function medir() {
  const estadoDir = ESTADO_DIR;
  const porta = 8397;
  const resultados = {
    host: {
      plataforma: `${os.type()} ${os.release()}`,
      arquitetura: os.arch(),
      modelo: (() => {
        try {
          return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
        } catch {
          return (os.cpus()[0] && os.cpus()[0].model) || "desconhecido";
        }
      })(),
      cpus: os.cpus().length,
      memoriaTotalBytes: os.totalmem(),
      node: process.version,
      ehRaspberryPi: (() => {
        try {
          return /Raspberry Pi/i.test(fs.readFileSync("/proc/device-tree/model", "utf8"));
        } catch {
          return false;
        }
      })(),
    },
    cenarios: {},
  };

  // 1. Console off. The zero is the same on all three systems, but the REASON differs, and saying
  // "socket activation" on Windows would describe a mechanism that does not exist there.
  const mecanismoOcioso = {
    linux:
      "Com ativação por socket, o systemd guarda a porta e nenhum processo do console existe. " +
      "Este zero é estrutural, não a medição de um processo enxuto.",
    win32:
      "Não há serviço residente: o console só existe enquanto alguém o usa. Quem o abre é o " +
      "lançador (atalho ou tarefa agendada ONLOGON, que não mantém processo), e ele sai sozinho " +
      "ao ficar ocioso. O zero é o mesmo do Linux, por outro caminho.",
    darwin:
      "Não há serviço residente: o LaunchAgent é instalado com RunAtLoad=false e KeepAlive=false, " +
      "então nada sobe no login. O console existe enquanto alguém o usa e sai sozinho ao ficar " +
      "ocioso. O zero é o mesmo do Linux, por outro caminho.",
  };
  resultados.cenarios.desligado = {
    descricao: "console instalado, sem ninguém usando",
    processosNode: 0,
    rssBytes: 0,
    mecanismo: process.platform === "linux" ? "socket do systemd" : "partida sob demanda pelo lançador",
    observacao: mecanismoOcioso[process.platform] || "Nenhum processo do console fica residente neste sistema.",
  };

  // 1b. Cold open cost: what the operator feels where no socket holds the port. Node alone already
  // costs part of it, and separating the two avoids billing the runtime's price to the Console.
  const partidaNodeVazio = medirPartida(["-e", "0"]);
  const partidaLancador = medirPartida([path.join(RAIZ, "launcher.js"), "--status"]);
  resultados.cenarios.aberturaFria = {
    descricao: "custo de abrir o lançador com o console parado (node frio + código do console)",
    nodeVazioMs: partidaNodeVazio,
    lancadorStatusMs: partidaLancador,
    custoDoConsoleMs:
      partidaNodeVazio !== null && partidaLancador !== null ? Number((partidaLancador - partidaNodeVazio).toFixed(1)) : null,
    observacao:
      "Mede o caminho que o operador percorre onde não há ativação por socket. O lançador ainda " +
      "sonda a saúde da aplicação e o gerenciador de serviços, então parte deste tempo é espera de I/O, não CPU.",
  };

  // 2. Partida do processo.
  const inicioPartida = agora();
  const filho = spawn(process.execPath, [path.join(RAIZ, "console.js")], {
    env: {
      ...process.env,
      CONSOLE_ESTADO_DIR: estadoDir,
      CONSOLE_PORTA: String(porta),
      CONSOLE_OCIOSIDADE_S: "0",
      CONSOLE_SEM_PRIVILEGIO: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saidaProcesso = "";
  filho.stdout.on("data", (d) => (saidaProcesso += d));
  filho.stderr.on("data", (d) => (saidaProcesso += d));

  let pronto = false;
  let msParaAtender = null;
  for (let i = 0; i < 100 && !pronto; i += 1) {
    try {
      const r = await pedir(porta, "/api/sessao");
      if (r.status === 200) {
        pronto = true;
        msParaAtender = agora() - inicioPartida;
      }
    } catch {
      await esperar(50);
    }
  }
  if (!pronto) {
    filho.kill("SIGKILL");
    fs.rmSync(estadoDir, { recursive: true, force: true });
    throw new Error(`console não subiu: ${saidaProcesso}`);
  }

  await esperar(400);
  resultados.cenarios.ligadoSemNavegador = {
    descricao: "processo no ar após a primeira conexão, sem navegador aberto",
    partidaAtePrimeiraRespostaMs: Number(msParaAtender.toFixed(1)),
    processosNode: 1,
    rssBytes: rssDe(filho.pid),
    observacao:
      "Este é o custo pago na primeira conexão depois de um período ocioso. Com saída por " +
      "ociosidade ativa (padrão 900 s), ele volta a zero quando o console deixa de ser usado.",
  };

  // 3-6: authenticated scenarios.
  const auth = require(path.join(RAIZ, "src", "auth"));

  // The operator is created by the measuring process itself, in the same state directory.
  const nome = "medicao";
  const senha = "senha-de-medicao-123456";
  try {
    auth.criarOperador(nome, senha);
  } catch {}

  const login = await new Promise((resolve, reject) => {
    const corpo = JSON.stringify({ nome, senha });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: porta,
        path: "/api/sessao",
        method: "POST",
        headers: { Host: `127.0.0.1:${porta}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo), Origin: `http://127.0.0.1:${porta}` },
      },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (texto += d));
        res.on("end", () => resolve({ status: res.statusCode, texto, cookie: (res.headers["set-cookie"] || [""])[0].split(";")[0] }));
      }
    );
    req.on("error", reject);
    req.end(corpo);
  });
  if (login.status !== 200) throw new Error(`login de medição falhou: ${login.status} ${login.texto}`);
  const cabecalhosSessao = { Cookie: login.cookie, Origin: `http://127.0.0.1:${porta}` };

  // 3. Panel open and idle: the interface does not poll; measures rest.
  const rssAntesRepouso = rssDe(filho.pid);
  await pedir(porta, "/api/painel", cabecalhosSessao);
  await esperar(5000);
  resultados.cenarios.painelAbertoOcioso = {
    descricao: "uma aba aberta na Visão geral, sem interação, por 5 s",
    rssBytes: rssDe(filho.pid),
    crescimentoRssBytes: rssDe(filho.pid) !== null && rssAntesRepouso !== null ? rssDe(filho.pid) - rssAntesRepouso : null,
    requisicoesEmSegundoPlano: 0,
    observacao: "A interface não faz polling automático: uma aba aberta e parada não gera requisição nem trabalho.",
  };

  // 4. Status refresh.
  resultados.cenarios.atualizacaoDeStatus = await cenario(
    "GET /api/painel (serviço, watchdog, host, backups, versões)",
    async () => {
      const amostras = [];
      for (let i = 0; i < 10; i += 1) {
        const r = await pedir(porta, "/api/painel", cabecalhosSessao, { timeoutMs: 60_000 });
        amostras.push(r.ms);
      }
      amostras.sort((a, b) => a - b);
      return {
        descricao: "GET /api/painel (serviço, watchdog, host, backups, versões)",
        amostras: amostras.length,
        medianaMs: Number(amostras[Math.floor(amostras.length / 2)].toFixed(1)),
        piorMs: Number(amostras.at(-1).toFixed(1)),
        rssBytes: rssDe(filho.pid),
      };
    }
  );

  // 5. Leitura de registros.
  resultados.cenarios.leituraDeRegistros = await cenario("GET /api/logs com 200 linhas", async () => {
  const log = await pedir(porta, "/api/logs?unidade=aplicacao&linhas=200", cabecalhosSessao, { timeoutMs: 90_000 });
  return {
    descricao: "GET /api/logs com 200 linhas",
    ms: Number(log.ms.toFixed(1)),
    bytesResposta: Buffer.byteLength(log.texto),
    rssBytes: rssDe(filho.pid),
    observacao:
      process.platform === "linux"
        ? "No Pi o custo real inclui o journalctl invocado pelo auxiliar privilegiado."
        : process.platform === "win32"
          ? "No Windows a leitura passa por Get-WinEvent num PowerShell novo; o tempo acima é dominado por essa partida."
          : "No macOS a leitura passa por `log show`; o tempo acima é dominado por essa consulta.",
  };
  });

  // 6. Representative maintenance: a database backup, if there is a database.
  const config = require(path.join(RAIZ, "src", "config"));
  const app = config.caminhosDaAplicacao();
  if (fs.existsSync(app.banco)) {
    const inicio = agora();
    const backup = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(RAIZ, "bin", "backup.js"), "medicao"], {
        env: { ...process.env, CONSOLE_ESTADO_DIR: estadoDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let texto = "";
      p.stdout.on("data", (d) => (texto += d));
      p.stderr.on("data", (d) => (texto += d));
      p.on("close", (codigo) => resolve({ codigo, texto }));
    });
    resultados.cenarios.manutencaoRepresentativa = {
      descricao: "backup do banco (VACUUM INTO + verificação de integridade)",
      ms: Number((agora() - inicio).toFixed(1)),
      ok: backup.codigo === 0,
      bancoBytes: fs.statSync(app.banco).size,
      observacao: "O custo cresce com o tamanho do banco; no Pi some CPU e I/O de cartão SD ao número.",
    };
  } else {
    resultados.cenarios.manutencaoRepresentativa = {
      descricao: "backup do banco",
      executado: false,
      motivo: `nenhum banco em ${app.banco} neste host`,
    };
  }

  // 7. Terminal, if the PTY is available.
  const terminal = require(path.join(RAIZ, "src", "terminal"));
  const disp = terminal.disponibilidade();
  resultados.cenarios.terminal = disp.disponivel
    ? { descricao: "sessão de terminal aberta", medido: false, observacao: "medição de terminal exige sessão interativa; não incluída nesta passagem automática" }
    : { descricao: "sessão de terminal", disponivel: false, motivo: disp.motivo };

  filho.kill("SIGTERM");
  await esperar(500);
  try {
    filho.kill("SIGKILL");
  } catch {}
  fs.rmSync(estadoDir, { recursive: true, force: true });

  resultados.ressalvas = [
    resultados.host.ehRaspberryPi
      ? "Medido em Raspberry Pi: os números valem para o alvo."
      : "NÃO medido em Raspberry Pi 3. Estes números descrevem apenas o host acima e não podem ser " +
        "apresentados como desempenho do Pi. Para obter os valores do alvo, rode este mesmo script no Pi.",
    resultados.cenarios.ligadoSemNavegador.rssBytes === null
      ? `Não foi possível ler a memória residente neste host (${process.platform}); os campos rssBytes vêm nulos.`
      : null,
    process.platform !== "linux"
      ? "Sem systemd, o zero ocioso vem da saída por ociosidade do próprio console, não de um " +
        "socket guardado pelo sistema: se o processo for iniciado à mão e ninguém o fechar, ele não sai sozinho."
      : null,
    "Nenhuma medição foi feita contra dispositivos ESP32 reais nem contra dados de produção.",
    ...Object.entries(resultados.cenarios)
      .filter(([, c]) => c.medido === false)
      .map(([nome, c]) => `Cenário "${nome}" NÃO foi medido neste host: ${c.motivo}.`),
  ].filter(Boolean);

  return resultados;
}

medir()
  .then((r) => {
    if (JSON_SAIDA) {
      console.log(JSON.stringify(r, null, 2));
      return r;
    }
    const mib = (b) => (b === null || b === undefined ? "n/d" : `${(b / 1048576).toFixed(1)} MiB`);
    console.log("Medição de recursos do Console de Operações");
    console.log("===========================================\n");
    console.log(`Host:   ${r.host.modelo}`);
    console.log(`        ${r.host.plataforma} · ${r.host.arquitetura} · ${r.host.cpus} CPU · ${mib(r.host.memoriaTotalBytes)} RAM`);
    console.log(`Node:   ${r.host.node}\n`);
    for (const [nome, c] of Object.entries(r.cenarios)) {
      console.log(`- ${nome}: ${c.descricao}`);
      for (const [chave, valor] of Object.entries(c)) {
        if (chave === "descricao") continue;
        const formatado = /rss|Bytes/i.test(chave) && typeof valor === "number" ? mib(valor) : valor;
        console.log(`    ${chave}: ${formatado}`);
      }
      console.log("");
    }
    console.log("Ressalvas:");
    r.ressalvas.forEach((o) => console.log(`  * ${o}`));
    return r;
  })
  .then((r) => {
    if (!r) return;
    // A MANDATORY scenario that was not measured is a measurement failure, not an informational
    // field. Tolerating everything would let the CI step pass green with no numbers at all.
    const OBRIGATORIOS = ["ligadoSemNavegador", "atualizacaoDeStatus"];
    const faltando = OBRIGATORIOS.filter((nome) => !r.cenarios[nome] || r.cenarios[nome].medido === false);
    if (faltando.length) {
      console.error(`
medição incompleta: ${faltando.join(", ")} não foi medido neste host.`);
      process.exitCode = 1;
    }
  })
  .catch((erro) => {
    console.error(`falha na medição: ${erro.message}`);
    process.exit(1);
  });
