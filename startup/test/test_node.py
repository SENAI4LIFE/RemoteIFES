import io
import json
import os
import shutil
import stat
import tempfile
import unittest

from startup import common as c

LINUX_ARM = c.Platform("linux", "aarch64", 32)
LINUX_X64 = c.Platform("linux", "x86_64", 64)
MINIMUM = (22, 13, 0)
POSIX = os.name == "posix"


def fake_probe(table):
    def probe(path):
        version, arch, platform_name, error = table[path]
        return c.NodeCandidate(path, c.parse_version(version) if version else None, arch, platform_name, error)

    return probe


class VersionTest(unittest.TestCase):
    def test_parsing(self):
        self.assertEqual(c.parse_version("v22.13.0"), (22, 13, 0))
        self.assertEqual(c.parse_version("24.1.0-nightly20250101"), (24, 1, 0))
        self.assertIsNone(c.parse_version("22"))
        self.assertIsNone(c.parse_version(None))
        self.assertLess(c.parse_version("22.12.9"), MINIMUM)
        self.assertGreaterEqual(c.parse_version("22.13.0"), MINIMUM)

    def test_minimum_comes_from_package_json_engines(self):
        self.assertEqual(c.minimum_node_version(os.path.join(c.SERVER_DIR, "package.json")), MINIMUM)
        self.assertEqual(c.minimum_node_version(os.path.join(c.CONSOLE_DIR, "package.json")), MINIMUM)
        folder = tempfile.mkdtemp()
        try:
            package = os.path.join(folder, "package.json")
            with open(package, "w") as handle:
                json.dump({"engines": {"node": ">=24.1.2"}}, handle)
            self.assertEqual(c.minimum_node_version(package), (24, 1, 2))
            with open(package, "w") as handle:
                json.dump({"engines": {"node": "^22"}}, handle)
            self.assertEqual(c.minimum_node_version(package), c.FALLBACK_NODE_MINIMUM)
        finally:
            shutil.rmtree(folder)
        self.assertEqual(c.minimum_node_version("/nonexistent/package.json"), c.FALLBACK_NODE_MINIMUM)


class SelectionTest(unittest.TestCase):
    def test_old_node_first_on_path_is_skipped_for_a_newer_one(self):
        probe = fake_probe({
            "/usr/bin/node": ("18.19.0", "arm", "linux", None),
            "/usr/local/bin/node": ("22.20.0", "arm", "linux", None),
        })
        selection = c.select_node(MINIMUM, LINUX_ARM, {}, probe=probe, candidates=["/usr/bin/node", "/usr/local/bin/node"])
        self.assertEqual(selection.node.path, "/usr/local/bin/node")
        self.assertEqual([r.path for r in selection.rejected], ["/usr/bin/node"])
        self.assertIn("anterior ao mínimo 22.13.0", selection.rejected[0].problem(MINIMUM, LINUX_ARM))

    def test_first_suitable_node_wins_and_later_ones_are_not_probed(self):
        probed = []

        def probe(path):
            probed.append(path)
            return c.NodeCandidate(path, (22, 20, 0), "x64", "linux")

        selection = c.select_node(MINIMUM, LINUX_X64, {}, probe=probe, candidates=["/a/node", "/b/node"])
        self.assertEqual(selection.node.path, "/a/node")
        self.assertEqual(probed, ["/a/node"])

    def test_wrong_build_or_platform_is_rejected(self):
        probe = fake_probe({
            "/opt/arm64/node": (None, None, None, "não executa neste sistema (No such file or directory; binário de outra arquitetura?)"),
            "/mnt/c/node": ("22.20.0", "x64", "win32", None),
        })
        selection = c.select_node(MINIMUM, LINUX_ARM, {}, probe=probe, candidates=["/opt/arm64/node", "/mnt/c/node"])
        self.assertIsNone(selection.node)
        problems = [r.problem(MINIMUM, LINUX_ARM) for r in selection.rejected]
        self.assertIn("binário de outra arquitetura", problems[0])
        self.assertIn("win32", problems[1])

    def test_pinned_node_is_never_replaced(self):
        probe = fake_probe({
            "/pinned/node": ("20.11.0", "arm", "linux", None),
            "/usr/local/bin/node": ("22.20.0", "arm", "linux", None),
        })
        env = {"REMOTEIFES_NODE": "/pinned/node"}
        selection = c.select_node(MINIMUM, LINUX_ARM, env, probe=probe, candidates=["/usr/local/bin/node"])
        self.assertIsNone(selection.node)
        self.assertTrue(selection.override)
        self.assertIn("REMOTEIFES_NODE", c.node_missing_error(MINIMUM, selection, []).message)

        probe = fake_probe({"/pinned/node": ("22.13.0", "arm", "linux", None)})
        self.assertEqual(c.select_node(MINIMUM, LINUX_ARM, env, probe=probe).node.path, "/pinned/node")

    def test_armv7_node_is_accepted_with_its_support_horizon(self):
        out = io.StringIO()
        term = c.Terminal(out=out, err=out, env={}, system="linux")
        node = c.NodeCandidate("/usr/local/bin/node", (22, 20, 0), "arm", "linux")
        c.report_node(term, c.NodeSelection(node, []), MINIMUM, LINUX_ARM)
        self.assertIn("[OK]    Node.js 22.20.0 (arm)", out.getvalue())
        self.assertIn("2027-04-30", out.getvalue())
        self.assertNotIn("experimental", out.getvalue())

        out = io.StringIO()
        term = c.Terminal(out=out, err=out, env={}, system="linux")
        node = c.NodeCandidate("/usr/local/bin/node", (24, 0, 0), "arm", "linux")
        c.report_node(term, c.NodeSelection(node, []), MINIMUM, LINUX_ARM)
        self.assertIn("experimental", out.getvalue())

    def test_child_processes_get_the_selected_node_first_on_path(self):
        env = {"PATH": os.pathsep.join(["/usr/bin", "/bin"])}
        child = c.child_env(env, "/usr/local/lib/nodejs/node-v22.20.0/bin/node")
        self.assertEqual(c.path_entries(child)[0], os.path.abspath("/usr/local/lib/nodejs/node-v22.20.0/bin"))
        self.assertEqual(env["PATH"], os.pathsep.join(["/usr/bin", "/bin"]), "the caller's environment is untouched")
        already = {"PATH": os.pathsep.join([os.path.abspath("/opt/node/bin"), "/usr/bin"])}
        self.assertEqual(c.child_env(already, "/opt/node/bin/node")["PATH"], already["PATH"])


def write_executable(path, text):
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@unittest.skipUnless(POSIX, "fake node scripts need a POSIX shell")
class RealPathConflictTest(unittest.TestCase):
    """Real executables on a real PATH: an old Node shadowing a new one, and a binary this system
    cannot execute (what an arm64 Node looks like on a 32-bit userland)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.old = os.path.join(self.dir, "old")
        self.new = os.path.join(self.dir, "new")
        self.broken = os.path.join(self.dir, "broken")
        for folder, version in ((self.old, "18.19.0"), (self.new, "22.20.0")):
            os.mkdir(folder)
            write_executable(os.path.join(folder, "node"), "#!/bin/sh\nprintf '%s arm linux'\n" % version)
            write_executable(os.path.join(folder, "npm"), "#!/bin/sh\nexit 0\n")
        os.mkdir(self.broken)
        with open(os.path.join(self.broken, "node"), "wb") as handle:
            handle.write(b"\x7fELF\x02\x01\x01garbage-not-a-real-binary")
        os.chmod(os.path.join(self.broken, "node"), 0o755)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_path_order_conflict(self):
        env = {"PATH": os.pathsep.join([self.broken, self.old, self.new])}
        selection = c.select_node(MINIMUM, LINUX_ARM, env, candidates=c.node_candidates(LINUX_ARM, env)[:3])
        self.assertEqual(selection.node.path, os.path.join(self.new, "node"))
        self.assertEqual(selection.node.arch, "arm")
        self.assertEqual(selection.path_node, os.path.join(self.broken, "node"))
        self.assertEqual([r.path for r in selection.rejected], [os.path.join(self.broken, "node"), os.path.join(self.old, "node")])
        self.assertIn("não executa neste sistema", selection.rejected[0].error)

        child = c.child_env(env, selection.node.path)
        self.assertEqual(shutil.which("npm", path=child["PATH"]), os.path.join(self.new, "npm"))
        self.assertEqual(c.find_npm(child, selection.node.path), os.path.join(self.new, "npm"))

        out = io.StringIO()
        c.report_node(c.Terminal(out=out, err=out, env={}, system="linux"), selection, MINIMUM, LINUX_ARM)
        self.assertIn("o node do PATH não atende", out.getvalue())

    def test_candidates_are_deduplicated_by_real_path(self):
        os.symlink(os.path.join(self.new, "node"), os.path.join(self.old, "node-link"))
        os.rename(os.path.join(self.old, "node-link"), os.path.join(self.old, "node"))
        env = {"PATH": os.pathsep.join([self.old, self.new])}
        found = [p for p in c.node_candidates(LINUX_ARM, env) if p.startswith(self.dir)]
        self.assertEqual(found, [os.path.join(self.old, "node")])

    def test_probe_of_a_missing_file(self):
        self.assertEqual(c.probe_node(os.path.join(self.dir, "nothing")).error, "arquivo não existe")


if __name__ == "__main__":
    unittest.main()
