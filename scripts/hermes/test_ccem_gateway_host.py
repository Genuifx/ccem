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
from unittest.mock import patch


class NativePairingProvenance(unittest.IsolatedAsyncioTestCase):
    async def test_confirmation_rewrite_keeps_gateway_admission_and_explicit_task_text(self):
        from gateway.config import Platform
        from gateway.platforms.base import MessageEvent
        from gateway.session import SessionSource
        host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
            "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc", "platform": "wecom"},
            Path(os.environ["HERMES_HOME"]))
        host.rpc = lambda *args: self.fail("A pre-dispatch rewrite cannot issue RPC")
        source = SessionSource(platform=Platform("wecom"), chat_id="chat", user_id="user", chat_type="dm")
        text = "两分钟内发送：\n/ccem confirm " + "c" * 48
        for flags in ({"internal": True}, {"allow_gateway_control": False}):
            event = MessageEvent(text=text, message_id="native-message", source=source, **flags)
            self.assertIsNone(host.pairing_hook(event=event))
        for command in ("chat", "input native-one"):
            text = f"/ccem {command} explain this example:\n/ccem confirm " + "c" * 48
            event = MessageEvent(text=text, message_id="native-message", source=source)
            self.assertIsNone(host.pairing_hook(event=event))
            self.assertEqual(event.text, text)

    async def test_wecom_copied_confirmation_dispatches_once_without_creating_a_new_task(self):
        from gateway.config import PlatformConfig
        from plugins.platforms.wecom.adapter import WeComAdapter
        from gateway.managed_contracts import native_source_message_id

        host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
            "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc", "platform": "wecom"},
            Path(os.environ["HERMES_HOME"]))
        challenge = "0123456789abcdef" * 3
        calls, replies = [], []
        def rpc(method, params):
            calls.append((method, params))
            if method == "confirm":
                return {"operationId": "hermes:test", "state": "submitting"}
            self.fail("A copied control reply must never create another chat preview")
        async def send(runner, target, text):
            replies.append(text)
            return {"status": "sent"}
        host.rpc = rpc
        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._is_dm_intake_allowed = lambda sender: True
        adapter._text_batch_delay_seconds = adapter._attachment_text_merge_delay_seconds = 0
        async def receive(event):
            rewrite = host.pairing_hook(event=event)
            self.assertEqual(rewrite["action"], "rewrite")
            context = types.SimpleNamespace(platform="wecom", profile="managed", transport_profile="managed",
                user_id=event.source.user_id, chat_id=event.source.chat_id, thread_id=None,
                chat_type="dm", source_message_id=native_source_message_id(event))
            await host.command(rewrite["text"].removeprefix("/ccem "), context)
        adapter.handle_message = receive
        async def packet(text, message_id):
            await adapter._on_message({"headers": {"req_id": "native-request"}, "body": {
                "msgtype": "text", "text": {"content": text}, "msgid": message_id,
                "from": {"userid": "native-user"}, "chatid": "native-chat", "chattype": "single"}})
        with patch("gateway.managed_contracts.send_strict", send):
            await packet(f"两分钟内发送：\n/ccem confirm\n{challenge[:30]}\n{challenge[30:]}", "native-confirm")
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "confirm")
            self.assertEqual(calls[0][1]["challenge"], challenge)
            self.assertEqual(calls[0][1]["sourceMessageId"], "native-confirm")
            self.assertEqual(calls[0][1]["source"]["userId"], "native-user")
            self.assertIn("hermes:test", replies[-1])
            await packet(host_module.render_result({"runtimeId": "native-one", "text": "hello", "challenge": challenge}), "native-preview-copy")
            self.assertEqual(len(calls), 1)
            self.assertIn("单独发送一条", replies[-1])
            host.rpc = lambda *args: (_ for _ in ()).throw(ValueError("challenge_expired_or_revoked"))
            await packet(f"/ccem confirm {challenge}", "native-expired")
            self.assertIn("失效", replies[-1])
            self.assertIn("重新发送原任务", replies[-1])

    async def test_invalid_feishu_region_is_rejected_before_adapter_start(self):
        with patch.dict(os.environ, {"HERMES_BUNDLED_PLUGINS": str(source / "plugins")}):
            for region in ("unknown", "https://untrusted.test", ""):
                host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
                    "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc", "platform": "feishu", "connect": True,
                    "fields": {"FEISHU_APP_ID": "cli_synthetic", "FEISHU_APP_SECRET": "synthetic-secret", "FEISHU_DOMAIN": region}},
                    Path(os.environ["HERMES_HOME"]) / "invalid-feishu-region")
                host.publish = lambda: None
                with self.assertRaisesRegex(ValueError, "^invalid_channel_field$"):
                    await host.initialize()
                self.assertIsNone(host.runner)

    async def test_running_status_requires_the_adapter_transport_readiness(self):
        host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
                                "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc",
                                "platform": "slack"}, Path(os.environ["HERMES_HOME"]))
        ready = False
        async def strict_delivery_ready():
            return ready
        host.runner = types.SimpleNamespace(adapters={"slack": types.SimpleNamespace(is_connected=True, strict_delivery_ready=strict_delivery_ready)})
        host.state = "running"
        self.assertFalse(await host.refresh_transport_status())
        self.assertEqual(host.snapshot()["state"], "reconnecting")
        ready = True
        self.assertTrue(await host.refresh_transport_status())
        self.assertEqual(host.snapshot()["state"], "running")
        ready = False
        await host.refresh_transport_status()
        self.assertEqual(host.snapshot()["state"], "reconnecting")

    async def test_discord_input_budget_is_checked_before_requesting_confirmation(self):
        host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
                                "accountRef": "a" * 48, "endpoint": "http://127.0.0.1:1/rpc",
                                "platform": "discord"}, Path(os.environ["HERMES_HOME"]))
        host.platforms = [{"id": "discord", "maxMessageLength": 2000}]
        context = types.SimpleNamespace(platform="discord", profile="default", transport_profile="default",
                                        user_id="user", chat_id="chat", thread_id=None, chat_type="dm", source_message_id="native-id")
        replies, requests = [], []
        async def send(runner, target, text):
            replies.append(text)
            return {"status": "sent"}
        def rpc(method, params):
            requests.append(params)
            return {"runtimeId": "native-" + "r" * 48, "text": params["text"], "challenge": "c" * 48}
        host.rpc = rpc
        with patch("gateway.managed_contracts.send_strict", send):
            await host.command("input runtime " + "x" * 1500, context)
            self.assertEqual(requests, [])
            self.assertIn("1400", replies[-1])
            await host.command("input runtime " + "x" * 1400, context)
            self.assertEqual(len(requests), 1)
            self.assertIn("x" * 1400, replies[-1])
            self.assertIn("/ccem confirm", replies[-1])
            self.assertLessEqual(len(replies[-1].encode()), 2000)

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
