const fs = require("fs");
const path = require("path");
const config = require("./config");
const processos = require("./processos");
const coleta = require("./coleta");
const plataforma = require("./plataforma");

// Portable deploy and rollback.
//
// The Console must deploy on Linux, Windows and macOS, and `deploy.sh` depends on bash, systemd and
// coreutils. This is the implementation the Console uses on every platform; `deploy.sh` and
// `rollback.sh` remain on the server as the **independent emergency path**, which must work without
// the Console, without the Console's Node and without network. The two roles differ on purpose.
//
// The guarantees are the same as the scripts', and the contract test checks they stay equal:
//   - refuses a dirty tree (the Console never uses --force);
//   - verified backup before touching code;
//   - `npm ci --omit=dev` only when dependencies changed;
//   - success requires the **running process** to report exactly the target commit;
//   - a version older than the `commit` field passes only with a provably restarted process, and
//     the record says "identidade não confirmada";
//   - HEAD equal to the target is not completion;
//   - failure reverts by itself and reinstalls the previous version's dependencies.
//
// The maintenance lock is NOT acquired here: the caller (bin/implantar.js or bin/reverter.js) holds
// it for the whole operation.

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
 * Does the commit's tree contain `src/config/release.js`? A version without it can never report its
 * own commit in /health, so its identity cannot be required.
 */
async function versaoInformaCommit(commit) {
  const r = await git(["cat-file", "-e", `${commit}:remoteifes-server/src/config/release.js`], { timeoutMs: 15_000 });
  if (r.ok) return true;
  // Old checkouts may have the server at the root; try the relative path too.
  const alternativo = await processos.executar("git", ["cat-file", "-e", `${commit}:src/config/release.js`], {
    cwd: config.DIR_SERVIDOR,
    timeoutMs: 15_000,
  });
  return alternativo.ok;
}

/**
 * Waits for the running process to confirm the expected version.
 *
 * A healthy /health is not enough: an old process that survived a failed restart answers like a
 * healthy one. Success only when the process reports exactly the commit.
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
 * Checkout state before any operation that swaps code.
 *
 * Includes **untracked** files: `git checkout --force` to a commit that now contains the same path
 * overwrites the operator's file without warning. "Never discards local work" only holds if
 * uncommitted local work counts too.
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

/**
 * Paths the target commit tracks that currently exist as IGNORED content.
 *
 * `git status` does not list ignored files, and `checkout --force`/`reset --hard` overwrite any
 * path the target commit contains. If someone committed a file under a directory the project
 * ignores (`remoteifes-server/data/` is ignored and holds the database), the code swap would delete
 * operational data without any earlier check seeing it.
 *
 * The check is the intersection between the target commit's tree and the ignored files present on
 * disk: exactly the dangerous set, in two git calls, without stdin and without passing thousands of
 * paths on the command line.
 */
async function ignoradosQueOAlvoSobrescreveria(commitAlvo) {
  const [arvore, ignorados] = await Promise.all([
    git(["ls-tree", "-r", "--name-only", commitAlvo]),
    git(["ls-files", "--others", "--ignored", "--exclude-standard"]),
  ]);
  if (!arvore.ok) return { ok: false, motivo: "não foi possível listar a árvore do commit alvo" };
  if (!ignorados.ok) return { ok: false, motivo: "não foi possível listar os arquivos ignorados do checkout" };

  const doAlvo = new Set(
    arvore.saida
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const colidem = ignorados.saida
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((caminho) => doAlvo.has(caminho));

  return { ok: true, caminhos: colidem };
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
 * Applies an already reviewed target.
 *
 * @param {object} opcoes
 *  - alvo: commit or ref (the Console always passes an exact commit)
 *  - offline: do not access the network
 *  - semReiniciar: swap the code without restarting or verifying
 *  - log: function(line) for progress
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

  // HEAD equal to the target is not completion: the running process may be on another version.
  if (commitAlvo === antes) {
    if (semReiniciar) return { ok: true, resumo: `já está em ${commitAlvo}; serviço não reiniciado (--sem-reiniciar).`, commit: commitAlvo };
    const saude = await coleta.consultarSaude({ timeoutMs: 4000 });
    if (saude.respondeu && saude.ok && saude.commit === commitAlvo) {
      return { ok: true, resumo: `já está em ${commitAlvo} e o processo em execução a confirma. Nada a fazer.`, commit: commitAlvo, nadaAFazer: true };
    }
    log(`O código já está em ${commitAlvo}, mas o processo em execução ${saude.commit ? `está em ${saude.commit.slice(0, 12)}` : "não a confirma"}; reiniciando para aplicá-la.`);
  } else {
    log(`Nova versão: ${commitAlvo}`);
    // Same guard as rollback: the target must not overwrite content Git ignores, because
    // operational data lives there.
    const colisao = await ignoradosQueOAlvoSobrescreveria(commitAlvo);
    if (!colisao.ok) return { ok: false, erro: colisao.motivo };
    if (colisao.caminhos.length) {
      return {
        ok: false,
        erro:
          "a versão de destino rastreia caminhos que hoje existem como conteúdo IGNORADO neste checkout; " +
          "aplicá-la os sobrescreveria, e dados operacionais moram em caminhos ignorados. " +
          `Resolva à mão antes de atualizar:\n${colisao.caminhos.slice(0, 50).join("\n")}`,
      };
    }
    const destacado = inicial.ramo !== "main";
    const aplicar = destacado
      ? await git(["checkout", "--force", "--quiet", commitAlvo])
      : await git(["checkout", "--quiet", "main"]).then(() => git(["reset", "--hard", commitAlvo]));
    if (!aplicar.ok) return { ok: false, erro: `não foi possível aplicar o código: ${(aplicar.saida || "").slice(0, 400)}` };

    const deps = await instalarDependencias(antes, commitAlvo, { offline, log });
    if (!deps.ok) {
      // Recovery is VERIFIED before being announced.
      //
      // If reverting the code or reinstalling dependencies fails (npm missing, module in use,
      // network down), the checkout may be at the new HEAD with a half-installed `node_modules`. An
      // unknown outcome must be presented as unknown.
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
 * Goes back to a previous version. Swaps **only the code**: never touches the database.
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
  // Rollback runs `reset --hard`/`checkout --force`: without this refusal it would discard exactly
  // the local work deploy refuses to touch. Both operations swap code the same way; the guarantee
  // must be the same.
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

  const colisao = await ignoradosQueOAlvoSobrescreveria(commitAlvo);
  if (!colisao.ok) return { ok: false, erro: colisao.motivo };
  if (colisao.caminhos.length) {
    return {
      ok: false,
      erro:
        "a versão de destino rastreia caminhos que hoje existem como conteúdo IGNORADO neste checkout; " +
        "trocar o código os sobrescreveria, e dados operacionais moram em caminhos ignorados. " +
        `Resolva à mão antes de voltar a versão:\n${colisao.caminhos.slice(0, 50).join("\n")}`,
    };
  }

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
