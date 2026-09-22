#!/usr/bin/env python3
"""QR protocol/state regressions. HTTPS tests resolve only to a local TLS server."""
import asyncio
import importlib.util
import io
import json
from pathlib import Path
import queue
import shutil
import socket
import ssl
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


qr = load("onboarding_under_test", "ccem_gateway_onboarding.py")
host_module = load("host_under_test", "ccem_gateway_host.py")
QR_URL = "https://work.weixin.qq.com/ai/qc/c?s=synthetic-auth-code&hide_more_btn=1&for_native=1"
GENERATED = {"data": {"scode": "synthetic-private-poll-code", "auth_url": QR_URL}}
READY = {"data": {"status": "success", "bot_info": {"botid": "synthetic-bot", "secret": "synthetic-bot-secret"}}}


class SetupTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, fetch=None):
        self.calls = []
        self.responses = [GENERATED, READY]
        self.clock = 100.0
        async def default_fetch(url):
            self.calls.append(url)
            return self.responses.pop(0)
        manager = qr.WeComSetup(fetch_json=fetch or default_fetch, monotonic=lambda: self.clock, wall_clock=lambda: 1000.0)
        self.addCleanup(manager.clear)
        return manager

    async def test_ready_returns_complete_credentials_once_without_retaining_them(self):
        manager = self.manager()
        begun = await manager.begin("session", "wecom")
        self.assertEqual(begun, {"id": "session", "state": "waiting", "qrPayload": QR_URL, "expiresAt": 1_300_000})
        self.assertNotIn("synthetic-private-poll-code", json.dumps(begun))
        session = manager._current
        result = await manager.poll("session")
        self.assertEqual(result, {"id": "session", "state": "ready", "platform": "wecom",
                                  "fields": {"WECOM_BOT_ID": "synthetic-bot", "WECOM_SECRET": "synthetic-bot-secret"}})
        self.assertIsNone(manager._current)
        self.assertIsNone(session["scode"])
        with self.assertRaisesRegex(ValueError, "^setup_consumed$"):
            await manager.poll("session")

    async def test_pending_response_does_not_expose_provider_fields(self):
        manager = self.manager()
        self.responses[1] = {"data": {"status": "init", "bot_info": READY["data"]["bot_info"]}}
        await manager.begin("session", "wecom")
        self.assertEqual(await manager.poll("session"), {"id": "session", "state": "waiting"})

    async def test_cancel_during_generate_rejects_late_result(self):
        started, released = asyncio.Event(), asyncio.Event()
        async def fetch(url):
            started.set()
            await released.wait()
            return GENERATED
        manager = self.manager(fetch)
        pending = asyncio.create_task(manager.begin("session", "wecom"))
        await started.wait()
        session = manager._current
        self.assertEqual(manager.cancel("session"), {"id": "session", "state": "cancelled"})
        self.assertEqual(manager.cancel("session"), {"id": "session", "state": "cancelled"})
        released.set()
        with self.assertRaisesRegex(ValueError, "^setup_cancelled$"):
            await pending
        self.assertIsNone(session["scode"])

    async def test_replace_generation_ignores_old_result_even_when_id_is_reused(self):
        started, released = asyncio.Event(), asyncio.Event()
        count = 0
        async def fetch(url):
            nonlocal count
            count += 1
            if count == 1:
                started.set()
                await released.wait()
            return GENERATED
        manager = self.manager(fetch)
        previous = asyncio.create_task(manager.begin("session", "wecom"))
        await started.wait()
        old_session = manager._current
        await manager.begin("session", "wecom")
        released.set()
        with self.assertRaisesRegex(ValueError, "^setup_superseded$"):
            await previous
        self.assertIsNone(old_session["scode"])
        self.assertEqual(manager._current["scode"], GENERATED["data"]["scode"])

    async def test_cancel_during_poll_cannot_release_credentials(self):
        started, released = asyncio.Event(), asyncio.Event()
        async def fetch(url):
            if url == qr.GENERATE_URL:
                return GENERATED
            started.set()
            await released.wait()
            return READY
        manager = self.manager(fetch)
        await manager.begin("session", "wecom")
        session = manager._current
        pending = asyncio.create_task(manager.poll("session"))
        await started.wait()
        manager.cancel("session")
        released.set()
        with self.assertRaisesRegex(ValueError, "^setup_cancelled$"):
            await pending
        self.assertIsNone(session["scode"])

    async def test_replace_during_poll_preserves_new_session(self):
        started, released = asyncio.Event(), asyncio.Event()
        async def fetch(url):
            if url == qr.GENERATE_URL:
                return GENERATED
            started.set()
            await released.wait()
            return READY
        manager = self.manager(fetch)
        await manager.begin("old", "wecom")
        pending = asyncio.create_task(manager.poll("old"))
        await started.wait()
        await manager.begin("new", "wecom")
        released.set()
        with self.assertRaisesRegex(ValueError, "^setup_superseded$"):
            await pending
        self.assertEqual(manager._current["id"], "new")

    async def test_expiry_uses_monotonic_time_and_clears_poll_code(self):
        manager = self.manager()
        await manager.begin("session", "wecom")
        session = manager._current
        self.clock += 300
        with self.assertRaisesRegex(ValueError, "^setup_expired$"):
            await manager.poll("session")
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(session["scode"])

    async def test_expiry_during_poll_rejects_returned_credentials(self):
        async def fetch(url):
            if url == qr.GENERATE_URL:
                return GENERATED
            self.clock += 300
            return READY
        manager = self.manager(fetch)
        await manager.begin("session", "wecom")
        with self.assertRaisesRegex(ValueError, "^setup_expired$"):
            await manager.poll("session")

    async def test_idle_expiry_clears_code_without_another_poll(self):
        manager = self.manager()
        with patch.object(qr, "SESSION_TIMEOUT", 0.01):
            await manager.begin("session", "wecom")
        session = manager._current
        await asyncio.sleep(0.03)
        self.assertIsNone(session["scode"])
        self.assertIsNone(manager._current)

    async def test_wrong_id_cannot_poll_or_cancel_current_session(self):
        manager = self.manager()
        await manager.begin("session", "wecom")
        with self.assertRaisesRegex(ValueError, "^setup_session_not_current$"):
            await manager.poll("other")
        with self.assertRaisesRegex(ValueError, "^setup_session_not_current$"):
            manager.cancel("other")
        self.assertEqual(manager._current["id"], "session")
        self.assertEqual(len(self.calls), 1)

    async def test_malformed_provider_results_fail_closed_and_redact_secrets(self):
        invalid = [None, [], {"data": []}, {"data": {"status": None}},
                   {"data": {"status": "success"}},
                   {"data": {"status": "success", "bot_info": {"secret": "synthetic-bot-secret"}}},
                   {"data": {"status": "success", "bot_info": {"botid": "synthetic-bot"}}},
                   {"data": {"status": "success", "bot_info": {"botid": 123, "secret": "synthetic-bot-secret"}}},
                   {"errcode": 5, "errmsg": "synthetic-bot-secret", "data": READY["data"]}]
        for value in invalid:
            with self.subTest(value=value):
                manager = self.manager()
                self.responses[1] = value
                await manager.begin("session", "wecom")
                with self.assertRaises(qr.SetupError) as caught:
                    await manager.poll("session")
                self.assertNotIn("synthetic-bot-secret", str(caught.exception))
                self.assertIsNone(manager._current)

    async def test_unexpected_exception_text_is_redacted(self):
        async def fetch(url):
            raise ValueError("synthetic-bot-secret")
        manager = self.manager(fetch)
        with self.assertRaisesRegex(ValueError, "^setup_request_failed$"):
            await manager.begin("session", "wecom")

    async def test_invalid_generate_data_and_foreign_qr_urls_are_rejected(self):
        for data in ({}, {"scode": "code", "auth_url": "https://example.com/ai/qc/c?s=x"},
                     {"scode": "code", "auth_url": "https://work.weixin.qq.com/other?s=x"},
                     {"scode": "code", "auth_url": "https://user@work.weixin.qq.com/ai/qc/c?s=x"},
                     {"scode": "code", "auth_url": QR_URL + "#fragment"},
                     {"scode": "code", "auth_url": "http://work.weixin.qq.com/ai/qc/c?s=x"}):
            with self.subTest(data=data):
                manager = self.manager()
                self.responses[0] = {"data": data}
                with self.assertRaises(qr.SetupError):
                    await manager.begin("session", "wecom")
                self.assertIsNone(manager._current)

    async def test_request_ids_and_platform_are_validated_before_network(self):
        manager = self.manager()
        for identifier in (None, "", "has space", "x" * 129, "secret\n"):
            with self.assertRaisesRegex(ValueError, "^setup_invalid_id$"):
                await manager.begin(identifier, "wecom")
        with self.assertRaisesRegex(ValueError, "^setup_platform_not_supported$"):
            await manager.begin("session", "telegram")
        self.assertEqual(self.calls, [])


class HostTests(unittest.IsolatedAsyncioTestCase):
    def new_host(self):
        host = host_module.Host({"protocolVersion": 1, "token": "synthetic-capability-" + "x" * 32,
                                 "accountRef": "account", "endpoint": "http://127.0.0.1:1/rpc"}, Path("/unused"))
        host.platforms = [{"id": "wecom", "available": True, "qrSetup": True}]
        self.addCleanup(host.setup.clear)
        return host

    async def test_status_never_contains_setup_code_or_credentials(self):
        host = self.new_host()
        async def fetch(url):
            return GENERATED if url == qr.GENERATE_URL else READY
        host.setup = qr.WeComSetup(fetch_json=fetch)
        self.addCleanup(host.setup.clear)
        await host.request("beginSetup", {"id": "session", "platform": "wecom"})
        before = await host.request("status", {})
        result = await host.request("pollSetup", {"id": "session"})
        after = await host.request("status", {})
        output = io.StringIO()
        with patch.object(host_module, "_wire", output):
            host.publish()
        status = json.dumps([before, after]) + output.getvalue()
        for sensitive in ("synthetic-private-poll-code", "synthetic-bot-secret", QR_URL, "fields", "scode"):
            self.assertNotIn(sensitive, status)
        self.assertEqual(result["fields"]["WECOM_SECRET"], "synthetic-bot-secret")

    async def test_host_requires_available_qr_platform(self):
        host = self.new_host()
        host.platforms[0]["qrSetup"] = False
        with self.assertRaisesRegex(ValueError, "^setup_platform_not_available$"):
            await host.request("beginSetup", {"id": "session", "platform": "wecom"})

    async def test_wire_cancel_preempts_generate_and_replacement_is_bounded(self):
        host = self.new_host()
        started = asyncio.Queue()
        active = peak = 0
        async def fetch(url):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            started.put_nowait(True)
            try:
                await asyncio.sleep(60)
            finally:
                active -= 1
        host.setup = qr.WeComSetup(fetch_json=fetch)
        self.addCleanup(host.setup.clear)
        async def initialize():
            host.state = "unconfigured"
        host.initialize = initialize
        incoming, outgoing = queue.Queue(), []
        with patch.object(host_module, "read_frame", incoming.get), patch.object(host_module, "emit", outgoing.append):
            serving = asyncio.create_task(host.serve())
            incoming.put({"id": "first-request", "method": "beginSetup", "params": {"id": "first", "platform": "wecom"}})
            await asyncio.wait_for(started.get(), 1)
            incoming.put({"id": "second-request", "method": "beginSetup", "params": {"id": "second", "platform": "wecom"}})
            await asyncio.wait_for(started.get(), 1)
            incoming.put({"id": "cancel-request", "method": "cancelSetup", "params": {"id": "second"}})
            for _ in range(100):
                if active == 0:
                    break
                await asyncio.sleep(0.01)
            incoming.put({"id": "stop-request", "method": "stop", "params": {}})
            await asyncio.wait_for(serving, 1)
        self.assertEqual(peak, 1)
        self.assertEqual(active, 0)
        self.assertIsNone(host.setup._current)
        self.assertIn({"id": "cancel-request", "result": {"id": "second", "state": "cancelled"}}, outgoing)
        self.assertIn({"id": "first-request", "error": "setup_cancelled"}, outgoing)

    async def test_wire_invalid_begin_does_not_cancel_the_current_generation(self):
        host = self.new_host()
        started = asyncio.Event()
        cancelled = False
        async def fetch(url):
            nonlocal cancelled
            started.set()
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled = True
                raise
        host.setup = qr.WeComSetup(fetch_json=fetch)
        self.addCleanup(host.setup.clear)
        async def initialize():
            host.state = "unconfigured"
        host.initialize = initialize
        incoming, outgoing = queue.Queue(), []
        with patch.object(host_module, "read_frame", incoming.get), patch.object(host_module, "emit", outgoing.append):
            serving = asyncio.create_task(host.serve())
            incoming.put({"id": "begin", "method": "beginSetup", "params": {"id": "current", "platform": "wecom"}})
            await asyncio.wait_for(started.wait(), 1)
            incoming.put({"id": "invalid", "method": "beginSetup", "params": {"id": "invalid id", "platform": "wecom"}})
            for _ in range(100):
                if any(item.get("id") == "invalid" for item in outgoing):
                    break
                await asyncio.sleep(0.01)
            self.assertIn({"id": "invalid", "error": "setup_invalid_id"}, outgoing)
            self.assertFalse(cancelled)
            self.assertEqual(host.setup._current["id"], "current")
            incoming.put({"id": "stop", "method": "stop", "params": {}})
            await asyncio.wait_for(serving, 1)
        self.assertTrue(cancelled)

    async def test_wire_duplicate_poll_does_not_spawn_another_request(self):
        host = self.new_host()
        started = asyncio.Event()
        calls = []
        async def fetch(url):
            calls.append(url)
            if url == qr.GENERATE_URL:
                return GENERATED
            started.set()
            await asyncio.sleep(60)
        host.setup = qr.WeComSetup(fetch_json=fetch)
        self.addCleanup(host.setup.clear)
        await host.setup.begin("current", "wecom")
        async def initialize():
            host.state = "unconfigured"
        host.initialize = initialize
        incoming, outgoing = queue.Queue(), []
        with patch.object(host_module, "read_frame", incoming.get), patch.object(host_module, "emit", outgoing.append):
            serving = asyncio.create_task(host.serve())
            incoming.put({"id": "first", "method": "pollSetup", "params": {"id": "current"}})
            await asyncio.wait_for(started.wait(), 1)
            incoming.put({"id": "duplicate", "method": "pollSetup", "params": {"id": "current"}})
            incoming.put({"id": "stop", "method": "stop", "params": {}})
            await asyncio.wait_for(serving, 1)
        self.assertIn({"id": "duplicate", "error": "setup_poll_in_progress"}, outgoing)
        self.assertEqual(len(calls), 2)


class HttpsTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl is required for the local HTTPS fixture")
        cls.directory = tempfile.TemporaryDirectory(prefix="ccem-qr-https-")
        directory = Path(cls.directory.name)
        config = directory / "openssl.cnf"
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=work.weixin.qq.com\n[ext]\nsubjectAltName=DNS:work.weixin.qq.com\n")
        cls.cert, cls.key = directory / "cert.pem", directory / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-keyout", str(cls.key), "-out", str(cls.cert), "-config", str(config)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    async def asyncSetUp(self):
        import aiohttp
        from aiohttp import web
        self.web, self.requests = web, []
        self.handler = lambda request: web.json_response(GENERATED)
        async def handle(request):
            self.requests.append(request.path)
            value = self.handler(request)
            return await value if asyncio.iscoroutine(value) else value
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ssl.load_cert_chain(self.cert, self.key)
        site = web.TCPSite(self.runner, "127.0.0.1", 0, ssl_context=server_ssl)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        class LocalResolver(aiohttp.abc.AbstractResolver):
            async def resolve(self, host, target_port=0, family=socket.AF_INET):
                if host != "work.weixin.qq.com":
                    raise AssertionError("external DNS is prohibited")
                return [{"hostname": host, "host": "127.0.0.1", "port": port,
                         "family": socket.AF_INET, "proto": 0, "flags": 0}]
            async def close(self):
                return None
        client_ssl = ssl.create_default_context(cafile=str(self.cert))
        original = aiohttp.ClientSession
        original_connector = aiohttp.TCPConnector
        def local_connector(**kwargs):
            self.assertEqual(kwargs["ssl"].verify_mode, ssl.CERT_REQUIRED)
            return original_connector(resolver=LocalResolver(), ssl=client_ssl)
        def local_session(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            self.assertLessEqual(kwargs["timeout"].total, 10)
            return original(**kwargs)
        self.client_patch = patch.object(aiohttp, "ClientSession", local_session)
        self.connector_patch = patch.object(aiohttp, "TCPConnector", local_connector)
        self.client_patch.start()
        self.connector_patch.start()

    async def asyncTearDown(self):
        self.client_patch.stop()
        self.connector_patch.stop()
        await self.runner.cleanup()

    async def test_real_https_valid_json(self):
        self.assertEqual(await qr._fetch_json(qr.GENERATE_URL), GENERATED)
        self.assertEqual(self.requests, ["/ai/qc/generate"])

    async def test_real_https_redirect_is_not_followed(self):
        self.handler = lambda request: self.web.Response(status=302, headers={"Location": "https://work.weixin.qq.com/should-not-follow"})
        with self.assertRaisesRegex(ValueError, "^setup_redirect_rejected$"):
            await qr._fetch_json(qr.GENERATE_URL)
        self.assertEqual(self.requests, ["/ai/qc/generate"])

    async def test_real_https_content_length_is_bounded(self):
        self.handler = lambda request: self.web.Response(body=b"x" * (qr.RESPONSE_LIMIT + 1))
        with self.assertRaisesRegex(ValueError, "^setup_response_too_large$"):
            await qr._fetch_json(qr.GENERATE_URL)

    async def test_real_https_chunked_response_is_bounded(self):
        async def chunked(request):
            response = self.web.StreamResponse()
            response.enable_chunked_encoding()
            await response.prepare(request)
            await response.write(b"x" * (qr.RESPONSE_LIMIT + 1))
            await response.write_eof()
            return response
        self.handler = chunked
        with self.assertRaisesRegex(ValueError, "^setup_response_too_large$"):
            await qr._fetch_json(qr.GENERATE_URL)

    async def test_real_https_bad_json_and_error_body_are_redacted(self):
        for status in (200, 500):
            with self.subTest(status=status):
                self.handler = lambda request: self.web.Response(status=status, text="synthetic-bot-secret")
                with self.assertRaises(qr.SetupError) as caught:
                    await qr._fetch_json(qr.GENERATE_URL)
                self.assertNotIn("synthetic-bot-secret", str(caught.exception))

    async def test_real_https_total_timeout_is_bounded(self):
        async def delayed(request):
            await asyncio.sleep(0.15)
            return self.web.json_response(GENERATED)
        self.handler = delayed
        with patch.object(qr, "REQUEST_TIMEOUT", 0.03), self.assertRaisesRegex(ValueError, "^setup_request_timeout$"):
            await qr._fetch_json(qr.GENERATE_URL)

    async def test_nonofficial_endpoint_is_rejected_before_network(self):
        with self.assertRaisesRegex(ValueError, "^setup_invalid_endpoint$"):
            await qr._fetch_json("https://example.com/ai/qc/query_result?scode=private")
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
