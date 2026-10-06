import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import server
from startup import common as c

MINIMUM = (22, 13, 0)


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class RealStartTest(unittest.TestCase):
    """The wrapper starts the real server with a throwaway database; a second run finds it and starts
    nothing. Skipped until ./server.sh --preparar has installed the dependencies."""

    def setUp(self):
        plat = c.detect_platform()
        if c.select_node(MINIMUM, plat, os.environ).node is None:
            self.skipTest("no Node.js %s+ on this host" % c.format_version(MINIMUM))
        if c.missing_dependencies(c.SERVER_DIR) or not os.path.isfile(os.path.join(c.SERVER_DIR, ".env")):
            self.skipTest("server not prepared (./server.sh --preparar)")
        if server.owning_service_state(plat):
            self.skipTest("this checkout is run by remoteifes.service")
        self.tmp = tempfile.mkdtemp()
        self.port = free_port()
        self.env = dict(
            os.environ,
            PORTA=str(self.port),
            REMOTEIFES_DATA_DIR=self.tmp,
            NODE_ENV="development",
            SENHA_ADMIN_INICIAL="startup-smoke-strong-password",
            BACKUP_AUTOMATICO="false",
            NO_COLOR="1",
            PYTHONIOENCODING="utf-8",
        )
        if os.name == "nt":
            self.cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", os.path.join(c.ROOT, "server.bat")]
        else:
            self.cmd = [os.path.join(c.ROOT, "server.sh")]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stop(self, process):
        if process.poll() is not None:
            return process.returncode
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            process.terminate()
        try:
            return process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait()

    def test_start_repeat_and_stop(self):
        log_path = os.path.join(self.tmp, "server.log")
        with open(log_path, "w") as log:
            process = subprocess.Popen(self.cmd, env=self.env, stdout=log, stderr=subprocess.STDOUT, cwd=self.tmp)
        try:
            health = None
            deadline = time.time() + 90
            while time.time() < deadline and process.poll() is None:
                health = c.http_json("127.0.0.1", self.port, "/health")
                if health:
                    break
                time.sleep(0.3)
            with open(log_path, encoding="utf-8", errors="replace") as log:
                output = log.read()
            self.assertIsNotNone(health, output)
            self.assertEqual((health.get("ok"), health.get("servico")), (True, "RemoteIFES API"))
            self.assertIn("porta %d livre" % self.port, output)
            if sys.platform.startswith("linux"):
                with open("/proc/%d/comm" % process.pid) as comm:
                    self.assertEqual(comm.read().strip(), "node", "the launcher execs Node; no Python stays resident")

            second = subprocess.run(self.cmd, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace", timeout=120)
            self.assertEqual(second.returncode, 0, second.stdout)
            self.assertIn("já está rodando na porta %d" % self.port, second.stdout)
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, "remoteifes.db")))
        finally:
            code = self.stop(process)
        if os.name != "nt":
            self.assertEqual(code, 0, "SIGTERM reaches Node, which shuts down gracefully")


if __name__ == "__main__":
    unittest.main()
