"""Official device-flow lifecycle with synthetic credentials; no accounts created."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("feishu_qr", Path(__file__).with_name("ccem_gateway_onboarding.py"))
qr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qr)
LINK = "https://open.feishu.cn/page/launcher?user_code=synthetic-code"
INIT = {"supported_auth_methods": ["client_secret"]}
BEGIN = {"device_code": "synthetic-private-device-code", "verification_uri_complete": LINK, "expires_in": 600, "interval": 5}
READY = {"client_id": "cli_synthetic", "client_secret": "synthetic-private-app-secret",
         "user_info": {"open_id": "untrusted-owner", "tenant_brand": "feishu"}}


class FeishuSetupTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, fetch=None):
        self.clock, self.calls = 100., []
        self.replies = [dict(INIT), dict(BEGIN), dict(READY)]
        async def default_fetch(url, **kwargs):
            self.calls.append((url, kwargs))
            reply = self.replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        manager = qr.FeishuSetup(fetch_json=fetch or default_fetch, monotonic=lambda: self.clock, wall_clock=lambda: 1000)
        self.addCleanup(manager.clear)
        return manager

    async def test_complete_credentials_once_after_interval_without_trusting_owner(self):
        manager = self.manager()
        begin = await manager.begin("session", "feishu")
        self.assertEqual(begin["qrPayload"], LINK + "&from=hermes&tp=hermes")
        self.assertEqual(begin["expiresAt"], 1300000)
        self.assertNotIn(BEGIN["device_code"], json.dumps(begin))
        self.assertEqual(await manager.poll("session"), {"id": "session", "state": "waiting"})
        self.assertEqual(len(self.calls), 2)
        self.clock += 5
        session = manager._current
        ready = await manager.poll("session")
        self.assertEqual(ready, {"id": "session", "state": "ready", "platform": "feishu", "fields": {
            "FEISHU_APP_ID": READY["client_id"], "FEISHU_APP_SECRET": READY["client_secret"], "FEISHU_DOMAIN": "feishu"}})
        self.assertNotIn("untrusted-owner", json.dumps(ready))
        self.assertIsNone(session["scode"])
        self.assertEqual(self.calls[-1][1], {"method": "POST", "form": {"action": "poll", "device_code": BEGIN["device_code"], "tp": "ob_app"}})
        with self.assertRaisesRegex(qr.SetupError, "setup_consumed"):
            await manager.poll("session")

    async def test_lark_switch_handles_pending_and_same_response_credentials(self):
        for pending_first in (False, True):
            manager = self.manager()
            self.replies[-1] = {**READY, "user_info": {"tenant_brand": "lark", "open_id": "untrusted-owner"}}
            if pending_first:
                self.replies.insert(2, {"error": "authorization_pending", "user_info": {"tenant_brand": "lark"}})
            await manager.begin("session", "feishu")
            self.clock += 5
            if pending_first:
                self.assertEqual((await manager.poll("session"))["state"], "waiting")
                self.clock += 5
            result = await manager.poll("session")
            self.assertEqual(result["fields"]["FEISHU_DOMAIN"], "lark")
            self.assertEqual(self.calls[-1][0], qr.FEISHU_URLS["lark" if pending_first else "feishu"])

    async def test_pending_slow_down_and_transient_failure_respect_next_poll(self):
        manager = self.manager()
        self.replies[2:] = [{"error": "authorization_pending"}, {"error": "slow_down"},
                            qr.SetupError("setup_network_failed"), READY]
        await manager.begin("session", "feishu")
        for delay in (5, 5, 10):
            self.clock += delay
            self.assertEqual((await manager.poll("session"))["state"], "waiting")
            count = len(self.calls)
            self.assertEqual((await manager.poll("session"))["state"], "waiting")
            self.assertEqual(len(self.calls), count)
        self.clock += 9
        self.assertEqual((await manager.poll("session"))["state"], "waiting")
        self.clock += 1
        self.assertEqual((await manager.poll("session"))["state"], "ready")

    async def test_actual_expiry_takes_precedence_and_clears_capability(self):
        manager = self.manager()
        self.replies[1].update(expires_in=10, expire_in=999999)
        begun = await manager.begin("session", "feishu")
        self.assertEqual(begun["expiresAt"], 1010000)
        self.clock += 10
        with self.assertRaisesRegex(qr.SetupError, "setup_expired"):
            await manager.poll("session")
        self.assertIsNone(manager._current)
        self.assertEqual(len(self.calls), 2)

    async def test_cancellation_and_replacement_reject_late_generate_or_credentials(self):
        for blocked_action in ("init", "begin", "poll"):
            for replace in (False, True):
                started, release = asyncio.Event(), asyncio.Event()
                async def fetch(url, **kwargs):
                    action = kwargs["form"]["action"]
                    if action == blocked_action and not started.is_set():
                        started.set()
                        await release.wait()
                    return {"init": INIT, "begin": BEGIN, "poll": READY}[action]
                manager = self.manager(fetch)
                if blocked_action == "poll":
                    await manager.begin("old", "feishu")
                    self.clock += 5
                pending = asyncio.create_task(manager.poll("old") if blocked_action == "poll" else manager.begin("old", "feishu"))
                await started.wait()
                old = manager._current
                if replace:
                    await manager.begin("new", "feishu")
                else:
                    manager.cancel("old")
                release.set()
                with self.assertRaises(qr.SetupError):
                    await pending
                self.assertIsNone(old["scode"])
                if replace:
                    self.assertEqual(manager._current["id"], "new")

    async def test_invalid_qr_timing_or_auth_method_never_retains_session(self):
        for changes in ({"expires_in": True}, {"expires_in": -1}, {"expires_in": float("inf")},
                        {"interval": 0}, {"interval": True}, {"interval": 301},
                        {"verification_uri_complete": LINK + "&redirect_uri=https://evil.test"},
                        {"device_code": "contains\nnewline"}):
            manager = self.manager()
            self.replies[1].update(changes)
            with self.assertRaises(qr.SetupError):
                await manager.begin("session", "feishu")
            self.assertIsNone(manager._current)
        manager = self.manager()
        self.replies[0] = {"supported_auth_methods": ["private_key_jwt"]}
        with self.assertRaisesRegex(qr.SetupError, "setup_unavailable"):
            await manager.begin("session", "feishu")
        self.assertEqual(len(self.calls), 1)

    async def test_denied_expired_and_partial_credentials_fail_without_leaking(self):
        for reply in ({"error": "access_denied", "error_description": READY["client_secret"]},
                      {"error": "expired_token"}, {"error": "unknown-secret-error"},
                      {"client_id": "cli_partial"}, {**READY, "client_secret": "bad\nsecret"}):
            manager = self.manager()
            self.replies[2] = reply
            await manager.begin("session", "feishu")
            self.clock += 5
            with self.assertRaises(qr.SetupError) as caught:
                await manager.poll("session")
            self.assertNotIn("secret", str(caught.exception))
            self.assertIsNone(manager._current)

    def test_qr_destination_is_exact_official_launcher_only(self):
        for valid in (LINK, LINK.replace("feishu.cn", "larksuite.com"), LINK + "&from=hermes&tp=hermes"):
            self.assertEqual(qr._feishu_qr_payload(valid), valid)
        for invalid in (LINK.replace("https:", "http:"), LINK.replace("open.feishu.cn", "open.feishu.cn.evil.test"),
                        LINK.replace("open.feishu.cn", "user@open.feishu.cn"), LINK.replace("open.feishu.cn", "open.feishu.cn:443"),
                        LINK.replace("/page/launcher", "/other"), LINK + "#fragment", LINK + "&user_code=duplicate",
                        LINK + "&from=other", LINK + "&tp=hermes&tp=hermes", LINK + "&secret=private",
                        LINK.replace("synthetic-code", "%0A"), LINK.replace("synthetic-code", "")):
            with self.assertRaises(qr.SetupError):
                qr._feishu_qr_payload(invalid)


if __name__ == "__main__":
    unittest.main()
