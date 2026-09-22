#!/usr/bin/env python3
"""Private JSONL host for a pinned Hermes runtime. No model configuration is required.

Run only from a verified runtime bundle. Credentials arrive once on stdin. The host
uses Hermes's registry, authentication and live adapters; it has no platform SDKs
or delivery fallback of its own.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

# -I deliberately omits the script directory from sys.path. Load only this
# verified bundle's companion module, never a project/user module of that name.
_setup_spec = importlib.util.spec_from_file_location("ccem_gateway_onboarding", Path(__file__).with_name("ccem_gateway_onboarding.py"))
_setup_module = importlib.util.module_from_spec(_setup_spec)
_setup_spec.loader.exec_module(_setup_module)

PROTOCOL = 1
FRAME_LIMIT = 64 * 1024
_wire = sys.stdout
_wire_lock = threading.Lock()


def emit(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(data.encode("utf-8")) >= FRAME_LIMIT:
        raise ValueError("response_too_large")
    with _wire_lock:
        _wire.write(data + "\n")
        _wire.flush()


def read_frame():
    raw = sys.stdin.buffer.readline(FRAME_LIMIT + 1)
    if not raw:
        return None
    if len(raw) > FRAME_LIMIT or not raw.endswith(b"\n"):
        raise ValueError("invalid_frame")
    value = json.loads(raw.decode("utf-8", errors="strict"))
    if not isinstance(value, dict):
        raise ValueError("invalid_frame")
    return value


def validate_endpoint(endpoint):
    url = urllib.parse.urlsplit(endpoint)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path != "/rpc" or url.username or url.password or url.query or url.fragment:
        raise ValueError("invalid_bridge_endpoint")


def source_value(context, account_ref):
    if not all(isinstance(value, str) and value for value in (context.platform, context.profile, context.transport_profile, context.user_id, context.chat_id, context.chat_type)):
        raise ValueError("incomplete_authenticated_source")
    return {
        "accountRef": account_ref,
        "platform": str(context.platform), "profile": str(context.profile),
        "transportProfile": str(context.transport_profile), "userId": str(context.user_id),
        "chatId": str(context.chat_id), "threadId": context.thread_id,
        "chatType": str(context.chat_type),
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("bridge_redirect_rejected")


class Host:
    def __init__(self, boot, profile):
        if boot.get("protocolVersion") != PROTOCOL:
            raise ValueError("protocol_mismatch")
        validate_endpoint(boot.get("endpoint", ""))
        token = boot.get("token", "")
        if not isinstance(token, str) or len(token) < 32 or len(token) > 256:
            raise ValueError("invalid_bridge_capability")
        self.boot, self.profile = boot, profile
        self.runner = None
        self.state = "configuring"
        self.error = None
        self.platforms = []
        self.pending = {}
        self.pairing = None
        self.lock = threading.RLock()
        self.stopped = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.command_slots = asyncio.Semaphore(4)
        self.setup = _setup_module.WeComSetup()

    def snapshot(self):
        with self.lock:
            current = int(time.time() * 1000)
            self.pending = {k: v for k, v in self.pending.items() if v["expiresAt"] > current}
            if self.pairing and self.pairing["expiresAt"] <= current:
                self.pairing = None
            state = self.state
            if state == "running" and self.runner:
                connected = any(getattr(adapter, "is_connected", False) is True for adapter in self.runner.adapters.values())
                state = "running" if connected else "reconnecting"
            return {"state": state, "error": self.error, "platforms": self.platforms,
                    "pending": [{k: v for k, v in p.items() if k not in ("nativeCode", "nativeSource")} for p in self.pending.values()],
                    "pairing": self.pairing}

    def publish(self):
        emit({"event": "status", "payload": self.snapshot()})

    async def initialize(self):
        # Only this private profile is visible to the child; no project plugins,
        # shared dotenv, model keys or automatic skills are imported from user paths.
        self.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        config = {"gateway": {"integration_only": True, "unauthorized_dm_behavior": "ignore", "stt_enabled": False,
                              "multiplex_profiles": False, "loop_watchdog": False},
                  "plugins": {"enabled": [], "entries": {}}, "mcp_servers": {}}
        (self.profile / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        from hermes_cli.plugins import discover_plugins, get_plugin_manager, PluginContext, PluginManifest
        from gateway.platform_registry import platform_registry
        from gateway.managed_contracts import strict_send_supported
        discover_plugins()
        for entry in platform_registry.all_entries():
            if not strict_send_supported(entry.name):
                continue
            fields = []
            for required in entry.required_env:
                key = required if isinstance(required, str) else required.get("name", "")
                if not key or not key.replace("_", "").isalnum() or not key.isupper():
                    continue
                fields.append({"key": key, "label": key.replace("_", " "),
                               "secret": any(word in key for word in ("SECRET", "TOKEN", "PASSWORD", "KEY")), "required": True})
            try:
                available = bool(entry.check_fn())
            except Exception:
                available = False
            qr_available = available and entry.name == "wecom"
            if qr_available:
                try:
                    _setup_module.tls_context()
                except _setup_module.SetupError:
                    qr_available = False
            self.platforms.append({"id": entry.name, "label": entry.label, "available": available,
                                   "strictSend": True, "fields": fields, "qrSetup": qr_available})
        self.platforms.sort(key=lambda p: p["id"])
        self.state = "configured" if self.boot.get("platform") else "unconfigured"
        self.publish()
        if not self.boot.get("connect"):
            return
        platform = self.boot.get("platform")
        meta = next((p for p in self.platforms if p["id"] == platform and p["available"]), None)
        if not meta:
            raise ValueError("platform_not_available")
        fields = self.boot.get("fields", {})
        allowed = {f["key"] for f in meta["fields"]}
        if set(fields) - allowed:
            raise ValueError("unknown_channel_field")
        for key in allowed:
            value = fields.get(key)
            if not isinstance(value, str) or not value or len(value) > 4096 or "\0" in value:
                raise ValueError("required_channel_field_missing")
            os.environ[key] = value
        # The capability is never copied into environment, profile config or adapter metadata.
        from gateway.config import load_gateway_config
        from gateway.run import GatewayRunner
        gateway_config = load_gateway_config()
        gateway_config.integration_only = True
        gateway_config.unauthorized_dm_behavior = "ignore"
        gateway_config.stt_enabled = False
        gateway_config.multiplex_profiles = False
        gateway_config.loop_watchdog = False
        for key, channel in gateway_config.platforms.items():
            channel.enabled = str(key.value) == platform
        self.runner = GatewayRunner(gateway_config)
        context = PluginContext(PluginManifest(name="ccem-managed-bridge", source="bundled", kind="standalone"), get_plugin_manager())
        context.register_command("ccem", self.command, description="CCEM task commands", with_context=True)
        context.register_hook("pre_gateway_dispatch", self.pairing_hook)
        self.state = "starting"
        self.publish()
        await self.runner.start()
        adapters = getattr(self.runner, "adapters", {})
        if not any(str(getattr(k, "value", k)) == platform and getattr(adapter, "is_connected", False) is True for k, adapter in adapters.items()):
            raise ValueError("channel_connection_failed")
        self.state = "running"
        self.publish()

    def pairing_hook(self, *args, **kwargs):
        event = kwargs.get("event")
        if not event or getattr(event, "internal", True) or not getattr(event, "allow_gateway_control", False):
            return None
        if not event.is_command() or event.get_command() != "ccem":
            return None
        pieces = event.get_command_args().split()
        if not pieces or pieces[0] != "connect":
            return None
        source = event.source
        # Pairing is an observation only. It cannot read a task or authorize input.
        from gateway.managed_contracts import native_source_message_id
        if not source or not source.user_id or not source.chat_id or source.chat_type != "dm" or not native_source_message_id(event):
            return {"action": "skip", "reason": "invalid_pairing_source"}
        with self.lock:
            self.snapshot()
            if len(pieces) != 2 or not self.pairing or not secrets.compare_digest(pieces[1], self.pairing["code"]):
                return {"action": "skip", "reason": "pairing_window_not_open"}
            platform = str(source.platform.value)
            if platform != self.boot.get("platform"):
                return {"action": "skip", "reason": "pairing_platform_mismatch"}
            native_source = dataclasses.replace(source)
            store = self.runner._pairing_store_for(native_source)
            code = store.generate_code(platform, source.user_id, source.user_name or "") if store else None
            if not code:
                return {"action": "skip", "reason": "pairing_rate_limited"}
            from hermes_cli.profiles import get_active_profile_name
            profile = source.profile or get_active_profile_name()
            target_profile = getattr(self.runner, "_primary_profile_name", None) or get_active_profile_name()
            identity = {"accountRef": self.boot["accountRef"], "platform": platform, "profile": profile, "transportProfile": target_profile,
                        "userId": source.user_id, "chatId": source.chat_id,
                        "threadId": source.thread_id, "chatType": source.chat_type}
            identifier = secrets.token_hex(24)
            self.pending[identifier] = {"id": identifier, "source": identity, "expiresAt": int(time.time()*1000)+120_000,
                                        "nativeCode": code, "nativeSource": native_source}
            self.pairing = None  # one native sender per desktop pairing window
            self.publish()
        return {"action": "skip", "reason": "awaiting_desktop_approval"}

    def rpc(self, method, params):
        # Disable proxy inheritance and redirects; the bearer is valid for this exact loopback endpoint only.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        body = json.dumps({"id": secrets.token_hex(16), "method": "ccem.bridge."+method, "params": params}).encode()
        if len(body) > FRAME_LIMIT:
            raise ValueError("request_too_large")
        request = urllib.request.Request(self.boot["endpoint"], body, {"Content-Type": "application/json", "Authorization": "Bearer "+self.boot["token"]}, method="POST")
        with opener.open(request, timeout=8) as response:
            raw = response.read(FRAME_LIMIT+1)
        if len(raw) > FRAME_LIMIT:
            raise ValueError("response_too_large")
        value = json.loads(raw)
        if "error" in value:
            message = value["error"].get("message", "bridge_error")
            raise ValueError(message[:160])
        return value.get("result")

    async def command(self, raw_args, context):
        from gateway.managed_contracts import send_strict, StrictTarget
        target = StrictTarget(profile=context.transport_profile, platform=context.platform,
                              chat_id=context.chat_id, thread_id=context.thread_id)
        async with self.command_slots:
            try:
                args = raw_args.strip().split(maxsplit=2)
                method = args[0] if args else "help"
                params = {"source": source_value(context, self.boot["accountRef"]), "sourceMessageId": context.source_message_id}
                if method in ("list",):
                    pass
                elif method in ("status", "events", "input") and len(args) >= 2:
                    params["runtimeId"] = args[1]
                    if method == "input":
                        if len(args) != 3:
                            raise ValueError("input_text_required")
                        if len(args[2].encode("utf-8")) > 2000:
                            await send_strict(self.runner, target, "继续任务的指令太长，请缩短到 2000 UTF-8 字节以内后重试。")
                            return None
                        params["text"] = args[2]
                    elif method == "events" and len(args) == 3:
                        params["cursor"] = int(args[2])
                elif method in ("confirm", "cancel") and len(args) == 2:
                    params["challenge"] = args[1]
                elif method == "operation" and len(args) == 2:
                    params["operationId"] = args[1]
                else:
                    await send_strict(self.runner, target, "/ccem list\n/ccem status <runtime>\n/ccem events <runtime> [cursor]\n/ccem input <runtime> <text>\n/ccem confirm <challenge>\n/ccem cancel <challenge>\n/ccem operation <operation>")
                    return None
                result = await asyncio.to_thread(self.rpc, method, params)
                text = render_result(result)
            except (ValueError, urllib.error.URLError, TimeoutError):
                # Avoid echoing credentials, arbitrary exception strings or task content on transport errors.
                text = "CCEM 请求未完成。请在桌面检查连接、工作区授权或确认有效期；已提交任务可用 /ccem operation 查询。"
            except Exception:
                text = "CCEM 请求失败；请在桌面检查连接状态。"
            receipt = await send_strict(self.runner, target, text)
            if receipt.get("status") != "sent":
                self.error = "command_reply_" + str(receipt.get("status", "unknown"))
                self.publish()
            return None  # handled; never let Hermes send a second ordinary reply

    def validate_begin_setup(self, params):
        if not isinstance(params, dict):
            raise ValueError("setup_invalid_request")
        platform = params.get("platform")
        identifier = _setup_module.validate_begin(params.get("id"), platform)
        if not any(p["id"] == platform and p.get("qrSetup") is True for p in self.platforms):
            raise ValueError("setup_platform_not_available")
        return identifier, platform

    async def request(self, method, params):
        if method == "status":
            return self.snapshot()
        if method == "stop":
            self.setup.clear()
            self.stopped.set()
            return {"ok": True}
        if method in ("beginSetup", "pollSetup", "cancelSetup"):
            if not isinstance(params, dict):
                raise ValueError("setup_invalid_request")
            identifier = params.get("id")
            if method == "beginSetup":
                identifier, platform = self.validate_begin_setup(params)
                return await self.setup.begin(identifier, platform)
            if method == "pollSetup":
                return await self.setup.poll(identifier)
            return self.setup.cancel(identifier)
        if method == "openPairing":
            if self.state != "running":
                raise ValueError("gateway_not_running")
            with self.lock:
                self.pending.clear()
                self.pairing = {"code": secrets.token_hex(12), "expiresAt": int(time.time()*1000)+120_000}
            self.publish()
            return self.pairing
        if method == "approvePairing":
            with self.lock:
                self.snapshot()
                pending = self.pending.pop(params.get("id", ""), None)
            if not pending:
                raise ValueError("pairing_expired")
            store = self.runner._pairing_store_for(pending["nativeSource"])
            approved = store.approve_code(pending["source"]["platform"], pending["nativeCode"])
            if not approved or str(approved["user_id"]) != pending["source"]["userId"]:
                raise ValueError("pairing_approval_failed")
            self.publish()
            return {"source": pending["source"]}
        if method == "sendStrict":
            from gateway.managed_contracts import send_strict, StrictTarget
            if self.state != "running":
                return {"status": "not_sent", "error_code": "gateway_not_running"}
            target = StrictTarget(**params["target"])
            if target.platform != self.boot.get("platform"):
                return {"status": "not_sent", "error_code": "platform_mismatch"}
            return await send_strict(self.runner, target, str(params["text"]), timeout=30.0)
        raise ValueError("unknown_host_method")

    async def serve(self):
        async def initialize():
            try:
                await self.initialize()
            except Exception as exc:
                self.state, self.error = "error", "gateway_start_failed:" + type(exc).__name__
                self.publish()
        initialization = asyncio.create_task(initialize())
        async def heartbeat():
            while not self.stopped.is_set():
                await asyncio.sleep(5)
                self.publish()
        heartbeat_task = asyncio.create_task(heartbeat())
        setup_jobs = {}
        async def respond(frame):
            identifier = frame.get("id")
            try:
                result = await self.request(frame.get("method"), frame.get("params", {}))
                emit({"id": identifier, "result": result})
                # Setup task handles remain bounded in setup_jobs. Do not keep
                # a QR URL or credentials in a completed task's return value.
                return result if frame.get("method") == "cancelSetup" else None
            except asyncio.CancelledError:
                emit({"id": identifier, "error": "setup_cancelled"})
            except Exception as exc:
                emit({"id": identifier, "error": str(exc)[:160] if isinstance(exc, ValueError) else "host_request_failed"})
        async def cancel_jobs(identifier=None):
            jobs = [job for job, owner in setup_jobs.values() if identifier is None or owner == identifier]
            for job in jobs:
                job.cancel()
            if jobs:
                await asyncio.gather(*jobs, return_exceptions=True)
        try:
            while not self.stopped.is_set():
                frame = await asyncio.to_thread(read_frame)
                if frame is None:
                    break
                identifier = frame.get("id")
                if not isinstance(identifier, str) or len(identifier) > 256:
                    raise ValueError("invalid_request_id")
                method = frame.get("method")
                params = frame.get("params", {})
                if method in ("beginSetup", "pollSetup") and isinstance(params, dict):
                    if method == "beginSetup":
                        try:
                            self.validate_begin_setup(params)
                        except ValueError as exc:
                            emit({"id": identifier, "error": str(exc)})
                            continue
                        self.setup.clear("superseded")
                        await cancel_jobs()
                    elif method in setup_jobs and not setup_jobs[method][0].done():
                        emit({"id": identifier, "error": "setup_poll_in_progress"})
                        continue
                    setup_jobs[method] = (asyncio.create_task(respond(frame)), params.get("id"))
                else:
                    result = await respond(frame)
                    if method == "cancelSetup" and result and result.get("state") == "cancelled":
                        await cancel_jobs(result["id"])
        finally:
            self.setup.clear()
            await cancel_jobs()
            initialization.cancel()
            heartbeat_task.cancel()
            await asyncio.gather(initialization, heartbeat_task, return_exceptions=True)
            if self.runner:
                await asyncio.wait_for(self.runner.stop(), timeout=2)


def render_result(result):
    if not isinstance(result, dict):
        return "CCEM：请求已处理。"
    if "challenge" in result:
        return f"继续任务 {result['runtimeId']}\n\n{result['text']}\n\n两分钟内发送：\n/ccem confirm {result['challenge']}\n取消：/ccem cancel {result['challenge']}"
    if "sessions" in result:
        return limit_utf8("\n\n".join(f"{limit_utf8(s.get('title') or 'Task', 60)} · {s['status']}\n{s['runtimeId']}" for s in result["sessions"]), 3500) or "授权工作区暂无任务。"
    if "events" in result:
        if not result.get("sourceAvailable") or result.get("gapDetected") or result.get("decodeFailureCount", 0) or result.get("oversizedEventCount", 0):
            return "事件记录不完整，请在 CCEM 查看任务。"
        events = "\n\n".join(f"{limit_utf8(e['title'], 120)}\n{limit_utf8(e['text'], 360)}" for e in result["events"])
        return (limit_utf8(events, 3200) or "暂无新事件。") + f"\n游标：{result.get('nextCursor')}"
    if "operationId" in result:
        return f"操作 {result['operationId']}\n{result['state']}\n{limit_utf8(result.get('detail', ''), 2500)}\n/ccem operation {result['operationId']}"
    return limit_utf8("\n".join(str(result[k]) for k in ("title", "runtimeId", "status", "state", "updatedAt") if result.get(k) is not None), 3500)


def limit_utf8(value, maximum):
    encoded = str(value).encode("utf-8")
    return str(value) if len(encoded) <= maximum else encoded[:maximum-3].decode("utf-8", errors="ignore") + "…"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--profile", type=Path)
    args = parser.parse_args()
    if args.self_test:
        source = Path(__file__).resolve().parent / "source"
        sys.path.insert(0, str(source))
        # Some Hermes import-time modules initialize a home. Confine those effects
        # to a disposable directory, outside both user data and the immutable bundle.
        sys.stdout = sys.stderr
        with tempfile.TemporaryDirectory(prefix="ccem-hermes-health-") as temporary:
            os.environ["HOME"] = temporary
            os.environ["HERMES_HOME"] = temporary
            from gateway.managed_contracts import StrictTarget, strict_send_supported
            assert strict_send_supported("wecom") and StrictTarget
            from plugins.platforms.wecom.adapter import WeComAdapter, check_wecom_requirements
            assert WeComAdapter and check_wecom_requirements(), "WeCom transport dependencies are unavailable"
            assert _setup_module.WeComSetup and _setup_module.tls_context()
        emit({"ok": True, "protocolVersion": PROTOCOL})
        return
    if not args.source or not args.profile or not args.source.is_absolute() or not args.profile.is_absolute():
        parser.error("private absolute source/profile paths required")
    sys.stdout = sys.stderr
    sys.path.insert(0, str(args.source))
    os.environ["HERMES_HOME"] = str(args.profile)
    os.environ["HERMES_BUNDLED_PLUGINS"] = str(args.source / "plugins")
    boot = read_frame()
    if boot is None:
        return
    async def run():
        await Host(boot, args.profile).serve()
    asyncio.run(run())


if __name__ == "__main__":
    main()
