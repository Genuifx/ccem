#!/usr/bin/env python3
"""Exercise a real private runtime's self-test without credentials or network.

Run after finalization: python3 test-runtime-package.py --package /path/to/hermes-runtime.
The package is never modified. A subprocess-only import blocker proves that the
same self-test rejects a missing transport instead of trusting static metadata.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RuntimePackageTests(unittest.TestCase):
    def execute(self, script):
        with tempfile.TemporaryDirectory(prefix="ccem-runtime-gate-") as temporary:
            environment = {"PATH": "/usr/bin:/bin", "HOME": temporary, "HERMES_HOME": temporary,
                           "LANG": "en_US.UTF-8"}
            return subprocess.run([str(package / "python/bin/python3.11"), "-I", "-B", "-c", script,
                                   str(package / "ccem_gateway_host.py")], cwd=temporary,
                                  env=environment, text=True, capture_output=True, timeout=30)

    def test_dependencies_and_companion_come_from_the_private_bundle(self):
        result = self.execute("""
import aiohttp, certifi, importlib.util, json, pathlib, ssl, sys
root = pathlib.Path(sys.argv[1]).parent.resolve()
assert pathlib.Path(aiohttp.__file__).resolve().is_relative_to(root)
assert pathlib.Path(certifi.where()).resolve().is_relative_to(root)
spec = importlib.util.spec_from_file_location('private_qr', root / 'ccem_gateway_onboarding.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
assert helper.tls_context().verify_mode == ssl.CERT_REQUIRED
print(json.dumps({'ok': True}))
""")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(json.loads(result.stdout), {"ok": True})

    def test_real_adapter_and_qr_host_self_test_pass(self):
        result = self.execute("""
import runpy, socket, sys
def no_network(*args, **kwargs):
    raise AssertionError('network prohibited in package self-test')
socket.socket.connect = socket.socket.connect_ex = socket.socket.sendto = no_network
socket.getaddrinfo = no_network
sys.argv = [sys.argv[1], '--self-test']
runpy.run_path(sys.argv[0], run_name='__main__')
""")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(json.loads(result.stdout), {"ok": True, "protocolVersion": 1})

    def test_same_self_test_fails_when_aiohttp_is_missing(self):
        result = self.execute("""
import importlib.abc, runpy, sys
class MissingTransport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'aiohttp' or fullname.startswith('aiohttp.'):
            raise ModuleNotFoundError('synthetic missing transport')
sys.meta_path.insert(0, MissingTransport())
sys.argv = [sys.argv[1], '--self-test']
runpy.run_path(sys.argv[0], run_name='__main__')
""")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('"ok":true', result.stdout)
        self.assertIn("WeCom transport dependencies are unavailable", result.stderr)

    def test_real_registry_exposes_wecom_qr_setup_without_connecting(self):
        result = self.execute("""
import asyncio, importlib.util, json, os, pathlib, socket, sys
host_path = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(host_path.parent / 'source'))
os.environ['HERMES_BUNDLED_PLUGINS'] = str(host_path.parent / 'source/plugins')
def no_network(*args, **kwargs):
    raise AssertionError('network prohibited in metadata probe')
socket.socket.connect = socket.socket.connect_ex = socket.socket.sendto = no_network
socket.getaddrinfo = no_network
spec = importlib.util.spec_from_file_location('private_host', host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.emit = lambda value: None
async def verify():
    host = module.Host({'protocolVersion': 1, 'token': 'synthetic-' + 'x' * 40,
                       'accountRef': 'synthetic', 'endpoint': 'http://127.0.0.1:1/rpc'},
                      pathlib.Path(os.environ['HERMES_HOME']))
    await host.initialize()
    wecom = next(item for item in host.platforms if item['id'] == 'wecom')
    assert wecom['available'] is True and wecom['qrSetup'] is True
    assert all(item['qrSetup'] is False for item in host.platforms if item['id'] != 'wecom')
    assert host.state == 'unconfigured'
asyncio.run(verify())
print(json.dumps({'ok': True}))
""")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(json.loads(result.stdout), {"ok": True})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    args, remaining = parser.parse_known_args()
    package = args.package.resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *remaining])
