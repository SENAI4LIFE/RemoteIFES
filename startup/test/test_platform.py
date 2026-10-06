import io
import json
import os
import tempfile
import unittest
from unittest import mock

from startup import common as c


class FakeTTY(io.StringIO):
    def isatty(self):
        return True


class ArchitectureTest(unittest.TestCase):
    def test_userland_decides_the_architecture(self):
        cases = [
            ("x86_64", 64, "x64"),
            ("AMD64", 64, "x64"),
            ("x86_64", 32, "x86"),
            ("i686", 32, "x86"),
            ("aarch64", 64, "arm64"),
            ("arm64", 64, "arm64"),
            ("aarch64", 32, "armv7l"),
            ("armv8l", 32, "armv7l"),
            ("armv7l", 32, "armv7l"),
            ("armv6l", 32, "armv6l"),
            ("riscv64", 64, "riscv64"),
            ("", 64, "desconhecida"),
        ]
        for machine, bits, expected in cases:
            self.assertEqual(c.normalize_arch(machine, bits), expected, (machine, bits))

    def test_pi3_with_64_bit_kernel_and_32_bit_raspberry_pi_os(self):
        with tempfile.NamedTemporaryFile("wb", delete=False) as model:
            model.write(b"Raspberry Pi 3 Model B Rev 1.2\x00")
        with tempfile.NamedTemporaryFile("w", delete=False) as release:
            release.write('NAME="Raspbian GNU/Linux"\nPRETTY_NAME="Raspbian GNU/Linux 11 (bullseye)"\n')
        try:
            plat = c.detect_platform(system="Linux", machine="aarch64", userland_bits=32, model_path=model.name, os_release_path=release.name)
        finally:
            os.unlink(model.name)
            os.unlink(release.name)
        self.assertEqual(plat.system, "linux")
        self.assertEqual(plat.arch, "armv7l")
        self.assertEqual(plat.node_dist_arch, "armv7l")
        self.assertEqual(plat.model, "Raspberry Pi 3 Model B Rev 1.2")
        out = io.StringIO()
        c.report_platform(c.Terminal(out=out, err=out, env={}, system="linux"), plat)
        self.assertIn("armv7l (kernel aarch64 de 64 bits, userland de 32 bits)", out.getvalue())
        self.assertIn("Raspberry Pi 3 Model B Rev 1.2", out.getvalue())
        self.assertIn("Linux - Raspbian GNU/Linux 11 (bullseye)", out.getvalue())

    def test_matching_kernel_and_userland_print_no_detail(self):
        out = io.StringIO()
        c.report_platform(c.Terminal(out=out, err=out, env={}, system="linux"), c.Platform("linux", "x86_64", 64))
        self.assertIn("Arquitetura       x64\n", out.getvalue())
        out = io.StringIO()
        c.report_platform(c.Terminal(out=out, err=out, env={}, system="linux"), c.Platform("linux", "armv7l", 32))
        self.assertIn("Arquitetura       armv7l\n", out.getvalue())

    def test_installable_node_builds_on_linux(self):
        self.assertEqual(c.detect_platform("Linux", "x86_64", 64, model_path="/nonexistent").node_dist_arch, "x64")
        self.assertEqual(c.detect_platform("Linux", "aarch64", 64, model_path="/nonexistent").node_dist_arch, "arm64")
        self.assertIsNone(c.detect_platform("Linux", "armv6l", 32, model_path="/nonexistent").node_dist_arch)
        self.assertIsNone(c.detect_platform("Linux", "i686", 32, model_path="/nonexistent").node_dist_arch)
        self.assertIsNone(c.detect_platform("Darwin", "arm64", 64).node_dist_arch)

    def test_windows_and_macos_report_the_os_architecture(self):
        windows = c.detect_platform(system="Windows", machine="AMD64", userland_bits=32)
        self.assertEqual((windows.system, windows.arch, windows.node_platform), ("windows", "x64", "win32"))
        self.assertEqual(c.detect_platform(system="Windows", machine="ARM64", userland_bits=64).arch, "arm64")
        mac = c.detect_platform(system="Darwin", machine="arm64")
        self.assertEqual((mac.label, mac.arch, mac.node_platform), ("macOS", "arm64", "darwin"))
        self.assertEqual(c.detect_system("MINGW64_NT-10.0"), "windows")

    def test_unsupported_system_is_refused(self):
        plat = c.detect_platform(system="FreeBSD", machine="amd64", userland_bits=64)
        self.assertFalse(plat.supported)
        out = io.StringIO()
        with self.assertRaises(c.StartupError) as ctx:
            c.report_platform(c.Terminal(out=out, err=out, env={}, system="linux"), plat)
        self.assertIn("não suportado", ctx.exception.message)


class TerminalTest(unittest.TestCase):
    def render(self, stream_cls, env, system="linux"):
        out, err = stream_cls(), stream_cls()
        term = c.Terminal(out=out, err=err, env=env, system=system)
        term.header("RemoteIFES - servidor")
        term.step("Node.js")
        term.ok("pronto")
        term.warn("atenção")
        term.error("falhou")
        return out.getvalue(), err.getvalue()

    def test_plain_text_when_not_a_terminal(self):
        out, err = self.render(io.StringIO, {})
        self.assertNotIn("\033[", out + err)
        self.assertIn("[OK]    pronto", out)
        self.assertIn("[WARN]  atenção", out)
        self.assertIn("==> Node.js", out)
        self.assertEqual(err, "[ERROR] falhou\n")

    def test_colors_only_on_a_capable_terminal(self):
        out, err = self.render(FakeTTY, {"TERM": "xterm-256color"})
        self.assertIn("\033[32m[OK]", out)
        self.assertIn("\033[31m[ERROR]", err)
        for env in ({"NO_COLOR": "1"}, {"TERM": "dumb"}):
            out, err = self.render(FakeTTY, env)
            self.assertNotIn("\033[", out + err, env)

    def test_windows_colors_depend_on_virtual_terminal_support(self):
        with mock.patch.object(c, "_enable_windows_vt", return_value=False):
            out, _ = self.render(FakeTTY, {}, system="windows")
            self.assertNotIn("\033[", out)
        with mock.patch.object(c, "_enable_windows_vt", return_value=True):
            out, _ = self.render(FakeTTY, {}, system="windows")
            self.assertIn("\033[32m[OK]", out)

    def test_unencodable_text_never_breaks_a_redirected_stream(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="ascii")
        term = c.Terminal(out=stream, err=stream, env={}, system="windows")
        term.ok("instalação concluída")
        stream.flush()
        self.assertIn(b"[OK]    instala??o conclu?da", raw.getvalue())

    def test_guard_maps_failures_to_exit_codes(self):
        out = io.StringIO()
        term = c.Terminal(out=out, err=out, env={}, system="linux")

        def fails():
            raise c.StartupError("algo faltou", ["faça isto"])

        def interrupted():
            raise KeyboardInterrupt

        def misused():
            raise c.UsageError("opção desconhecida")

        def unwritable():
            raise PermissionError(13, "Permission denied", "/x/.env")

        self.assertEqual(c.guard(term, fails), 1)
        self.assertEqual(c.guard(term, interrupted), 130)
        self.assertEqual(c.guard(term, misused), 2)
        self.assertEqual(c.guard(term, unwritable), 1)
        self.assertIn("[ERROR] Permission denied: /x/.env", out.getvalue())
        self.assertEqual(c.guard(term, lambda: 0), 0)
        self.assertIn("[ERROR] algo faltou\n        faça isto\n", out.getvalue())


class ProjectStateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, relative, text):
        path = os.path.join(self.dir, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def test_dependencies_follow_the_lockfile(self):
        import json

        lock = {
            "packages": {
                "": {"name": "x"},
                "node_modules/express": {"version": "4.21.2"},
                "node_modules/ws": {"version": "8.21.3"},
                "node_modules/mock": {"version": "1.0.0", "dev": True},
                "node_modules/fsevents": {"version": "2.3.3", "optional": True},
                "node_modules/express/node_modules/debug": {"version": "2.6.9"},
            }
        }
        self.write("package-lock.json", json.dumps(lock))
        self.assertEqual(c.missing_dependencies(self.dir), ["express 4.21.2", "ws 8.21.3"])
        self.write("node_modules/express/package.json", '{"version": "4.21.2"}')
        self.write("node_modules/ws/package.json", '{"version": "8.0.0"}')
        self.assertEqual(c.missing_dependencies(self.dir), ["ws 8.21.3"])
        self.write("node_modules/ws/package.json", '{"version": "8.21.3"}')
        self.assertEqual(c.missing_dependencies(self.dir), [])
        self.assertEqual(c.missing_dependencies(self.dir, production_only=False), ["mock 1.0.0"])

    def test_missing_lockfile_is_reported(self):
        self.assertEqual(c.missing_dependencies(self.dir), ["package-lock.json ausente ou ilegível"])

    ENV_SAMPLE = (
        "# comentário\r\nNODE_ENV=production\r\nexport PORTA = 9090 # alterado\nCORS_ORIGIN=\"https://a.example\" # origem\n"
        "X='y#z'\nBIND_ADDR=127.0.0.1#local\nVAZIA=\ninvalido\n"
    )

    def test_env_file_parsing(self):
        self.write(".env", self.ENV_SAMPLE)
        self.assertEqual(
            c.read_env_file(os.path.join(self.dir, ".env")),
            {"NODE_ENV": "production", "PORTA": "9090", "CORS_ORIGIN": "https://a.example", "X": "y#z", "BIND_ADDR": "127.0.0.1", "VAZIA": ""},
        )
        self.assertEqual(c.read_env_file(os.path.join(self.dir, "ausente")), {})

    def test_env_file_parsing_agrees_with_node(self):
        import subprocess

        selection = c.select_node((22, 13, 0), c.detect_platform(), os.environ)
        if selection.node is None:
            self.skipTest("no Node.js 22.13+ on this host")
        self.write(".env", self.ENV_SAMPLE)
        keys = ["NODE_ENV", "PORTA", "CORS_ORIGIN", "X", "BIND_ADDR", "VAZIA"]
        env = {k: v for k, v in os.environ.items() if k not in keys}
        r = subprocess.run(
            [selection.node.path, "--env-file=.env", "-p", "JSON.stringify(%s.map(k => process.env[k] ?? null))" % json.dumps(keys)],
            cwd=self.dir, env=env, stdout=subprocess.PIPE, universal_newlines=True,
        )
        parsed = c.read_env_file(os.path.join(self.dir, ".env"))
        self.assertEqual(json.loads(r.stdout), [parsed.get(k) for k in keys])

    def test_quoted_windows_path_entries(self):
        with mock.patch.object(c.os, "name", "nt"):
            self.assertEqual(c.path_entries({"PATH": os.pathsep.join(['"/a b"', "", "/c"])}), ["/a b", "/c"])


if __name__ == "__main__":
    unittest.main()
