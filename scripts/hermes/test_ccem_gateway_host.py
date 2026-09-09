#!/usr/bin/env python3
"""Isolated host pairing regression against an explicitly supplied patched Hermes tree.

Run with the runtime Python: python -I test_ccem_gateway_host.py --source PATH.
Only synthetic callbacks and an in-memory pairing store are used; no connection
is created and import-time profile writes are confined to a temporary home.
"""
import argparse
import asyncio
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import types
import unittest


class NativePairingProvenance(unittest.IsolatedAsyncioTestCase):
    async def test_synthetic_ids_cannot_consume_pairing_nonce(self):
        from gateway.config import PlatformConfig
        from plugins.platforms.wecom.adapter import WeComAdapter

        host = host_module.Host({"protocolVersion": 1, "token": "synthetic-capability-" + "x" * 32,
                                "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc",
                                "platform": "wecom"}, Path(os.environ["HERMES_HOME"]))
        native_requests = []
        def generate_code(platform, user, name):
            native_requests.append((platform, user))
            return "synthetic-native-pairing-code"
        store = types.SimpleNamespace(generate_code=generate_code)
        host.runner = types.SimpleNamespace(_pairing_store_for=lambda source: store,
                                            _primary_profile_name="custom")
        host.publish = lambda: None
        host.pairing = {"code": "pairing-nonce", "expiresAt": int(time.time() * 1000) + 120_000}
        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._is_dm_intake_allowed = lambda sender: True
        adapter._text_batch_delay_seconds = adapter._attachment_text_merge_delay_seconds = 0
        decisions = []
        async def receive(event):
            decisions.append(host.pairing_hook(event=event))
        adapter.handle_message = receive
        body = {"msgtype": "text", "text": {"content": "/ccem connect pairing-nonce"},
                "from": {"userid": "synthetic-user"}, "chatid": "synthetic-chat", "chattype": "single"}
        for headers in ({}, {"req_id": "request-only-id"}):
            await adapter._on_message({"headers": headers, "body": body})
            self.assertEqual(decisions[-1]["reason"], "invalid_pairing_source")
            self.assertEqual(native_requests, [])
            self.assertEqual(host.pending, {})
            self.assertIsNotNone(host.pairing)
        await adapter._on_message({"headers": {"req_id": "native-request"},
                                   "body": {**body, "msgid": "native-message"}})
        self.assertEqual(decisions[-1]["reason"], "awaiting_desktop_approval")
        self.assertEqual(native_requests, [("wecom", "synthetic-user")])
        self.assertEqual(len(host.pending), 1)
        self.assertIsNone(host.pairing)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    args, remaining = parser.parse_known_args()
    source = args.source.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="ccem-host-provenance-") as temporary:
        os.environ.clear()
        os.environ.update(HOME=temporary, HERMES_HOME=temporary)
        def no_network(*args, **kwargs):
            raise AssertionError("network prohibited in host pairing regression")
        socket.socket.connect = socket.socket.connect_ex = socket.socket.sendto = no_network
        socket.getaddrinfo = no_network
        sys.path.insert(0, str(source))
        import gateway.managed_contracts as contracts
        assert Path(contracts.__file__).resolve().is_relative_to(source)
        spec = importlib.util.spec_from_file_location("ccem_host_under_test", Path(__file__).with_name("ccem_gateway_host.py"))
        host_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host_module)
        unittest.main(argv=[sys.argv[0], *remaining])
