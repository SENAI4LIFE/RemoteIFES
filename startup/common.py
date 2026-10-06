"""Shared pieces of server.py and console.py: terminal output, platform and Node.js detection,
dependency checks and process helpers. Standard library only; runs on Python 3.7+."""

import glob
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "remoteifes-server")
CONSOLE_DIR = os.path.join(ROOT, "remoteifes-console")

FALLBACK_NODE_MINIMUM = (22, 13, 0)
NODE_PLATFORM = {"linux": "linux", "darwin": "darwin", "windows": "win32"}
SYSTEM_LABEL = {"linux": "Linux", "darwin": "macOS", "windows": "Windows"}
# Builds setup.sh can install (nodejs.org publishes no official Node 22 for ARMv6 or 32-bit x86).
LINUX_NODE_DIST = ("x64", "arm64", "armv7l")
NODE_GLIBC_MINIMUM = (2, 28)


class StartupError(Exception):
    def __init__(self, message, hints=()):
        Exception.__init__(self, message)
        self.message = message
        self.hints = list(hints)


class UsageError(Exception):
    pass


# --- Terminal -------------------------------------------------------------------------------


def _enable_windows_vt(stream):
    try:
        import ctypes
        import msvcrt

        kernel32 = ctypes.windll.kernel32
        handle = msvcrt.get_osfhandle(stream.fileno())
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        enable_vt = 0x0004
        return bool(mode.value & enable_vt) or bool(kernel32.SetConsoleMode(handle, mode.value | enable_vt))
    except Exception:
        return False


def supports_color(stream, env, system):
    if env.get("NO_COLOR") or env.get("TERM") == "dumb":
        return False
    try:
        if not stream.isatty():
            return False
    except (AttributeError, ValueError):
        return False
    if system == "windows":
        return _enable_windows_vt(stream)
    return True


class Terminal:
    TAGS = {"ok": ("[OK]", "32"), "warn": ("[WARN]", "33"), "error": ("[ERROR]", "31")}

    def __init__(self, out=None, err=None, env=None, system=None):
        self.out = out or sys.stdout
        self.err = err or sys.stderr
        env = os.environ if env is None else env
        system = system or detect_system()
        for stream in (self.out, self.err):
            # A redirected stream on Windows uses the ANSI code page; never die on an unencodable character.
            reconfigure = getattr(stream, "reconfigure", None)
            if reconfigure:
                try:
                    reconfigure(errors="replace")
                except (ValueError, OSError):
                    pass
        self.color_out = supports_color(self.out, env, system)
        self.color_err = supports_color(self.err, env, system)

    @staticmethod
    def _paint(enabled, code, text):
        return "\033[%sm%s\033[0m" % (code, text) if enabled else text

    def _line(self, text, stream=None):
        stream = stream or self.out
        stream.write(text + "\n")
        stream.flush()

    def header(self, title):
        self._line("")
        self._line(self._paint(self.color_out, "1", title))
        self._line("=" * len(title))

    def field(self, label, value):
        self._line("  %-17s %s" % (label, value))

    def step(self, title):
        self._line("")
        self._line(self._paint(self.color_out, "1", "==> " + title))

    def say(self, text=""):
        self._line(text)

    def _tagged(self, kind, message, stream, color):
        tag, code = self.TAGS[kind]
        self._line("%s %s" % (self._paint(color, code, tag.ljust(7)), message), stream)

    def ok(self, message):
        self._tagged("ok", message, self.out, self.color_out)

    def warn(self, message):
        self._tagged("warn", message, self.out, self.color_out)

    def error(self, message):
        self.out.flush()
        self._tagged("error", message, self.err, self.color_err)

    def detail(self, message, error=False):
        self._line(" " * 8 + message, self.err if error else self.out)


def guard(term, body):
    try:
        return body()
    except UsageError as exc:
        term.error(str(exc))
        return 2
    except StartupError as exc:
        term.error(exc.message)
        for hint in exc.hints:
            term.detail(hint, error=True)
        return 1
    except KeyboardInterrupt:
        term.error("interrompido.")
        return 130
    except BrokenPipeError:
        # Output piped to a reader that quit (| head): stop quietly instead of a traceback at exit.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 1
    except OSError as exc:
        term.error("%s%s" % (exc.strerror or exc, ": %s" % exc.filename if exc.filename else ""))
        return 1


# --- Platform -------------------------------------------------------------------------------


def detect_system(name=None):
    name = (name or platform.system()).lower()
    if name.startswith(("cygwin", "msys", "mingw")):
        return "windows"
    return name


def normalize_arch(machine, userland_bits):
    """Architecture of the userland that will run Node. A Raspberry Pi 3/4 can boot a 64-bit kernel
    (uname: aarch64) under a 32-bit Raspberry Pi OS: the Node build must be armv7l there."""
    m = (machine or "").lower()
    if m in ("x86_64", "amd64", "x64"):
        return "x64" if userland_bits == 64 else "x86"
    if m in ("i386", "i486", "i586", "i686", "x86"):
        return "x86"
    if m in ("aarch64", "arm64", "aarch64_be"):
        return "arm64" if userland_bits == 64 else "armv7l"
    if m.startswith("armv8") or m.startswith("armv7"):
        return "armv7l"
    if m.startswith("armv6"):
        return "armv6l"
    return m or "desconhecida"


def _read_text(path):
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", "replace").replace("\0", "").strip()
    except OSError:
        return None


def _glibc_version():
    try:
        value = os.confstr("CS_GNU_LIBC_VERSION")
    except (AttributeError, ValueError, OSError):
        return None
    if not value or not value.startswith("glibc "):
        return None
    return parse_version(value.split()[1])


def _os_release(path):
    for line in (_read_text(path) or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip("\"'") or None
    return None


def _os_version(system, os_release_path):
    if system == "linux":
        return _os_release(os_release_path)
    if system == "darwin":
        return platform.mac_ver()[0] or None
    if system == "windows":
        return platform.version() or None
    return None


class Platform:
    def __init__(self, system, machine, userland_bits, model=None, libc=None, os_version=None):
        self.system = system
        self.machine = machine
        self.userland_bits = userland_bits
        self.arch = normalize_arch(machine, userland_bits)
        self.model = model
        self.libc = libc
        self.os_version = os_version

    @property
    def kernel_bits(self):
        return 64 if (self.machine or "").lower() in ("x86_64", "amd64", "aarch64", "arm64", "aarch64_be") else 32

    @property
    def supported(self):
        return self.system in SYSTEM_LABEL

    @property
    def label(self):
        return SYSTEM_LABEL.get(self.system, self.system or "desconhecido")

    @property
    def node_platform(self):
        return NODE_PLATFORM.get(self.system)

    @property
    def node_dist_arch(self):
        if self.system == "linux" and self.arch in LINUX_NODE_DIST:
            return self.arch
        return None


def detect_platform(system=None, machine=None, userland_bits=None, model_path="/proc/device-tree/model", os_release_path="/etc/os-release"):
    system = detect_system(system)
    machine = machine if machine is not None else platform.machine()
    if userland_bits is None:
        userland_bits = struct.calcsize("P") * 8
    linux = system == "linux"
    plat = Platform(system, machine, userland_bits, _read_text(model_path) if linux else None, _glibc_version() if linux else None)
    if not linux:
        plat = Platform(system, machine, plat.kernel_bits)
    plat.os_version = _os_version(system, os_release_path)
    return plat


def report_platform(term, plat):
    term.field("Sistema", plat.label + (" - %s" % plat.os_version if plat.os_version else ""))
    if plat.model:
        term.field("Hardware", plat.model)
    detail = ""
    if plat.kernel_bits != plat.userland_bits:
        detail = " (kernel %s de %d bits, userland de %d bits)" % (plat.machine, plat.kernel_bits, plat.userland_bits)
    term.field("Arquitetura", plat.arch + detail)
    term.field("Python", platform.python_version())
    if not plat.supported:
        raise StartupError(
            "sistema %s não suportado; o RemoteIFES roda em Linux, macOS e Windows." % plat.label,
            ["Instale o Node.js 22.13+ e use os comandos manuais do README (seção Referência técnica)."],
        )


def is_root():
    return hasattr(os, "geteuid") and os.geteuid() == 0


def invoking_user(env):
    user = env.get("SUDO_USER") if is_root() else None
    if user and user != "root":
        return user
    try:
        import getpass

        return getpass.getuser()
    except Exception:
        return "usuario"


def as_invoking_user(cmd, env):
    """Under sudo, npm runs as the account that owns the checkout, so node_modules never ends up
    owned by root (deploy.sh later runs npm ci there as that account)."""
    if not is_root():
        return cmd
    user = env.get("SUDO_USER")
    if not user or user == "root" or not shutil.which("sudo"):
        return cmd
    return ["sudo", "-H", "-u", user, "--", "env", "PATH=" + env.get("PATH", "")] + list(cmd)


# --- Versions -------------------------------------------------------------------------------

_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def parse_version(text):
    m = _VERSION.match((text or "").strip())
    return tuple(int(part) for part in m.groups()) if m else None


def format_version(version):
    return ".".join(str(part) for part in version)


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def minimum_node_version(package_json):
    """Lower bound of engines.node (">=22.13.0"): package.json stays the single source of truth."""
    try:
        engines = read_json(package_json).get("engines", {}).get("node", "")
    except (OSError, ValueError, AttributeError):
        return FALLBACK_NODE_MINIMUM
    m = re.match(r"^\s*>=\s*(\S+)\s*$", engines)
    version = parse_version(m.group(1)) if m else None
    return version or FALLBACK_NODE_MINIMUM


# --- Node.js --------------------------------------------------------------------------------

_PROBE = "process.stdout.write([process.versions.node,process.arch,process.platform].join(' '))"


class NodeCandidate:
    def __init__(self, path, version=None, arch=None, node_platform=None, error=None):
        self.path = os.path.abspath(path)
        self.version = version
        self.arch = arch
        self.node_platform = node_platform
        self.error = error

    def problem(self, minimum, plat):
        if self.error:
            return self.error
        if self.node_platform != plat.node_platform:
            return "é um Node para %s, não para este sistema" % self.node_platform
        if self.version < minimum:
            return "%s é anterior ao mínimo %s" % (format_version(self.version), format_version(minimum))
        return None


def probe_node(path, timeout=30):
    if not os.path.isfile(path):
        return NodeCandidate(path, error="arquivo não existe")
    try:
        r = subprocess.run(
            [path, "-e", _PROBE],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return NodeCandidate(path, error="não respondeu em %d s" % timeout)
    except OSError as exc:
        # ENOENT on an existing file is a missing ELF loader: a binary for another userland.
        reason = exc.strerror or str(exc)
        return NodeCandidate(path, error="não executa neste sistema (%s; binário de outra arquitetura?)" % reason)
    if r.returncode != 0:
        return NodeCandidate(path, error="terminou com código %d" % r.returncode)
    parts = r.stdout.split()
    version = parse_version(parts[0]) if parts else None
    if version is None or len(parts) < 3:
        return NodeCandidate(path, error="resposta inesperada: %r" % r.stdout[:60])
    return NodeCandidate(path, version, parts[1], parts[2])


def _node_exe(plat):
    return "node.exe" if plat.system == "windows" else "node"


def path_entries(env):
    entries = env.get("PATH", "").split(os.pathsep)
    if os.name == "nt":
        entries = [d.strip('"') for d in entries]
    return [d for d in entries if d]


def _is_executable(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def node_candidates(plat, env):
    exe = _node_exe(plat)
    paths = [os.path.join(d, exe) for d in path_entries(env)]
    if plat.system == "windows":
        for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)")):
            if base:
                paths.append(os.path.join(base, "nodejs", exe))
        if env.get("LOCALAPPDATA"):
            paths.append(os.path.join(env["LOCALAPPDATA"], "Programs", "nodejs", exe))
        if env.get("NVM_SYMLINK"):
            paths.append(os.path.join(env["NVM_SYMLINK"], exe))
    else:
        # setup.sh links /usr/local/bin/node to /usr/local/lib/nodejs/node-v<versao>.
        paths.append("/usr/local/bin/node")
        installed = glob.glob("/usr/local/lib/nodejs/node-v*/bin/node")
        installed.sort(key=lambda p: parse_version(p.split("node-v")[-1]) or (0, 0, 0), reverse=True)
        paths.extend(installed)
        if plat.system == "darwin":
            paths.extend(["/opt/homebrew/bin/node", "/opt/homebrew/opt/node@22/bin/node", "/usr/local/opt/node@22/bin/node"])
    seen = set()
    result = []
    for candidate_path in paths:
        if not _is_executable(candidate_path):
            continue
        key = os.path.normcase(os.path.realpath(candidate_path))
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate_path)
    return result


class NodeSelection:
    def __init__(self, node, rejected, path_node=None, override=False):
        self.node = node
        self.rejected = rejected
        self.path_node = path_node
        self.override = override


def select_node(minimum, plat, env, probe=probe_node, candidates=None):
    """First Node that actually runs here and meets the minimum. REMOTEIFES_NODE pins one binary;
    an unsuitable pinned binary is an error, never silently replaced."""
    pinned = env.get("REMOTEIFES_NODE")
    if pinned:
        candidate = probe(pinned)
        ok = candidate.problem(minimum, plat) is None
        return NodeSelection(candidate if ok else None, [] if ok else [candidate], override=True)
    if candidates is None:
        candidates = node_candidates(plat, env)
    exe = _node_exe(plat)
    on_path = next((c for c in (os.path.join(d, exe) for d in path_entries(env)) if _is_executable(c)), None)
    rejected = []
    for candidate_path in candidates:
        candidate = probe(candidate_path)
        if candidate.problem(minimum, plat) is None:
            return NodeSelection(candidate, rejected, on_path)
        rejected.append(candidate)
    return NodeSelection(None, rejected, on_path)


def report_node(term, selection, minimum, plat):
    for candidate in selection.rejected:
        term.warn("ignorado: %s (%s)" % (candidate.path, candidate.problem(minimum, plat)))
    node = selection.node
    if node is None:
        return
    term.ok("Node.js %s (%s) em %s" % (format_version(node.version), node.arch, node.path))
    if selection.path_node and os.path.normcase(os.path.realpath(selection.path_node)) != os.path.normcase(
        os.path.realpath(node.path)
    ):
        term.detail("o node do PATH não atende; esta execução coloca %s à frente no PATH" % os.path.dirname(node.path))
    if node.arch == "arm":
        term.warn("ARMv7 (32 bits): suportado pelo Node.js 22 até 2027-04-30; planeje migrar o host para 64 bits")
        if node.version[0] >= 24:
            term.detail("o Node.js 24+ trata ARMv7 como experimental; o RemoteIFES é validado no 22.x")


def node_missing_error(minimum, selection, hints):
    if selection.override:
        return StartupError("REMOTEIFES_NODE não aponta para um Node.js %s ou mais novo utilizável." % format_version(minimum), hints)
    return StartupError("Node.js %s ou mais novo não encontrado." % format_version(minimum), hints)


def child_env(env, node_path):
    """Environment for every child process: the selected Node's directory first on PATH, so npm and
    any `#!/usr/bin/env node` script run that Node and not another one found earlier."""
    new_env = dict(env)
    folder = os.path.dirname(os.path.abspath(node_path))
    entries = path_entries(env)
    if not entries or os.path.normcase(entries[0]) != os.path.normcase(folder):
        new_env["PATH"] = os.pathsep.join([folder] + entries)
    return new_env


def with_path_prefix(env, folders):
    new_env = dict(env)
    new_env["PATH"] = os.pathsep.join(list(folders) + path_entries(env))
    return new_env


def find_npm(env, node_path):
    name = "npm.cmd" if os.name == "nt" else "npm"
    sibling = os.path.join(os.path.dirname(os.path.abspath(node_path)), name)
    if os.path.isfile(sibling):
        return sibling
    return shutil.which("npm", path=env.get("PATH", ""))


# --- Project state --------------------------------------------------------------------------


def missing_dependencies(project_dir, production_only=True):
    """Packages pinned by package-lock.json that node_modules lacks or holds at another version.
    Same rule as remoteifes-console/instalacao/dependencias.js; reading files avoids starting npm."""
    try:
        lock = read_json(os.path.join(project_dir, "package-lock.json"))
    except (OSError, ValueError):
        return ["package-lock.json ausente ou ilegível"]
    missing = []
    prefix = "node_modules/"
    for key, info in sorted((lock.get("packages") or {}).items()):
        if not key.startswith(prefix) or not isinstance(info, dict) or info.get("link"):
            continue
        name = key[len(prefix):]
        if "/" + prefix in name:
            continue
        if production_only and (info.get("dev") or info.get("devOptional")):
            continue
        try:
            installed_version = read_json(os.path.join(project_dir, *key.split("/"), "package.json")).get("version")
        except (OSError, ValueError, AttributeError):
            installed_version = None
        if installed_version is None and info.get("optional"):
            continue
        if installed_version != info.get("version"):
            missing.append("%s %s" % (name, info.get("version")))
    return missing


def read_env_file(path):
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return values
    for line in lines:
        # Same dialect as node --env-file: optional "export", quoted values, "#" comments after the value.
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        value = m.group(2).strip()
        closing = value.find(value[0], 1) if value[:1] in ("'", '"', "`") else -1
        values[m.group(1)] = value[1:closing] if closing > 0 else value.split("#", 1)[0].strip()
    return values


# --- Processes and network ------------------------------------------------------------------


def run(cmd, cwd=None, env=None):
    """Runs a command attached to this terminal (sudo can prompt). Ctrl+C reaches the child too;
    the child is awaited before the interruption propagates."""
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        process = subprocess.Popen(cmd, cwd=cwd, env=env)
    except OSError as exc:
        raise StartupError("não foi possível executar %s: %s" % (os.path.basename(cmd[0]), exc.strerror or exc))
    return wait(process)


def wait(process):
    interrupted = False
    while True:
        try:
            code = process.wait()
            break
        except KeyboardInterrupt:
            interrupted = True
    if interrupted:
        raise KeyboardInterrupt
    return code


def exec_or_wait(cmd, cwd, env):
    """POSIX: the launcher becomes the process (no Python left resident; signals reach Node
    directly). Windows has no real exec, so it waits and returns the exit code."""
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        if os.name == "posix":
            os.chdir(cwd)
            os.execve(cmd[0], cmd, env)
        process = subprocess.Popen(cmd, cwd=cwd, env=env)
    except OSError as exc:
        raise StartupError("não foi possível executar %s: %s" % (cmd[0], exc.strerror or exc))
    return wait(process)


def http_json(host, port, path, timeout=3):
    import http.client

    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return json.loads(response.read(64 * 1024).decode("utf-8", "replace"))
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def server_status(host, port, timeout=3):
    """("free" | "remoteifes" | "other", health). "remoteifes" means its /health answered, healthy or not."""
    try:
        socket.create_connection((host, port), timeout).close()
    except OSError:
        return "free", None
    health = http_json(host, port, "/health", timeout)
    if isinstance(health, dict) and health.get("servico") == "RemoteIFES API":
        return "remoteifes", health
    return "other", None


def lan_address():
    """Address of the default route's interface. A UDP connect sends no packet."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        address = sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()
    return None if address.startswith("127.") or address == "0.0.0.0" else address
