"""Filesystem isolation regressions; no Hermes installation or real profile needed."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


PROBE = Path(__file__).with_name("probe-compatibility.py").resolve()


class ProbeIsolationTests(unittest.TestCase):
    def run_guarded(self, code):
        with tempfile.TemporaryDirectory(prefix="ccem-probe-test-") as directory:
            result = subprocess.run(
                [sys.executable, "-c", textwrap.dedent(code), str(PROBE), directory],
                capture_output=True, text=True, timeout=10, check=True)
            report = json.loads(result.stdout)
            for relative, expected in {
                "source/.env": "SYNTHETIC_TEST_SECRET=no-real-secret\n".encode("utf16"),
                "profile/config.json": b'{"synthetic":true}',
            }.items():
                path = Path(directory) / relative
                if path.exists():
                    self.assertEqual(path.read_bytes(), expected)
            return report

    def test_import_cannot_read_or_rewrite_project_env(self):
        result = self.run_guarded('''
            import importlib, json, pathlib, runpy, sys
            Guard = runpy.run_path(sys.argv[1])["ProbeIOGuard"]
            root = pathlib.Path(sys.argv[2])
            source, worker = root / "source", root / "worker"
            source.mkdir(); worker.mkdir()
            env = source / ".env"
            original = "SYNTHETIC_TEST_SECRET=no-real-secret\\n".encode("utf16")
            env.write_bytes(original)
            (source / "loader.py").write_text(
                "from pathlib import Path\\n"
                "p = Path(__file__).with_name('.env')\\n"
                "text = p.read_text(encoding='utf16')\\n"
                "p.write_text(text, encoding='utf8')\\n")
            sys.path.insert(0, str(source)); sys.dont_write_bytecode = True
            sys.addaudithook(Guard(source, worker, (pathlib.Path(sys.prefix), pathlib.Path(sys.base_prefix))))
            denied = []
            try:
                importlib.import_module("loader")
            except PermissionError:
                denied.append("read")
            try:
                env.write_text("overwritten")
            except PermissionError:
                denied.append("write")
            (worker / "receipt.json").write_text(json.dumps(denied))
            print(json.dumps({"denied": denied, "workerWritable": (worker / "receipt.json").is_file()}))
        ''')
        self.assertEqual(result, {"denied": ["read", "write"], "workerWritable": True})

    def test_profile_symlink_and_mutation_escape_are_denied(self):
        result = self.run_guarded('''
            import json, os, pathlib, runpy, sys
            Guard = runpy.run_path(sys.argv[1])["ProbeIOGuard"]
            root = pathlib.Path(sys.argv[2])
            source, worker, profile = root / "source", root / "worker", root / "profile"
            source.mkdir(); worker.mkdir(); profile.mkdir()
            secret = profile / "config.json"; secret.write_text('{"synthetic":true}')
            link = worker / "profile.json"; link.symlink_to(secret)
            owned = worker / "owned"; owned.write_text("synthetic")
            directory_fd = os.open(profile, os.O_RDONLY)
            sys.addaudithook(Guard(source, worker, (pathlib.Path(sys.prefix), pathlib.Path(sys.base_prefix))))
            denied = []
            for name, action in [
                ("profile", secret.read_text),
                ("symlinkRead", link.read_text),
                ("symlinkWrite", lambda: link.write_text("overwrite")),
                ("rename", lambda: owned.replace(secret)),
                ("dirFdRemove", lambda: os.remove("config.json", dir_fd=directory_fd)),
            ]:
                try:
                    action()
                except PermissionError:
                    denied.append(name)
            os.close(directory_fd)
            print(json.dumps(denied))
        ''')
        self.assertEqual(result, ["profile", "symlinkRead", "symlinkWrite", "rename", "dirFdRemove"])

    def test_open_relative_to_runtime_directory_cannot_create_files(self):
        result = self.run_guarded('''
            import json, os, pathlib, runpy, sys
            Guard = runpy.run_path(sys.argv[1])["ProbeIOGuard"]
            root = pathlib.Path(sys.argv[2])
            source, worker, runtime = root / "source", root / "worker", root / "runtime"
            source.mkdir(); worker.mkdir(); runtime.mkdir()
            os.chdir(worker)
            sys.addaudithook(Guard(source, worker, (runtime,)))
            directory_fd = os.open(runtime, os.O_RDONLY)
            denied = False
            try:
                fd = os.open("synthetic-new.txt", os.O_WRONLY | os.O_CREAT, dir_fd=directory_fd)
                os.close(fd)
            except PermissionError:
                denied = True
            os.close(directory_fd)
            print(json.dumps({"denied": denied, "created": (runtime / "synthetic-new.txt").exists()}))
        ''')
        self.assertEqual(result, {"denied": True, "created": False})

    @unittest.skipIf(sys.platform == "win32", "Unix datagram fixture")
    def test_unconnected_datagram_cannot_bypass_connect_guard(self):
        result = self.run_guarded('''
            import json, pathlib, runpy, socket, sys
            Guard = runpy.run_path(sys.argv[1])["ProbeIOGuard"]
            root = pathlib.Path(sys.argv[2])
            source, worker = root / "source", root / "worker"
            source.mkdir(); worker.mkdir()
            receiver = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            # macOS Unix socket paths are limited to 104 bytes; cwd keeps it short.
            import os
            os.chdir(worker); receiver.bind("receiver.sock"); receiver.settimeout(0.05)
            sender = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            sys.addaudithook(Guard(source, worker, (pathlib.Path(sys.prefix), pathlib.Path(sys.base_prefix))))
            denied = False
            try:
                sender.sendto(b"synthetic-only", "receiver.sock")
            except PermissionError:
                denied = True
            received = False
            try:
                received = bool(receiver.recv(32))
            except TimeoutError:
                pass
            sender.close(); receiver.close()
            print(json.dumps({"denied": denied, "received": received}))
        ''')
        self.assertEqual(result, {"denied": True, "received": False})


if __name__ == "__main__":
    unittest.main()
