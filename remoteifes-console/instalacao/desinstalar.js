#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

// Desinstalação do Console de Operações.
//
// Três regras governam este arquivo, e valem mais do que qualquer conveniência:
//
//   1. **Nada é apagado sem prova de que é nosso.** Antes de qualquer remoção recursiva, o
//      diretório precisa exibir a assinatura de uma instalação do console (camada estável +
//      versoes/), estar contido num lugar plausível, não ser raiz de disco nem home, e
//      pertencer a quem está desinstalando. Um `--raiz` digitado errado não pode virar um
//      `rm -rf` no lugar errado.
//   2. **O estado fica, por padrão.** Operadores, auditoria e backups sobrevivem à remoção do
//      programa; quem quiser apagá-los pede explicitamente. Reinstalar e descobrir que a conta
//      sumiu é pior do que deixar um diretório para trás.
//   3. **Nada de processo órfão.** O console em execução é encerrado antes de o programa sair;
//      caso contrário a desinstalação "dá certo" e deixa um processo atendendo no loopback,
//      ainda capaz de operações privilegiadas de um programa que já não existe. E o que autoriza
//      encerrar não é o PID do contrato — PID é reciclado —, é a prova de identidade.
//
// O checkout do RemoteIFES (código e banco da aplicação) **nunca** é tocado: o console o
// administra, não é dono dele.
//
// Uso:
//   node instalacao/desinstalar.js [--escopo usuario|sistema] [--raiz <dir>] [--estado <dir>]
//                                 [--apagar-estado] [--simular] [--sim]

const RE_VERSAO = /^\d+\.\d+\.\d+$/;

function argumento(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
}

const temFlag = (nome) => process.argv.includes(`--${nome}`);

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

function falhar(mensagem) {
  process.stderr.write(`\n${mensagem}\n`);
  process.exit(1);
}

/**
 * Autoriza (ou recusa) uma remoção recursiva. Devolve sempre um motivo legível: uma recusa que
 * não explica o que faltou leva o operador a apagar na mão, que é exatamente o risco.
 *
 * @param {string} caminho  diretório candidato
 * @param {object} exigido  `marcas`: nomes que identificam o diretório; `rotulo`: o que é;
 *                          `exigirTodas`: quando verdadeiro, a ausência de qualquer marca recusa.
 */
function autorizarRemocao(caminho, { marcas, rotulo, exigirTodas = false }) {
  const alvo = path.resolve(caminho);

  if (!fs.existsSync(alvo)) return { ok: false, ausente: true, motivo: `${rotulo} não existe em ${alvo}` };
  let info;
  try {
    info = fs.lstatSync(alvo);
  } catch (erro) {
    return { ok: false, motivo: `não foi possível inspecionar ${alvo}: ${erro.message}` };
  }
  if (info.isSymbolicLink()) return { ok: false, motivo: `${alvo} é um link simbólico; remova-o à mão para não seguir o alvo` };
  if (!info.isDirectory()) return { ok: false, motivo: `${alvo} não é um diretório` };

  // Contenção: nunca a raiz de um disco, nunca a home, nunca um caminho raso demais.
  const raizDoDisco = path.parse(alvo).root;
  if (alvo === raizDoDisco) return { ok: false, motivo: "recusado: o caminho é a raiz do sistema de arquivos" };
  if (alvo === path.resolve(os.homedir())) return { ok: false, motivo: "recusado: o caminho é o diretório do usuário" };
  const profundidade = alvo.slice(raizDoDisco.length).split(path.sep).filter(Boolean).length;
  if (profundidade < 2) return { ok: false, motivo: `recusado: ${alvo} é raso demais para ser removido recursivamente` };

  // Identidade: o diretório tem de parecer o que dizemos que é.
  //
  // Para a raiz do programa, TODAS as marcas são exigidas. Aceitar "pelo menos uma" deixava um
  // diretório qualquer que por acaso tivesse um `versoes/` dentro ser apagado recursivamente —
  // e um `--raiz` digitado errado é justamente o caso que estas verificações existem para pegar.
  const faltando = marcas.filter((m) => !fs.existsSync(path.join(alvo, m)));
  if (exigirTodas ? faltando.length > 0 : faltando.length === marcas.length) {
    return {
      ok: false,
      motivo: exigirTodas
        ? `${alvo} não tem as marcas de ${rotulo} (faltam: ${faltando.join(", ")})`
        : `${alvo} não tem nenhuma marca de ${rotulo} (esperado: ${marcas.join(", ")})`,
    };
  }

  // Nunca dentro de um checkout do RemoteIFES: ali moram o código e o banco da aplicação.
  for (let dir = alvo; ; ) {
    if (fs.existsSync(path.join(dir, "remoteifes-server", "package.json"))) {
      return { ok: false, motivo: `recusado: ${alvo} está dentro do checkout do RemoteIFES (${dir}), que o console não é dono` };
    }
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }

  // Propriedade: em POSIX, de quem está desinstalando (ou root). No Windows, a prova prática é
  // conseguir escrever: o modelo de ACL não se reduz a um uid.
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const eu = process.getuid();
    if (eu !== 0 && info.uid !== eu) {
      return { ok: false, motivo: `recusado: ${alvo} pertence ao uid ${info.uid} e você é o uid ${eu}` };
    }
  }
  try {
    fs.accessSync(alvo, fs.constants.W_OK);
  } catch {
    return { ok: false, motivo: `sem permissão de escrita em ${alvo}; repita com privilégio administrativo` };
  }

  return { ok: true, alvo };
}

function lerJsonSeguro(arquivo) {
  try {
    const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    return dados && typeof dados === "object" ? dados : {};
  } catch {
    return {};
  }
}

function remover(caminho, { simular, rotulo }) {
  if (simular) {
    log(`   [simulação] removeria ${rotulo}: ${caminho}`);
    return;
  }
  fs.rmSync(caminho, { recursive: true, force: true });
  log(`   removido: ${caminho}`);
}

function removerArquivo(caminho, { simular }) {
  if (!caminho || !fs.existsSync(caminho)) return false;
  if (simular) {
    log(`   [simulação] removeria ${caminho}`);
    return true;
  }
  fs.rmSync(caminho, { recursive: true, force: true });
  log(`   removido: ${caminho}`);
  return true;
}

/**
 * Se o desinstalador estiver rodando de DENTRO da instalação que vai apagar, ele se copia para
 * um diretório temporário e recomeça de lá.
 *
 * Não é preciosismo: no Windows, um arquivo com handle aberto só é removido quando o handle
 * fecha, e o diretório que o contém fica "não vazio" até lá. Apagar a instalação a partir de um
 * script que mora dentro dela deixava a raiz para trás com EPERM, com todo o conteúdo já
 * removido — o pior dos dois mundos. Recomeçar de fora resolve de uma vez, sem repetir
 * tentativas nem esperar por um handle.
 */
function reexecutarForaDaInstalacao(raiz, dirEstado, escopoEfetivo) {
  const aqui = path.resolve(__dirname);
  const alvo = path.resolve(raiz);
  if (!aqui.startsWith(alvo + path.sep)) return false;

  const payload = path.join(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "console-desinstalar-"));
  try {
    fs.cpSync(path.join(payload, "src"), path.join(temp, "src"), { recursive: true });
    fs.copyFileSync(path.join(payload, "package.json"), path.join(temp, "package.json"));
    fs.mkdirSync(path.join(temp, "instalacao"), { recursive: true });
    const copia = path.join(temp, "instalacao", "desinstalar.js");
    fs.copyFileSync(__filename, copia);

    // Os caminhos vão resolvidos: a cópia não deve recalcular padrões a partir de onde está.
    // O ESCOPO também vai resolvido. A cópia temporária não mora dentro de uma instalação, então
    // ela não consegue inferir nada: sem repassar, uma desinstalação de escopo de usuário virava
    // escopo de sistema no filho, deixava a integração do usuário instalada e podia mexer na
    // integração de sistema de outra instalação.
    const repassar = process.argv.slice(2).filter((a, i, todos) => {
      const anterior = todos[i - 1];
      if (a === "--raiz" || a === "--estado" || a === "--escopo") return false;
      if (anterior === "--raiz" || anterior === "--estado" || anterior === "--escopo") return false;
      return true;
    });
    // O cwd precisa sair da instalação, no pai e no filho: no Windows um handle de diretório
    // aberto também impede a remoção da raiz, e o processo pai continua vivo durante o spawnSync.
    try {
      if (path.resolve(process.cwd()).startsWith(alvo)) process.chdir(os.tmpdir());
    } catch {}
    const r = require("child_process").spawnSync(
      process.execPath,
      [copia, ...repassar, "--raiz", alvo, "--estado", path.resolve(dirEstado), "--escopo", escopoEfetivo],
      { stdio: "inherit", cwd: temp }
    );
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

/**
 * Encerra o console em execução antes de apagar o programa.
 *
 * Sem isto, a desinstalação "dá certo" e deixa um processo vivo: ele continua atendendo no
 * loopback, continua com o contrato de identidade publicado e continua capaz de executar
 * operações privilegiadas de um programa que, para o operador, já não existe. No Linux o
 * `systemctl disable --now` resolvia por acidente; no Windows e no macOS, onde quem sobe o
 * console é o lançador, nada parava o processo.
 *
 * O PID sozinho não autoriza um kill — PID é reciclado. O que autoriza é a **prova de
 * identidade**: quem responde naquela porta demonstra possuir o segredo que só este console
 * publicou. Se a prova falhar, nada é encerrado e o operador é avisado, porque aí ou o contrato
 * está velho ou há outro processo na porta — e matar um processo alheio é pior do que deixar o
 * nosso vivo.
 */
async function encerrarConsoleEmExecucao({ plataforma, dirEstado, simular, log }) {
  const identidade = require(path.join(__dirname, "..", "src", "identidade"));
  const contrato = identidade.lerContrato(path.join(dirEstado, "endereco.json"));
  if (!contrato) {
    log("   nenhum console em execução (sem contrato publicado).");
    return { encerrado: false };
  }

  const prova = await identidade.verificarIdentidade(contrato);
  if (!prova.ok) {
    if (prova.impostor) {
      log(`   ATENÇÃO: há algo escutando em 127.0.0.1:${contrato.porta} que NÃO é este console.`);
      log("   Nada foi encerrado. Investigue qual processo tomou a porta antes de prosseguir.");
      return { encerrado: false, impostor: true };
    }
    log(`   o console não está respondendo (${prova.motivo}); nada a encerrar.`);
    return { encerrado: false };
  }

  if (simular) {
    log(`   [simulação] encerraria o console em execução (pid ${contrato.pid}, porta ${contrato.porta}).`);
    return { encerrado: false, simulado: true };
  }

  log(`   encerrando o console em execução (pid ${contrato.pid}, porta ${contrato.porta})...`);
  try {
    plataforma.encerrarArvore(contrato.pid, "SIGTERM");
  } catch (erro) {
    log(`   não foi possível encerrar: ${erro.message}`);
    return { encerrado: false, motivo: erro.message };
  }

  // Prazos ajustáveis: um Pi carregado demora mais que um desktop, e um teste não deve gastar
  // 15 s provando que a espera termina.
  const prazoPedido = Number(process.env.CONSOLE_PARADA_MS);
  const prazoNormal = Number.isFinite(prazoPedido) && prazoPedido > 0 ? Math.min(prazoPedido, 5 * 60 * 1000) : 10_000;
  const prazoForcado = Math.max(Math.round(prazoNormal / 2), 500);

  if (await esperarPortaFechar(contrato.porta, prazoNormal)) {
    log("   console encerrado.");
    return { encerrado: true };
  }

  log("   o console não encerrou no prazo; forçando.");
  try {
    plataforma.encerrarArvore(contrato.pid, "SIGKILL");
  } catch (erro) {
    log(`   não foi possível forçar: ${erro.message}`);
  }
  // O resultado do SIGKILL é RECONFERIDO: engolir o erro e declarar encerrado era afirmar sem
  // prova justamente no caminho em que a parada tinha acabado de falhar.
  if (await esperarPortaFechar(contrato.porta, prazoForcado)) {
    log("   console encerrado à força.");
    return { encerrado: true, forcado: true };
  }
  return { encerrado: false, motivo: `a porta ${contrato.porta} continua aceitando conexão depois do encerramento forçado` };
}

/**
 * Espera a porta parar de ACEITAR CONEXÃO — não "a identidade parar de conferir".
 *
 * Uma requisição de identidade que falhe por tempo esgotado, resposta malformada ou erro de rota
 * parece exatamente igual a um processo que morreu, e tratar as duas coisas como parada era
 * declarar sucesso sobre um console possivelmente vivo. A recusa de conexão é a prova de que não
 * há mais nada escutando ali.
 */
function esperarPortaFechar(porta, prazoMs) {
  const limite = Date.now() + prazoMs;
  const tentar = () =>
    new Promise((resolver) => {
      const socket = net.connect({ host: "127.0.0.1", port: porta });
      const encerrar = (aceitou) => {
        socket.destroy();
        resolver(aceitou);
      };
      socket.setTimeout(1000);
      socket.once("connect", () => encerrar(true));
      socket.once("timeout", () => encerrar(true)); // aceitou a conexão mas não respondeu: ainda há algo ali
      socket.once("error", () => encerrar(false));
    });

  return (async () => {
    for (;;) {
      if (!(await tentar())) return true;
      if (Date.now() >= limite) return false;
      await new Promise((resolver) => setTimeout(resolver, 250));
    }
  })();
}

async function main() {
  const plataforma = require(path.join(__dirname, "..", "src", "plataforma"));
  const simular = temFlag("simular");
  const escopo = argumento("escopo", process.platform === "linux" ? "sistema" : "usuario");
  if (!["usuario", "sistema"].includes(escopo)) falhar("--escopo aceita apenas 'usuario' ou 'sistema'");

  // A instalação que contém ESTE script é a referência: o desinstalador viaja dentro do payload,
  // então `../..` é a raiz instalada. Presumir o escopo pelo sistema fazia uma instalação de
  // usuário no Linux ser tratada como de sistema, reclamar que `/opt` não existe e deixar
  // `~/.local/...` intacto — e é exatamente o comando que a interface manda executar.
  const raizDoProprioScript = path.resolve(path.join(__dirname, "..", "..", ".."));
  const pareceInstalacao = fs.existsSync(path.join(raizDoProprioScript, "estado-instalacao.json"));
  const registro = pareceInstalacao ? lerJsonSeguro(path.join(raizDoProprioScript, "estado-instalacao.json")) : {};
  const escopoEfetivo = argumento("escopo", registro.escopo || escopo);
  const padroes = plataforma.diretoriosPadrao({ escopo: escopoEfetivo });
  const raiz = path.resolve(argumento("raiz", pareceInstalacao ? raizDoProprioScript : padroes.raizInstalacao));
  const dirEstado = path.resolve(argumento("estado", registro.estado || padroes.estado));

  if (!temFlag("simular") && reexecutarForaDaInstalacao(raiz, dirEstado, escopoEfetivo)) return;

  log("");
  log("  Console de Operações RemoteIFES — desinstalação");
  log("  ──────────────────────────────────────────────");
  log(`  Plataforma : ${plataforma.rotulo}`);
  log(`  Escopo     : ${escopoEfetivo}`);
  log(`  Programa   : ${raiz}`);
  log(`  Estado     : ${dirEstado}${temFlag("apagar-estado") ? " (será apagado)" : " (preservado)"}`);
  if (simular) log("  Modo       : simulação — nada será removido");
  log("");

  const autorizacao = autorizarRemocao(raiz, {
    marcas: ["console-bootstrap.js", "versoes", "estado-instalacao.json"],
    rotulo: "instalação do console",
    exigirTodas: true,
  });
  if (!autorizacao.ok && !autorizacao.ausente) falhar(`  ${autorizacao.motivo}`);

  if (!simular && !temFlag("sim") && !process.stdin.isTTY) {
    falhar(
      "  Sem terminal interativo, a desinstalação exige --sim para confirmar.\n" +
        "  Use --simular primeiro para ver exatamente o que seria removido."
    );
  }
  if (!simular && !temFlag("sim") && process.stdin.isTTY) {
    const resposta = await perguntar("  Confirmar a desinstalação? digite 'desinstalar': ");
    if (resposta.trim() !== "desinstalar") falhar("  Cancelado.");
    log("");
  }

  // --- Integração com a plataforma ------------------------------------------------------------
  //
  // A integração sai ANTES do encerramento. Com ativação por socket ainda habilitada, a própria
  // sondagem da porta reativaria o serviço, e o console voltaria logo depois de ser encerrado.
  log("== Removendo a integração com o sistema");
  if (simular) {
    // `removerInicializacao` é destrutiva: no Linux ela para o console, apaga as unidades do
    // systemd, a regra de sudo e o auxiliar privilegiado. Chamá-la em modo de simulação fazia o
    // "ensaio" desmontar de verdade a instalação que o operador só queria inspecionar.
    log("   [simulação] removeria o registro de inicialização e, no Linux, unidades, regra de sudo e auxiliar.");
  } else {
    try {
      const r = await plataforma.removerInicializacao({ escopo: escopoEfetivo });
      log(r.disponivel ? `   ${r.mecanismo || "registro de inicialização removido"}` : `   nada a remover (${r.motivo})`);
    } catch (erro) {
      log(`   não foi possível remover o registro de inicialização: ${erro.message}`);
    }
  }

  // --- Console em execução -----------------------------------------------------------------
  log("== Encerrando o console, se estiver em execução");
  const encerramento = await encerrarConsoleEmExecucao({ plataforma, dirEstado, simular, log });
  if (encerramento.impostor && !temFlag("sim")) {
    falhar("  Desinstalação interrompida: a porta do console está ocupada por outro processo.");
  }
  // Não conseguir provar a parada IMPEDE a remoção: apagar o programa deixando um processo vivo
  // e autenticado é o pior desfecho possível, e era o que acontecia quando a falha era ignorada.
  if (encerramento.motivo && !simular) {
    falhar(
      `  Desinstalação interrompida: não foi possível confirmar que o console parou (${encerramento.motivo}).\n` +
        "  Encerre o processo à mão e repita. Nada foi removido."
    );
  }

  // --- Atalhos ---------------------------------------------------------------------------------
  log("== Removendo atalhos");
  let removeuAtalho = false;
  const atalhos = plataforma.diretoriosPadrao({ escopo: "usuario" }).atalhos;
  if (plataforma.nome === "linux" && atalhos) {
    removeuAtalho = removerArquivo(path.join(atalhos, "remoteifes-console.desktop"), { simular }) || removeuAtalho;
  }
  if (plataforma.nome === "windows" && atalhos) {
    removeuAtalho = removerArquivo(path.join(atalhos, "Console de Operações RemoteIFES.lnk"), { simular }) || removeuAtalho;
  }
  if (plataforma.nome === "macos") {
    // No macOS o bundle **é** o programa: ele sai junto com a raiz, logo abaixo.
    removeuAtalho = true;
  }
  if (!removeuAtalho) log("   nenhum atalho encontrado.");

  // --- Programa ---------------------------------------------------------------------------------
  log("== Removendo o programa");
  if (autorizacao.ausente) {
    log(`   nada a remover: ${autorizacao.motivo}`);
  } else {
    const versoes = (() => {
      try {
        return fs.readdirSync(path.join(raiz, "versoes")).filter((v) => RE_VERSAO.test(v));
      } catch {
        return [];
      }
    })();
    if (versoes.length) log(`   versões instaladas: ${versoes.join(", ")}`);

    // No macOS, remover a raiz (Contents/Resources) deixaria um bundle quebrado em Aplicativos.
    const bundle = plataforma.nome === "macos" && plataforma.bundleDaRaiz ? plataforma.bundleDaRaiz(raiz) : null;
    if (bundle) {
      const autBundle = autorizarRemocao(bundle, { marcas: [path.join("Contents", "Info.plist")], rotulo: "bundle do console" });
      if (autBundle.ok) remover(bundle, { simular, rotulo: "bundle" });
      else log(`   bundle mantido: ${autBundle.motivo}`);
    } else {
      remover(raiz, { simular, rotulo: "programa" });
    }
  }

  // --- Estado ------------------------------------------------------------------------------------
  log("== Estado (operadores, auditoria, saídas de trabalhos)");
  if (!temFlag("apagar-estado")) {
    log(`   preservado em ${dirEstado}`);
    log("   Para apagá-lo também, repita com --apagar-estado.");
  } else {
    const autEstado = autorizarRemocao(dirEstado, {
      marcas: ["operadores.json", "auditoria.log", "saidas", "checkout-dir"],
      rotulo: "estado do console",
    });
    if (autEstado.ok) remover(dirEstado, { simular, rotulo: "estado" });
    else log(`   mantido: ${autEstado.motivo}`);
  }

  // --- O que continua no host -----------------------------------------------------------------
  log("");
  log("  O que NÃO foi tocado:");
  log("   • o checkout do RemoteIFES, seu banco e seus backups;");
  log("   • o serviço da aplicação (remoteifes) e suas unidades do sistema;");
  log("   • o Node instalado no host.");
  if (!temFlag("apagar-estado")) log(`   • o estado do console em ${dirEstado}.`);
  log("");
  if (plataforma.nome === "linux" && escopoEfetivo === "sistema") {
    log("  Se o console foi instalado por pacote (.deb), remova-o também com:");
    log("      sudo apt-get remove remoteifes-console");
    log("");
  }
  log(simular ? "  Simulação concluída; nada foi alterado." : "  Desinstalação concluída.");
  log("");
}

function perguntar(rotulo) {
  return new Promise((resolve) => {
    process.stdout.write(rotulo);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(String(d));
    });
  });
}

if (require.main === module) {
  main().catch((erro) => falhar(`  Falha na desinstalação: ${erro.message}`));
}

module.exports = { autorizarRemocao };
