#!/usr/bin/env python3
"""RemoteIFES server entrypoint (./server.sh, server.bat). Prepares what is missing through the
existing setup (remoteifes-server/setup.sh; on Windows the README's npm install + .env copy) and
starts the server with the package.json start script, without npm staying resident."""

import os
import shlex
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

from startup import common as c

SERVER_DIR = c.SERVER_DIR
SETUP = os.path.join(SERVER_DIR, "setup.sh")
ENV_FILE = os.path.join(SERVER_DIR, ".env")
ENV_EXAMPLE = os.path.join(SERVER_DIR, ".env.example")
PACKAGE_JSON = os.path.join(SERVER_DIR, "package.json")
SERVICE = "remoteifes.service"
DEFAULT_PORT = 8080
# Process variables win over .env, as with node --env-file.
SETTINGS = ("NODE_ENV", "PORTA", "BIND_ADDR", "SENHA_ADMIN_INICIAL", "REMOTEIFES_DATA_DIR", "REMOTEIFES_DB_PATH")
# Where setup.sh (Linux) or Homebrew (macOS) put a freshly installed node.
NODE_INSTALL_BIN = {"linux": ["/usr/local/bin"], "darwin": ["/opt/homebrew/bin", "/usr/local/bin"]}
WILDCARD = ("", "0.0.0.0", "::", "[::]")

USAGE = """uso: ./server.sh [--preparar | --verificar]      (Windows: server.bat)

  sem opção     prepara o que faltar (Node.js, dependências, .env) e inicia o servidor
  --preparar    prepara sem iniciar
  --verificar   só confere; não instala nem inicia nada (código 1 se faltar algo)

  REMOTEIFES_NODE=<caminho do node>   usa exatamente esse Node.js
  NO_COLOR=1                          saída sem cores"""


def parse_args(argv):
    modes = {"--preparar": "prepare", "--verificar": "check", "-h": "help", "--ajuda": "help", "--help": "help"}
    if not argv:
        return "start"
    if len(argv) == 1 and argv[0] in modes:
        return modes[argv[0]]
    raise c.UsageError("opção desconhecida: %s (veja --ajuda)" % " ".join(argv))


def summarize(items, limit=3):
    return ", ".join(items[:limit]) + (" e mais %d" % (len(items) - limit) if len(items) > limit else "")


def check_node_install_prerequisites(plat, env, minimum, selection):
    manual = "Ou instale o Node.js %s+ (https://nodejs.org/en/download) e rode de novo." % c.format_version(minimum)
    if plat.system == "windows":
        raise c.node_missing_error(
            minimum,
            selection,
            ["Instale o Node.js 22 LTS: https://nodejs.org/en/download (ou: winget install OpenJS.NodeJS.LTS)", "Depois abra um novo terminal e rode server.bat de novo."],
        )
    search = os.pathsep.join(NODE_INSTALL_BIN["darwin"] + c.path_entries(env))
    if plat.system == "darwin":
        if not shutil.which("brew", path=search):
            raise c.node_missing_error(minimum, selection, ["Instale o Node.js 22 LTS (https://nodejs.org/en/download ou brew install node@22) e rode de novo."])
        return
    if plat.node_dist_arch is None:
        if plat.arch == "armv6l":
            message = "ARMv6 (Raspberry Pi 1, Zero, Zero W): não há Node.js 22 oficial para essa arquitetura."
            hints = ["Use um Raspberry Pi 3, 4, 5 ou Zero 2 W.", "Com um Node.js %s+ compatível já instalado, aponte REMOTEIFES_NODE para ele." % c.format_version(minimum)]
        else:
            message = "a instalação automática do Node.js não cobre a arquitetura %s." % plat.arch
            hints = [manual]
        raise c.StartupError(message, hints)
    if plat.libc is not None and plat.libc < c.NODE_GLIBC_MINIMUM:
        raise c.StartupError(
            "glibc %s: o Node.js 22 oficial exige glibc 2.28 ou mais nova." % c.format_version(plat.libc),
            ["Atualize o sistema (Raspberry Pi OS Buster ou posterior)."],
        )
    missing = [tool for tool in ("bash", "curl", "tar", "xz") if not shutil.which(tool, path=env.get("PATH"))]
    if not (shutil.which("sha256sum", path=env.get("PATH")) or shutil.which("shasum", path=env.get("PATH"))):
        missing.append("sha256sum")
    if missing:
        raise c.StartupError(
            "faltam ferramentas para instalar o Node.js: %s." % ", ".join(missing),
            ["Debian/Raspberry Pi OS: sudo apt install curl xz-utils coreutils", manual],
        )
    if not c.is_root() and not os.access("/usr/local/lib", os.W_OK) and not shutil.which("sudo", path=env.get("PATH")):
        raise c.StartupError("instalar o Node.js em /usr/local exige root, e o sudo não está disponível.", [manual])


def require_npm(child, node):
    npm = c.find_npm(child, node.path)
    if not npm:
        raise c.StartupError(
            "npm não encontrado para o Node.js em %s." % node.path,
            ["Instale o npm correspondente (Debian/Ubuntu: sudo apt install npm) ou aponte REMOTEIFES_NODE para um Node.js que o traga."],
        )
    return npm


def run_setup(term, plat, env, node):
    if node:
        child = c.child_env(env, node.path)
        require_npm(child, node)
    else:
        child = c.with_path_prefix(env, NODE_INSTALL_BIN[plat.system])
    if not shutil.which("bash", path=child.get("PATH")):
        raise c.StartupError("bash não encontrado; o remoteifes-server/setup.sh precisa dele.", ["Debian/Raspberry Pi OS: sudo apt install bash"])
    term.step("Preparação: remoteifes-server/setup.sh")
    if node is None:
        term.warn("o setup.sh vai instalar o Node.js; a extração em /usr/local pode pedir a senha do sudo")
    code = c.run(["bash", SETUP], cwd=SERVER_DIR, env=child)
    if code != 0:
        raise c.StartupError("setup.sh terminou com código %d; veja a saída acima." % code)
    term.ok("setup.sh concluído")


def prepare_windows(term, node, missing, has_env, env):
    child = c.child_env(env, node.path)
    if missing:
        npm = require_npm(child, node)
        term.step("Preparação: npm install")
        code = c.run([npm, "install"], cwd=SERVER_DIR, env=child)
        if code != 0:
            raise c.StartupError("npm install terminou com código %d; veja a saída acima." % code)
    if not has_env:
        shutil.copyfile(ENV_EXAMPLE, ENV_FILE)
        term.ok(".env criado a partir de .env.example")


def effective_settings(env):
    settings = c.read_env_file(ENV_FILE)
    settings.update({key: env[key] for key in SETTINGS if key in env})
    return settings


def parse_port(value):
    text = (value or "").strip()
    if not text:
        return DEFAULT_PORT
    if text.isdigit() and 1 <= int(text) <= 65535:
        return int(text)
    raise c.StartupError("PORTA inválida: %r." % text, ["Corrija PORTA em remoteifes-server/.env (1 a 65535)."])


def database_path(settings):
    data_dir = os.path.join(SERVER_DIR, settings.get("REMOTEIFES_DATA_DIR") or "data")
    return os.path.join(SERVER_DIR, settings.get("REMOTEIFES_DB_PATH") or os.path.join(data_dir, "remoteifes.db"))


def report_settings(term, plat, settings):
    node_env = settings.get("NODE_ENV") or "development"
    port = parse_port(settings.get("PORTA"))
    bind = settings.get("BIND_ADDR") or ""
    term.ok(".env: NODE_ENV=%s, PORTA=%d%s" % (node_env, port, ", BIND_ADDR=%s" % bind if bind else ""))
    if node_env == "production":
        if plat.system == "linux":
            term.detail("produção: para operação permanente use o serviço systemd (sudo bash remoteifes-server/install-service.sh)")
    else:
        term.warn("modo de desenvolvimento: sem restrição de rede e com CORS aberto; não deixe assim numa rede compartilhada")
    if not settings.get("SENHA_ADMIN_INICIAL") and not os.path.exists(database_path(settings)):
        term.warn("banco novo sem SENHA_ADMIN_INICIAL: o primeiro acesso é superadmin / admin; troque a senha no aviso exibido")
    return port, bind


def owning_service_state(plat):
    """ActiveState of remoteifes.service when that unit runs this very checkout, else None."""
    if plat.system != "linux" or not os.path.isdir("/run/systemd/system") or not shutil.which("systemctl"):
        return None
    try:
        r = subprocess.run(
            ["systemctl", "show", SERVICE, "--property=LoadState,ActiveState,WorkingDirectory"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            universal_newlines=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    props = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    directory = props.get("WorkingDirectory", "")
    if props.get("LoadState") != "loaded" or not directory:
        return None
    if os.path.realpath(directory) != os.path.realpath(SERVER_DIR):
        return None
    return props.get("ActiveState") or "desconhecido"


def probe_host(bind):
    return "127.0.0.1" if bind in WILDCARD else bind


def port_hint(plat, port):
    if plat.system == "windows":
        return "Descubra quem a usa: netstat -ano | findstr :%d" % port
    if plat.system == "darwin":
        return "Descubra quem a usa: lsof -nP -iTCP:%d -sTCP:LISTEN" % port
    return "Descubra quem a usa: ss -ltnp 'sport = :%d'" % port


def print_urls(term, port, bind):
    term.say("")
    term.say("Endereços do RemoteIFES:")
    if bind in WILDCARD:
        term.field("Neste host", "http://localhost:%d" % port)
        lan = c.lan_address()
        if lan:
            term.field("Na rede local", "http://%s:%d" % (lan, port))
    elif bind in ("127.0.0.1", "::1", "localhost"):
        term.field("Neste host", "http://localhost:%d" % port)
        term.field("Na rede local", "pelo proxy reverso (BIND_ADDR=%s)" % bind)
    else:
        term.field("Endereço", "http://%s:%d" % ("[%s]" % bind if ":" in bind else bind, port))


def start_command(node_path):
    script = c.read_json(PACKAGE_JSON).get("scripts", {}).get("start", "")
    tokens = shlex.split(script)
    if not tokens or tokens[0] != "node":
        raise c.StartupError("o script start do remoteifes-server/package.json não começa com node.", ["Inicie manualmente: cd remoteifes-server && npm start"])
    return [node_path] + tokens[1:]


def run(argv, term, env):
    mode = parse_args(argv)
    if mode == "help":
        term.say(USAGE)
        return 0
    plat = c.detect_platform()
    term.header("RemoteIFES - servidor")
    c.report_platform(term, plat)
    if c.is_root():
        term.warn("rodando como root: dependências e banco criados agora ficam com dono root; prefira a conta dona do checkout")
    minimum = c.minimum_node_version(PACKAGE_JSON)

    term.step("Node.js %s ou mais novo" % c.format_version(minimum))
    selection = c.select_node(minimum, plat, env)
    c.report_node(term, selection, minimum, plat)
    node = selection.node
    if node is None:
        if selection.override:
            raise c.node_missing_error(minimum, selection, ["Corrija ou remova REMOTEIFES_NODE."])
        term.warn("nenhum Node.js utilizável encontrado")

    term.step("Dependências e configuração")
    missing = c.missing_dependencies(SERVER_DIR)
    has_env = os.path.isfile(ENV_FILE)
    if missing:
        term.warn("dependências ausentes ou desatualizadas (%d): %s" % (len(missing), summarize(missing)))
    else:
        term.ok("dependências conferem com o package-lock.json")
    if not has_env:
        term.warn(".env ausente; será criado a partir de .env.example")

    if node is None or missing or not has_env:
        if mode == "check":
            raise c.StartupError("o servidor ainda não está pronto para iniciar.", ["./server.sh (Windows: server.bat) prepara o que falta; --preparar só prepara."])
        if node is None:
            check_node_install_prerequisites(plat, env, minimum, selection)
        if plat.system == "windows":
            prepare_windows(term, node, missing, has_env, env)
        else:
            run_setup(term, plat, env, node)
        if node is None:
            term.step("Node.js instalado")
            selection = c.select_node(minimum, plat, env)
            c.report_node(term, selection, minimum, plat)
            node = selection.node
            if node is None:
                raise c.node_missing_error(minimum, selection, ["A instalação automática não deixou um Node.js utilizável; instale manualmente: https://nodejs.org/en/download"])
        missing = c.missing_dependencies(SERVER_DIR)
        if missing:
            raise c.StartupError("dependências ainda incompletas após a preparação: %s." % summarize(missing))
        if not os.path.isfile(ENV_FILE):
            raise c.StartupError("remoteifes-server/.env não foi criado.")
        term.ok("dependências e .env prontos")

    port, bind = report_settings(term, plat, effective_settings(env))
    if mode != "start":
        term.say("")
        term.ok("pronto para iniciar: ./server.sh (Windows: server.bat)")
        return 0

    term.step("Partida")
    service = owning_service_state(plat)
    state, health = c.server_status(probe_host(bind), port)
    if state == "remoteifes":
        managed = " pelo %s" % SERVICE if service else ""
        term.ok("o RemoteIFES já está rodando na porta %d%s (ambiente %s); nada foi iniciado" % (port, managed, health.get("ambiente", "?")))
        print_urls(term, port, bind)
        return 0
    if service is not None:
        raise c.StartupError(
            "este checkout é o do %s (estado: %s), e é o systemd quem inicia o servidor." % (SERVICE, service),
            ["Inicie pelo Console de Operações (./console.sh) ou: sudo systemctl start %s" % SERVICE, "Registros: sudo journalctl -u %s -e" % SERVICE],
        )
    if state == "other":
        raise c.StartupError("a porta %d já está em uso por outro programa." % port, [port_hint(plat, port), "Ou troque PORTA em remoteifes-server/.env."])
    command = start_command(node.path)
    term.ok("porta %d livre; iniciando (Ctrl+C encerra)" % port)
    print_urls(term, port, bind)
    term.say("")
    return c.exec_or_wait(command, SERVER_DIR, c.child_env(env, node.path))


def main(argv=None):
    term = c.Terminal()
    return c.guard(term, lambda: run(sys.argv[1:] if argv is None else argv, term, os.environ))


if __name__ == "__main__":
    sys.exit(main())
