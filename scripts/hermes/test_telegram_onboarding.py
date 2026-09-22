"""Telegram managed-bot lifecycle uses synthetic service responses, no accounts."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("telegram_qr", Path(__file__).with_name("ccem_gateway_onboarding.py"))
qr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qr)
LINK = "https://t.me/newbot/HermesSetupBot/ccem_synthetic_bot?name=CCEM"
START_LINK = "https://t.me/HermesSetupBot?start=synthetic_pairing-123"
CREATED = {"pairing_id": "synthetic-session", "poll_token": "synthetic-private-poll-token", "deep_link": LINK, "qr_payload": LINK}
TOKEN = "12345:" + "x" * 32
READY = {"status": "ready", "token": TOKEN, "owner_user_id": 7654321}


class TelegramSetupTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, fetch=None):
        self.clock = 100.0
        self.calls = []
        self.replies = [dict(CREATED), dict(READY)]
        async def default_fetch(url, **kwargs):
            self.calls.append((url, kwargs))
            return self.replies.pop(0)
        manager = qr.TelegramSetup(fetch_json=fetch or default_fetch, monotonic=lambda: self.clock, wall_clock=lambda: 1000)
        self.addCleanup(manager.clear)
        return manager

    async def test_complete_credentials_return_once_without_authorizing_owner(self):
        manager = self.manager()
        begun = await manager.begin("desktop-id", "telegram")
        self.assertEqual(begun["qrPayload"], LINK)
        self.assertNotIn("poll_token", json.dumps(begun))
        state = manager._current
        result = await manager.poll("desktop-id")
        self.assertEqual(result, {"id": "desktop-id", "state": "ready", "platform": "telegram", "fields": {"TELEGRAM_BOT_TOKEN": TOKEN}})
        self.assertIsNone(state["scode"])
        self.assertNotIn("owner", json.dumps(result))
        self.assertEqual(self.calls[1], (qr.TELEGRAM_URL + "/synthetic-session", {"bearer": CREATED["poll_token"]}))
        with self.assertRaisesRegex(ValueError, "setup_consumed"):
            await manager.poll("desktop-id")

    async def test_service_bot_start_link_reaches_pending_poll(self):
        # The live official broker also returns a private bot /start link.
        manager = self.manager()
        self.replies[0].update(deep_link=START_LINK, qr_payload=START_LINK)
        self.replies[1] = {"status": "pending"}
        begun = await manager.begin("desktop-id", "telegram")
        self.assertEqual(begun["qrPayload"], START_LINK)
        self.assertNotIn("poll_token", json.dumps(begun))
        self.assertEqual(await manager.poll("desktop-id"), {"id": "desktop-id", "state": "waiting"})

    async def test_cancelled_generate_and_poll_reject_late_success(self):
        for during in ("generate", "poll"):
            started, release = asyncio.Event(), asyncio.Event()
            async def fetch(url, **kwargs):
                generating = kwargs.get("method") == "POST"
                if generating == (during == "generate"):
                    started.set()
                    await release.wait()
                return CREATED if generating else READY
            manager = self.manager(fetch)
            if during == "poll":
                await manager.begin("id", "telegram")
            pending = asyncio.create_task(manager.begin("id", "telegram") if during == "generate" else manager.poll("id"))
            await started.wait()
            state = manager._current
            manager.cancel("id")
            release.set()
            with self.assertRaisesRegex(ValueError, "setup_cancelled"):
                await pending
            self.assertIsNone(state["scode"])

    async def test_replacement_cannot_release_old_credentials(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def fetch(url, **kwargs):
            if kwargs.get("method") == "POST":
                return CREATED
            started.set()
            await release.wait()
            return READY
        manager = self.manager(fetch)
        await manager.begin("first", "telegram")
        old = asyncio.create_task(manager.poll("first"))
        await started.wait()
        await manager.begin("second", "telegram")
        release.set()
        with self.assertRaisesRegex(ValueError, "setup_superseded"):
            await old
        self.assertEqual(manager._current["id"], "second")

    async def test_expired_and_malformed_ready_never_release_credentials(self):
        manager = self.manager()
        await manager.begin("id", "telegram")
        self.clock += 300
        with self.assertRaisesRegex(ValueError, "setup_expired"):
            await manager.poll("id")
        for token in (None, "arbitrary", True, TOKEN + "\n", TOKEN + "?redirect=x"):
            manager = self.manager()
            self.replies[1] = {"status": "ready", "token": token}
            await manager.begin("id", "telegram")
            with self.assertRaisesRegex(ValueError, "setup_credentials_missing"):
                await manager.poll("id")
            self.assertIsNone(manager._current)

    async def test_service_expiry_shortens_local_deadline(self):
        manager = self.manager()
        self.replies[0]["expires_at"] = "1970-01-01T00:17:00Z"
        begun = await manager.begin("id", "telegram")
        self.assertEqual(begun["expiresAt"], 1020000)
        self.clock += 21
        with self.assertRaisesRegex(ValueError, "setup_expired"):
            await manager.poll("id")

    async def test_poll_capability_and_qr_are_validated_before_retention(self):
        for change in ({"pairing_id": "../escape"}, {"poll_token": "x\r\ny"},
                       {"qr_payload": "https://t.me/newbot/HermesSetupBot/other_bot"},
                       {"deep_link": "https://example.com/create", "qr_payload": "https://example.com/create"}):
            manager = self.manager()
            self.replies[0].update(change)
            with self.assertRaises(qr.SetupError):
                await manager.begin("id", "telegram")
            self.assertIsNone(manager._current)

    def test_qr_url_allows_only_bot_creation(self):
        self.assertEqual(qr._telegram_qr_payload(LINK), LINK)
        for invalid in ("tg://resolve?domain=HermesSetupBot", "https://t.me/user", LINK + "#x", LINK + "&token=private",
                        LINK + "&token=", START_LINK + "&start=duplicate", START_LINK + "&token=",
                        START_LINK.replace("start=", "startgroup="), START_LINK.replace("HermesSetupBot", "ordinary_user"),
                        "https://t.me/HermesSetupBot?start=", "https://t.me/HermesSetupBot?start=" + "x" * 65,
                        "https://t.me/HermesSetupBot?start=%0A", START_LINK + "#fragment",
                        "https://user:pass@t.me/newbot/HermesSetupBot/ccem_bot", "https://t.me:8443/newbot/HermesSetupBot/ccem_bot"):
            with self.assertRaises(qr.SetupError):
                qr._telegram_qr_payload(invalid)


if __name__ == "__main__":
    unittest.main()
