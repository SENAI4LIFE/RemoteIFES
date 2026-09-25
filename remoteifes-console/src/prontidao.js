const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const coleta = require("./coleta");
const trava = require("./trava");
const execucao = require("./execucao");

// Impact assessment before interrupting the service.
//
// Distinctions RemoteIFES requires and a naive panel gets wrong:
//  - `/admin/sessoes` shows recent activity, not the exact count of connected users;
//  - "online" in the database does not prove an open command channel with the ESP32;
//  - `modoManutencao` blocks part of regular access but does not drain schedules, administrator
//    actions, device commands or OTA;
//  - `monitoramentoService` counts OTA in progress without the `validando` phase; here every active
//    phase counts, including `validando` and a paused rollout with pending work;
//  - unavailable telemetry is **unknown**, never zero.

const NIVEL = { BLOQUEIO: "bloqueio", AVISO: "aviso", INFO: "info" };
const DISCO_MINIMO_BYTES = 200 * 1024 * 1024;

function caminhoTokenProntidao() {
  return path.join(config.caminhosDaAplicacao().dirDados, ".console-token");
}

/**
 * Ensures the readiness contract's shared secret. Created with 0600 by the Console; the application
 * only reads it. Without it the application route answers 404 and costs nothing.
 */
function garantirTokenProntidao() {
  const arquivo = caminhoTokenProntidao();
  try {
    const atual = fs.readFileSync(arquivo, "utf8").trim();
    if (atual.length >= 32) return atual;
  } catch {}
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, `${token}\n`, { mode: 0o600 });
  return token;
}

function lerTokenProntidao() {
  try {
    const valor = fs.readFileSync(caminhoTokenProntidao(), "utf8").trim();
    return valor || null;
  } catch {
    return null;
  }
}

/**
 * Queries the application's readiness contract. If the application is stopped, the result is "not
 * observable", which is already the relevant information for a stop.
 */
function consultarProntidaoDaAplicacao({ timeoutMs = 3000 } = {}) {
  const app = config.caminhosDaAplicacao();
  const token = lerTokenProntidao();
  if (!token) {
    return Promise.resolve({ disponivel: false, motivo: "contrato de prontidão ainda não provisionado" });
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: app.porta,
        path: "/manutencao/prontidao",
        method: "GET",
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let corpo = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (corpo.length < 64 * 1024) corpo += d;
        });
        res.on("end", () => {
          if (res.statusCode === 404) {
            return resolve({ disponivel: false, motivo: "a aplicação em execução é anterior ao contrato de prontidão" });
          }
          if (res.statusCode !== 200) {
            return resolve({ disponivel: false, motivo: `a aplicação respondeu ${res.statusCode} ao contrato de prontidão` });
          }
          try {
            resolve({ disponivel: true, ...JSON.parse(corpo) });
          } catch {
            resolve({ disponivel: false, motivo: "resposta inválida no contrato de prontidão" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ disponivel: false, motivo: "a aplicação não respondeu ao contrato de prontidão" });
    });
    req.on("error", (erro) => resolve({ disponivel: false, motivo: `aplicação inacessível (${erro.code || erro.message})` }));
    req.end();
  });
}

function achado(nivel, titulo, detalhe, extra = {}) {
  return { nivel, titulo, detalhe, ...extra };
}

/**
 * Assesses whether an operation that interrupts the service may start.
 *
 * @param {object} opcoes
 *  - interrompeServico: the operation restarts/stops the application
 *  - exigeBackup: the operation requires a recent backup
 *  - exigeRepositorioLimpo: the operation changes the checkout
 *  - exigeAplicacaoParada: the operation requires that nobody writes to the database
 */
async function avaliar(opcoes = {}) {
  const achados = [];
  const app = config.caminhosDaAplicacao();

  // 1. Conflicting maintenance (Console, CLI or leftover).
  const manutencao = trava.situacao();
  if (manutencao.ocupada) {
    achados.push(achado(NIVEL.BLOQUEIO, "Outra manutenção em andamento", manutencao.descricao));
  } else if (manutencao.residuo) {
    achados.push(
      achado(NIVEL.AVISO, "Trava de manutenção residual", `${manutencao.descricao}. Ela será reconciliada automaticamente ao iniciar a operação.`)
    );
  }
  const trabalho = execucao.trabalhoAtivo();
  if (trabalho) {
    achados.push(achado(NIVEL.BLOQUEIO, "Operação do console em andamento", `${trabalho.rotulo} (iniciada em ${trabalho.iniciadoEm})`));
  }

  // 2. Service and application state.
  const [saude, servico, prontidaoApp] = await Promise.all([
    coleta.consultarSaude(),
    coleta.estadoDoServico(),
    consultarProntidaoDaAplicacao(),
  ]);

  if (opcoes.exigeAplicacaoParada) {
    if (saude.respondeu) {
      achados.push(
        achado(
          NIVEL.BLOQUEIO,
          "A aplicação está no ar",
          "Esta operação escreve no banco e exige que o RemoteIFES esteja parado. O console para o serviço e o watchdog antes de começar e os restabelece no fim.",
          { resolvivel: true }
        )
      );
    }
  } else if (opcoes.interrompeServico) {
    if (!servico.suportado) {
      achados.push(
        achado(NIVEL.AVISO, "systemd não consultável", servico.motivo || "não foi possível confirmar o estado do serviço antes de reiniciar")
      );
    } else if (!servico.ativo) {
      achados.push(achado(NIVEL.AVISO, "Serviço não está ativo", `estado atual: ${servico.estadoAtivo}/${servico.subEstado}`));
    }
  }

  // 3. Atividade real de dispositivos e OTA.
  if (!prontidaoApp.disponivel) {
    achados.push(
      achado(
        NIVEL.AVISO,
        "Atividade dos ESP32 desconhecida",
        `${prontidaoApp.motivo}. Não é possível saber quantos canais de comando estão abertos nem se há OTA em andamento; trate como desconhecido, não como zero.`
      )
    );
  } else {
    const canais = prontidaoApp.dispositivos ? prontidaoApp.dispositivos.canaisDeComando : null;
    const conectados = prontidaoApp.dispositivos ? prontidaoApp.dispositivos.conectados : null;
    if (canais !== null) {
      achados.push(
        achado(
          NIVEL.INFO,
          "Dispositivos com canal de comandos aberto",
          `${canais} de ${conectados} presentes no hub. Uma parada derruba esses sockets; os ESP32 reconectam sozinhos depois que o serviço volta.`,
          { valor: canais }
        )
      );
    }
    const ota = prontidaoApp.ota || {};
    if (ota.ativos > 0) {
      const fases = Object.entries(ota.porFase || {})
        .filter(([, n]) => n > 0)
        .map(([fase, n]) => `${fase}: ${n}`)
        .join(", ");
      achados.push(
        achado(
          NIVEL.BLOQUEIO,
          "Atualização de firmware em andamento",
          `${ota.ativos} dispositivo(s) em OTA (${fases}). Interromper agora pode deixar ESP32 em estado inconsistente. Aguarde o fim ou cancele a distribuição na Administração.`
        )
      );
    }
    const rollout = prontidaoApp.rollout;
    // A paused rollout is not harmless: it touches devices again when resumed, and may have devices
    // STILL IN FLIGHT at pause time (updating, rebooting or validating). Interrupting the service
    // while an ESP32 is writing flash risks a device that does not come back.
    const emVoo = Number(rollout && rollout.emAndamento) || 0;
    const pendentes = Number(rollout && rollout.pendentes) || 0;
    if (rollout && (rollout.ativo || (rollout.pausado && (pendentes || emVoo)))) {
      const contagens = [pendentes ? `${pendentes} pendente(s)` : null, emVoo ? `${emVoo} em voo` : null].filter(Boolean).join(", ");
      // A device in flight blocks even with the rollout paused; pending work only warns.
      const bloqueia = rollout.ativo || emVoo > 0;
      achados.push(
        achado(
          bloqueia ? NIVEL.BLOQUEIO : NIVEL.AVISO,
          rollout.ativo
            ? "Distribuição de firmware ativa"
            : emVoo
              ? "Distribuição pausada com dispositivos ainda em atualização"
              : "Distribuição de firmware pausada com trabalho pendente",
          `versão ${rollout.versao || "?"}, estado ${rollout.estado || "?"}${contagens ? `, ${contagens}` : ""}. ` +
            (bloqueia
              ? "Espere os dispositivos em voo terminarem, ou cancele, antes de interromper o serviço."
              : "Ela volta a mexer nos dispositivos quando for retomada.")
        )
      );
    }
  }

  // 4. User sessions: recent activity, not an exact count of connected users.
  if (opcoes.interrompeServico || opcoes.exigeAplicacaoParada) {
    const banco = coleta.espiarBanco({ permitirLeitura: saude.respondeu });
    if (banco.lido && banco.sessoesAbertas !== null) {
      achados.push(
        achado(
          NIVEL.INFO,
          "Sessões de usuário abertas no banco",
          `${banco.sessoesAbertas} sessão(ões) sem logout registrado. Isso é atividade recente, não a contagem exata de quem está com a tela aberta. ` +
            "O reinício invalida todas as sessões (o servidor encerra as ativas na partida) e os usuários precisarão entrar de novo.",
          { valor: banco.sessoesAbertas }
        )
      );
    } else {
      achados.push(
        achado(NIVEL.INFO, "Sessões de usuário desconhecidas", banco.erro || "o banco não pôde ser lido agora; trate como desconhecido")
      );
    }
  }

  // 5. Backup available.
  if (opcoes.exigeBackup) {
    const backups = coleta.listarBackups();
    if (!backups.disponivel || !backups.ultimo) {
      achados.push(
        achado(
          NIVEL.AVISO,
          "Sem backup registrado",
          "Nenhum backup foi encontrado. A atualização faz um backup antes de começar, mas convém ter um verificado à mão."
        )
      );
    } else {
      const idadeH = Math.round((Date.now() - Date.parse(backups.ultimo.modificadoEm)) / 3600000);
      achados.push(
        achado(
          idadeH > 48 ? NIVEL.AVISO : NIVEL.INFO,
          "Último backup",
          `${backups.ultimo.nome} (${(backups.ultimo.bytes / 1024).toFixed(0)} KiB, há ${idadeH} h)`
        )
      );
    }
  }

  // 6. Disk space.
  const discos = await coleta.lerDisco([...new Set([app.dirDados, config.DIR_CHECKOUT])]);
  for (const disco of discos) {
    if (!disco.suportado) continue;
    if (disco.livreBytes < DISCO_MINIMO_BYTES) {
      achados.push(
        achado(
          NIVEL.BLOQUEIO,
          "Espaço em disco insuficiente",
          `${disco.caminho}: ${(disco.livreBytes / 1048576).toFixed(0)} MiB livres (mínimo ${DISCO_MINIMO_BYTES / 1048576} MiB). ` +
            "Backup pré-atualização e npm ci precisam de espaço; sem ele a operação falha no meio."
        )
      );
    } else if (disco.usoPercentual >= 90) {
      achados.push(achado(NIVEL.AVISO, "Disco quase cheio", `${disco.caminho}: ${disco.usoPercentual}% usado`));
    }
  }

  // 7. Database quarantined by a previous recovery.
  const quarentena = coleta.quarentenaDoBanco();
  if (quarentena.length) {
    achados.push(
      achado(NIVEL.AVISO, "Há banco em quarentena", `${quarentena.length} arquivo(s) .corrompido-* preservados em ${path.dirname(app.banco)} de uma recuperação anterior.`)
    );
  }

  const bloqueios = achados.filter((a) => a.nivel === NIVEL.BLOQUEIO);
  return {
    avaliadoEm: new Date().toISOString(),
    pronto: bloqueios.length === 0,
    bloqueios,
    avisos: achados.filter((a) => a.nivel === NIVEL.AVISO),
    informacoes: achados.filter((a) => a.nivel === NIVEL.INFO),
    contexto: {
      aplicacaoNoAr: saude.respondeu,
      servicoAtivo: servico.suportado ? servico.ativo : null,
      prontidaoObservavel: prontidaoApp.disponivel,
    },
  };
}

module.exports = { avaliar, consultarProntidaoDaAplicacao, garantirTokenProntidao, lerTokenProntidao, caminhoTokenProntidao, NIVEL };
