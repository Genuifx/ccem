#!/usr/bin/env python3
"""Verify packaged native profile resources without touching the user's home."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

parser = argparse.ArgumentParser()
parser.add_argument("--package", type=Path, required=True)
args, remaining = parser.parse_known_args()
package = args.package.resolve(strict=True)
temporary = tempfile.TemporaryDirectory(prefix="ccem-native-profile-")
real_home = Path(temporary.name) / "user"
real_home.mkdir()
os.environ.clear()
os.environ.update(HOME=str(real_home), HERMES_REAL_HOME=str(real_home),
    HERMES_HOME=str(Path(temporary.name) / "host"), PATH="/usr/bin:/bin",
    HERMES_SAFE_MODE="1", HERMES_DISABLE_LAZY_INSTALLS="1")
sys.path.insert(0, str(package / "source"))
sys.dont_write_bytecode = True
fixture = Path(temporary.name) / "bundle"
fixture.mkdir()
for name in ("ccem_gateway_host.py", "ccem_gateway_onboarding.py", "ccem_gateway_conversation.py"):
    shutil.copy2(Path(__file__).with_name(name), fixture / name)
shutil.copytree(Path(__file__).resolve().parents[2] / "packages/agent-skills/ccem",
    fixture / "bundled-skills/ccem")
spec = importlib.util.spec_from_file_location("native_profile_host_test", fixture / "ccem_gateway_host.py")
host_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_module)


class NativeProfile(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = Path(tempfile.mkdtemp(dir=temporary.name))
        self.host = host_module.Host({"protocolVersion": 1, "token": "x" * 48,
            "endpoint": "http://127.0.0.1:1/rpc", "toolsMode": "native"}, self.home)

    async def test_native_seeds_real_skills_and_keeps_profile_settings(self):
        import yaml
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from agent.skill_utils import _external_dirs_cache_clear
        from tools.skills_tool import skills_list, skill_view
        installed = real_home / ".hermes/skills/owner-fixture"
        installed.mkdir(parents=True, exist_ok=True)
        original_skill = "---\nname: owner-fixture\ndescription: Local owner fixture\n---\nKeep owner skills intact.\n"
        (installed / "SKILL.md").write_text(original_skill)
        (real_home / ".hermes/.env").write_text("FAKE_OTHER_BOT_TOKEN=not-a-real-token\n")
        config = host_module._conversation_module.configuration("native")
        config.update({"agent": {"max_turns": 23}, "terminal": {"timeout": 71}})
        (self.home / "config.yaml").write_text(json.dumps(config))
        self.host.prepare_conversation_home(self.home, "native")
        saved = yaml.safe_load((self.home / "config.yaml").read_text())
        self.assertEqual(saved["agent"]["max_turns"], 23)
        self.assertEqual(saved["terminal"]["timeout"], 71)
        self.assertEqual(saved["terminal"]["backend"], "local")
        self.assertEqual(saved["terminal"]["home_mode"], "real")
        self.assertTrue(Path(saved["terminal"]["cwd"]).is_dir())
        self.assertEqual(saved["skills"]["external_dirs"], [str(installed.parent)])
        self.assertFalse((self.home / ".env").exists())
        self.assertEqual((installed / "SKILL.md").read_text(), original_skill)
        token = set_hermes_home_override(self.home)
        try:
            _external_dirs_cache_clear()
            listing = skills_list()
            self.assertIn("ccem", listing)
            self.assertIn("owner-fixture", listing)
            self.assertIn("cron list", skill_view("ccem"))
            self.assertIn("Keep owner skills intact", skill_view("owner-fixture"))
            self.assertGreater(len(list((self.home / "skills").rglob("SKILL.md"))), 10)
        finally:
            reset_hermes_home_override(token)
            _external_dirs_cache_clear()
        before = (self.home / "config.yaml").read_bytes()
        self.host.prepare_conversation_home(self.home, "native")
        self.assertEqual((self.home / "config.yaml").read_bytes(), before)

    async def test_restricted_profile_does_not_gain_local_resources(self):
        self.host.prepare_conversation_home(self.home, "ccem")
        self.assertEqual(list(self.home.iterdir()), [])


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *remaining])
