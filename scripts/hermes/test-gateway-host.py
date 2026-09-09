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

if __name__ == "__main__":
    unittest.main()
