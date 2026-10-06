import io
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

import console
import server
from startup import common as c

ROOT = c.ROOT
POSIX = os.name == "posix"
MINIMUM = (22, 13, 0)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def node_at(folder, arch="x64", version=(22, 20, 0), platform_name="linux"):
    path = os.path.join(folder, "node")
    write(path, "")
    write(os.path.join(folder, "npm"), "")
    write(os.path.join(folder, "npm.cmd"), "")
    return c.NodeCandidate(path, version, arch, platform_name)


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.node_dir = os.path.join(self.tmp, "nodebin")
        self.node = node_at(self.node_dir)
        self.commands = []
        self.run_results = []
        self.run_effects = []
        self.out = io.StringIO()
        self.err = io.StringIO()
        self.term = c.Terminal(out=self.out, err=self.err, env={}, system="linux")
        self.patches = [
            mock.patch.object(c, "run", side_effect=self.fake_run),
            mock.patch.object(c, "is_root", return_value=False),
            mock.patch.object(c, "lan_address", return_value="192.168.0.10"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_run(self, cmd, cwd=None, env=None):
        self.commands.append({"cmd": list(cmd), "cwd": cwd, "env": env})
        if self.run_effects:
            effect = self.run_effects.pop(0)
            if effect:
                effect()
        return self.run_results.pop(0) if self.run_results else 0

    def patch(self, target, attribute, **kwargs):
        patch = mock.patch.object(target, attribute, **kwargs)
        self.patches.append(patch)
        return patch.start()

    def output(self):
        return self.out.getvalue() + self.err.getvalue()

    def assert_never_forced(self):
        for entry in self.commands:
            self.assertFalse({"--force", "--forcar"} & set(entry["cmd"]), entry["cmd"])


class ServerFlowTest(Harness):
    def setUp(self):
        Harness.setUp(self)
        self.server_dir = os.path.join(self.tmp, "remoteifes-server")
        os.makedirs(self.server_dir)
        shutil.copy(os.path.join(c.SERVER_DIR, "package.json"), self.server_dir)
        shutil.copy(os.path.join(c.SERVER_DIR, ".env.example"), self.server_dir)
        write(
            os.path.join(self.server_dir, "package-lock.json"),
            json.dumps({"packages": {"": {}, "node_modules/express": {"version": "4.21.2"}}}),
        )
        for name, value in (
            ("SERVER_DIR", self.server_dir),
            ("SETUP", os.path.join(self.server_dir, "setup.sh")),
            ("ENV_FILE", os.path.join(self.server_dir, ".env")),
            ("ENV_EXAMPLE", os.path.join(self.server_dir, ".env.example")),
            ("PACKAGE_JSON", os.path.join(self.server_dir, "package.json")),
        ):
            self.patch(server, name, new=value)
        self.platform = c.Platform("linux", "aarch64", 32, model="Raspberry Pi 3 Model B Rev 1.2", libc=(2, 36))
        self.patch(c, "detect_platform", side_effect=lambda: self.platform)
        self.selections = []
        self.patch(c, "select_node", side_effect=self.fake_select)
        self.status = ("free", None)
        self.patch(c, "server_status", side_effect=lambda host, port: self.status)
        self.service = None
        self.patch(server, "owning_service_state", side_effect=lambda plat: self.service)
        self.execs = []
        self.patch(c, "exec_or_wait", side_effect=lambda cmd, cwd, env: self.execs.append((cmd, cwd, env)) or 0)
        # The simulated Linux flows run setup.sh through bash; never depend on the host having one.
        real_which = shutil.which
        self.patch(shutil, "which", side_effect=lambda name, mode=os.F_OK | os.X_OK, path=None: "/bin/bash" if name == "bash" else real_which(name, mode, path))
        self.env = {"PATH": os.pathsep.join(["/usr/bin", "/bin"])}

    def fake_select(self, minimum, plat, env):
        if self.selections:
            return self.selections.pop(0)
        return c.NodeSelection(self.node, [])

    def install_deps(self):
        write(os.path.join(self.server_dir, "node_modules", "express", "package.json"), '{"version": "4.21.2"}')

    def create_env(self, text="NODE_ENV=development\nPORTA=8080\n"):
        write(os.path.join(self.server_dir, ".env"), text)

    def main(self, *args):
        return c.guard(self.term, lambda: server.run(list(args), self.term, self.env))

    def test_ready_checkout_starts_without_reinstalling(self):
        self.install_deps()
        self.create_env()
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.commands, [], "nothing is installed when everything is in place")
        cmd, cwd, env = self.execs[0]
        self.assertEqual(cmd, [self.node.path, "--env-file-if-exists=.env", "server.js"])
        self.assertEqual(cwd, self.server_dir)
        self.assertEqual(c.path_entries(env)[0], self.node_dir)
        text = self.output()
        self.assertIn("armv7l (kernel aarch64 de 64 bits, userland de 32 bits)", text)
        self.assertIn("http://localhost:8080", text)
        self.assertIn("http://192.168.0.10:8080", text)
        self.assertIn("modo de desenvolvimento", text)
        self.assertIn("superadmin / admin", text)

    def test_repeated_run_finds_the_running_server_and_starts_nothing(self):
        self.install_deps()
        self.create_env()
        self.status = ("remoteifes", {"servico": "RemoteIFES API", "ambiente": "development"})
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.execs, [])
        self.assertEqual(self.commands, [])
        self.assertIn("já está rodando na porta 8080", self.output())

    def test_port_held_by_another_program(self):
        self.install_deps()
        self.create_env("PORTA=9090\n")
        self.status = ("other", None)
        self.assertEqual(self.main(), 1)
        self.assertEqual(self.execs, [])
        self.assertIn("a porta 9090 já está em uso", self.err.getvalue())
        self.assertIn("ss -ltnp 'sport = :9090'", self.err.getvalue())

    def test_checkout_owned_by_the_systemd_service_is_not_started_by_hand(self):
        self.install_deps()
        self.create_env("NODE_ENV=production\n")
        self.service = "inactive"
        self.assertEqual(self.main(), 1)
        self.assertEqual(self.execs, [])
        self.assertIn("sudo systemctl start remoteifes.service", self.err.getvalue())
        self.service = "active"
        self.status = ("remoteifes", {"servico": "RemoteIFES API", "ambiente": "production"})
        self.assertEqual(self.main(), 0)
        self.assertIn("pelo remoteifes.service", self.output())

    def test_first_run_delegates_to_setup_sh_once(self):
        def setup_effect():
            self.install_deps()
            self.create_env()

        self.run_effects = [setup_effect]
        self.assertEqual(self.main(), 0)
        self.assertEqual(len(self.commands), 1)
        call = self.commands[0]
        self.assertEqual(call["cmd"], ["bash", os.path.join(self.server_dir, "setup.sh")])
        self.assertEqual(c.path_entries(call["env"])[0], self.node_dir, "setup.sh and npm see the selected Node first")
        self.assertEqual(len(self.execs), 1)
        self.commands, self.execs = [], []
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.commands, [], "second run reinstalls nothing")
        self.assert_never_forced()

    def test_missing_node_on_armv7_is_installed_by_setup_sh(self):
        self.patch(shutil, "which", side_effect=lambda name, path=None: "/usr/bin/" + name)
        self.selections = [c.NodeSelection(None, [c.NodeCandidate("/usr/bin/node", (18, 19, 0), "arm", "linux")]), c.NodeSelection(self.node, [])]

        def setup_effect():
            self.install_deps()
            self.create_env()

        self.run_effects = [setup_effect]
        self.assertEqual(self.main(), 0)
        call = self.commands[0]
        self.assertEqual(call["cmd"][0], "bash")
        self.assertEqual(c.path_entries(call["env"])[0], "/usr/local/bin")
        self.assertIn("pode pedir a senha do sudo", self.output())
        self.assertIn("ignorado: %s (18.19.0 é anterior ao mínimo 22.13.0)" % os.path.abspath("/usr/bin/node"), self.output())
        self.assertEqual(len(self.execs), 1)

    def test_armv6_without_node_fails_before_touching_anything(self):
        self.platform = c.Platform("linux", "armv6l", 32, model="Raspberry Pi Zero W Rev 1.1", libc=(2, 36))
        self.selections = [c.NodeSelection(None, [])]
        self.assertEqual(self.main(), 1)
        self.assertEqual(self.commands, [])
        self.assertIn("ARMv6", self.err.getvalue())
        self.assertIn("REMOTEIFES_NODE", self.err.getvalue())

    def test_old_glibc_is_reported_before_setup(self):
        self.selections = [c.NodeSelection(None, [])]
        self.platform = c.Platform("linux", "armv7l", 32, libc=(2, 24))
        self.assertEqual(self.main(), 1)
        self.assertIn("glibc 2.24", self.err.getvalue())

    @unittest.skipUnless(POSIX, "PATH lookup of extensionless tools is POSIX behavior")
    def test_missing_download_tools_are_reported_before_setup(self):
        tools = os.path.join(self.tmp, "tools")
        os.makedirs(tools)
        for name in ("bash", "tar", "sha256sum", "sudo"):
            write(os.path.join(tools, name), "")
            os.chmod(os.path.join(tools, name), 0o755)
        self.env = {"PATH": tools}
        self.selections = [c.NodeSelection(None, [])]
        self.platform = c.Platform("linux", "armv7l", 32, libc=(2, 36))
        self.assertEqual(self.main(), 1)
        self.assertIn("curl, xz", self.err.getvalue())
        self.assertEqual(self.commands, [])

    def test_missing_bash_stops_before_setup(self):
        with mock.patch.object(shutil, "which", return_value=None):
            self.assertEqual(self.main(), 1)
        self.assertEqual(self.commands, [])
        self.assertIn("bash não encontrado", self.err.getvalue())

    def test_setup_failure_is_concise_and_stops(self):
        self.run_results = [3]
        self.assertEqual(self.main(), 1)
        self.assertEqual(self.execs, [])
        self.assertIn("setup.sh terminou com código 3", self.err.getvalue())

    def test_check_mode_never_installs_or_starts(self):
        self.assertEqual(self.main("--verificar"), 1)
        self.assertIn("não está pronto", self.err.getvalue())
        self.install_deps()
        self.create_env()
        self.assertEqual(self.main("--verificar"), 0)
        self.assertEqual(self.main("--preparar"), 0)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.execs, [])

    def test_windows_without_node_points_to_the_installer(self):
        self.platform = c.Platform("windows", "AMD64", 64)
        self.selections = [c.NodeSelection(None, [])]
        self.assertEqual(self.main(), 1)
        self.assertIn("winget install OpenJS.NodeJS.LTS", self.err.getvalue())
        self.assertEqual(self.commands, [])

    def test_windows_prepares_with_npm_install_and_env_copy(self):
        self.platform = c.Platform("windows", "AMD64", 64)
        self.node = node_at(self.node_dir, platform_name="win32")
        self.run_effects = [self.install_deps]
        self.assertEqual(self.main(), 0)
        call = self.commands[0]
        self.assertEqual(os.path.basename(call["cmd"][0]), "npm.cmd" if os.name == "nt" else "npm")
        self.assertEqual(call["cmd"][1:], ["install"])
        self.assertTrue(os.path.isfile(os.path.join(self.server_dir, ".env")))
        self.assertIn("netstat", server.port_hint(self.platform, 8080))

    def test_env_values_and_process_overrides(self):
        self.install_deps()
        self.create_env("PORTA=8081\nBIND_ADDR=127.0.0.1\nNODE_ENV=production\nSENHA_ADMIN_INICIAL=uma-senha-forte\n")
        self.env["PORTA"] = "18080"
        self.assertEqual(self.main(), 0)
        text = self.output()
        self.assertIn("PORTA=18080", text)
        self.assertIn("pelo proxy reverso (BIND_ADDR=127.0.0.1)", text)
        self.assertNotIn("superadmin / admin", text)
        self.assertNotIn("modo de desenvolvimento", text)

    def test_invalid_port_and_pinned_node(self):
        self.install_deps()
        self.create_env("PORTA=abc\n")
        self.assertEqual(self.main(), 1)
        self.assertIn("PORTA inválida", self.err.getvalue())
        self.selections = [c.NodeSelection(None, [c.NodeCandidate("/x/node", (20, 0, 0), "x64", "linux")], override=True)]
        self.assertEqual(self.main(), 1)
        self.assertIn("REMOTEIFES_NODE", self.err.getvalue())

    def test_root_is_warned(self):
        self.install_deps()
        self.create_env()
        with mock.patch.object(c, "is_root", return_value=True):
            self.assertEqual(self.main(), 0)
        self.assertIn("rodando como root", self.output())

    def test_interruption_and_unknown_options(self):
        def interrupt():
            raise KeyboardInterrupt

        self.run_effects = [interrupt]
        self.assertEqual(self.main(), 130)
        self.assertEqual(self.main("--forcar"), 2)
        self.assertEqual(self.main("--ajuda"), 0)


@unittest.skipUnless(POSIX, "fake systemctl script")
class SystemdServiceTest(unittest.TestCase):
    """owning_service_state against a fake systemctl: only a unit running this checkout counts."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.plat = c.Platform("linux", "aarch64", 64)
        real_isdir = os.path.isdir
        self.patches = [
            mock.patch.object(os.path, "isdir", side_effect=lambda p: p == "/run/systemd/system" or real_isdir(p)),
            mock.patch.dict(os.environ, {"PATH": self.tmp + os.pathsep + os.environ.get("PATH", "")}),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_systemctl(self, load, active, directory):
        path = os.path.join(self.tmp, "systemctl")
        with open(path, "w") as handle:
            handle.write('#!/bin/sh\nprintf "LoadState=%s\\nActiveState=%s\\nWorkingDirectory=%s\\n"\n' % (load, active, directory))
        os.chmod(path, 0o755)

    def test_states(self):
        self.fake_systemctl("loaded", "inactive", c.SERVER_DIR)
        self.assertEqual(server.owning_service_state(self.plat), "inactive")
        self.fake_systemctl("loaded", "active", c.SERVER_DIR + "/")
        self.assertEqual(server.owning_service_state(self.plat), "active")
        self.fake_systemctl("loaded", "active", "/opt/outro-checkout/remoteifes-server")
        self.assertIsNone(server.owning_service_state(self.plat))
        self.fake_systemctl("not-found", "inactive", "")
        self.assertIsNone(server.owning_service_state(self.plat))
        self.assertIsNone(server.owning_service_state(c.Platform("darwin", "arm64", 64)))


class ExecFailureTest(unittest.TestCase):
    def test_missing_executable_is_a_startup_error(self):
        with mock.patch.object(os, "execve", side_effect=FileNotFoundError(2, "No such file or directory")), mock.patch.object(os, "chdir"):
            with self.assertRaises(c.StartupError) as ctx:
                c.exec_or_wait([os.path.join(tempfile.gettempdir(), "sem-node"), "server.js"], tempfile.gettempdir(), {})
        self.assertIn("não foi possível executar", ctx.exception.message)


class ConsoleFlowTest(Harness):
    def setUp(self):
        Harness.setUp(self)
        self.platform = c.Platform("linux", "aarch64", 64, model="Raspberry Pi 5 Model B Rev 1.0")
        self.patch(c, "detect_platform", side_effect=lambda: self.platform)
        self.patch(c, "select_node", side_effect=lambda minimum, plat, env: c.NodeSelection(self.node, []))
        self.root = os.path.join(self.tmp, "programa")
        self.state = os.path.join(self.tmp, "estado")
        self.patch(console, "installation_roots", side_effect=lambda node, env: [os.path.join(self.tmp, "sistema"), self.root])
        self.console_dir = os.path.join(self.tmp, "remoteifes-console")
        write(os.path.join(self.console_dir, "package.json"), '{"version": "1.0.0"}')
        write(
            os.path.join(self.console_dir, "package-lock.json"),
            json.dumps({"packages": {"node_modules/@sigstore/verify": {"version": "3.1.1"}, "node_modules/@sigstore/mock": {"version": "0.12.1", "dev": True}}}),
        )
        self.patch(console, "CONSOLE_DIR", new=self.console_dir)
        self.patch(console, "PACKAGE_JSON", new=os.path.join(self.console_dir, "package.json"))
        self.patch(console, "INSTALLER", new=os.path.join(self.console_dir, "instalacao", "instalar.js"))
        self.env = {"PATH": "/usr/bin"}

    def install(self, scope="usuario", port=8123, token=True, version="1.0.0"):
        write(os.path.join(self.root, "launcher-bootstrap.js"), "")
        record = {"versaoAtiva": version, "escopo": scope, "estado": self.state, "porta": port}
        write(os.path.join(self.root, "estado-instalacao.json"), json.dumps(record))
        if token:
            write(os.path.join(self.state, "bootstrap-token"), "segredo\n")

    def install_deps(self):
        write(os.path.join(self.console_dir, "node_modules", "@sigstore", "verify", "package.json"), '{"version": "3.1.1"}')

    def main(self, *args):
        return c.guard(self.term, lambda: console.run(list(args), self.term, self.env))

    def test_installed_console_is_opened_without_reinstalling(self):
        self.install()
        self.env["DISPLAY"] = ":0"
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.commands[0]["cmd"], [self.node.path, os.path.join(self.root, "launcher-bootstrap.js")])
        self.assertEqual(len(self.commands), 1)
        text = self.output()
        self.assertIn("http://127.0.0.1:8123/", text)
        self.assertIn("ssh -L 8123:127.0.0.1:8123", text)
        self.assertIn("./console.sh --criar-operador", text)

    def test_environment_port_wins_over_the_recorded_one(self):
        self.install(port=8123)
        self.env["CONSOLE_PORTA"] = "18799"
        self.assertEqual(self.main(), 0)
        self.assertIn("http://127.0.0.1:18799/", self.output())
        self.assertNotIn("8123", self.output())

    def test_headless_host_starts_without_a_browser(self):
        self.install(token=False)
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.commands[0]["cmd"][-1], "--iniciar")
        self.assertNotIn("--criar-operador", self.output())

    def test_root_uses_iniciar_and_sudo_hint_for_system_scope(self):
        self.install(scope="sistema")
        self.env["DISPLAY"] = ":0"
        with mock.patch.object(c, "is_root", return_value=True):
            self.assertEqual(self.main(), 0)
        self.assertEqual(self.commands[0]["cmd"][-1], "--iniciar")
        self.assertIn("sudo ./console.sh --criar-operador", self.output())

    def test_first_run_installs_with_the_portable_installer_once(self):
        self.run_effects = [self.install_deps, lambda: self.install(token=True)]
        self.assertEqual(self.main(), 0)
        cmds = [entry["cmd"] for entry in self.commands]
        self.assertEqual(cmds[0][1:], ["ci", "--omit=dev"])
        self.assertEqual(cmds[1], [self.node.path, os.path.join(self.console_dir, "instalacao", "instalar.js")])
        self.assertEqual(cmds[2][:2], [self.node.path, os.path.join(self.root, "launcher-bootstrap.js")])
        if os.path.isdir("/run/systemd/system"):
            self.assertIn("instalação por usuário", self.output())
        self.assert_never_forced()

        self.commands = []
        self.assertEqual(self.main(), 0)
        self.assertEqual(len(self.commands), 1, "an existing installation is never reinstalled")

    def test_newer_installed_version_is_kept(self):
        self.install(version="1.4.0")
        self.assertEqual(self.main("--status"), 0)
        self.assertEqual(self.commands[0]["cmd"][-1], "--status")
        self.assertIn("se atualiza pelos releases", self.output())
        self.assertNotIn("Console de Operações:\n", self.output())

    def test_npm_runs_as_the_invoking_user_under_sudo(self):
        self.env["SUDO_USER"] = "pi"
        self.run_effects = [self.install_deps, lambda: self.install(scope="sistema")]
        with mock.patch.object(c, "is_root", return_value=True), mock.patch.object(shutil, "which", return_value="/usr/bin/sudo"):
            self.assertEqual(self.main(), 0)
        npm = self.commands[0]["cmd"]
        self.assertEqual(npm[:5], ["sudo", "-H", "-u", "pi", "--"])
        self.assertEqual(npm[-2:], ["ci", "--omit=dev"])
        self.assertEqual(self.commands[1]["cmd"][0], self.node.path, "the installer itself runs as root")

    def test_check_mode_and_failures(self):
        self.assertEqual(self.main("--verificar"), 1)
        self.assertEqual(self.commands, [])
        self.assertIn("console não instalado", self.err.getvalue())

        self.install_deps()
        self.run_results = [4]
        self.assertEqual(self.main(), 1)
        self.assertIn("o instalador terminou com código 4", self.err.getvalue())

        self.install()
        self.assertEqual(self.main("--verificar"), 0)
        self.run_results = [1]
        self.commands = []
        self.assertEqual(self.main(), 1)
        self.assertIn("o lançador do console terminou com código 1", self.err.getvalue())
        self.assertIn("Recuperação de emergência", self.err.getvalue())

    def test_missing_node_and_bad_options(self):
        self.patch(c, "select_node", side_effect=lambda minimum, plat, env: c.NodeSelection(None, []))
        self.assertEqual(self.main(), 1)
        self.assertIn("./server.sh instala o Node.js", self.err.getvalue())
        self.assertEqual(self.main("--forcar"), 2)
        self.assertEqual(self.main("--verificar", "--status"), 2)
        self.assertEqual(self.main("--ajuda"), 0)


class ConsoleRootsQueryTest(unittest.TestCase):
    """The real query against the Console's own platform adapter, with XDG paths redirected."""

    def test_roots_come_from_the_console_adapter(self):
        plat = c.detect_platform()
        selection = c.select_node(MINIMUM, plat, os.environ)
        if selection.node is None:
            self.skipTest("no Node.js %s+ on this host" % c.format_version(MINIMUM))
        tmp = tempfile.mkdtemp()
        try:
            env = c.child_env(dict(os.environ, XDG_DATA_HOME=tmp, CONSOLE_RAIZ_INSTALACAO=os.path.join(tmp, "custom")), selection.node.path)
            roots = console.installation_roots(selection.node, env)
            self.assertEqual(roots[0], os.path.join(tmp, "custom"))
            self.assertEqual(len(roots), 3)
            if plat.system == "linux":
                self.assertEqual(roots[1:], ["/opt/remoteifes-console", os.path.join(tmp, "remoteifes-console")])
            if not any(os.path.isfile(os.path.join(root, "launcher-bootstrap.js")) for root in roots[1:]):
                self.assertIsNone(console.find_installation(selection.node, env))
            write(os.path.join(tmp, "remoteifes-console", "launcher-bootstrap.js"), "")
            if plat.system == "linux" and not os.path.isfile("/opt/remoteifes-console/launcher-bootstrap.js"):
                found = console.find_installation(selection.node, env)
                self.assertEqual((found.root, found.port), (os.path.join(tmp, "remoteifes-console"), 8099))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(POSIX, "POSIX wrappers")
class ShellWrapperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.mkdir(self.bin)
        for tool in ("dirname",):
            os.symlink(shutil.which(tool), os.path.join(self.bin, tool))
        self.record = os.path.join(self.tmp, "args")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_python(self, name, version_ok=True):
        path = os.path.join(self.bin, name)
        with open(path, "w") as handle:
            handle.write(
                '#!/bin/sh\nif [ "$1" = "-c" ]; then exit %d; fi\nprintf "%%s\\n" "%s" "$@" > "%s"\n'
                % (0 if version_ok else 1, name, self.record)
            )
        os.chmod(path, 0o755)

    def shells(self):
        found = [s for s in ("sh", "dash", "bash", "busybox") if shutil.which(s)]
        return [[shutil.which(s), "sh"] if s == "busybox" else [shutil.which(s)] for s in found]

    def run_wrapper(self, shell, name, *args, cwd=None):
        return subprocess.run(
            shell + [os.path.join(ROOT, name)] + list(args),
            env={"PATH": self.bin},
            cwd=cwd or self.tmp,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def test_wrappers_pass_arguments_to_their_python_entrypoint(self):
        self.fake_python("python3")
        for shell in self.shells():
            for name in ("server", "console"):
                r = self.run_wrapper(shell, name + ".sh", "--verificar", "com espaço")
                self.assertEqual(r.returncode, 0, (shell, r.stderr))
                with open(self.record) as handle:
                    self.assertEqual(handle.read().splitlines(), ["python3", os.path.join(ROOT, name + ".py"), "--verificar", "com espaço"], shell)

    def test_old_python3_falls_back_to_python(self):
        self.fake_python("python3", version_ok=False)
        self.fake_python("python")
        r = self.run_wrapper([shutil.which("sh")], "server.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.record) as handle:
            self.assertEqual(handle.readline().strip(), "python")

    def test_missing_python_fails_with_a_concise_hint(self):
        r = self.run_wrapper([shutil.which("sh")], "console.sh")
        self.assertEqual(r.returncode, 1)
        self.assertIn("[ERROR] Python 3.7 ou mais novo não encontrado", r.stderr)
        self.assertIn("sudo apt install python3", r.stderr)

    def test_wrappers_are_executable_and_lf(self):
        for name in ("server.sh", "console.sh"):
            path = os.path.join(ROOT, name)
            self.assertTrue(os.stat(path).st_mode & stat.S_IXUSR, name)
            with open(path, "rb") as handle:
                content = handle.read()
            self.assertTrue(content.startswith(b"#!/bin/sh\n"))
            self.assertNotIn(b"\r", content)

    def test_real_wrapper_runs_from_any_directory(self):
        r = subprocess.run(
            [os.path.join(ROOT, "server.sh"), "--ajuda"],
            cwd=tempfile.gettempdir(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("uso: ./server.sh", r.stdout)

    def test_output_piped_to_a_reader_that_quits(self):
        r = subprocess.run(
            "%s --verificar | head -n 1 >/dev/null" % os.path.join(ROOT, "server.sh"),
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
        self.assertNotIn("Traceback", r.stderr)
        self.assertNotIn("BrokenPipeError", r.stderr)


class BatchWrapperTest(unittest.TestCase):
    def test_batch_files_are_crlf_ascii_and_propagate_the_exit_code(self):
        with open(os.path.join(ROOT, ".gitattributes")) as handle:
            self.assertIn("*.bat text eol=crlf", handle.read())
        for name in ("server", "console"):
            with open(os.path.join(ROOT, name + ".bat"), "rb") as handle:
                content = handle.read()
            content.decode("ascii")
            lines = content.split(b"\r\n")
            self.assertEqual(lines[-1], b"", "ends with CRLF")
            self.assertFalse(any(b"\n" in line for line in lines), "every line ends with CRLF")
            text = content.decode("ascii")
            self.assertIn('set "SCRIPT=%%~dp0%s.py"' % name, text)
            self.assertLess(text.index("py -3 -c"), text.index("python -c"), "py launcher first")
            self.assertIn('py -3 "%SCRIPT%" %*', text)
            self.assertIn('python "%SCRIPT%" %*', text)
            self.assertIn("sys.version_info < (3, 7)", text)
            self.assertTrue(text.rstrip().endswith("exit /b %ERRORLEVEL%"))


if __name__ == "__main__":
    unittest.main()
