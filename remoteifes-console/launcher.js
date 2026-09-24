#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");

const raiz = path.join(__dirname);
const config = require(path.join(raiz, "src", "config"));
const plataforma = require(path.join(raiz, "src", "plataforma"));
const moduloIdentidade = require(path.join(raiz, "src", "identidade"));

// Lançador do Console de Operações.
//
// É o que o atalho do menu Iniciar, o `.desktop` e o bundle `.app` executam. Ele resolve três
// coisas que abrir um navegador na porta 8099 não resolve:
//
//  1. **partida sob demanda** — sobe o backend se ele não estiver no ar e espera ficar pronto;
//  2. **identidade do listener** — confere que quem atende na porta é o console instalado antes
//     de mandar o operador digitar a senha ali;
//  3. **instância única** — se já há console no ar, apenas abre o navegador.
//
// Nenhuma credencial entra em URL, argumento de processo ou atalho. O que viaja é um desafio
// aleatório; a prova é um HMAC calculado com um segredo que só existe no arquivo protegido de
// estado — um impostor que tenha tomado a porta não consegue produzi-lo.

// Prazo para o backend ficar pronto. Ajustável porque um Raspberry Pi frio leva mais tempo que
// um desktop, e porque um teste não deve gastar 30 s provando que a espera termina.
const ESPERA_MAXIMA_MS = Number(process.env.CONSOLE_LANCADOR_ESPERA_MS) > 0 ? Number(process.env.CONSOLE_LANCADOR_ESPERA_MS) : 30_000;

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

function erro(linha) {
  process.stderr.write(`${linha}\n`);
}

// A leitura do contrato e a prova de identidade moram em src/identidade.js: o desinstalador faz
// a mesma pergunta antes de encerrar um processo, e duas implementações da mesma prova é uma a
// mais do que se pode auditar.
const lerContrato = (...a) => moduloIdentidade.lerContrato(...a);
const verificarIdentidade = (...a) => moduloIdentidade.verificarIdentidade(...a);


function pedir(porta, caminho, { metodo = "GET", corpo = null, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const dados = corpo === null ? null : JSON.stringify(corpo);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: porta,
        path: caminho,
        method: metodo,
        timeout: timeoutMs,
        headers: {
          Host: `127.0.0.1:${porta}`,
          ...(dados ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(dados) } : {}),
        },
      },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (texto.length < 64 * 1024) texto += d;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {}
          resolve({ ok: res.statusCode === 200, status: res.statusCode, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: "tempo esgotado" });
    });
    req.on("error", (e) => resolve({ ok: false, erro: e.code || e.message }));
    if (dados) req.end(dados);
    else req.end();
  });
}

/**
 * Prova de identidade do listener.
 *
 * Sem isto, o lançador abriria o navegador em qualquer processo que tivesse tomado a porta
 * primeiro — um phishing local com página de login idêntica. O desafio é aleatório a cada
 * verificação, e a resposta é `HMAC-SHA256(segredo, desafio)`; o segredo vive só no arquivo de
 * estado protegido, que o impostor não lê.
 */

function backendNoAr(contrato) {
  if (!contrato) return false;
  try {
    process.kill(contrato.pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function esperarPronto({ timeoutMs = ESPERA_MAXIMA_MS } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const contrato = lerContrato();
    if (contrato) {
      const identidade = await verificarIdentidade(contrato);
      if (identidade.ok) return { ok: true, contrato, versao: identidade.versao };
      if (identidade.impostor) return { ok: false, ...identidade };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, motivo: `o console não ficou pronto em ${Math.round(timeoutMs / 1000)}s` };
}

function caminhoDoBackend() {
  // Camada estável: o bootstrap resolve a versão ativa. Em desenvolvimento, console.js direto.
  const bootstrap = path.join(config.RAIZ_INSTALACAO, "console-bootstrap.js");
  return fs.existsSync(bootstrap) ? bootstrap : path.join(raiz, "console.js");
}

/** A porta aceita conexão? Distingue "ninguém ali" de "reservada por alguém". */
function portaOcupada(porta) {
  return new Promise((resolver) => {
    const socket = net.connect({ host: "127.0.0.1", port: porta });
    const encerrar = (valor) => {
      socket.destroy();
      resolver(valor);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => encerrar(true));
    socket.once("timeout", () => encerrar(false));
    socket.once("error", () => encerrar(false));
  });
}

/** Uma conexão HTTP qualquer, só para que o systemd ative o serviço por trás do socket. */
function tocarPorta(porta) {
  return new Promise((resolver) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: "/api/sessao", method: "GET", timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () => resolver(true));
    });
    req.on("timeout", () => {
      req.destroy();
      resolver(false);
    });
    req.on("error", () => resolver(false));
    req.end();
  });
}

async function garantirBackend() {
  const contrato = lerContrato();
  if (contrato) {
    const identidade = await verificarIdentidade(contrato);
    if (identidade.ok) return { ok: true, jaEstava: true, contrato, versao: identidade.versao };
    if (identidade.impostor) return { ok: false, ...identidade };
    // Contrato velho de um processo que morreu: seguir e subir um novo.
    if (backendNoAr(contrato)) {
      return { ok: false, motivo: `o processo ${contrato.pid} está vivo mas não responde; encerre-o antes de tentar de novo` };
    }
  }

  // Se alguém já detém a porta sem haver contrato, o caminho certo é **conectar**, não subir
  // outro processo.
  //
  // É o estado normal de um Linux com ativação por socket depois da saída por ociosidade: o
  // contrato foi apagado, mas o systemd continua dono da porta. Criar um backend TCP ali recebe
  // EADDRINUSE, e o lançador reportaria falha exatamente no estado que o desenho pretende.
  // Uma conexão basta para o systemd subir o serviço; então o contrato novo aparece.
  if (await portaOcupada(config.PORTA)) {
    log("A porta já está reservada (ativação por socket); conectando para ativar o serviço...");
    await tocarPorta(config.PORTA);
    const ativado = await esperarPronto();
    if (ativado.ok) return { ok: true, jaEstava: false, contrato: ativado.contrato, versao: ativado.versao };
    return {
      ok: false,
      motivo:
        `a porta ${config.PORTA} está ocupada, mas o console não publicou identidade depois da conexão ` +
        `(${ativado.motivo}). Verifique quem detém a porta antes de prosseguir.`,
    };
  }

  const alvo = caminhoDoBackend();
  if (!fs.existsSync(alvo)) return { ok: false, motivo: `o backend do console não foi encontrado em ${alvo}` };

  log("Iniciando o console...");
  const filho = spawn(process.execPath, [alvo], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      CONSOLE_INICIADO_PELO_LANCADOR: "1",
      // O alvo do bootstrap vai EXPLÍCITO, nunca herdado.
      //
      // Quando o atalho do sistema roda `launcher-bootstrap.js`, ele marca
      // CONSOLE_BOOTSTRAP_ALVO=launcher no ambiente deste processo. Herdar isso aqui faria o
      // bootstrap filho carregar `launcher.js` outra vez em vez de `console.js`: um lançador
      // subindo outro lançador, cada um esperando 30 s e desistindo, em cadeia — e o console
      // nunca subindo. É o caminho normal de quem abre pelo atalho no Windows e no macOS.
      CONSOLE_BOOTSTRAP_ALVO: "console",
    },
  });
  filho.unref();

  const pronto = await esperarPronto();
  if (!pronto.ok) return pronto;
  return { ok: true, jaEstava: false, contrato: pronto.contrato, versao: pronto.versao };
}

function urlDoConsole(contrato) {
  return `http://127.0.0.1:${contrato.porta}/`;
}

/**
 * URL da aplicação, a partir da configuração real — não de uma porta fixa nem de um esquema
 * presumido. Atrás de proxy com HTTPS, o endereço do operador é o domínio, não 127.0.0.1:8080.
 */
const urlDaAplicacao = config.urlDaAplicacao;

async function abrir(url) {
  let validada;
  try {
    validada = new URL(url);
  } catch {
    return { ok: false, motivo: `endereço inválido: ${url}` };
  }
  if (!["http:", "https:"].includes(validada.protocol)) return { ok: false, motivo: "só endereços HTTP(S) são abertos" };
  const r = await plataforma.abrirNavegador(validada.toString());
  if (!r.disponivel) {
    log(`Não foi possível abrir o navegador automaticamente (${r.motivo}).`);
    log(`Abra manualmente: ${validada.toString()}`);
    return { ok: true, manual: true };
  }
  return { ok: true };
}

// --- Status -----------------------------------------------------------------------------------

async function coletarStatus() {
  const contrato = lerContrato();
  const consoleNoAr = contrato ? await verificarIdentidade(contrato) : { ok: false, motivo: "console não está no ar" };

  const coleta = require(path.join(raiz, "src", "coleta"));
  const saude = await coleta.consultarSaude({ timeoutMs: 2500 });
  const servico = await plataforma.estadoDoServico();

  let atualizacao = null;
  try {
    atualizacao = await require(path.join(raiz, "src", "atualizador")).situacao({ consultarRede: false });
  } catch {}

  return {
    console: {
      noAr: consoleNoAr.ok,
      motivo: consoleNoAr.ok ? null : consoleNoAr.motivo,
      impostor: !!consoleNoAr.impostor,
      url: contrato ? urlDoConsole(contrato) : null,
      versao: consoleNoAr.versao || null,
    },
    aplicacao: {
      respondendo: saude.respondeu,
      saudavel: !!saude.ok,
      commit: saude.commit || null,
      url: urlDaAplicacao(),
      servico: { estado: servico.estado, disponivel: !!servico.disponivel, ativo: servico.ativo ?? null, motivo: servico.motivo || null },
    },
    atualizacaoDoConsole: atualizacao
      ? {
          instalada: atualizacao.versaoEmExecucao,
          disponivel: atualizacao.disponivel,
          podeAtualizar: atualizacao.podeAtualizar,
          confiancaConfigurada: atualizacao.confiancaConfigurada,
          ressalva: atualizacao.ultimaObservacao ? atualizacao.ultimaObservacao.ressalva : null,
        }
      : null,
    plataforma: plataforma.rotulo,
  };
}

function imprimirStatus(s) {
  log("");
  log("  Console de Operações RemoteIFES");
  log("  ───────────────────────────────");
  log(`  Plataforma      : ${s.plataforma}`);
  if (s.console.impostor) {
    log(`  Console         : ⚠ PORTA OCUPADA POR OUTRO PROCESSO`);
    log(`                    ${s.console.motivo}`);
  } else {
    log(`  Console         : ${s.console.noAr ? `no ar — ${s.console.url}` : `parado (${s.console.motivo})`}`);
  }
  log(`  RemoteIFES      : ${s.aplicacao.respondendo ? (s.aplicacao.saudavel ? "saudável" : "degradado") : "sem resposta"}`);
  log(`                    ${s.aplicacao.url}`);
  const srv = s.aplicacao.servico;
  log(`  Serviço         : ${srv.disponivel ? (srv.ativo ? "ativo" : "parado") : `${srv.estado} — ${srv.motivo || ""}`}`);
  if (s.atualizacaoDoConsole) {
    const a = s.atualizacaoDoConsole;
    const disponivel = a.confiancaConfigurada ? a.disponivel || "não consultada" : "não configurada";
    log(`  Versão console  : ${a.instalada} (publicada: ${disponivel})`);
  }
  log("");
}

// --- Menu interativo ----------------------------------------------------------------------------

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const perguntar = (q) => new Promise((r) => rl.question(q, r));

  for (;;) {
    const s = await coletarStatus();
    imprimirStatus(s);
    log("  1) Abrir o Console de Operações");
    log("  2) Abrir o RemoteIFES");
    log("  3) Atualizar este status");
    log("  4) Iniciar/reiniciar o RemoteIFES");
    log("  5) Encerrar o console (ele volta sozinho na próxima abertura)");
    log("  0) Sair");
    const escolha = (await perguntar("\n  Opção: ")).trim();

    if (escolha === "0") break;
    if (escolha === "1") {
      const r = await garantirBackend();
      if (!r.ok) {
        erro(`\n  ${r.motivo}`);
        continue;
      }
      await abrir(urlDoConsole(r.contrato));
    } else if (escolha === "2") {
      await abrir(s.aplicacao.url);
    } else if (escolha === "4") {
      const servico = await plataforma.estadoDoServico();
      if (!servico.disponivel) {
        erro(`\n  Não é possível controlar o serviço aqui: ${servico.motivo}`);
        continue;
      }
      log("\n  Reiniciando o RemoteIFES...");
      const r = await plataforma.controlarServico(servico.ativo ? "reiniciar" : "iniciar");
      log(r.disponivel ? "  Pedido enviado." : `  Falhou: ${r.motivo}`);
    } else if (escolha === "5") {
      const contrato = lerContrato();
      if (!contrato) {
        log("\n  O console já não está no ar.");
        continue;
      }
      try {
        process.kill(contrato.pid, "SIGTERM");
        log("\n  Encerrado.");
      } catch (e) {
        erro(`\n  Não foi possível encerrar: ${e.message}`);
      }
    }
  }
  rl.close();
}

// --- Entrada ------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--ajuda") || args.includes("-h")) {
    log("uso: launcher.js [--menu|--status|--iniciar|--abrir-app|--abrir-console]");
    log("  sem argumento: sobe o console se necessário, verifica a identidade e abre o navegador");
    log("  --iniciar: sobe o console e sai, sem abrir navegador (host sem interface gráfica)");
    return 0;
  }

  if (args.includes("--status")) {
    imprimirStatus(await coletarStatus());
    return 0;
  }

  if (args.includes("--iniciar")) {
    // Sobe o console e sai, sem abrir navegador: é o que serve um host sem interface gráfica
    // (um Pi sem systemd, por exemplo), e é o caminho que a CI exercita para provar que o
    // lançador instalado realmente inicia o **console**, e não outra cópia de si mesmo.
    const r = await garantirBackend();
    if (!r.ok) {
      erro(r.motivo);
      return 1;
    }
    log(r.jaEstava ? "Console já estava no ar." : "Console iniciado.");
    log(urlDoConsole(r.contrato));
    return 0;
  }

  if (args.includes("--abrir-app")) {
    const r = await abrir(urlDaAplicacao());
    return r.ok ? 0 : 1;
  }

  if (args.includes("--menu")) {
    await menu();
    return 0;
  }

  const r = await garantirBackend();
  if (!r.ok) {
    erro(r.motivo);
    if (r.impostor) {
      erro("");
      erro("O navegador NÃO foi aberto de propósito: digitar a senha do console numa página servida");
      erro("por outro processo entregaria a credencial a ele.");
    }
    return 1;
  }
  if (r.jaEstava) log("Console já estava no ar.");
  const abertura = await abrir(urlDoConsole(r.contrato));
  return abertura.ok ? 0 : 1;
}

function executar() {
  return main()
    .then((codigo) => {
      process.exitCode = codigo;
    })
    .catch((e) => {
      erro(`Erro inesperado: ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    });
}

// Entrada explícita, pelo mesmo motivo de console.js: sob a camada estável de bootstrap, o
// módulo principal é o bootstrap, e um `require.main === module` faria o lançador não fazer nada.
if (require.main === module) executar();

module.exports = { executar, lerContrato, verificarIdentidade, garantirBackend, urlDaAplicacao, urlDoConsole, coletarStatus, abrir };
