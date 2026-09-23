#!/usr/bin/env node
// Ciclo de vida da aplicação, portátil.
//
// Substitui `bin/servico.sh`, que dependia de bash e do auxiliar systemd. A sequência continua
// a mesma e pelo mesmo motivo: parar a aplicação sem desligar o watchdog não é uma parada
// durável (no Linux ele reinicia em até ~6 min, após 3 falhas do /health em intervalos de
// 2 min), e iniciar sem religá-lo deixa o host sem recuperação automática. Onde não há
// watchdog — Windows e macOS —, o passo é declarado "não aplicável" em vez de silenciosamente
// pulado.
//
// Uso: node bin/servico.js {reiniciar|parar|iniciar|reiniciar-host}

const path = require("path");

const raiz = path.join(__dirname, "..");
const coleta = require(path.join(raiz, "src", "coleta"));
const plataforma = require(path.join(raiz, "src", "plataforma"));

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function saudavel({ tentativas, intervaloMs }) {
  for (let i = 0; i < tentativas; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 3000 });
    if (saude.respondeu && saude.ok) return saude;
    await esperar(intervaloMs);
  }
  return null;
}

async function mudo({ tentativas, intervaloMs }) {
  for (let i = 0; i < tentativas; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
    if (!saude.respondeu) return true;
    await esperar(intervaloMs);
  }
  return false;
}

async function reiniciar() {
  log("== Reiniciando o serviço da aplicação");
  const r = await plataforma.controlarServico("reiniciar");
  if (!r.disponivel) {
    console.error(`não foi possível reiniciar: ${r.motivo}`);
    return 1;
  }
  log("== Aguardando o /health responder saudável");
  const saude = await saudavel({ tentativas: 20, intervaloMs: 2000 });
  if (!saude) {
    console.error("ATENÇÃO: o serviço foi reiniciado, mas o /health não respondeu saudável no prazo.");
    console.error("Verifique os registros da aplicação antes de concluir que a operação deu certo.");
    return 1;
  }
  log(`/health ok — banco ${saude.banco}, commit ${saude.commit ? saude.commit.slice(0, 12) : "não informado"}.`);
  return 0;
}

async function parar() {
  const watchdog = await plataforma.estadoDoWatchdog();
  if (watchdog.disponivel && watchdog.ativo) {
    log("== Desligando o watchdog de saúde");
    log("Sem isso, o watchdog reiniciaria a aplicação em poucos minutos e a parada não seria durável.");
    const r = await plataforma.controlarWatchdog("desligar");
    if (!r.disponivel) {
      console.error(`não foi possível desligar o watchdog (${r.motivo}); abortando para não parar a aplicação sem controle.`);
      return 1;
    }
  } else {
    log(`== Watchdog: ${watchdog.disponivel ? "já estava desligado" : watchdog.motivo}`);
  }

  log("== Parando o serviço da aplicação");
  const r = await plataforma.controlarServico("parar");
  if (!r.disponivel) {
    console.error(`não foi possível parar: ${r.motivo}`);
    return 1;
  }

  log("== Confirmando que a aplicação parou de responder");
  if (!(await mudo({ tentativas: 15, intervaloMs: 1000 }))) {
    console.error("ATENÇÃO: algo continua respondendo na porta da aplicação depois da parada.");
    return 1;
  }
  log("Aplicação parada. Use 'Iniciar o RemoteIFES' para voltar à operação normal.");
  return 0;
}

async function iniciar() {
  log("== Iniciando o serviço da aplicação");
  const r = await plataforma.controlarServico("iniciar");
  if (!r.disponivel) {
    console.error(`não foi possível iniciar: ${r.motivo}`);
    return 1;
  }
  const watchdog = await plataforma.estadoDoWatchdog();
  if (watchdog.disponivel) {
    log("== Religando o watchdog de saúde");
    const w = await plataforma.controlarWatchdog("ligar");
    if (!w.disponivel) console.error(`AVISO: o serviço subiu, mas o watchdog não pôde ser religado (${w.motivo}).`);
  }
  log("== Aguardando o /health responder saudável");
  const saude = await saudavel({ tentativas: 20, intervaloMs: 2000 });
  if (!saude) {
    console.error("ATENÇÃO: o serviço foi iniciado, mas o /health não respondeu saudável no prazo.");
    return 1;
  }
  log(`/health ok — banco ${saude.banco}, commit ${saude.commit ? saude.commit.slice(0, 12) : "não informado"}.`);
  return 0;
}

async function reiniciarHost() {
  log("== Reiniciando o host");
  log("A conexão com o console vai cair agora. Reabra a página depois que o host subir.");
  const r = await plataforma.reiniciarHost();
  if (!r.disponivel) {
    console.error(`não foi possível reiniciar o host: ${r.motivo}`);
    return 1;
  }
  log("Pedido de reinício enviado.");
  return 0;
}

const ACOES = { reiniciar, parar, iniciar, "reiniciar-host": reiniciarHost };

const acao = ACOES[process.argv[2]];
if (!acao) {
  console.error("uso: servico.js {reiniciar|parar|iniciar|reiniciar-host}");
  process.exitCode = 2;
} else {
  acao()
    .then((codigo) => {
      process.exitCode = codigo;
    })
    .catch((erro) => {
      console.error(`Erro inesperado: ${erro && erro.message ? erro.message : erro}`);
      process.exitCode = 1;
    });
}
