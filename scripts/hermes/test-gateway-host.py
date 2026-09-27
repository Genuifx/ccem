#!/usr/bin/env python3
"""Bounded protocol/renderer regressions; no Hermes profile or network access."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("ccem_host", Path(__file__).with_name("ccem_gateway_host.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class GatewayHostTest(unittest.TestCase):
    def test_mobile_confirmation_copy_normalizes_only_a_whole_control_reply(self):
        challenge = "0123456789abcdef" * 3
        for prefix in ("/ccem", "!ccem"):
            for text in (f"{prefix} confirm {challenge}",
                         f"两分钟内发送：\n{prefix} confirm\n{challenge[:32]}\n{challenge[32:]}",
                         f" 两分钟内发送:\n{prefix} confirm {challenge.upper()}\n"):
                with self.subTest(text=text):
                    self.assertEqual(host.confirmation_reply(text, prefix), f"confirm {challenge}")
            self.assertEqual(host.confirmation_reply(f"取消：\n{prefix} cancel\n{challenge}", prefix), f"cancel {challenge}")

    def test_preview_and_ambiguous_control_copies_never_become_confirmation(self):
        challenge = "c" * 48
        examples = [host.render_result({"runtimeId": "native-one", "text": "hello", "challenge": challenge}),
            f"/ccem confirm {challenge}\n/ccem cancel {challenge}",
            f"/ccem confirm {challenge}\n/ccem confirm {challenge}",
            f"请分析这条命令\n/ccem confirm {challenge}",
            f"> /ccem confirm {challenge}",
            f"两分钟内发送：\n/ccem cancel {challenge}",
            f"取消：/ccem confirm {challenge}",
            f"/ccem confirm {challenge} extra",
            "/ccem confirm " + "c" * 47,
            "/ccem confirm " + "c" * 49,
            "/ccem confirm <确认码>"]
        for text in examples:
            with self.subTest(text=text):
                self.assertEqual(host.confirmation_reply(text, "/ccem"), "confirmation-help")
        self.assertEqual(host.confirmation_reply(f"/ccem confirm {challenge}", "!ccem"), f"confirm {challenge}")
        self.assertEqual(host.confirmation_reply(f"!ccem confirm {challenge}", "/ccem"), "confirmation-help")
        self.assertIsNone(host.confirmation_reply("继续", "/ccem"))

    def test_confirmation_errors_are_specific_without_echoing_arbitrary_details(self):
        for code in ("challenge_expired_or_revoked", "challenge_not_found", "challenge_scope_mismatch"):
            message = host.command_error(code, "/ccem")
            self.assertIn("失效", message)
            self.assertIn("重新发送原任务", message)
            self.assertNotIn("桌面", message)
        self.assertIn("原会话当前不可用", host.command_error("session_not_found", "/ccem"))
        self.assertNotIn("sensitive-details", host.command_error("sensitive-details", "/ccem"))

    def test_only_exact_loopback_rpc_endpoint_is_accepted(self):
        host.validate_endpoint("http://127.0.0.1:8123/rpc")
        for url in ["https://127.0.0.1:10/rpc", "http://localhost:10/rpc", "http://127.0.0.1:10/rpc?token=x", "http://127.0.0.1:10/else", "http://example.com:10/rpc", "http://x@127.0.0.1:10/rpc"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                host.validate_endpoint(url)

    def test_confirmation_preserves_entire_frozen_input(self):
        text = "😀" * 500
        result = host.render_result({"runtimeId": "native-" + "r" * 48, "text": text, "challenge": "c" * 48})
        self.assertIn(text, result)
        self.assertIn("/ccem confirm " + "c" * 48, result)
        self.assertLess(len(result.encode()), 3500)

    def test_unicode_events_fit_strict_delivery_with_cursor(self):
        result = host.render_result({"events": [{"title": "标题" * 60, "text": "测试" * 1000} for _ in range(5)], "sourceAvailable": True, "gapDetected": False, "nextCursor": 12345})
        self.assertLess(len(result.encode()), 3500)
        self.assertIn("12345", result)

    def test_missing_authenticated_user_is_not_stringified(self):
        context = SimpleNamespace(platform="wecom", profile="custom", transport_profile="custom", user_id=None, chat_id="recipient", thread_id=None, chat_type="dm")
        with self.assertRaises(ValueError):
            host.source_value(context, "account")
        context.user_id = "user"
        self.assertEqual(host.source_value(context, "account")["accountRef"], "account")

    def test_byte_limit_does_not_split_unicode(self):
        value = host.limit_utf8("😀中文" * 1000, 3500)
        self.assertLessEqual(len(value.encode()), 3500)
        self.assertTrue(value.endswith("…"))

    def test_history_gap_is_not_reported_as_empty_success(self):
        result = host.render_result({"events": [], "sourceAvailable": True, "gapDetected": True})
        self.assertIn("不完整", result)

    def test_registry_keeps_unsupported_and_missing_dependency_channels_distinct(self):
        entry = SimpleNamespace(name="matrix", label="Matrix", required_env=["MATRIX_TOKEN"],
                                check_fn=lambda: True, max_message_length=8000,
                                ensure_deps_fn=lambda: self.fail("status must not install"),
                                setup_fn=lambda: self.fail("status must not launch setup"))
        unsupported = host.platform_metadata(entry, lambda name: False)
        self.assertEqual(unsupported["id"], "matrix")
        self.assertTrue(unsupported["available"])
        self.assertFalse(unsupported["strictSend"])
        self.assertEqual(unsupported["unavailableReason"], "integration_unsupported")
        entry.name = "telegram"
        entry.check_fn = lambda: False
        missing = host.platform_metadata(entry, lambda name: True)
        self.assertFalse(missing["available"])
        self.assertEqual(missing["unavailableReason"], "dependency_missing")
        self.assertFalse(missing["qrSetup"])

    def test_channel_catalog_uses_passive_dependencies_and_account_identity(self):
        entry = SimpleNamespace(name="slack", label="Slack", required_env=["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
                                check_fn=lambda: True, max_message_length=39000)
        meta = host.platform_metadata(entry, lambda name: name == "slack")
        self.assertIsNone(meta["unavailableReason"])
        self.assertEqual(meta["identityFields"], ["SLACK_BOT_TOKEN"])
        self.assertEqual(meta["commandPrefix"], "!ccem")
        self.assertTrue(all(field["secret"] for field in meta["fields"]))
        self.assertEqual(meta["setupUrl"], "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack")

    def test_catalog_dependency_probe_failure_cannot_advertise_available(self):
        def broken():
            raise RuntimeError("synthetic import failure")
        entry = SimpleNamespace(name="telegram", label="Telegram", required_env=[], check_fn=broken)
        meta = host.platform_metadata(entry, lambda name: True)
        self.assertEqual(meta["unavailableReason"], "dependency_missing")
        self.assertNotIn("synthetic", str(meta))

    def test_discord_replies_fit_without_cutting_confirmation_or_cursor(self):
        preview = {"runtimeId": "native-" + "r" * 48, "text": "x" * 1400, "challenge": "c" * 48}
        rendered = host.render_result(preview, 2000)
        self.assertIn(preview["text"], rendered)
        self.assertIn("/ccem confirm " + preview["challenge"], rendered)
        self.assertLessEqual(len(rendered.encode()), 2000)
        with self.assertRaisesRegex(ValueError, "confirmation_preview_too_large"):
            host.render_result({**preview, "text": "x" * 2000}, 2000)
        history = host.render_result({"events": [{"title": "t", "text": "😀" * 1000}] * 5,
                                      "sourceAvailable": True, "nextCursor": 123}, 2000)
        self.assertLessEqual(len(history.encode()), 2000)
        self.assertIn("123", history)
        operation = host.render_result({"operationId": "h" * 55, "state": "completed", "detail": "x" * 4000}, 2000)
        self.assertLessEqual(len(operation.encode()), 2000)

    def test_slack_commands_use_message_prefix_and_preserve_input_verbatim(self):
        instruction = "Preserve /ccem operation inside task text"
        result = host.render_result({"runtimeId": "runtime", "text": instruction, "challenge": "challenge"}, 3500, "!ccem")
        self.assertIn(instruction, result)
        self.assertIn("!ccem confirm challenge", result)
        self.assertIn("!ccem cancel challenge", result)
        notification = "body\n/ccem operation example\nmore text\n/ccem status runtime"
        self.assertEqual(host.notification_text(notification, "slack"), "body\n/ccem operation example\nmore text\n!ccem status runtime")
        self.assertEqual(host.notification_text(notification, "wecom"), notification)

if __name__ == "__main__":
    unittest.main()
