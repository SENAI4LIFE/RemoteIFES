#!/usr/bin/env node
// Medição do custo de recursos do console.
//
// Existe porque "o console é leve" não é afirmação verificável. Este script mede, no host em
// que roda, os números que sustentam (ou derrubam) a escolha de arquitetura:
//
//   1. console desligado                -> processos e RSS do console: zero, por construção
//   2. console ligado, sem navegador    -> partida do processo e RSS logo após subir
//   3. painel aberto e ocioso           -> custo de uma tela aberta sem interação
//   4. atualização de status            -> custo por requisição de /api/painel
//   5. leitura de registros             -> custo de uma leitura de journal
//   6. manutenção representativa        -> custo de uma operação real (backup)
//
// Ele NÃO extrapola: imprime o host real onde mediu. Num Raspberry Pi 3 os números serão
// diferentes dos de um desktop, e o relatório diz isso em voz alta.
//
// Uso:  node test/medicao-recursos.js [--json]

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const RAIZ = path.join(__dirname, "..");
const JSON_SAIDA = process.argv.includes("--json");

// O diretório de estado precisa estar definido antes de qualquer require de src/,
// porque config.js lê o ambiente no carregamento e fica em cache.
const ESTADO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "console-medicao-"));
process.env.CONSOLE_ESTADO_DIR = ESTADO_DIR;
process.env.CONSOLE_SEM_PRIVILEGIO = "1";

function agora() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function rssDe(pid) {
  if (process.platform === "linux") {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
      if (m) return Number(m[1]) * 1024;
    } catch {}
  }
  return null;
}

function pedir(porta, caminho, cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    const inicio = agora();
    const req = http.request(
      { host: "127.0.0.1", port: porta, path: caminho, method: "GET", headers: { Host: `127.0.0.1:${porta}`, ...cabecalhos }, timeout: 30_000 },
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

  // 1. Console desligado.
  resultados.cenarios.desligado = {
    descricao: "console instalado com ativação por socket, sem ninguém usando",
    processosNode: 0,
    rssBytes: 0,
    observacao:
      "Com ativação por socket, o systemd guarda a porta e nenhum processo do console existe. " +
      "Este zero é estrutural, não uma medição de um processo enxuto.",
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

  // 3-6: cenários autenticados.
  const auth = require(path.join(RAIZ, "src", "auth"));

  // O operador é criado pelo próprio processo de medição, no mesmo diretório de estado.
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

  // 3. Painel aberto e ocioso: a interface não faz polling; mede o repouso.
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

  // 4. Atualização de status.
  const amostrasPainel = [];
  for (let i = 0; i < 10; i += 1) {
    const r = await pedir(porta, "/api/painel", cabecalhosSessao);
    amostrasPainel.push(r.ms);
  }
  amostrasPainel.sort((a, b) => a - b);
  resultados.cenarios.atualizacaoDeStatus = {
    descricao: "GET /api/painel (serviço, watchdog, host, backups, versões)",
    amostras: amostrasPainel.length,
    medianaMs: Number(amostrasPainel[Math.floor(amostrasPainel.length / 2)].toFixed(1)),
    piorMs: Number(amostrasPainel.at(-1).toFixed(1)),
    rssBytes: rssDe(filho.pid),
  };

  // 5. Leitura de registros.
  const log = await pedir(porta, "/api/logs?unidade=aplicacao&linhas=200", cabecalhosSessao);
  resultados.cenarios.leituraDeRegistros = {
    descricao: "GET /api/logs com 200 linhas",
    ms: Number(log.ms.toFixed(1)),
    bytesResposta: Buffer.byteLength(log.texto),
    rssBytes: rssDe(filho.pid),
    observacao: "Neste host o journal não existe; o custo real no Pi inclui o journalctl invocado pelo auxiliar.",
  };

  // 6. Manutenção representativa: um backup do banco, se houver banco.
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

  // 7. Terminal, se o PTY estiver disponível.
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
    process.platform !== "linux"
      ? "RSS por processo não é lido fora do Linux: os campos rssBytes vêm nulos."
      : null,
    "Nenhuma medição foi feita contra dispositivos ESP32 reais nem contra dados de produção.",
  ].filter(Boolean);

  return resultados;
}

medir()
  .then((r) => {
    if (JSON_SAIDA) {
      console.log(JSON.stringify(r, null, 2));
      return;
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
  })
  .catch((erro) => {
    console.error(`falha na medição: ${erro.message}`);
    process.exit(1);
  });
