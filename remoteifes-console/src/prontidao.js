const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const coleta = require("./coleta");
const trava = require("./trava");
const execucao = require("./execucao");

// Avaliação de impacto antes de interromper o serviço.
//
// Distinções que o RemoteIFES exige e que um painel ingênuo erra:
//  - `/admin/sessoes` mostra atividade recente, não a contagem exata de quem está conectado;
//  - "online" no banco não prova canal de comandos aberto com o ESP32;
//  - `modoManutencao` barra parte do acesso comum, mas não drena agendamento, ação de
//    administrador, comando de dispositivo nem OTA;
//  - `monitoramentoService` conta OTA em andamento sem a fase `validando`; aqui todas as
//    fases ativas entram, inclusive `validando` e rollout pausado com trabalho pendente;
//  - telemetria indisponível é **desconhecida**, nunca zero.

const NIVEL = { BLOQUEIO: "bloqueio", AVISO: "aviso", INFO: "info" };
const DISCO_MINIMO_BYTES = 200 * 1024 * 1024;

function caminhoTokenProntidao() {
  return path.join(config.caminhosDaAplicacao().dirDados, ".console-token");
}

/**
 * Garante o segredo compartilhado do contrato de prontidão. Criado com 0600 pelo console;
 * a aplicação apenas o lê. Sem ele a rota da aplicação responde 404 e não custa nada.
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
 * Consulta o contrato de prontidão da aplicação. Se a aplicação está parada, o resultado é
 * "não observável" — o que já é a informação relevante para uma parada.
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
 * Avalia se uma operação que interrompe o serviço pode começar.
 *
 * @param {object} opcoes
 *  - interrompeServico: a operação reinicia/para a aplicação
 *  - exigeBackup: a operação deve ter backup recente disponível
 *  - exigeRepositorioLimpo: a operação mexe no checkout
 *  - exigeAplicacaoParada: a operação exige que ninguém esteja escrevendo no banco
 */
async function avaliar(opcoes = {}) {
  const achados = [];
  const app = config.caminhosDaAplicacao();

  // 1. Manutenção conflitante (console, CLI ou resíduo).
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

  // 2. Estado do serviço e da aplicação.
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
    if (rollout && (rollout.ativo || (rollout.pausado && rollout.pendentes))) {
      achados.push(
        achado(
          rollout.ativo ? NIVEL.BLOQUEIO : NIVEL.AVISO,
          rollout.ativo ? "Distribuição de firmware ativa" : "Distribuição de firmware pausada com trabalho pendente",
          `versão ${rollout.versao || "?"}, estado ${rollout.estado || "?"}${rollout.pendentes ? `, ${rollout.pendentes} pendente(s)` : ""}. ` +
            (rollout.ativo
              ? "Pause ou cancele antes de interromper o serviço."
              : "Ela volta a mexer nos dispositivos quando for retomada.")
        )
      );
    }
  }

  // 4. Sessões de usuário: atividade recente, não contagem exata de conectados.
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

  // 5. Backup disponível.
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

  // 6. Espaço em disco.
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

  // 7. Banco em quarentena de uma recuperação anterior.
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
