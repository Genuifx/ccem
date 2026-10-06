#!/usr/bin/env python3
"""Exercise the pinned native Hermes gateway against a loopback-only model."""
import argparse
import asyncio
import contextlib
import dataclasses
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument("--package", type=Path, required=True)
args, remaining = parser.parse_known_args()
package = args.package.resolve(strict=True)
temporary = tempfile.TemporaryDirectory(prefix="ccem-native-chat-test-")
os.environ.clear()
os.environ.update(HOME=temporary.name, HERMES_HOME=temporary.name, PATH="/usr/bin:/bin",
    HERMES_SAFE_MODE="1", HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_BUNDLED_PLUGINS=str(package / "source/plugins"),
    NO_PROXY="127.0.0.1,localhost,::1")
sys.path.insert(0, str(package / "source"))
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("conversation_host_test", Path(__file__).with_name("ccem_gateway_host.py"))
host_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_module)
conversation = host_module._conversation_module


def guard(original):
    def connect(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            raise AssertionError("external network prohibited")
        return original(sock, address)
    return connect


socket.socket.connect = guard(socket.socket.connect)
socket.socket.connect_ex = guard(socket.socket.connect_ex)
original_lookup = socket.getaddrinfo
def lookup(host, *args, **kwargs):
    if host not in ("127.0.0.1", "::1"):
        raise AssertionError("external DNS prohibited")
    return original_lookup(host, *args, **kwargs)
socket.getaddrinfo = lookup


class NativeConversation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests, self.calls, self.replies, self.previews = [], [], [], []
        self.scope = "a" * 64
        self.allowed = True
        self.model_available = True
        self.hold_model = threading.Event()
        self.model_entered = threading.Event()
        self.hold_model.set()
        self.model_replies = [[{"type": "text", "text": "你好，我是 Hermes。"}]]
        self.home = Path(tempfile.mkdtemp(dir=temporary.name))
        os.environ["HERMES_HOME"] = str(self.home)
        (self.home / "config.yaml").write_text(json.dumps(conversation.configuration()))
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.path == "/README.md":
                    raw = b"# Fixture project\nArchitecture: a native research agent reads documentation itself.\n"
                elif "/models" in self.path:
                    model = {"id": "claude-fixture", "context_length": 65536}
                    raw = json.dumps({"data": [model]} if self.path.endswith("/models") else model).encode()
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not self.path.endswith("/messages"):
                    self.send_error(404)
                    return
                owner.requests.append((self.path, dict(self.headers), body))
                owner.model_entered.set()
                if not owner.hold_model.wait(10):
                    raise AssertionError("fixture model release timed out")
                content = owner.model_replies.pop(0) if owner.model_replies else [{"type": "text", "text": "收到。"}]
                message = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-fixture",
                    "content": content, "stop_reason": "tool_use" if any(c["type"] == "tool_use" for c in content) else "end_turn",
                    "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 10}}
                # The SDK accepts non-streamed JSON when the request explicitly disables streaming.
                if body.get("stream"):
                    start = {**message, "content": [], "stop_reason": None}
                    events = [("message_start", {"type": "message_start", "message": start})]
                    for index, block in enumerate(content):
                        block_start = {**block, **({"text": ""} if block["type"] == "text" else {"input": {}})}
                        events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": block_start}))
                        delta = {"type": "text_delta", "text": block["text"]} if block["type"] == "text" else {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                        events.extend([("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}),
                            ("content_block_stop", {"type": "content_block_stop", "index": index})])
                    events.extend([("message_delta", {"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 10}}),
                        ("message_stop", {"type": "message_stop"})])
                    raw = "".join("event: "+name+"\ndata: "+json.dumps(data)+"\n\n" for name,data in events).encode()
                    content_type = "text/event-stream"
                else:
                    raw, content_type = json.dumps(message).encode(), "application/json"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        from gateway.config import GatewayConfig, Platform
        from gateway.session import SessionSource
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
        self.source = SessionSource(platform=Platform("wecom"), chat_id="chat", user_id="user", chat_type="dm", profile="managed")
        self.host = host_module.Host({"protocolVersion": 1, "accountRef": "account", "token": "x"*48,
            "endpoint": "http://127.0.0.1:1/rpc", "platform": "wecom"}, self.home)
        self.host.publish = lambda: None
        self.host.rpc = self.rpc
        self.host.platforms = [{"id": "wecom", "maxMessageLength": 3500}]
        self.config = GatewayConfig()
        self.config.sessions_dir = self.home / "sessions"
        self.config.integration_only = False
        self.runner = self.new_runner()

    def new_runner(self):
        runner = conversation.create_runner(self.host, self.config)
        runner._is_user_authorized_for_source = lambda source: self.allowed
        self.host.runner = runner
        from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
        PluginContext(PluginManifest(name="ccem-managed-bridge", source="bundled", kind="standalone"), get_plugin_manager()).register_command(
            "ccem", self.host.command, with_context=True)
        return runner

    def rpc(self, method, params):
        self.calls.append((method, params.copy()))
        if params.get("conversationScope", self.scope) != self.scope:
            raise ValueError("conversation_scope_changed")
        if method == "conversation":
            return {"scope": self.scope, "model": {"model": "claude-fixture", "baseUrl": f"http://127.0.0.1:{self.server.server_port}",
                "apiKey": "synthetic-only-model-secret", "apiMode": "anthropic_messages", "authStyle": "bearer"} if self.model_available else None,
                "bindings": [{"runtimeId": "native-fixture", "title": "Test task"}], "recentNotifications": [],
                "hasPendingCcemInput": getattr(self, "pending_ccem", False)}
        if method == "replyConversation":
            key = (params["sourceMessageId"], params.get("deliveryKey"))
            self.delivery_keys = getattr(self, "delivery_keys", set())
            if key not in self.delivery_keys:
                self.replies.append(params["text"])
                self.delivery_keys.add(key)
            return {"deliveryId": "fixture", "status": getattr(self, "delivery_status", "pending")}
        if method == "list":
            return {"sessions": [{"runtimeId": "native-fixture", "title": "Test task", "status": "ready"}]}
        if method == "validateConversation":
            return {"ok": True}
        if method == "input":
            return {"challenge": "c"*48, "runtimeId": params["runtimeId"], "text": params["text"], "expiresAt": 9999999999999}
        if method == "shortReply":
            return {"state": "submitted"}
        raise AssertionError("unexpected RPC " + method)

    async def send(self, text, message):
        from gateway.platforms.base import MessageEvent
        from hermes_cli.lifecycle import invoke_hook as original_hook
        event = MessageEvent(text=text, source=self.source, message_id=message)
        async def strict_send(runner, target, text):
            self.previews.append(text)
            return {"status": "sent"}
        def hook(name, **kwargs):
            if name == "pre_gateway_dispatch":
                return [self.host.pairing_hook(**kwargs)]
            return original_hook(name, **kwargs)
        with patch("hermes_cli.lifecycle.invoke_hook", side_effect=hook), patch("gateway.managed_contracts.send_strict", strict_send):
            output = io.StringIO()
            import logging
            handler = logging.StreamHandler(output)
            logging.getLogger().addHandler(handler)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                result = await self.runner._handle_message(event)
            logging.getLogger().removeHandler(handler)
            self.turn_log = output.getvalue()
        self.assertIsNone(result, "adapter must never auto-send or extract local media")

    async def asyncTearDown(self):
        self.hold_model.set()
        await self.runner.stop()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join()

    async def enable_native(self):
        await self.runner.stop()
        self.host.boot["toolsMode"] = "native"
        self.delivery_status = "sent"
        root_config = conversation.configuration("native")
        root_config["model"] = {"context_length": 65536}
        (self.home / "config.yaml").write_text(json.dumps(root_config))
        self.work = self.home / "native-work"
        self.work.mkdir()
        def prepare(home, mode):
            import yaml
            saved = yaml.safe_load((home / "config.yaml").read_text())
            saved["model"] = {"context_length": 65536}
            saved["terminal"] = {"backend": "local", "cwd": str(self.work), "home_mode": "isolated"}
            saved["approvals"] = {"mode": "manual", "timeout": 20}
            saved["security"]["tirith_enabled"] = False
            (home / "config.yaml").write_text(json.dumps(saved))
            skill = home / "skills" / "fixture-research"
            skill.mkdir(parents=True, exist_ok=True)
            (skill / "SKILL.md").write_text("---\nname: fixture-research\ndescription: Fixture research skill.\n---\nNative skill token sapphire.\n")
        self.host.prepare_conversation_home = prepare
        self.runner = self.new_runner()

    async def wait_for(self, condition):
        try:
            async with asyncio.timeout(15):
                while not condition():
                    await asyncio.sleep(0.01)
        except TimeoutError:
            self.fail("Expected native event did not arrive. Replies: " + repr(self.replies)
                + "\n" + getattr(self, "turn_log", "")[-10000:])

    async def wait_for_approval_ack(self):
        from tools import approval
        scoped = dataclasses.replace(self.source, profile="ccem-" + self.scope)
        key = self.runner._session_key_for_source(scoped)
        def acknowledged():
            with approval._lock:
                return any(entry.acknowledged for entry in approval._gateway_queues.get(key, []))
        await self.wait_for(acknowledged)

    async def test_native_mode_runs_its_own_research_terminal_files_and_skill(self):
        await self.enable_native()
        fixture = self.work / "fixture.txt"
        fixture.write_text("native file token emerald")
        research = f"import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:{self.server.server_port}/README.md').read().decode())"
        self.model_replies = [
            [{"type": "tool_use", "id": "terminal-native", "name": "terminal", "input": {"command": "printf native-terminal-token"}}],
            [{"type": "tool_use", "id": "read-native", "name": "read_file", "input": {"path": str(fixture)}}],
            [{"type": "tool_use", "id": "skill-native", "name": "skill_view", "input": {"name": "fixture-research"}}],
            [{"type": "tool_use", "id": "code-native", "name": "execute_code", "input": {"code": research}}],
            [{"type": "tool_use", "id": "write-native", "name": "write_file", "input": {"path": str(self.work / "result.txt"), "content": "research complete"}}],
            [{"type": "text", "text": "研究与本机验证完成。"}],
        ]
        running = asyncio.create_task(self.send("研究这个项目并读写测试文件，使用已有技能。", "full-native-tools"))
        try:
            await self.wait_for(lambda: any("execute_code" in text and "/approve" in text for text in self.replies))
            await self.wait_for_approval_ack()
            await asyncio.wait_for(self.send("/approve", "native-research-approval"), 5)
            await asyncio.wait_for(running, 30)
        finally:
            if not running.done():
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running
        self.assertEqual(self.replies[-1], "研究与本机验证完成。", self.turn_log)
        body = json.dumps(self.requests[-1][2], ensure_ascii=False)
        for token in ("native-terminal-token", "native file token emerald", "Native skill token sapphire", "Architecture: a native research agent"):
            self.assertIn(token, body, self.turn_log)
        self.assertEqual((self.work / "result.txt").read_text(), "research complete")
        tools = {tool["name"] for tool in self.requests[0][2]["tools"]}
        self.assertTrue({"terminal", "read_file", "write_file", "execute_code", "skill_view", "skill_manage", "clarify", "ccem_list"} <= tools, tools)
        self.assertNotIn("cronjob_manage", tools)
        self.assertNotIn("ccem_confirm", tools)
        self.assertFalse(any(method in ("input", "confirm") for method, _ in self.calls))
        self.assertNotIn("synthetic-only-model-secret", body)
        self.assertNotIn("You have no local terminal", body)

    async def test_native_configuration_and_long_answer_survive_followup(self):
        await self.enable_native()
        expected = "完整回答。" * 1600
        self.model_replies = [[{"type": "text", "text": expected}]]
        await self.send("详细回答", "native-long")
        self.assertEqual("".join(self.replies), expected, self.turn_log)
        deliveries = [p for m, p in self.calls if m == "replyConversation"]
        self.assertGreater(len(deliveries), 1)
        self.assertEqual(len({p["deliveryKey"] for p in deliveries}), len(deliveries))
        self.assertTrue(all(len(p["text"].encode()) <= 3500 for p in deliveries))
        home = self.home / "conversations" / self.scope
        saved = json.loads((home / "config.yaml").read_text())
        saved["display"]["personality"] = "concise"
        saved["agent"]["max_turns"] = 19
        (home / "config.yaml").write_text(json.dumps(saved))
        await self.send("继续", "native-config-kept")
        restored = json.loads((home / "config.yaml").read_text())
        self.assertEqual(restored["agent"]["max_turns"], 19)
        self.assertEqual(restored["display"]["personality"], "concise")
        self.assertGreater(self.requests[0][2]["max_tokens"], 2048)

    async def test_native_clarify_reply_unblocks_agent_without_a_ccem_proposal(self):
        await self.enable_native()
        self.model_replies = [[{"type": "tool_use", "id": "clarify-native", "name": "clarify",
            "input": {"questions": [{"question": "选择哪种测试颜色？", "choices": ["翡翠", "蓝宝石"]}]}}],
            [{"type": "text", "text": "已采用蓝宝石。"}]]
        running = asyncio.create_task(self.send("请让我选择测试颜色", "native-clarify-start"))
        try:
            await self.wait_for(lambda: any("选择哪种测试颜色" in text for text in self.replies))
            await asyncio.wait_for(self.send("2", "native-clarify-answer"), 5)
            await asyncio.wait_for(running, 15)
        finally:
            if not running.done():
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running
        self.assertIn("已采用蓝宝石。", self.replies, self.turn_log)
        self.assertIn("蓝宝石", json.dumps(self.requests[-1][2], ensure_ascii=False))
        self.assertFalse(any(method in ("input", "confirm") for method, _ in self.calls))

    async def test_native_terminal_approval_uses_actual_user_reply(self):
        await self.enable_native()
        for reply in ("/deny", "/approve"):
            marker = self.work / ("delete-" + reply[1:])
            marker.write_text("fixture only")
            command = "rm -rf " + shlex.quote(str(marker))
            self.model_replies = [[{"type": "tool_use", "id": "terminal-approval-" + reply[1:], "name": "terminal", "input": {"command": command}}],
                [{"type": "text", "text": "本轮已结束。"}]]
            before = len(self.replies)
            running = asyncio.create_task(self.send("执行已指定的测试命令", "native-approval-" + reply[1:]))
            try:
                await self.wait_for(lambda: any("/approve" in text and command in text for text in self.replies[before:]))
                await self.wait_for_approval_ack()
                self.assertTrue(marker.exists(), "native guard must block until a real user reply")
                self.assertFalse(any("/approve always" in text for text in self.replies[before:]))
                from tools.approval import _permanent_approved
                previous_allowlist = set(_permanent_approved)
                await asyncio.wait_for(self.send("/approve always", "native-disallowed-always-" + reply[1:]), 5)
                self.assertTrue(marker.exists(), "always must not authorize this or other route scopes")
                self.assertEqual(_permanent_approved, previous_allowlist)
                await asyncio.wait_for(self.send(reply, "native-control-" + reply[1:]), 5)
                await asyncio.wait_for(running, 15)
            finally:
                if not running.done():
                    from tools.approval import resolve_gateway_approval
                    scoped = dataclasses.replace(self.source, profile="ccem-" + self.scope)
                    resolve_gateway_approval(self.runner._session_key_for_source(scoped), "deny")
                    running.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await running
            self.assertEqual(marker.exists(), reply == "/deny", self.turn_log)
        self.assertFalse(any(method in ("input", "confirm") for method, _ in self.calls))

    async def test_native_session_approval_does_not_cross_route_generation(self):
        await self.enable_native()
        self.scope = "c" * 64
        for number, reply in enumerate(("/approve session", "/deny")):
            marker = self.work / ("scoped-approval-" + str(number))
            marker.write_text("fixture only")
            command = "rm -rf " + shlex.quote(str(marker))
            self.model_replies = [[{"type": "tool_use", "id": "terminal-scoped-" + str(number), "name": "terminal", "input": {"command": command}}],
                [{"type": "text", "text": "本轮已结束。"}]]
            before = len(self.replies)
            running = asyncio.create_task(self.send("执行这个测试命令", "scope-approval-" + str(number)))
            try:
                await self.wait_for(lambda: any(command in text and "/approve" in text for text in self.replies[before:]))
                await self.wait_for_approval_ack()
                self.assertTrue(marker.exists())
                await asyncio.wait_for(self.send(reply, "scope-control-" + str(number)), 5)
                await asyncio.wait_for(running, 15)
            finally:
                if not running.done():
                    running.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await running
            self.assertEqual(marker.exists(), number == 1)
            self.scope = "d" * 64

    async def test_native_scoped_adapter_drops_revoked_prompt_and_final(self):
        await self.enable_native()
        original = self.rpc
        def changing(method, params):
            if method == "replyConversation":
                self.scope = "b" * 64
            return original(method, params)
        self.host.rpc = changing
        self.model_replies = [[{"type": "tool_use", "id": "clarify-revoked", "name": "clarify",
            "input": {"questions": [{"question": "这个过期问题不得发送"}]}}],
            [{"type": "text", "text": "这个过期回答不得发送"}]]
        await asyncio.wait_for(self.send("测试撤销", "native-revoke-prompt"), 15)
        self.assertGreaterEqual(len(self.requests), 2, self.turn_log)
        self.assertEqual(self.replies, [], self.turn_log)
        self.assertEqual(self.previews, [])

    async def test_native_pending_preview_cannot_be_approved_by_an_early_or_replayed_reply(self):
        await self.enable_native()
        self.delivery_status = "pending"
        marker = self.work / "ack-marker"
        marker.write_text("fixture only")
        command = "rm -rf " + shlex.quote(str(marker))
        self.model_replies = [[{"type": "tool_use", "id": "terminal-wait-ack", "name": "terminal", "input": {"command": command}}],
            [{"type": "text", "text": "本轮已结束。"}]]
        running = asyncio.create_task(self.send("执行测试命令", "native-wait-ack"))
        try:
            await self.wait_for(lambda: any(command in text for text in self.replies))
            await asyncio.wait_for(self.send("/approve", "early-native-approval"), 5)
            self.assertTrue(marker.exists())
            self.assertTrue(any("尚未确认送达" in text for text in self.replies))
            self.delivery_status = "sending"
            attempts = sum(m == "replyConversation" and p["sourceMessageId"] == "native-wait-ack" for m, p in self.calls)
            await self.wait_for(lambda: sum(m == "replyConversation" and p["sourceMessageId"] == "native-wait-ack" for m, p in self.calls) > attempts)
            self.assertTrue(marker.exists(), "sending is an intermediate state, not an ACK")
            self.delivery_status = "sent"
            await self.wait_for_approval_ack()
            await asyncio.wait_for(self.send("/approve", "early-native-approval"), 5)
            self.assertTrue(marker.exists(), "duplicate original ingress retains its pre-ACK time")
            await asyncio.wait_for(self.send("/approve", "fresh-native-approval"), 5)
            await asyncio.wait_for(running, 15)
        finally:
            if not running.done():
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running
        self.assertFalse(marker.exists(), self.turn_log)
        prompt_attempts = [p for m, p in self.calls if m == "replyConversation" and p["sourceMessageId"] == "native-wait-ack" and command in p["text"]]
        self.assertGreater(len(prompt_attempts), 1)
        self.assertEqual(len({p["deliveryKey"] for p in prompt_attempts}), 1)

    async def test_native_unknown_preview_fails_closed_without_running_command(self):
        await self.enable_native()
        self.delivery_status = "unknown"
        marker = self.work / "unknown-marker"
        marker.write_text("fixture only")
        command = "rm -rf " + shlex.quote(str(marker))
        self.model_replies = [[{"type": "tool_use", "id": "terminal-unknown", "name": "terminal", "input": {"command": command}}],
            [{"type": "text", "text": "命令没有执行。"}]]
        await asyncio.wait_for(self.send("执行测试命令", "native-unknown-ack"), 15)
        await asyncio.wait_for(self.send("/approve", "native-after-unknown"), 5)
        self.assertTrue(marker.exists(), self.turn_log)
        self.assertGreaterEqual(len(self.requests), 2)
        self.assertIn("BLOCKED", json.dumps(self.requests[-1][2]))
        attempts = [p for m, p in self.calls if m == "replyConversation" and command in p["text"]]
        self.assertEqual(len({p["deliveryKey"] for p in attempts}), 1)

    async def test_native_delegate_inherits_memory_only_credentials_and_returns_in_turn(self):
        await self.enable_native()
        self.model_replies = [
            [{"type": "tool_use", "id": "delegate-native", "name": "delegate_task", "input": {"tasks": [{"goal": "只回复 child-sapphire"}]}}],
            [{"type": "text", "text": "child-sapphire"}],
            [{"type": "text", "text": "子任务已完成。"}],
        ]
        await asyncio.wait_for(self.send("分配一个测试子任务并总结结果", "native-delegate"), 30)
        self.assertEqual(self.replies[-1], "子任务已完成。", self.turn_log)
        self.assertEqual(len(self.requests), 3, self.turn_log)
        self.assertIn("child-sapphire", json.dumps(self.requests[-1][2]))
        for path, headers, body in self.requests:
            self.assertTrue(path.endswith("/messages"), path)
            normalized = {k.lower(): v for k, v in headers.items()}
            self.assertEqual(normalized.get("authorization"), "Bearer synthetic-only-model-secret")
            self.assertNotIn("x-api-key", normalized)
            self.assertNotIn("synthetic-only-model-secret", json.dumps(body))
        for file in (self.home / "conversations").rglob("config.yaml"):
            self.assertNotIn("synthetic-only-model-secret", file.read_text())

    async def test_native_chinese_clarify_and_ccem_confirmation_remain_distinct(self):
        await self.enable_native()
        self.model_replies = [[{"type": "tool_use", "id": "clarify-chinese", "name": "clarify",
            "input": {"questions": [{"question": "是否采用这个测试名称？请回复确认或取消。"}]}}],
            [{"type": "text", "text": "收到你的确认。"}]]
        running = asyncio.create_task(self.send("请我确认测试名称", "native-chinese-question"))
        try:
            await self.wait_for(lambda: any("是否采用这个测试名称" in text for text in self.replies))
            self.pending_ccem = True
            await asyncio.wait_for(self.send("确认", "native-chinese-ambiguous"), 5)
            self.assertTrue(any("当前同时有" in text for text in self.replies))
            self.assertFalse(any(m == "shortReply" for m, _ in self.calls))
            self.assertFalse(running.done())
            await asyncio.wait_for(self.send("/ccem shortReply confirm", "explicit-ccem-short"), 5)
            self.assertEqual(sum(m == "shortReply" for m, _ in self.calls), 1)
            self.assertFalse(running.done())
            self.pending_ccem = False
            await asyncio.wait_for(self.send("确认", "native-chinese-answer"), 5)
            await asyncio.wait_for(running, 15)
            self.assertEqual(sum(m == "shortReply" for m, _ in self.calls), 1)
            self.assertIn("收到你的确认。", self.replies)
            await asyncio.wait_for(self.send("确认", "ccem-only-short"), 5)
            self.assertEqual(sum(m == "shortReply" for m, _ in self.calls), 2)
        finally:
            if not running.done():
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running

    async def test_native_chat_replies_without_preparing_a_ccem_task(self):
        await self.send("你好", "native-hello")
        self.assertEqual(self.replies, ["你好，我是 Hermes。"], self.turn_log)
        self.assertEqual([m for m,p in self.calls], ["conversation", "validateConversation", "replyConversation"])
        self.assertEqual(len(self.requests), 1)
        headers = {key.lower(): value for key, value in self.requests[0][1].items()}
        self.assertEqual(headers.get("authorization"), "Bearer synthetic-only-model-secret")
        self.assertNotIn("x-api-key", headers)
        body = self.requests[0][2]
        tools = {t["name"] for t in body["tools"]}
        self.assertTrue({"ccem_list", "ccem_prepare", "memory", "skill_view"} <= tools, tools)
        self.assertFalse({"terminal", "write_file", "execute_code", "delegate_task", "send_message", "ccem_confirm"} & tools)
        self.assertNotIn("synthetic-only-model-secret", json.dumps(body))

    async def test_first_contact_keeps_ccem_identity_without_native_setup_prompts(self):
        await self.send("你好", "native-first-contact")
        body = json.dumps(self.requests[0][2], ensure_ascii=False)
        self.assertIn("running inside CCEM Desktop", body)
        self.assertIn("Keep your Hermes identity", body)
        self.assertNotIn("mention that /help shows available commands", body)
        self.assertNotIn("/sethome", body)
        self.assertNotIn("profile-build", body)
        self.assertEqual(self.previews, [])

    async def test_help_describes_only_the_managed_conversation_capabilities(self):
        await self.send("/help", "native-help")
        self.assertEqual(len(self.replies), 1)
        self.assertIn("CCEM 里的 Hermes", self.replies[0])
        self.assertIn("确认", self.replies[0])
        self.assertIn("/new", self.replies[0])
        for unsupported in ("/approve", "/rollback", "/bg", "/goal", "/sethome", "/stop"):
            self.assertNotIn(unsupported, self.replies[0])
        self.assertEqual(self.requests, [], "help should not consume a model call")
        self.assertEqual(self.previews, [], "help stays in the scoped reply outbox")

    async def test_missing_model_and_unauthorized_sender_do_not_invoke_model(self):
        self.model_available = False
        await self.send("你好", "native-no-model")
        self.assertIn("选择一个对话模型", self.replies[-1])
        self.assertEqual(self.requests, [])
        self.allowed = False
        count = len(self.calls)
        await self.send("你好", "native-unpaired")
        self.assertEqual(len(self.calls), count)

    async def test_native_agent_selects_ccem_tool_but_cannot_execute_confirmation(self):
        self.model_replies = [[{"type": "tool_use", "id": "call_prepare", "name": "ccem_prepare",
            "input": {"runtimeId": "native-fixture", "text": "只回复收到"}}], [{"type": "text", "text": "确认后我会继续这个任务。"}]]
        await self.send("让当前任务只回复收到", "native-prepare")
        self.assertEqual(self.previews, [], "only Rust's scoped outbox may send previews")
        self.assertEqual([m for m,p in self.calls if m in ("input", "confirm")], ["input"])
        call = next(p for m,p in self.calls if m == "input")
        self.assertEqual(call["sourceMessageId"], "native-prepare")
        self.assertEqual(call["source"]["profile"], "managed")
        self.assertEqual(call["conversationScope"], "a"*64)
        self.assertNotIn("c"*48, json.dumps(self.requests[-1][2]))

    async def test_history_survives_gateway_restart_and_isolated_from_new_scope(self):
        await self.send("请记住本轮暗号是晨星。", "native-first")
        await self.runner.stop()
        self.runner = self.new_runner()
        self.model_replies = [[{"type": "text", "text": "晨星。"}]]
        await self.send("刚才的暗号是什么？", "native-second")
        self.assertIn("本轮暗号是晨星", json.dumps(self.requests[-1][2], ensure_ascii=False))
        self.scope = "b" * 64
        await self.send("你好，新对话。", "native-rebound")
        self.assertNotIn("晨星", json.dumps(self.requests[-1][2], ensure_ascii=False))

    async def test_native_memory_is_scoped_and_persists_between_turns(self):
        self.model_replies = [[{"type": "tool_use", "id": "call_memory", "name": "memory",
            "input": {"action": "add", "target": "user", "content": "User prefers short Chinese replies. Fixture emerald."}}],
            [{"type": "text", "text": "记住了。"}]]
        await self.send("请记住我喜欢简短中文回复。", "native-memory")
        await self.runner.stop()
        self.runner = self.new_runner()
        await self.send("继续聊。", "native-after-memory")
        self.assertIn("Fixture emerald", json.dumps(self.requests[-1][2]), self.turn_log)
        self.scope = "b" * 64
        await self.send("你好", "native-new-person")
        self.assertNotIn("Fixture emerald", json.dumps(self.requests[-1][2]))

    async def test_revocation_during_model_turn_drops_reply(self):
        original = self.rpc
        def changing(method, params):
            if method == "replyConversation":
                self.scope = "b" * 64
            return original(method, params)
        self.host.rpc = changing
        await self.send("你好", "native-revoked")
        self.assertEqual(self.replies, [])
        self.assertEqual(self.previews, [])

    async def test_real_wecom_ingress_preserves_short_confirmation_while_agent_is_busy(self):
        from gateway.config import Platform, PlatformConfig
        from plugins.platforms.wecom.adapter import WeComAdapter
        from hermes_cli.lifecycle import invoke_hook as original_hook
        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter.gateway_runner = self.runner
        adapter.set_message_handler(self.runner._handle_message)
        adapter._is_dm_intake_allowed = lambda sender: True
        self.runner._primary_profile_name = "managed"
        self.runner.adapters[Platform("wecom")] = adapter
        direct = []
        async def send(*args, **kwargs):
            direct.append((args, kwargs))
            raise AssertionError("native adapter bypassed scoped outbox")
        adapter.send = send
        async def incoming(text, message_id):
            await adapter._on_message({"headers": {"req_id": "request-" + message_id}, "body": {
                "msgtype": "text", "text": {"content": text}, "msgid": message_id,
                "from": {"userid": "user"}, "chatid": "chat", "chattype": "single"}})
        def hook(name, **kwargs):
            return [self.host.pairing_hook(**kwargs)] if name == "pre_gateway_dispatch" else original_hook(name, **kwargs)
        self.hold_model.clear()
        with patch("hermes_cli.lifecycle.invoke_hook", side_effect=hook):
            await incoming("你好", "wecom-first")
            async with asyncio.timeout(5):
                while not self.model_entered.is_set():
                    await asyncio.sleep(0.01)
            await incoming("确认", "wecom-confirm")
            await incoming("另外查一下进度", "wecom-followup")
            async with asyncio.timeout(5):
                while not any(m == "shortReply" for m, p in self.calls):
                    await asyncio.sleep(0.01)
            confirm = next(p for m, p in self.calls if m == "shortReply")
            self.assertEqual(confirm["sourceMessageId"], "wecom-confirm")
            self.assertEqual(confirm["text"], "confirm")
            self.hold_model.set()
            async with asyncio.timeout(10):
                while adapter._background_tasks:
                    await asyncio.gather(*list(adapter._background_tasks))
        self.assertEqual(direct, [])
        self.assertEqual(len(self.requests), 2)
        self.assertIn("另外查一下进度", json.dumps(self.requests[-1][2], ensure_ascii=False))
        self.assertEqual({p["sourceMessageId"] for m, p in self.calls if m == "replyConversation"},
            {"wecom-first", "wecom-confirm", "wecom-followup"})

    async def test_queued_and_reordered_wecom_confirmations_keep_first_arrival(self):
        from gateway.config import Platform, PlatformConfig
        from plugins.platforms.wecom.adapter import WeComAdapter
        from hermes_cli.lifecycle import invoke_hook as original_hook
        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter.gateway_runner = self.runner
        adapter._is_dm_intake_allowed = lambda sender: True
        self.runner._primary_profile_name = "managed"
        self.runner.adapters[Platform("wecom")] = adapter
        contexts, arrivals = [], []
        admit = self.runner._hm_admit_event
        async def record_admission(event):
            result = await admit(event)
            if result is not None:
                contexts.append(result[0]._hermes_trusted_command_context)
            return result
        async def handle(event):
            arrivals.append(event._hermes_received_at_ns)
            return await self.runner._handle_message(event)
        adapter.set_message_handler(handle)
        async def incoming(message_id):
            await adapter._on_message({"headers": {"req_id": "request-" + message_id}, "body": {
                "msgtype": "text", "text": {"content": "确认"}, "msgid": message_id,
                "from": {"userid": "user"}, "chatid": "chat", "chattype": "single"}})
        # A real adapter drops duplicates normally; exercise gateway identity
        # across distinct redelivered events as after transport dedup eviction.
        adapter._dedup.is_duplicate = lambda message_id: False
        def hook(name, **kwargs):
            if name != "pre_gateway_dispatch":
                return original_hook(name, **kwargs)
            kwargs["event"]._hermes_received_at_ns = time.monotonic_ns() + 10**15
            return [self.host.pairing_hook(**kwargs)]
        slots = self.host.command_slots
        for _ in range(4):
            await slots.acquire()
        first_waiting, duplicate_waiting, resume_first = asyncio.Event(), asyncio.Event(), asyncio.Event()
        acquire = slots.acquire
        attempts = 0
        async def delayed_acquire():
            nonlocal attempts
            index, attempts = attempts, attempts + 1
            (first_waiting if index == 0 else duplicate_waiting).set()
            result = await acquire()
            if index == 0:
                await resume_first.wait()  # let the later duplicate reach RPC first
            return result
        async def acknowledged(*args, **kwargs):
            return {"status": "sent", "receipt_id": "fixture-preview-ack"}
        self.host.state = "running"
        released = False
        try:
            with patch.object(slots, "acquire", new=delayed_acquire), \
                    patch("hermes_cli.lifecycle.invoke_hook", side_effect=hook), \
                    patch("gateway.managed_contracts.send_strict", new=acknowledged), \
                    patch.object(self.runner, "_hm_admit_event", new=record_admission):
                await incoming("before-preview")
                await asyncio.wait_for(first_waiting.wait(), 5)
                self.assertFalse(any(method == "shortReply" for method, _ in self.calls))
                receipt = await self.host.request("sendStrict", {"target": {
                    "profile": "managed", "platform": "wecom", "chat_id": "chat"}, "text": "准备执行"})
                acknowledged_at = receipt["confirmedAtNs"]
                await incoming("before-preview")
                await asyncio.wait_for(duplicate_waiting.wait(), 5)
                for _ in range(4):
                    slots.release()
                released = True
                async with asyncio.timeout(5):
                    while not any(method == "shortReply" for method, _ in self.calls):
                        await asyncio.sleep(0.01)
                first_rpc = next(params for method, params in self.calls if method == "shortReply")
                self.assertEqual(first_rpc["receivedAtNs"], arrivals[0])
                self.assertLess(first_rpc["receivedAtNs"], acknowledged_at)
                self.assertEqual(arrivals[0], arrivals[1])
                context = contexts[0]
                self.assertEqual(context.received_at_ns, arrivals[0])
                with self.assertRaises(dataclasses.FrozenInstanceError):
                    context.received_at_ns = acknowledged_at + 1
                await incoming("after-preview")
                async with asyncio.timeout(5):
                    while not any(method == "shortReply" and params["sourceMessageId"] == "after-preview" for method, params in self.calls):
                        await asyncio.sleep(0.01)
                new_rpc = next(params for method, params in self.calls if method == "shortReply" and params["sourceMessageId"] == "after-preview")
                self.assertGreater(new_rpc["receivedAtNs"], acknowledged_at)
                resume_first.set()
                async with asyncio.timeout(5):
                    while adapter._background_tasks:
                        await asyncio.gather(*list(adapter._background_tasks))
        finally:
            resume_first.set()
            if not released:
                for _ in range(4):
                    slots.release()
        same_id = [params["receivedAtNs"] for method, params in self.calls
            if method == "shortReply" and params["sourceMessageId"] == "before-preview"]
        self.assertEqual(same_id, [arrivals[0], arrivals[0]])
        self.assertEqual(self.requests, [], "confirmation timing is never sent to the model")

    async def test_ingress_clock_keeps_pending_ids_and_fails_closed_at_capacity(self):
        from gateway import managed_contracts as contracts
        from gateway.platforms.base import MessageEvent
        owner = types.SimpleNamespace(_primary_profile_name="managed")
        def event(message_id):
            return MessageEvent(text="确认", source=self.source, message_id=message_id)
        with patch.object(contracts, "_INGRESS_CLOCK_CAPACITY", 1), \
                patch.object(contracts, "_INGRESS_CLOCK_RETENTION_NS", 10), \
                patch.object(contracts.time, "monotonic_ns", side_effect=[100, 200, 201, 202, 203, 300, 301]):
            first = event("pending")
            key = contracts.stamp_managed_ingress(owner, first, pending=True)
            replay = event("pending")
            second_key = contracts.stamp_managed_ingress(owner, replay, pending=True)
            self.assertEqual(replay._hermes_received_at_ns, 100)
            unknown = event("overflow")
            contracts.stamp_managed_ingress(owner, unknown, pending=True)
            self.assertIsNone(unknown._hermes_received_at_ns)
            contracts.release_managed_ingress(owner, key)
            contracts.release_managed_ingress(owner, second_key)
            contracts.stamp_managed_ingress(owner, first, pending=True)
            self.assertEqual(first._hermes_received_at_ns, 100)
            retry = event("overflow")
            contracts.stamp_managed_ingress(owner, retry, pending=True)
            self.assertIsNone(retry._hermes_received_at_ns)
        legacy = contracts.TrustedCommandContext("wecom", "managed", "managed", "user", "chat", None, "id", "dm")
        self.assertIsNone(legacy.received_at_ns)

    async def test_unjournaled_short_controls_keep_clock_after_rpc_failure(self):
        from gateway import managed_contracts as contracts
        from gateway.platforms.base import MessageEvent
        for failure_method in ("conversation", "shortReply"):
            message_id = "failed-" + failure_method
            first = MessageEvent(text="确认", source=self.source, message_id=message_id)
            with patch.object(contracts, "_INGRESS_CLOCK_RETENTION_NS", 10), \
                    patch.object(contracts.time, "monotonic_ns", return_value=100):
                key = contracts.stamp_managed_ingress(self.runner, first, pending=True)
                context = contracts.TrustedCommandContext("wecom", "managed", "managed", "user", "chat", None, message_id, "dm", 100)
                def failed_rpc(method, params):
                    if method == failure_method:
                        raise host_module.urllib.error.URLError("fixture transport failure")
                    return self.rpc(method, params)
                with patch.object(self.host, "rpc", side_effect=failed_rpc):
                    await self.host.command("shortReply confirm", context)
                contracts.release_managed_ingress(self.runner, key)
            # The handler returned without a durable journal result. A fresh
            # event for this native ID keeps its first time beyond normal TTL.
            retry = MessageEvent(text="确认", source=self.source, message_id=message_id)
            with patch.object(contracts.time, "monotonic_ns", return_value=1000):
                contracts.stamp_managed_ingress(self.runner, retry)
            self.assertEqual(retry._hermes_received_at_ns, 100, failure_method)

    async def test_only_successful_strict_receipts_gain_ack_time(self):
        self.host.state = "running"
        params = {"target": {"profile": "managed", "platform": "wecom", "chat_id": "chat"}, "text": "准备执行"}
        for status in ("unknown", "not_sent"):
            async def receipt(*args, **kwargs):
                return {"status": status}
            with patch("gateway.managed_contracts.send_strict", new=receipt):
                self.assertNotIn("confirmedAtNs", await self.host.request("sendStrict", params))


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *remaining])
