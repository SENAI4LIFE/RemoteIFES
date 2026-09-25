const base = require("./base");

// Platform adapter selection. A single choice point; the rest of the Console talks to the
// interface, never to `process.platform`.
//
// CONSOLE_PLATAFORMA forces an adapter in tests, which exercises the Windows and macOS paths from
// any machine without pretending it replaces real execution on those systems.

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
 * Snapshot of this platform's capabilities. Serves the interface (to disable with a reason) and the
 * backend (which actually refuses: a disabled button is not access control).
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
