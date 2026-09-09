#!/usr/bin/env python3
"""REQ-0007 local contract probe, never a platform acceptance test.

Run with an explicit Hermes checkout and its Python. Workers get a temporary
HERMES_HOME and no inherited credentials. They invoke real Hermes functions
with synthetic inputs; filesystem access, sockets and subprocesses are guarded.
Exit 2 means the integration gate is incomplete, not that the report was lost.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch


class ProbeIOGuard:
    """Prevent reviewed Python imports from reaching live profiles or changing files.

    This is a regression guard, not an OS sandbox for hostile Python/native code.
    Only the worker's temporary directory is writable; source reads are code only.
    """

    def __init__(self, source, temporary_root, runtime_roots):
        self.source = source.resolve()
        self.temporary_root = temporary_root.resolve()
        self.runtime_roots = tuple(root.resolve() for root in runtime_roots)

    def is_temporary(self, path):
        return path.is_relative_to(self.temporary_root)

    def check_path(self, value, *, write=False):
        if isinstance(value, int):
            # Standard streams are already bound by the parent, never user files.
            if value in (0, 1, 2):
                return
            raise PermissionError("Probe file descriptor access denied")
        path = Path(os.fsdecode(value)).resolve()
        if path == Path(os.devnull) or self.is_temporary(path):
            return
        if write:
            raise PermissionError("Probe write outside temporary directory denied")
        if path.name == ".env" or path.name.startswith(".env."):
            raise PermissionError("Probe external environment file read denied")
        if any(path.is_relative_to(root) for root in self.runtime_roots):
            return
        if path.is_relative_to(self.source) and path.suffix in (".py", ".pyc", ".so", ".pyd"):
            return
        raise PermissionError("Probe external data file read denied")

    def __call__(self, event, args):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.bind", "socket.sendto", "socket.sendmsg",
                     "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.fork", "os.forkpty"}:
            raise PermissionError("External I/O disabled by CCEM contract probe")
        if event == "open":
            # CPython's open audit event omits dir_fd. A relative name could be
            # resolved against an external directory descriptor, not cwd.
            if not isinstance(args[0], int) and not Path(os.fsdecode(args[0])).is_absolute():
                raise PermissionError("Probe relative file open denied")
            flags = args[2] or 0
            write = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            self.check_path(args[0], write=write)
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown",
                       "os.utime", "os.truncate"}:
            # dir_fd-relative mutations are not used by these imports. Refuse
            # them, rather than interpreting the path against the wrong directory.
            dir_fd_index = {"os.remove": 1, "os.rmdir": 1, "os.mkdir": 2,
                            "os.chmod": 2, "os.chown": 3, "os.utime": 3}.get(event)
            if dir_fd_index is not None and args[dir_fd_index] not in (None, -1):
                raise PermissionError("Probe relative directory descriptor denied")
            self.check_path(args[0], write=True)
        elif event in {"os.rename", "os.link", "os.symlink"}:
            # These operations are unnecessary for contract probes, even inside
            # the temporary directory; disallow symlink/hardlink escape entirely.
            raise PermissionError("Probe link/rename denied")
        elif event == "os.chdir":
            self.check_path(args[0], write=True)


def probe_receipts():
    from hermes_cli.send_cmd import _emit_result, _read_message_body
    receipts = []
    for payload in [{"success": True, "message_id": "synthetic-message"},
                    {"success": True, "skipped": True}, {"error": "synthetic-error"}]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = _emit_result(json.dumps(payload), json_mode=True, quiet=False)
        receipts.append({"payload": payload, "exitCode": code,
                         "roundTrip": json.loads(output.getvalue()) == payload})
    with patch("sys.stdin", io.StringIO("literal $(no-shell)\n中文")):
        stdin_literal = _read_message_body(None, "-") == "literal $(no-shell)\n中文"
    return {"status": "observed", "receipts": receipts, "literalStdin": stdin_literal,
            "platformSendPerformed": False}


def probe_command_context():
    from gateway.run_inbound import GatewayInboundMixin
    from gateway.session_context import get_session_env, reset_session_vars
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

    manager = PluginManager()
    ctx = PluginContext(PluginManifest(name="ccem-contract-probe", version="0.1.0",
                                      description="Local synthetic probe"), manager)
    received = []

    async def handler(raw_args, *args, **kwargs):
        received.append({"rawArgs": raw_args, "extraArgCount": len(args),
                         "keywordNames": sorted(kwargs),
                         "ambientIdentityPresent": any(get_session_env(key, "") for key in (
                             "HERMES_SESSION_USER_ID", "HERMES_SESSION_CHAT_ID",
                             "HERMES_SESSION_MESSAGE_ID"))})
        return "probe-handled"

    ctx.register_command("ccem-contract-probe", handler)
    registered = manager._plugin_commands["ccem-contract-probe"]["handler"]
    runner = SimpleNamespace(_draining=False, _hm_quick_commands=lambda: {})

    async def dispatch():
        results = []
        for identity in ("synthetic-alice", "synthetic-bob"):
            reset_session_vars()
            source = SimpleNamespace(user_id=identity, chat_id="synthetic-chat",
                                     message_id="synthetic-message-" + identity)
            event = SimpleNamespace(source=source,
                                    get_command_args=lambda: 'status {"identity":"claimed-admin"}')
            # Keep the actual registry registration and actual dispatch implementation;
            # replace discovery only, so this probe cannot load unrelated user plugins.
            with patch("hermes_cli.plugins.get_plugin_command_handler", return_value=registered):
                results.append(await GatewayInboundMixin._hm_dispatch_quick_and_plugin_commands(
                    runner, event, source, "ccem-contract-probe"))
        return results

    results = asyncio.run(dispatch())
    if len(received) != 2 or not all(result[0] for result in results):
        return {"status": "blocked", "reason": "COMMAND_DISPATCH_NOT_OBSERVED",
                "handlerCallCount": len(received), "dispatchHandled": [r[0] for r in results]}
    missing = all(item["extraArgCount"] == 0 and not item["keywordNames"]
                  and not item["ambientIdentityPresent"] for item in received)
    return {"status": "blocked" if missing else "needs_review",
            "reason": "COMMAND_SOURCE_CONTEXT_UNAVAILABLE" if missing else "NEW_CONTEXT_REQUIRES_AUTH_REVIEW",
            "handlerObservations": received, "dispatchHandled": [r[0] for r in results],
            "scope": "Real command dispatcher slice; ingress authorization and real chats not exercised"}


def probe_gateway_send():
    from gateway.config import Platform
    from plugins.platforms.wecom import adapter as wecom

    actions = []

    class Adapter:
        def __init__(self, _config=None):
            actions.append("construct")

        async def connect(self):
            actions.append("connect")
            return True

        async def send(self, chat_id, message):
            actions.append("send")
            return SimpleNamespace(success=True, message_id="synthetic-message")

        async def disconnect(self):
            actions.append("disconnect")

    async def run(live):
        adapter = Adapter() if live else None
        actions.clear()
        runner = SimpleNamespace(adapters={Platform.WECOM: adapter}) if live else None
        # Only the SDK and process-local runner lookup are synthetic. This runs
        # Hermes' actual standalone sender, including its adapter ownership choice.
        # The runner lookup is the synthetic boundary. Do not import gateway.run:
        # importing the entire runner loads the checkout's project .env.
        with patch.dict(sys.modules, {"gateway.run": SimpleNamespace(_gateway_runner_ref=lambda: runner)}), \
             patch.object(wecom, "WeComAdapter", Adapter), \
             patch.object(wecom, "check_wecom_requirements", return_value=True):
            receipt = await wecom._standalone_send(None, "synthetic-chat", "synthetic-body")
        return {"actions": list(actions), "success": receipt.get("success") is True}

    standalone = asyncio.run(run(False))
    live = asyncio.run(run(True))
    return {"status": "blocked" if "connect" in standalone["actions"] else "needs_review",
            "reason": "STANDALONE_SEND_OPENS_SECOND_CONNECTION",
            "standalone": standalone, "inProcess": live, "networkConnections": 0,
            "scope": "Real Hermes sender with fake SDK; does not prove a real connection was displaced"}


PROBES = {"receipts": probe_receipts, "command-context": probe_command_context,
          "gateway-send": probe_gateway_send}


def run_worker(source, name):
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    guard = ProbeIOGuard(source, Path.cwd(), (Path(sys.prefix), Path(sys.base_prefix)))
    sys.addaudithook(guard)
    started = time.monotonic()
    # Keep third-party import diagnostics out of the machine-readable receipt.
    # Only synthetic observations and exception types leave the worker.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            result = PROBES[name]()
        except Exception as error:
            result = {"status": "blocked", "reason": "PROBE_RUNTIME_UNAVAILABLE",
                      "errorType": type(error).__name__}
            if isinstance(error, ModuleNotFoundError):
                result["missingModule"] = error.name
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def git_value(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], capture_output=True,
                            text=True, timeout=10, check=True)
    return result.stdout.strip()


def run_probe(source, python, output):
    if not source.is_dir() or not python.is_file():
        raise ValueError("Explicit Hermes source directory and Python executable are required")
    source = source.resolve()
    if Path(git_value(source, "rev-parse", "--show-toplevel")).resolve() != source:
        raise ValueError("--source must be the root of the Hermes checkout")
    head = git_value(source, "rev-parse", "HEAD")
    source_dirty = bool(git_value(source, "status", "--porcelain", "--untracked-files=no"))
    lock = source / "uv.lock"
    report = {"schemaVersion": 1, "stage": "0a-local-contracts", "stage0Passed": False,
              "livePlatformVerified": False, "sourceCommit": head, "trackedSourceDirty": source_dirty,
              "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None,
              "host": {"system": platform.system(), "machine": platform.machine()}, "probes": {}}
    with tempfile.TemporaryDirectory(prefix="ccem-hermes-probe-") as directory:
        root = Path(directory)
        for name in PROBES:
            home = root / name
            home.mkdir()
            (home / "config.yaml").write_text("plugins:\n  enabled: []\n", encoding="utf8")
            (home / ".env").write_text("", encoding="utf8")
            env = {"PATH": "/usr/bin:/bin", "HERMES_HOME": str(home),
                   "HERMES_MANAGED_DIR": str(root / "managed"),
                   "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                   "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "NO_COLOR": "1"}
            if os.name == "nt" and "SYSTEMROOT" in os.environ:
                env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
            try:
                completed = subprocess.run(
                    [str(python), str(Path(__file__).resolve()), "--source", str(source), "--worker", name],
                    cwd=root, env=env, capture_output=True, timeout=30, check=False)
                if completed.returncode != 0 or len(completed.stdout) > 65536:
                    raise ValueError("Invalid worker receipt")
                result = json.loads(completed.stdout.decode("utf8", errors="strict"))
            except (subprocess.TimeoutExpired, ValueError, UnicodeError, OSError) as error:
                result = {"status": "blocked", "reason": "PROBE_FAILED", "errorType": type(error).__name__}
            report["probes"][name] = result
    report["remainingGates"] = [
        "Versioned trusted inbound context and native confirmation contract",
        "Single gateway connection, exact account/target, scoped send contract",
        "CCEM scoped RPC, durable operation deduplication and input/event correlation",
        "Signed runtime artifacts, clean-machine measurements and failure recovery",
        "Authorized real platform acceptance and UI onboarding smoke",
    ]
    if source_dirty:
        report["remainingGates"].insert(0, "Tracked source differs from the recorded commit")
    report["sourceChangedDuringProbe"] = (
        git_value(source, "rev-parse", "HEAD") != head
        or bool(git_value(source, "status", "--porcelain", "--untracked-files=no")) != source_dirty)
    if report["sourceChangedDuringProbe"]:
        report["remainingGates"].insert(0, "Source changed during probing; rerun against a frozen checkout")
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf8")
    print(rendered, end="")
    return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=PROBES, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        return run_worker(args.source, args.worker)
    try:
        return run_probe(args.source, args.python.absolute(), args.output)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"stage0Passed": False, "errorType": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
