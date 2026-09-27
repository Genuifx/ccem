#!/usr/bin/env python3
"""Actual pinned Hermes adapters, real aiohttp, synthetic SDK/HTTP boundaries.

Run with the private package Python and --source pointing to a patched checkout.
All profiles are temporary. Only this process's loopback HTTP fixture is reachable.
No credentials, real bots, or existing Hermes profile are accessed.
"""

import argparse
import asyncio
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch


parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
args, remaining = parser.parse_known_args()
source = args.source.resolve(strict=True)
temporary = tempfile.TemporaryDirectory(prefix="ccem-multichannel-contract-")
os.environ.clear()
os.environ.update(HOME=temporary.name, HERMES_HOME=temporary.name, PATH="/usr/bin:/bin",
                  HERMES_BUNDLED_PLUGINS=str(source / "plugins"))
os.chdir(temporary.name)
sys.dont_write_bytecode = True
sys.path.insert(0, str(source))

_connect, _connect_ex, _getaddrinfo = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo


def loopback_connect(function):
    def guarded(sock, address):
        if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1"}:
            raise AssertionError("External network prohibited by contract test")
        return function(sock, address)
    return guarded


socket.socket.connect = loopback_connect(_connect)
socket.socket.connect_ex = loopback_connect(_connect_ex)


def loopback_lookup(host, *values, **kwargs):
    if host not in {"127.0.0.1", "::1"}:
        raise AssertionError("External DNS prohibited by contract test")
    return _getaddrinfo(host, *values, **kwargs)


socket.getaddrinfo = loopback_lookup

import aiohttp
import discord
from slack_sdk.web.async_client import AsyncWebClient
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.managed_contracts import StrictTarget, native_source_message_id, send_strict
from gateway import managed_http
from gateway.platforms.base import MessageEvent, MessageType
from plugins.platforms.discord.adapter import DiscordAdapter
from plugins.platforms.slack.adapter import SlackAdapter
from plugins.platforms.feishu.adapter import FeishuAdapter
from plugins.platforms.telegram.adapter import TelegramAdapter
from plugins.platforms.wecom.adapter import WeComAdapter

host_spec = importlib.util.spec_from_file_location("contract_host", Path(__file__).with_name("ccem_gateway_host.py"))
host_module = importlib.util.module_from_spec(host_spec)
host_spec.loader.exec_module(host_module)


class MultiChannelContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.status = 200
        self.reply_override = None
        self.close_without_receipt = False
        self.pause_delivery = None
        self.production_endpoints = dict(managed_http._ENDPOINTS)
        self.server = await asyncio.start_server(self.handle_http, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        endpoints = {key: f"http://127.0.0.1:{port}/{key[0]}/{key[1]}"
                     for key in managed_http._ENDPOINTS}
        self.endpoint_patch = patch.dict(managed_http._ENDPOINTS, endpoints)
        self.endpoint_patch.start()
        self.adapters = {}
        for name, cls in (("discord", DiscordAdapter), ("slack", SlackAdapter), ("feishu", FeishuAdapter)):
            adapter = cls(PlatformConfig(enabled=True, token="xoxb-synthetic"))
            adapter._running = True
            adapter.gateway_runner = NS(config=NS(integration_only=True), _profile_name_for_source=lambda source: "managed")
            self.adapters[name] = adapter
        self.adapters["discord"]._client = NS(http=NS(token="synthetic-discord-secret"), is_ready=lambda: True)
        self.adapters["slack"]._team_clients = {"T1": AsyncWebClient(token="xoxb-synthetic-slack-secret")}
        self.adapters["slack"]._handler = NS(client=NS(is_connected=AsyncMock(return_value=True)))
        feishu = self.adapters["feishu"]
        feishu._client = object()
        feishu._app_id, feishu._app_secret = "synthetic-app", "synthetic-feishu-secret"
        feishu._domain_name, feishu._connection_mode = "feishu", "websocket"
        feishu._ws_client = NS(_conn=NS(state=NS(name="OPEN")))

    async def asyncTearDown(self):
        self.endpoint_patch.stop()
        self.server.close()
        await self.server.wait_closed()

    async def handle_http(self, reader, writer):
        try:
            raw_head = await reader.readuntil(b"\r\n\r\n")
            lines = raw_head.decode("ascii").split("\r\n")
            headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
            raw = await reader.readexactly(int(headers.get("Content-Length", "0")))
            path = lines[0].split()[1]
            self.requests.append({"path": path, "payload": json.loads(raw), "headers": headers})
            if path.endswith("/message") and self.pause_delivery is not None:
                await self.pause_delivery.wait()
            if path.endswith("/token"):
                status, body = 200, {"code": 0, "tenant_access_token": "synthetic-access-secret", "expire": 7200}
            else:
                status = self.status
                platform = path.split("/")[1]
                body = self.reply_override if self.reply_override is not None else self.success_body(platform)
            if self.close_without_receipt and path.endswith("/message"):
                return
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            writer.write(f"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nLocation: http://127.0.0.1:1/must-not-follow\r\nConnection: close\r\n\r\n".encode() + data)
            await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    @staticmethod
    def chat(platform):
        return {"discord": "123456789", "slack": "D123ABC", "feishu": "oc_123ABC"}[platform]

    def success_body(self, platform):
        chat = self.chat(platform)
        return {"discord": {"id": "987654321", "channel_id": chat},
                "slack": {"ok": True, "channel": chat, "ts": "1234567890.123456", "message": {"ts": "1234567890.123456"}},
                "feishu": {"code": 0, "data": {"chat_id": chat, "message_id": "om_native"}}}[platform]

    async def deliver(self, platform, *, text="literal <@all> 中文", thread_id=None, profile="managed", timeout=30):
        runner = NS(_primary_profile_name="managed", adapters={Platform(platform): self.adapters[platform]})
        return await send_strict(runner, StrictTarget(profile, platform, self.chat(platform), thread_id), text, timeout=timeout)

    def deliveries(self, platform):
        return [item for item in self.requests if item["path"] == f"/{platform}/message"]

    async def test_success_confirms_exact_native_target_once(self):
        for platform in self.adapters:
            with self.subTest(platform=platform):
                result = await self.deliver(platform)
                self.assertEqual(result["status"], "sent")
                self.assertEqual(result["target"], result["requested_target"])
                self.assertTrue(result["message_id"])
                self.assertEqual(len(self.deliveries(platform)), 1)
        discord_payload = self.deliveries("discord")[0]["payload"]
        self.assertEqual(discord_payload["allowed_mentions"], {"parse": []})
        self.assertFalse(self.deliveries("slack")[0]["payload"]["mrkdwn"])
        feishu = self.deliveries("feishu")[0]["payload"]
        self.assertEqual(json.loads(feishu["content"])["text"], "literal <@all> 中文")
        self.assertEqual(feishu["receive_id"], "oc_123ABC")

    async def test_500_is_unknown_without_retry(self):
        self.status = 500
        self.reply_override = {"error": "synthetic-secret"}
        for platform in self.adapters:
            self.assertEqual((await self.deliver(platform))["status"], "unknown")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_429_is_explicit_rejection_without_retry(self):
        self.status = 429
        self.reply_override = {"error": "rate_limited"}
        for platform in self.adapters:
            self.assertEqual((await self.deliver(platform))["status"], "not_sent")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_close_after_accept_is_unknown_without_retry(self):
        self.close_without_receipt = True
        for platform in self.adapters:
            result = await self.deliver(platform)
            self.assertEqual(result["status"], "unknown")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_redirect_is_not_followed(self):
        self.status = 307
        for platform in self.adapters:
            result = await self.deliver(platform)
            self.assertEqual(result["status"], "unknown")
            self.assertEqual(result["error_code"], "redirect_refused")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_deadline_cancels_the_attempt_without_retry(self):
        for platform in self.adapters:
            self.pause_delivery = asyncio.Event()
            result = await self.deliver(platform, timeout=0.05)
            self.pause_delivery.set()
            self.assertEqual(result["status"], "unknown")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_malformed_native_receipt_does_not_echo_secrets(self):
        for platform in self.adapters:
            body = self.success_body(platform)
            if platform == "discord":
                body.update(id="synthetic-secret", channel_id="synthetic-secret")
            elif platform == "slack":
                body.update(ts="synthetic-secret", channel="synthetic-secret")
            else:
                body["data"].update(message_id="synthetic-secret", chat_id="synthetic-secret")
            self.reply_override = body
            result = await self.deliver(platform)
            self.assertEqual(result["status"], "unknown")
            self.assertNotIn("secret", json.dumps(result))

    async def test_provider_cannot_silently_move_a_message_to_a_thread(self):
        for platform, thread in (("slack", "1234567890.654321"), ("feishu", "omt_other")):
            body = self.success_body(platform)
            body["message" if platform == "slack" else "data"]["thread_ts" if platform == "slack" else "thread_id"] = thread
            self.reply_override = body
            self.assertEqual((await self.deliver(platform))["status"], "unknown")
            self.assertEqual(len(self.deliveries(platform)), 1)

    async def test_wrong_target_and_missing_receipt_are_unknown(self):
        for platform in self.adapters:
            body = self.success_body(platform)
            if platform == "discord":
                body["channel_id"] = "99999"
            elif platform == "slack":
                body["channel"] = "DOTHER"
            else:
                body["data"]["chat_id"] = "oc_other"
            self.reply_override = body
            self.assertEqual((await self.deliver(platform))["status"], "unknown")
            self.reply_override = {"ok": True, "code": 0}
            self.assertEqual((await self.deliver(platform))["status"], "unknown")
            self.assertEqual(len(self.deliveries(platform)), 2)

    async def test_malformed_or_oversized_reply_is_bounded_and_redacted(self):
        for response in (b"invalid synthetic-secret", b"x" * 65537, {"error": "synthetic-secret"}):
            self.reply_override = response
            for platform in self.adapters:
                result = await self.deliver(platform)
                self.assertEqual(result["status"], "unknown")
                self.assertNotIn("secret", json.dumps(result))

    async def test_no_thread_downgrade_profile_fallback_or_split(self):
        for platform in self.adapters:
            for kwargs in ({"thread_id": "123.456"}, {"profile": "other"}, {"text": "x" * 5000}):
                self.assertEqual((await self.deliver(platform, **kwargs))["status"], "not_sent")
            self.assertEqual(self.deliveries(platform), [])

    async def test_readiness_uses_live_sdk_transport(self):
        for platform, adapter in self.adapters.items():
            self.assertTrue(await adapter.strict_delivery_ready())
            if platform == "discord":
                adapter._client.is_ready = lambda: False
            elif platform == "slack":
                adapter._handler.client.is_connected.return_value = False
            else:
                adapter._ws_client._conn.state.name = "CLOSED"
            self.assertFalse(await adapter.strict_delivery_ready())
            self.assertEqual((await self.deliver(platform))["status"], "not_sent")
        self.assertEqual(self.requests, [])

    async def test_telegram_polling_degradation_is_reflected_in_host_until_recovery(self):
        adapter = TelegramAdapter(PlatformConfig(enabled=True, token="synthetic"))
        adapter._running = True
        adapter._bot = object()
        adapter._send_path_degraded = True
        await self.verify_legacy_readiness_transition("telegram", adapter,
            lambda healthy: setattr(adapter, "_send_path_degraded", not healthy))

    async def test_wecom_socket_close_is_reflected_in_host_until_recovery(self):
        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._running = True
        adapter._ws = NS(closed=True)
        await self.verify_legacy_readiness_transition("wecom", adapter,
            lambda healthy: setattr(adapter._ws, "closed", not healthy))

    async def verify_legacy_readiness_transition(self, platform, adapter, set_healthy):
        host = host_module.Host({"protocolVersion": 1, "token": "synthetic-" + "x" * 40,
            "accountRef": "synthetic", "endpoint": "http://127.0.0.1:1/rpc", "platform": platform},
            Path(temporary.name) / platform)
        host.runner = NS(_primary_profile_name="managed", adapters={Platform(platform): adapter})
        host.state = "running"
        for healthy in (False, True, False, True):
            set_healthy(healthy)
            self.assertEqual(await adapter.strict_delivery_ready(), healthy)
            self.assertEqual(await host.refresh_transport_status(), healthy)
            self.assertEqual(host.snapshot()["state"], "running" if healthy else "reconnecting")
            if not healthy:
                result = await send_strict(host.runner, StrictTarget("managed", platform, "12345"), "text")
                self.assertEqual((result["status"], result["error_code"]), ("not_sent", "live_adapter_unavailable"))
                with self.assertRaisesRegex(ValueError, "gateway_not_running"):
                    await host.request("openPairing", {})
        adapter._running = False
        self.assertFalse(await host.refresh_transport_status())
        self.assertEqual(self.requests, [])

    async def test_slack_rejects_multiple_accounts_before_loading_saved_tokens(self):
        adapter = self.adapters["slack"]
        for value in ("xoxb-one,xoxb-two", '["xoxb-one"]', '{"token":"xoxb-one"}'):
            adapter.config.token = value
            with patch("plugins.platforms.slack.adapter.get_secret", return_value="xapp-synthetic"), \
                 patch("plugins.platforms.slack.adapter._load_slack_bot_tokens", side_effect=AssertionError("must not read saved tokens")):
                self.assertFalse(await adapter.connect())
        adapter._team_clients["T2"] = AsyncWebClient(token="xoxb-second")
        self.assertEqual((await self.deliver("slack"))["status"], "not_sent")
        self.assertEqual(self.requests, [])

    async def test_feishu_token_is_adapter_local_and_only_cached_in_memory(self):
        self.assertEqual((await self.deliver("feishu"))["status"], "sent")
        self.assertEqual((await self.deliver("feishu"))["status"], "sent")
        self.assertEqual(sum(item["path"] == "/feishu/token" for item in self.requests), 1)
        self.adapters["feishu"]._domain_name = "https://untrusted.example"
        self.assertEqual((await self.deliver("feishu"))["status"], "not_sent")
        self.assertEqual(len(self.deliveries("feishu")), 2)

    async def test_transport_admission_does_not_grant_gateway_command_authority(self):
        from gateway.run import GatewayRunner
        from gateway.session import SessionSource
        for platform in self.adapters:
            runner = object.__new__(GatewayRunner)
            runner.config = GatewayConfig(integration_only=True, unauthorized_dm_behavior="ignore",
                platforms={Platform(platform): PlatformConfig(enabled=True)})
            runner._primary_profile_name = "managed"
            runner._profile_adapters, runner.adapters, runner._running_agents = {}, {}, {}
            runner._draining = False
            runner.hooks = NS(emit=AsyncMock(), emit_collect=AsyncMock(return_value=[]))
            runner._run_agent = AsyncMock(side_effect=AssertionError("must not start an agent"))
            event = MessageEvent(text="/ccem start arbitrary", message_id="native-message",
                source=SessionSource(platform=Platform(platform), chat_id=self.chat(platform),
                    user_id="unapproved", chat_type="dm"))
            self.assertIsNone(await runner._handle_message(event))
            runner._run_agent.assert_not_awaited()

    async def test_plain_text_rewrite_still_requires_native_sender_admission(self):
        from gateway.run import GatewayRunner
        from gateway.session import SessionSource
        for platform in self.adapters:
            host = host_module.Host({"protocolVersion": 1, "token": "x"*48,
                "accountRef": "a"*48, "endpoint": "http://127.0.0.1:1/rpc", "platform": platform}, Path(os.environ["HERMES_HOME"]))
            host.rpc = lambda *args: self.fail("unapproved text must not call CCEM")
            runner = object.__new__(GatewayRunner)
            runner.config = GatewayConfig(integration_only=True, unauthorized_dm_behavior="ignore", platforms={Platform(platform):PlatformConfig(enabled=True)})
            runner._primary_profile_name = "managed"
            runner._profile_adapters, runner.adapters, runner._running_agents = {}, {}, {}
            runner._draining = False
            runner._run_agent = AsyncMock(side_effect=AssertionError("must not start an agent"))
            challenge = "c" * 48
            prefix = host_module.command_prefix(platform)
            for text, expected in (("continue the attached session", "chat continue the attached session"),
                                   (f"两分钟内发送：\n{prefix} confirm\n{challenge}", f"confirm {challenge}"),
                                   (f"/ccem confirm {challenge}", f"confirm {challenge}"),
                                   (f"{prefix} confirm {challenge}", f"confirm {challenge}")):
                event = MessageEvent(text=text, message_id="native-message",
                    source=SessionSource(platform=Platform(platform), chat_id=self.chat(platform), user_id="unapproved", chat_type="dm"))
                rewrite = host.pairing_hook(event=event)
                self.assertEqual(rewrite, {"action":"rewrite", "text":"/ccem " + expected})
                rewritten = MessageEvent(text=rewrite["text"], message_id=event.message_id, source=event.source)
                self.assertEqual(rewritten.get_command(), "ccem")
                self.assertEqual(rewritten.get_command_args(), expected)
                runner.hooks = NS(emit=AsyncMock(), emit_collect=AsyncMock(return_value=[]))
                def invoke_pre_dispatch(name, **kwargs):
                    return [host.pairing_hook(event=kwargs["event"])]
                with patch("hermes_cli.lifecycle.invoke_hook", side_effect=invoke_pre_dispatch) as hook:
                    self.assertIsNone(await runner._handle_message(event))
                    hook.assert_called_once()
                    self.assertEqual(hook.call_args.args, ("pre_gateway_dispatch",))
                    self.assertEqual(hook.call_args.kwargs["event"].message_id, "native-message")
            runner._run_agent.assert_not_awaited()

    async def test_connected_adapter_proxy_is_used_without_inheriting_environment_auth(self):
        for platform in ("discord", "slack"):
            adapter = self.adapters[platform]
            if platform == "discord":
                adapter._client.http.proxy = "http://explicit-proxy.example:8080"
            else:
                adapter._proxy_url = "http://explicit-proxy.example:8080"
            with patch(f"plugins.platforms.{platform}.strict_delivery.post_json", new_callable=AsyncMock,
                       return_value=(200, self.success_body(platform))) as post:
                self.assertEqual((await self.deliver(platform))["status"], "sent")
                self.assertEqual(post.call_args.kwargs["proxy"], "http://explicit-proxy.example:8080")
                self.assertEqual(post.await_count, 1)

    async def test_discord_real_dm_message_keeps_native_identity(self):
        adapter = self.adapters["discord"]
        client = discord.Client(intents=discord.Intents.none())
        state = client._connection
        user = {"id": "12345", "username": "alice", "discriminator": "0", "avatar": None}
        channel = discord.DMChannel(me=None, state=state, data={"id": self.chat("discord"), "recipients": [user]})
        message = discord.Message(state=state, channel=channel, data={
            "id": "987654321", "content": "/ccem connect nonce", "author": user,
            "timestamp": datetime.now(timezone.utc).isoformat(), "type": 0,
            "attachments": [], "embeds": [], "mentions": [], "mention_roles": [], "pinned": False, "tts": False,
        })
        adapter._client = client
        adapter._self_is_explicitly_mentioned = lambda message: False
        adapter._get_effective_topic = lambda *args, **kwargs: None
        adapter._collect_attachment_media = AsyncMock(return_value=([], [], None))
        adapter._resolve_channel_skills = lambda *args: None
        adapter._resolve_channel_prompt = lambda *args: None
        adapter.handle_message = AsyncMock()
        adapter._ready_event.set()
        self.assertTrue(await adapter._dispatch_discord_message(message))
        event = adapter.handle_message.call_args.args[0]
        self.assertEqual((event.source.user_id, event.source.chat_id, event.source.chat_type), ("12345", self.chat("discord"), "dm"))
        self.assertEqual(event.text, "/ccem connect nonce")
        self.assertEqual(native_source_message_id(event), "987654321")
        adapter._auto_create_thread = AsyncMock(side_effect=AssertionError("must not create a thread"))
        self.assertFalse(await adapter._handle_message(NS(channel=object())))

    async def test_slack_real_message_parser_accepts_plugin_bang_command_only_from_single_dm(self):
        adapter = self.adapters["slack"]
        event = {"type": "message", "text": "!ccem connect nonce", "channel": self.chat("slack"),
                 "channel_type": "im", "user": "U123", "team": "T1", "ts": "1234567890.123456"}
        adapter._prefilter_inbound = AsyncMock(side_effect=lambda incoming, payload: (incoming, incoming["team"], incoming["channel"]))
        adapter._lookup_assistant_thread_metadata = lambda *args, **kwargs: {}
        adapter._agent_view_context_for_event = lambda *args: {}
        adapter.set_authorization_check(lambda *args: False)
        adapter._peer_bot_drop = AsyncMock(return_value=False)
        adapter._hydrate_thread_context = AsyncMock(return_value=(None, [], []))
        adapter._collect_inbound_media = AsyncMock(return_value=([], [], "unused enrichment"))
        adapter._resolve_user_name = AsyncMock(return_value="alice")
        adapter._resolve_channel_name = AsyncMock(return_value="private")
        adapter._humanize_user_mentions = AsyncMock(side_effect=lambda text, **kwargs: text)
        adapter._channel_prompt_with_identity = lambda *args: None
        adapter._reactions_enabled = lambda: False
        adapter.handle_message = AsyncMock()
        with patch("hermes_cli.commands._iter_plugin_command_entries", return_value=[("ccem", "managed", None)]):
            await adapter._handle_slack_message_impl(event)
        incoming = adapter.handle_message.call_args.args[0]
        self.assertEqual(incoming.text, "/ccem connect nonce")
        self.assertEqual(incoming.source.user_id, "U123")
        self.assertIsNone(incoming.source.thread_id)
        self.assertEqual(native_source_message_id(incoming), event["ts"])
        for changes in ({"channel_type": "mpim"}, {"team": "T2"}, {"_hermes_force_process": True}):
            adapter.handle_message.reset_mock()
            await adapter._handle_slack_message_impl(dict(event, **changes))
            adapter.handle_message.assert_not_awaited()

    async def test_feishu_native_dm_and_synthetic_callbacks_remain_distinct(self):
        adapter = self.adapters["feishu"]
        adapter._is_duplicate = AsyncMock(return_value=False)
        adapter._extract_message_content = AsyncMock(return_value=("/ccem connect nonce", MessageType.TEXT, [], [], []))
        adapter.get_chat_info = AsyncMock(return_value={"type": "p2p", "name": "private"})
        adapter._resolve_sender_profile = AsyncMock(return_value={"user_id": "native-user", "user_name": "alice", "user_id_alt": "ou_native"})
        adapter._dispatch_inbound_event = AsyncMock()
        message = NS(message_id="om_native", chat_id=self.chat("feishu"), chat_type="p2p", thread_id=None, root_id=None, parent_id=None)
        sender = NS(sender_id=NS(user_id="native-user", open_id="ou_native", union_id=None), sender_type="user")
        data = NS(event=NS(message=message, sender=sender))
        await adapter._handle_message_event_data(data)
        incoming = adapter._dispatch_inbound_event.call_args.args[0]
        self.assertEqual(native_source_message_id(incoming), "om_native")
        self.assertEqual(incoming.source.user_id, "native-user")
        self.assertEqual(incoming.source.chat_type, "dm")
        adapter._dispatch_inbound_event.reset_mock()
        message.chat_type = "group"
        await adapter._handle_message_event_data(data)
        adapter._dispatch_inbound_event.assert_not_awaited()
        adapter._handle_message_with_guards = AsyncMock()
        await adapter._dispatch_synthetic_event(text="/ccem connect nonce", message_type=MessageType.COMMAND,
            chat_id=self.chat("feishu"), sender_id=sender.sender_id, event_chat_type="p2p", raw_message=data, message_id="card-request-id")
        synthetic = adapter._handle_message_with_guards.call_args.args[0]
        self.assertIsNone(native_source_message_id(synthetic))
        self.assertFalse(synthetic.allow_gateway_control)

    async def test_transport_tls_and_redirect_settings_are_enforced(self):
        original = aiohttp.ClientSession.post
        calls = []
        def observe(session, url, **kwargs):
            self.assertFalse(session.trust_env)
            self.assertEqual(session.timeout.total, 10)
            calls.append(kwargs)
            return original(session, url, **kwargs)
        with patch.object(aiohttp.ClientSession, "post", observe):
            await self.deliver("discord")
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0]["allow_redirects"], False)
        context = calls[0]["ssl"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertTrue(all(url.startswith("https://") for url in self.production_endpoints.values()))


if __name__ == "__main__":
    try:
        unittest.main(argv=[sys.argv[0], *remaining])
    finally:
        temporary.cleanup()
