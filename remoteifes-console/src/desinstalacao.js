const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");
const plataforma = require("./plataforma");

// The Console runs instalacao/desinstalar.js itself only where its own account can finish every
// step and the supervised job survives the Console being stopped: user scope on Linux and macOS.
// Linux system scope needs root outside the service sandbox (/etc and /usr are read-only there),
// and root must never run code the Console account can rewrite; the .deb belongs to dpkg; on
// Windows the taskkill /T that stops the Console would also end the uninstaller it started.

const LISTA_DPKG = "/var/lib/dpkg/info/remoteifes-console.list";
const CHAVE_WINDOWS = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteIFESConsole";

function registroDaInstalacao() {
  return estado.lerJson(path.join(config.RAIZ_INSTALACAO, "estado-instalacao.json"), null);
}

function aspas(caminho) {
  return /[\s"'$`\\]/.test(caminho) ? `"${caminho.replace(/(["$`\\])/g, "\\$1")}"` : caminho;
}

function comandoNode(script, ...args) {
  return [aspas(process.execPath), aspas(script), ...args].join(" ");
}

function mesmoCaminho(a, b) {
  const real = (c) => {
    try {
      return fs.realpathSync.native(c);
    } catch {
      return path.resolve(c);
    }
  };
  const x = real(a);
  const y = real(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The installation this process belongs to: its payload is one of <raiz>/versoes and the record of
 * that root names the state directory this process uses. Anything else fails closed, because the
 * uninstaller would otherwise pair one installation's program with another one's state and identity
 * contract, and could stop a different console.
 */
function instalacaoVinculada() {
  const registro = registroDaInstalacao();
  if (!registro || !mesmoCaminho(path.dirname(config.RAIZ_CONSOLE), path.join(config.RAIZ_INSTALACAO, "versoes"))) {
    return { ok: false, registro, motivo: "Este console roda a partir do código-fonte do checkout, sem programa instalado: não há o que desinstalar." };
  }
  if (typeof registro.estado !== "string" || !registro.estado || !mesmoCaminho(registro.estado, config.DIR_ESTADO)) {
    return {
      ok: false,
      registro,
      motivo:
        `O registro da instalação em ${config.RAIZ_INSTALACAO} aponta o estado ${registro.estado || "(nenhum)"}, mas este console ` +
        `usa ${config.DIR_ESTADO}. Com os dois divergindo, a desinstalação pelo console fica bloqueada para não misturar ` +
        "instalações; confira a configuração do serviço e desinstale pelo terminal.",
    };
  }
  return { ok: true, registro };
}

/**
 * Arguments that pin the uninstaller to this installation. Left to itself it infers the root from
 * where it lives and falls back to the platform default.
 */
function argumentosDoDesinstalador(...extras) {
  const vinculo = instalacaoVinculada();
  if (!vinculo.ok) throw new Error(vinculo.motivo);
  const args = [path.join(config.RAIZ_CONSOLE, "instalacao", "desinstalar.js"), "--raiz", config.RAIZ_INSTALACAO, "--estado", vinculo.registro.estado];
  if (vinculo.registro.escopo === "usuario" || vinculo.registro.escopo === "sistema") args.push("--escopo", vinculo.registro.escopo);
  return args.concat(extras);
}

function situacao() {
  const vinculo = instalacaoVinculada();
  const registro = vinculo.registro;
  const instalado = vinculo.ok;
  const desinstalador = path.join(config.RAIZ_CONSOLE, "instalacao", "desinstalar.js");
  const escopo = (registro && registro.escopo) || null;
  const base = {
    instalado,
    plataforma: plataforma.nome,
    escopo,
    raiz: config.RAIZ_INSTALACAO,
    estado: config.DIR_ESTADO,
    preservado: ["operadores", "auditoria", "histórico de operações", "segredos do console"],
    naoTocado: ["o RemoteIFES, seu serviço e suas unidades", "o checkout, o banco e os backups da aplicação", "o Node instalado no host"],
    apagarEstado: "Para apagar também operadores e auditoria, repita a desinstalação no terminal com --apagar-estado.",
  };

  if (!instalado) {
    return {
      ...base,
      modo: "indisponivel",
      simulavel: false,
      motivo: vinculo.motivo,
      comando: null,
    };
  }

  if (plataforma.nome === "linux" && fs.existsSync(LISTA_DPKG)) {
    return {
      ...base,
      modo: "terminal",
      simulavel: false,
      motivo:
        "Esta instalação veio do pacote .deb, e os arquivos dela são do dpkg. Remova pelo gerenciador de pacotes, " +
        "que preserva operadores e auditoria (o purge apaga o estado).",
      comando: "sudo apt remove remoteifes-console",
    };
  }

  if (plataforma.nome === "windows") {
    const exe = path.join(config.RAIZ_INSTALACAO, "desinstalar.exe");
    return {
      ...base,
      modo: "terminal",
      simulavel: true,
      motivo:
        "No Windows, encerrar o console encerra também os processos que ele iniciou, inclusive um desinstalador. " +
        "Use Configurações > Aplicativos (Console de Operações RemoteIFES) ou o comando abaixo, fora do console.",
      comando: fs.existsSync(exe) ? aspas(exe) : comandoNode(desinstalador, "--sim"),
      chaveDoRegistro: CHAVE_WINDOWS,
    };
  }

  if (plataforma.nome !== "linux" && plataforma.nome !== "macos") {
    return {
      ...base,
      modo: "terminal",
      simulavel: true,
      motivo: "Este sistema não tem um modo de desinstalação pelo console.",
      comando: comandoNode(desinstalador, "--sim"),
    };
  }

  if (escopo !== "usuario") {
    return {
      ...base,
      modo: "terminal",
      simulavel: true,
      motivo:
        "A instalação de sistema tem a integração com o serviço do sistema (no Linux, unidades do systemd, a regra de sudo " +
        "e o auxiliar privilegiado), que pertence ao root. O console roda sem root e, no Linux, com /etc e /usr somente " +
        "leitura, então a remoção é feita no terminal do host.",
      comando: `sudo ${comandoNode(desinstalador, "--sim")}`,
    };
  }

  return {
    ...base,
    modo: "console",
    simulavel: true,
    motivo: null,
    comando: comandoNode(desinstalador, "--sim"),
    desinstalador,
  };
}

module.exports = { situacao, argumentosDoDesinstalador, LISTA_DPKG };
