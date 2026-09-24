const fs = require("fs");
const path = require("path");
const config = require("./config");
const processos = require("./processos");
const coleta = require("./coleta");
const plataforma = require("./plataforma");

// Implantação e reversão portáteis.
//
// Por que existe, já que `deploy.sh` funciona: o console precisa implantar em Linux, Windows e
// macOS, e `deploy.sh` depende de bash, systemd e coreutils. Esta é a implementação que o
// console usa em toda plataforma; `deploy.sh` e `rollback.sh` continuam no servidor como
// **caminho independente de emergência**, que tem de funcionar sem console, sem Node do console
// e sem rede — os dois papéis são diferentes de propósito.
//
// As garantias abaixo são as mesmas dos scripts, e o teste de contrato confere que continuam
// iguais:
//   - recusa com árvore suja (o console nunca usa --force);
//   - backup verificado antes de tocar no código;
//   - `npm ci --omit=dev` só quando as dependências mudaram;
//   - sucesso exige que o **processo em execução** informe exatamente o commit alvo;
//   - versão anterior ao campo `commit` só passa com processo comprovadamente reiniciado, e o
//     registro diz "identidade não confirmada";
//   - HEAD igual ao alvo não é conclusão;
//   - falha reverte sozinha e reinstala as dependências da versão anterior.
//
// A trava de manutenção NÃO é adquirida aqui: quem chama (bin/implantar.js ou bin/reverter.js)
// a segura durante toda a operação. Foi exatamente a dupla aquisição — console e script — que
// deixava a implantação gerenciada impossível de concluir.

const RE_COMMIT = /^[0-9a-f]{7,40}$/;

function git(args, opcoes = {}) {
  return processos.executar("git", args, {
    cwd: config.DIR_CHECKOUT,
    timeoutMs: opcoes.timeoutMs || 120_000,
    limiteBytes: 512 * 1024,
  });
}

function npmExecutavel() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npm(args, opcoes = {}) {
  return processos.executar(npmExecutavel(), args, {
    cwd: config.DIR_SERVIDOR,
    timeoutMs: opcoes.timeoutMs || 20 * 60 * 1000,
    limiteBytes: 512 * 1024,
  });
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function registrar(app, linha) {
  try {
    fs.mkdirSync(path.dirname(app.logDeploy), { recursive: true });
    fs.appendFileSync(app.logDeploy, `${linha}\n`);
  } catch {}
}

/**
 * A árvore do commit tem `src/config/release.js`? Uma versão sem ele nunca poderá informar o
 * próprio commit no /health, e por isso a identidade dela não pode ser exigida.
 */
async function versaoInformaCommit(commit) {
  const r = await git(["cat-file", "-e", `${commit}:remoteifes-server/src/config/release.js`], { timeoutMs: 15_000 });
  if (r.ok) return true;
  // Checkouts antigos podem ter o servidor na raiz; tenta o caminho relativo também.
  const alternativo = await processos.executar("git", ["cat-file", "-e", `${commit}:src/config/release.js`], {
    cwd: config.DIR_SERVIDOR,
    timeoutMs: 15_000,
  });
  return alternativo.ok;
}

/**
 * Espera o processo em execução confirmar a versão esperada.
 *
 * Um /health saudável não basta: um processo antigo que sobreviveu a um restart que falhou
 * responde igual a um saudável. Só é sucesso quando o processo informa exatamente o commit.
 */
async function aguardarVersao(esperado, { reinicioEm, tentativas = 20, intervaloMs = 2000, rotulo = "a nova versão" }) {
  const legado = !(await versaoInformaCommit(esperado));
  let ultimoMotivo = "o /health não respondeu saudável";

  for (let i = 0; i < tentativas; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 4000 });
    if (saude.respondeu && saude.ok) {
      if (saude.commit && saude.commit.startsWith(esperado)) {
        return { ok: true, confirmacao: `processo em execução confirmou ${esperado}`, resumo: "confirmado pelo processo em execução", identidadeConfirmada: true };
      }
      if (saude.commit) {
        ultimoMotivo = `o processo em execução continua em ${saude.commit.slice(0, 12)}, não em ${esperado.slice(0, 12)} (o reinício não aplicou ${rotulo})`;
      } else if (!legado) {
        ultimoMotivo = `o processo em execução não informa o commit, mas ${esperado.slice(0, 12)} informaria: é outra versão`;
      } else {
        const uptime = saude.uptimeSegundos;
        const decorrido = Math.round((Date.now() - reinicioEm) / 1000);
        if (uptime === null || uptime === undefined) {
          ultimoMotivo = "o processo em execução não informa commit nem tempo de vida: não é possível verificar se a versão subiu";
        } else if (uptime <= decorrido + 2) {
          return {
            ok: true,
            confirmacao: `identidade não confirmada: ${esperado.slice(0, 12)} não informa commit; processo saudável reiniciado há ${uptime}s`,
            resumo: `identidade não confirmada: ${esperado.slice(0, 12)} não informa commit; processo saudável reiniciado há ${uptime}s`,
            identidadeConfirmada: false,
          };
        } else {
          ultimoMotivo = `o processo em execução não informa o commit e está no ar há ${uptime}s, ou seja, sobreviveu ao reinício`;
        }
      }
    }
    await esperar(intervaloMs);
  }
  return { ok: false, motivo: ultimoMotivo };
}

async function instalarDependencias(de, para, { offline, log }) {
  const diff = await git(["diff", "--name-only", de, para, "--", "remoteifes-server/package.json", "remoteifes-server/package-lock.json"]);
  if (diff.ok && !diff.saida.trim()) {
    log("Dependências inalteradas; pulando npm ci.");
    return { ok: true, rodou: false };
  }
  log("Dependências mudaram; rodando npm ci...");
  const flags = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
  if (offline) flags.push("--offline");
  const r = await npm(flags);
  if (!r.ok) log(r.saida.slice(-4000));
  return { ok: r.ok, rodou: true, saida: r.saida };
}

async function reiniciarServico(log) {
  const estado = await plataforma.estadoDoServico();
  if (!estado.disponivel) {
    return { ok: false, semControle: true, motivo: estado.motivo || "o ciclo de vida do serviço não é controlável neste host" };
  }
  log("Reiniciando o serviço da aplicação...");
  const r = await plataforma.controlarServico("reiniciar");
  if (!r.disponivel) {
    log(`aviso: o reinício retornou erro (${r.motivo}); verificando qual versão está em execução mesmo assim.`);
  }
  return { ok: true, reinicioEm: Date.now() };
}

/**
 * Estado do checkout antes de qualquer operação que troque código.
 *
 * Inclui arquivos **não rastreados**. Com `--untracked-files=no` eles eram invisíveis, e um
 * `git checkout --force` para um commit que passou a conter aquele mesmo caminho sobrescreve o
 * arquivo do operador sem aviso. "Nunca descarta trabalho local" só vale se o trabalho local
 * ainda não commitado também contar.
 */
async function estadoDoCheckout() {
  const [head, sujo, ramo] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=normal"]),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  const linhas = sujo.ok ? sujo.saida.trim() : "";
  return {
    head: head.ok ? head.saida.trim() : null,
    limpo: sujo.ok && !linhas,
    sujeira: linhas,
    naoRastreados: linhas
      .split(/\r?\n/)
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3)),
    ramo: ramo.ok && ramo.saida.trim() ? ramo.saida.trim() : null,
  };
}

async function criarBackup(rotulo, log) {
  const app = config.caminhosDaAplicacao();
  if (!fs.existsSync(app.banco)) {
    log(`Nenhum banco em ${app.banco} ainda; seguindo sem backup.`);
    return { ok: true, pulado: true };
  }
  log(`Backup do banco (${rotulo}) antes da operação...`);
  const r = await processos.executar(process.execPath, [path.join(config.RAIZ_CONSOLE, "bin", "backup.js"), rotulo], {
    cwd: config.RAIZ_CONSOLE,
    timeoutMs: 15 * 60 * 1000,
    env: { CONSOLE_ESTADO_DIR: config.DIR_ESTADO, CONSOLE_CHECKOUT_DIR: config.DIR_CHECKOUT },
  });
  log(r.saida.trim());
  return { ok: r.ok };
}

/**
 * Aplica um alvo já revisado.
 *
 * @param {object} opcoes
 *  - alvo: commit ou ref (o console sempre passa um commit exato)
 *  - offline: não acessar a rede
 *  - semReiniciar: troca o código e não reinicia nem verifica
 *  - log: função(linha) para progresso
 */
async function implantar({ alvo, offline = false, semReiniciar = false, log = () => {} }) {
  const app = config.caminhosDaAplicacao();
  fs.mkdirSync(app.dirDados, { recursive: true });

  const inicial = await estadoDoCheckout();
  if (!inicial.head) return { ok: false, erro: `${config.DIR_CHECKOUT} não é um repositório git utilizável` };
  if (!inicial.limpo) {
    return {
      ok: false,
      erro:
        "há alterações locais não commitadas no repositório. Reverta-as antes de atualizar; " +
        "esta operação nunca descarta trabalho local.\n" + inicial.sujeira.slice(0, 2000),
    };
  }

  const antes = inicial.head;
  log(`Versão atual: ${antes}`);

  const backup = await criarBackup("pre-update", log);
  if (!backup.ok) return { ok: false, erro: "backup pré-atualização falhou; nada foi alterado." };

  if (!offline) {
    log("Buscando atualizações de origin...");
    const fetch = await git(["fetch", "--tags", "--prune", "origin"], { timeoutMs: 300_000 });
    if (!fetch.ok) log(`aviso: git fetch falhou (${(fetch.saida || fetch.erro || "").slice(0, 300)})`);
  } else {
    log("Modo offline: sem git fetch.");
  }

  const resolvido = await git(["rev-parse", "--verify", "--quiet", `${alvo}^{commit}`]);
  if (!resolvido.ok || !resolvido.saida.trim()) {
    return { ok: false, erro: `não foi possível resolver o alvo "${alvo}" no checkout.` };
  }
  const commitAlvo = resolvido.saida.trim();

  // HEAD igual ao alvo não é conclusão: o processo em execução pode estar noutra versão.
  if (commitAlvo === antes) {
    if (semReiniciar) return { ok: true, resumo: `já está em ${commitAlvo}; serviço não reiniciado (--sem-reiniciar).`, commit: commitAlvo };
    const saude = await coleta.consultarSaude({ timeoutMs: 4000 });
    if (saude.respondeu && saude.ok && saude.commit === commitAlvo) {
      return { ok: true, resumo: `já está em ${commitAlvo} e o processo em execução a confirma. Nada a fazer.`, commit: commitAlvo, nadaAFazer: true };
    }
    log(`O código já está em ${commitAlvo}, mas o processo em execução ${saude.commit ? `está em ${saude.commit.slice(0, 12)}` : "não a confirma"}; reiniciando para aplicá-la.`);
  } else {
    log(`Nova versão: ${commitAlvo}`);
    const destacado = inicial.ramo !== "main";
    const aplicar = destacado
      ? await git(["checkout", "--force", "--quiet", commitAlvo])
      : await git(["checkout", "--quiet", "main"]).then(() => git(["reset", "--hard", commitAlvo]));
    if (!aplicar.ok) return { ok: false, erro: `não foi possível aplicar o código: ${(aplicar.saida || "").slice(0, 400)}` };

    const deps = await instalarDependencias(antes, commitAlvo, { offline, log });
    if (!deps.ok) {
      // A recuperação é CONFERIDA antes de ser anunciada.
      //
      // Antes, o resultado da volta do código e da reinstalação das dependências era descartado e
      // a resposta afirmava que a atualização tinha sido desfeita. Se a própria volta falhasse —
      // npm ausente, módulo em uso, rede fora —, o operador recebia "código voltou para a versão
      // anterior" com um checkout possivelmente em HEAD novo e `node_modules` pela metade. Um
      // desfecho desconhecido precisa se apresentar como desconhecido.
      log("npm ci falhou; revertendo o código para a versão anterior.");
      const voltaCodigo = await reverterCodigo(antes, inicial.ramo, log);
      const voltaDeps = voltaCodigo.ok ? await instalarDependencias(commitAlvo, antes, { offline, log }) : { ok: false };
      const headAgora = await git(["rev-parse", "HEAD"]);
      const noCommitAnterior = headAgora.ok && headAgora.saida.trim() === antes;
      const recuperado = voltaCodigo.ok && voltaDeps.ok && noCommitAnterior;

      if (recuperado) {
        return {
          ok: false,
          erro: "npm ci falhou; a atualização foi desfeita e o código voltou para a versão anterior.",
          revertido: true,
          reversaoConfirmada: true,
        };
      }
      return {
        ok: false,
        revertido: false,
        reversaoConfirmada: false,
        erro:
          `npm ci falhou E a recuperação não pôde ser confirmada. Estado a conferir à mão: HEAD=${
            headAgora.ok ? headAgora.saida.trim() : "desconhecido"
          }, alvo pretendido=${antes}` +
          `${voltaCodigo.ok ? "" : "; a volta do código falhou"}` +
          `${voltaDeps.ok ? "" : "; as dependências da versão anterior não foram reinstaladas"}` +
          ". O serviço NÃO foi reiniciado.",
      };
    }
  }

  if (semReiniciar) {
    return { ok: true, resumo: `Código em ${commitAlvo}. Serviço não reiniciado nem verificado.`, commit: commitAlvo };
  }

  const reinicio = await reiniciarServico(log);
  if (!reinicio.ok) {
    return {
      ok: false,
      erro:
        `${reinicio.motivo}. O código foi trocado para ${commitAlvo}, mas o serviço não pôde ser reiniciado por aqui: ` +
        "reinicie-o pelo mecanismo do host e confirme a versão em execução.",
      commit: commitAlvo,
      desfechoIndefinido: true,
    };
  }

  const verificacao = await aguardarVersao(commitAlvo, { reinicioEm: reinicio.reinicioEm, rotulo: "a nova versão" });
  if (verificacao.ok) {
    registrar(app, `${new Date().toISOString()} deploy ${antes} -> ${commitAlvo} ok (${verificacao.confirmacao})`);
    if (antes !== commitAlvo) fs.writeFileSync(app.versaoAnterior, `${antes}\n`);
    fs.writeFileSync(app.versaoAtual, `${commitAlvo}\n`);
    return { ok: true, commit: commitAlvo, resumo: verificacao.resumo, identidadeConfirmada: verificacao.identidadeConfirmada };
  }

  registrar(app, `${new Date().toISOString()} deploy ${antes} -> ${commitAlvo} FALHOU: ${verificacao.motivo}; revertendo`);
  log(`A atualização não foi confirmada: ${verificacao.motivo}.`);
  log(`Revertendo para ${antes}...`);
  await reverterCodigo(antes, inicial.ramo, log);
  await instalarDependencias(commitAlvo, antes, { offline, log });
  const reinicioVolta = await reiniciarServico(log);
  const voltou = reinicioVolta.ok
    ? await aguardarVersao(antes, { reinicioEm: reinicioVolta.reinicioEm, rotulo: "a reversão" })
    : { ok: false, motivo: reinicioVolta.motivo };
  return {
    ok: false,
    erro: `a nova versão não foi confirmada (${verificacao.motivo}).`,
    revertido: true,
    reversaoConfirmada: voltou.ok,
    detalheReversao: voltou.ok ? voltou.resumo : voltou.motivo,
  };
}

async function reverterCodigo(destino, ramoOriginal, log) {
  if (ramoOriginal === "main") {
    await git(["checkout", "--quiet", "main"]);
    return git(["reset", "--hard", destino]);
  }
  return git(["checkout", "--force", "--quiet", destino]);
}

/**
 * Volta para uma versão anterior. Troca **apenas o código**: nunca mexe no banco.
 */
async function reverter({ alvo = null, offline = false, semReiniciar = false, log = () => {} }) {
  const app = config.caminhosDaAplicacao();
  fs.mkdirSync(app.dirDados, { recursive: true });

  let ref = alvo;
  if (!ref) {
    try {
      ref = fs.readFileSync(app.versaoAnterior, "utf8").trim();
    } catch {
      return { ok: false, erro: "nenhuma versão anterior registrada; informe explicitamente para onde voltar." };
    }
    if (!ref) return { ok: false, erro: "o registro de versão anterior está vazio." };
  }

  const inicial = await estadoDoCheckout();
  if (!inicial.head) return { ok: false, erro: `${config.DIR_CHECKOUT} não é um repositório git utilizável` };
  // A reversão faz `reset --hard`/`checkout --force`: sem esta recusa ela descartava exatamente
  // o trabalho local que a implantação se nega a tocar. As duas operações trocam código da mesma
  // forma; a garantia tem de ser a mesma.
  if (!inicial.limpo) {
    return {
      ok: false,
      erro:
        "há alterações locais não commitadas no repositório. Reverta-as antes de voltar a versão; " +
        "esta operação nunca descarta trabalho local.\n" + inicial.sujeira.slice(0, 2000),
    };
  }

  if (!offline) await git(["fetch", "--tags", "--prune", "origin"], { timeoutMs: 300_000 });
  const resolvido = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!resolvido.ok || !resolvido.saida.trim()) return { ok: false, erro: `não foi possível resolver o ref "${ref}".` };
  const commitAlvo = resolvido.saida.trim();
  const antes = inicial.head;

  const backup = await criarBackup("pre-rollback", log);
  if (!backup.ok) return { ok: false, erro: "backup pré-rollback falhou; nada foi alterado." };

  if (commitAlvo !== antes) {
    log(`Voltando de ${antes} para ${commitAlvo}...`);
    const aplicar = await reverterCodigo(commitAlvo, inicial.ramo, log);
    if (!aplicar.ok) return { ok: false, erro: `não foi possível aplicar o código: ${(aplicar.saida || "").slice(0, 400)}` };
    const deps = await instalarDependencias(antes, commitAlvo, { offline, log });
    if (!deps.ok) {
      return {
        ok: false,
        erro:
          "npm ci falhou: as dependências da versão alvo não foram instaladas de forma íntegra. " +
          `O código já está em ${commitAlvo}, mas o serviço NÃO foi reiniciado.`,
      };
    }
  } else {
    log(`O código já está em ${commitAlvo}; verificando o processo em execução.`);
  }

  if (semReiniciar) return { ok: true, resumo: `Código em ${commitAlvo}. Serviço não reiniciado.`, commit: commitAlvo };

  const reinicio = await reiniciarServico(log);
  if (!reinicio.ok) {
    return { ok: false, erro: `${reinicio.motivo}. O código está em ${commitAlvo}; reinicie pelo mecanismo do host.`, commit: commitAlvo, desfechoIndefinido: true };
  }
  const verificacao = await aguardarVersao(commitAlvo, { reinicioEm: reinicio.reinicioEm, rotulo: "a reversão" });
  if (verificacao.ok) {
    registrar(app, `${new Date().toISOString()} rollback ${antes} -> ${commitAlvo} ok (${verificacao.confirmacao})`);
    if (antes !== commitAlvo) fs.writeFileSync(app.versaoAnterior, `${antes}\n`);
    fs.writeFileSync(app.versaoAtual, `${commitAlvo}\n`);
    return {
      ok: true,
      commit: commitAlvo,
      resumo: verificacao.resumo,
      identidadeConfirmada: verificacao.identidadeConfirmada,
      aviso:
        "A reversão troca apenas o código. Se a versão revertida usa um esquema de banco mais antigo e incompatível, " +
        "restaurar o backup pre-update é uma decisão separada e explícita.",
    };
  }
  registrar(app, `${new Date().toISOString()} rollback ${antes} -> ${commitAlvo} FALHOU: ${verificacao.motivo}`);
  return { ok: false, erro: `a reversão não foi confirmada: ${verificacao.motivo}`, commit: commitAlvo };
}

module.exports = { implantar, reverter, aguardarVersao, versaoInformaCommit, estadoDoCheckout, RE_COMMIT };
