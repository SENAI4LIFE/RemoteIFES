const base = require("./base");

// Seleção do adaptador de plataforma. Um único ponto de escolha; o resto do console fala com
// a interface, nunca com `process.platform`.
//
// CONSOLE_PLATAFORMA força um adaptador nos testes — é o que permite exercitar o caminho do
// Windows e do macOS a partir de qualquer máquina, sem fingir que isso substitui execução real
// naqueles sistemas.

function escolher() {
  const forcada = (process.env.CONSOLE_PLATAFORMA || "").trim().toLowerCase();
  const alvo = forcada || process.platform;
  switch (alvo) {
    case "linux":
      return require("./linux");
    case "win32":
    case "windows":
      return require("./windows");
    case "darwin":
    case "macos":
      return require("./macos");
    default:
      return base;
  }
}

const adaptador = escolher();

/**
 * Retrato das capacidades desta plataforma. Serve à interface (para desabilitar com motivo) e
 * ao backend (que recusa de verdade — botão desabilitado não é controle de acesso).
 */
async function capacidades() {
  const [servico, watchdog, registros, inicializacao, arquitetura, ferramentas] = await Promise.all([
    adaptador.estadoDoServico().catch((e) => base.recurso(base.ESTADO.INDISPONIVEL, e.message)),
    adaptador.estadoDoWatchdog().catch((e) => base.recurso(base.ESTADO.INDISPONIVEL, e.message)),
    adaptador.lerRegistros({ linhas: 10 }).catch((e) => base.recurso(base.ESTADO.INDISPONIVEL, e.message)),
    adaptador.estadoDaInicializacao().catch((e) => base.recurso(base.ESTADO.INDISPONIVEL, e.message)),
    adaptador.classificarArquitetura().catch(() => null),
    adaptador.ferramentas().catch(() => ({})),
  ]);

  const resumo = (r) => ({ estado: r.estado, disponivel: !!r.disponivel, motivo: r.motivo || null });

  return {
    plataforma: adaptador.nome,
    rotulo: adaptador.rotulo,
    arquitetura,
    runtime: adaptador.runtimeAtual(),
    ferramentas,
    recursos: {
      controleDeServico: resumo(servico),
      watchdog: resumo(watchdog),
      registrosDoSistema: resumo(registros),
      inicializacaoAutomatica: resumo(inicializacao),
      reinicioDoHost: { estado: base.ESTADO.SUPORTADO, disponivel: true, motivo: null },
      terminal: resumo(require("../terminal").disponibilidade().disponivel
        ? base.recurso(base.ESTADO.SUPORTADO)
        : base.recurso(base.ESTADO.NAO_INSTALADO, require("../terminal").disponibilidade().motivo)),
    },
  };
}

module.exports = { ...adaptador, ESTADO: base.ESTADO, recurso: base.recurso, capacidades, escolher };
