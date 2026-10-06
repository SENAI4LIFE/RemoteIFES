#!/usr/bin/env python3
"""Operations Console entrypoint (./console.sh, console.bat). Installs the Console with its own
portable installer only when no installation exists, then hands over to the installed launcher."""

import json
import os
import socket
import subprocess
import sys

sys.dont_write_bytecode = True

from startup import common as c

CONSOLE_DIR = c.CONSOLE_DIR
INSTALLER = os.path.join(CONSOLE_DIR, "instalacao", "instalar.js")
PACKAGE_JSON = os.path.join(CONSOLE_DIR, "package.json")
LAUNCHER_OPTIONS = ("--status", "--iniciar", "--criar-operador", "--menu", "--abrir-app")
DEFAULT_PORT = 8099
# The installation roots come from the Console's own platform adapters (scopes, XDG, %LOCALAPPDATA%).
ROOTS_QUERY = (
    "const p=require(process.argv[1]);"
    "process.stdout.write(JSON.stringify(['sistema','usuario'].map(e=>p.diretoriosPadrao({escopo:e}).raizInstalacao)))"
)

USAGE = """uso: ./console.sh [--verificar | opção do lançador]      (Windows: console.bat)

  sem opção          instala o Console de Operações na primeira vez, com ícone na área de
                     trabalho, e o abre no navegador (sem interface gráfica, como numa sessão
                     SSH, ou como root: só o inicia, como --iniciar, e mostra o endereço)
  --verificar        só confere o Node.js e a instalação; não instala nem abre nada
  --status           estado do console, da aplicação e da versão do programa
  --iniciar          inicia o console sem abrir o navegador
  --criar-operador   cria o primeiro operador pelo terminal
  --menu             menu interativo do lançador
  --abrir-app        abre o RemoteIFES no navegador

  As opções do lançador vão para o lançador instalado (launcher-bootstrap.js).
  REMOTEIFES_NODE=<caminho do node>   usa exatamente esse Node.js
  NO_COLOR=1                          saída sem cores"""


class Installation:
    def __init__(self, root, version=None, scope=None, state_dir=None, port=DEFAULT_PORT):
        self.root = root
        self.launcher = os.path.join(root, "launcher-bootstrap.js")
        self.version = version
        self.scope = scope
        self.state_dir = state_dir
        self.port = port


def parse_args(argv):
    if any(arg in ("-h", "--ajuda", "--help") for arg in argv):
        return "help", []
    check = "--verificar" in argv
    rest = [arg for arg in argv if arg != "--verificar"]
    unknown = [arg for arg in rest if arg not in LAUNCHER_OPTIONS]
    if unknown:
        raise c.UsageError("opção desconhecida: %s (veja --ajuda)" % " ".join(unknown))
    if check and rest:
        raise c.UsageError("--verificar não se combina com opções do lançador")
    if len(rest) > 1:
        raise c.UsageError("use uma opção do lançador por vez")
    return ("check" if check else "run"), rest


def installation_roots(node, env):
    roots = [os.path.abspath(env["CONSOLE_RAIZ_INSTALACAO"])] if env.get("CONSOLE_RAIZ_INSTALACAO") else []
    try:
        r = subprocess.run(
            [node.path, "-e", ROOTS_QUERY, os.path.join(CONSOLE_DIR, "src", "plataforma")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=60,
            env=env,
        )
        found = json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise c.StartupError("não foi possível consultar onde o console se instala: %s" % exc)
    if not isinstance(found, list):
        last = (r.stderr.strip().splitlines() or ["sem detalhe"])[-1]
        raise c.StartupError("não foi possível consultar onde o console se instala: %s" % last)
    return roots + [root for root in found if isinstance(root, str)]


def find_installation(node, env):
    for root in installation_roots(node, env):
        if not os.path.isfile(os.path.join(root, "launcher-bootstrap.js")):
            continue
        try:
            record = c.read_json(os.path.join(root, "estado-instalacao.json"))
        except (OSError, ValueError):
            record = {}
        if not isinstance(record, dict):
            record = {}
        # Same precedence as instalacao/console-bootstrap.js: the environment wins over the record.
        port = env.get("CONSOLE_PORTA") or record.get("porta")
        port = int(port) if str(port).isdigit() and 1 <= int(port) <= 65535 else DEFAULT_PORT
        state_dir = env.get("CONSOLE_ESTADO_DIR") or record.get("estado")
        return Installation(root, record.get("versaoAtiva"), record.get("escopo"), state_dir, port)
    return None


def report_installation(term, installation):
    term.ok("instalado em %s (versão %s, escopo %s)" % (installation.root, installation.version or "?", installation.scope or "?"))
    try:
        checkout = c.read_json(PACKAGE_JSON).get("version")
    except (OSError, ValueError):
        checkout = None
    if installation.version and checkout and installation.version != checkout:
        term.detail("o checkout traz a versão %s; o console instalado se atualiza pelos releases publicados, não pelo checkout" % checkout)


def install(term, plat, node, child):
    missing = c.missing_dependencies(CONSOLE_DIR, production_only=True)
    if missing:
        term.step("Dependências do console: npm ci --omit=dev")
        npm = c.find_npm(child, node.path)
        if not npm:
            raise c.StartupError("npm não encontrado para o Node.js em %s." % node.path, ["Instale o npm correspondente (Debian/Ubuntu: sudo apt install npm)."])
        code = c.run(c.as_invoking_user([npm, "ci", "--omit=dev"], child), cwd=CONSOLE_DIR, env=child)
        if code != 0:
            raise c.StartupError("npm ci terminou com código %d; veja a saída acima." % code)
        if c.missing_dependencies(CONSOLE_DIR, production_only=True):
            raise c.StartupError("as dependências do console continuam incompletas depois do npm ci.")
    term.step("Instalação: remoteifes-console/instalacao/instalar.js")
    if plat.system == "linux" and not c.is_root() and os.path.isdir("/run/systemd/system"):
        term.warn("instalação por usuário: sem o socket do systemd e o auxiliar privilegiado (controle do serviço indisponível)")
        term.detail("para instalá-los: sudo ./console.sh")
    code = c.run([node.path, INSTALLER, "--atalho-area-de-trabalho"], cwd=CONSOLE_DIR, env=child)
    if code != 0:
        raise c.StartupError("o instalador terminou com código %d; veja a saída acima." % code)


def ssh_session(env):
    return any(env.get(name) for name in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"))


def default_launcher_args(plat, env):
    if c.is_root():
        return ["--iniciar"]
    if plat.system == "linux":
        has_display = env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")
        return [] if has_display else ["--iniciar"]
    return ["--iniciar"] if ssh_session(env) else []


def print_urls(term, plat, installation, env):
    url = "http://127.0.0.1:%d/" % installation.port
    entry = "console.bat" if plat.system == "windows" else "./console.sh"
    term.say("")
    term.say("Console de Operações:")
    term.field("Neste host", url)
    if plat.system != "windows" or ssh_session(env):
        tunnel = "ssh -L %d:127.0.0.1:%d %s@%s" % (installation.port, installation.port, c.invoking_user(env), socket.gethostname())
        term.field("De outra máquina", "%s  e abra %s" % (tunnel, url))
    if installation.state_dir and os.path.exists(os.path.join(installation.state_dir, "bootstrap-token")):
        sudo = "sudo " if installation.scope == "sistema" and plat.system != "windows" else ""
        term.field("Primeiro operador", "%s%s --criar-operador" % (sudo, entry))


def run(argv, term, env):
    mode, launcher_args = parse_args(argv)
    if mode == "help":
        term.say(USAGE)
        return 0
    plat = c.detect_platform()
    term.header("RemoteIFES - Console de Operações")
    c.report_platform(term, plat)
    minimum = c.minimum_node_version(PACKAGE_JSON)

    term.step("Node.js %s ou mais novo" % c.format_version(minimum))
    selection = c.select_node(minimum, plat, env)
    c.report_node(term, selection, minimum, plat)
    node = selection.node
    if node is None:
        if plat.system == "linux":
            hints = ["./server.sh instala o Node.js oficial e prepara o servidor; depois rode ./console.sh."]
        else:
            hints = ["Instale o Node.js 22 LTS (https://nodejs.org/en/download) e rode de novo."]
        if c.is_root() and env.get("SUDO_USER"):
            hints.append("Sob sudo o PATH muda: sudo env \"PATH=$PATH\" ./console.sh, ou REMOTEIFES_NODE=<caminho>.")
        raise c.node_missing_error(minimum, selection, hints)
    child = c.child_env(env, node.path)

    term.step("Instalação")
    installation = find_installation(node, child)
    if installation is None:
        term.warn("o Console de Operações ainda não está instalado")
        if mode == "check":
            raise c.StartupError("console não instalado.", ["./console.sh (Windows: console.bat) instala e abre o console."])
        install(term, plat, node, child)
        installation = find_installation(node, child)
        if installation is None:
            raise c.StartupError("a instalação terminou, mas o lançador instalado não foi encontrado.", ["Veja a saída do instalador acima."])
    report_installation(term, installation)
    if mode == "check":
        term.say("")
        term.ok("pronto: ./console.sh (Windows: console.bat) abre o console")
        return 0

    args = launcher_args or default_launcher_args(plat, env)
    term.step("Lançador: %s" % " ".join(["launcher-bootstrap.js"] + args))
    code = c.run([node.path, installation.launcher] + args, env=child)
    if code != 0:
        raise c.StartupError(
            "o lançador do console terminou com código %d; veja a mensagem acima." % code,
            ["Situação: ./console.sh --status", "Reparo: README, seção Recuperação de emergência por terminal."],
        )
    if args in ([], ["--iniciar"]):
        print_urls(term, plat, installation, env)
    return 0


def main(argv=None):
    term = c.Terminal()
    return c.guard(term, lambda: run(sys.argv[1:] if argv is None else argv, term, os.environ))


if __name__ == "__main__":
    sys.exit(main())
