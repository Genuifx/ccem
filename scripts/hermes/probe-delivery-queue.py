#!/usr/bin/env python3
"""Observe Hermes delivery contracts with synthetic data and no platform sends.

Use an explicit reviewed Hermes checkout and notification bridge. All actual
Hermes execution happens in a clean Python -I worker using ProbeIOGuard from
probe-compatibility.py. The parent snapshots source, writes the report and cleans
its temporary directory after the worker exits. This is not an OS sandbox for
hostile Python/native code and never certifies a real account or integration.

Exit 2 means contract gaps were observed; exit 1 means observation failed closed.
Exit 0 only means these synthetic cases observed no known gaps.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types

SOURCE_FILES = {
    "queue": "cron/delivery_queue.py",
    "scheduler": "cron/scheduler_delivery.py",
    "async": "agent/async_utils.py",
    "wecom": "plugins/platforms/wecom/adapter.py",
}
REQUIRED_FUNCTIONS = {
    "queue": {"enqueue", "get_status", "claim_next", "drain", "_finish", "_transaction",
              "_prune_terminal_unlocked", "_terminalize_wait_timeout", "enqueue_and_wait",
              "recover_abandoned", "_path"},
    "scheduler": {"_deliver_result", "_deliver_via_live_adapter", "_live_send_text", "_deliver_standalone"},
    "async": {"safe_schedule_threadsafe"},
    "wecom": {"_send_inner"},
    "notify": {"validate_request", "handle_request", "narrow_result", "attachment_content"},
}
SOURCES: dict[str, str] = {}
FILES: dict[str, Path] = {}
NOTIFY: Path | None = None


class IncompatibleSource(Exception):
    pass


def exact_functions(source, names, filename):
    tree = ast.parse(source, filename=filename)
    selected_nodes = []
    for name in sorted(names):
        matches = [node for node in ast.walk(tree)
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        if len(matches) != 1:
            raise IncompatibleSource()
        selected_nodes.append(matches[0])
    return selected_nodes


def selected(name, names, namespace):
    nodes = exact_functions(SOURCES[name], names, str(FILES[name]))
    code = "from __future__ import annotations\n" + "\n".join(ast.unparse(node) for node in nodes)
    exec(compile(code, str(FILES[name]), "exec"), namespace)


def module(name, **attrs):
    value = types.ModuleType(name)
    value.__dict__.update(attrs)
    sys.modules[name] = value
    return value

def new_queue(root):
    module("agent")
    module("agent.redact", redact_sensitive_text=lambda text, **kw: text)
    module("cron")
    module("cron.executions", _owner_is_live=lambda *args: False, _process_start_time=lambda pid: 1)
    module("hermes_cli")
    def add_column(conn, table, column, ddl):
        if column not in {row[1] for row in conn.execute("PRAGMA table_info(" + table + ")")}:
            conn.execute("ALTER TABLE " + table + " ADD COLUMN " + ddl)
    module("hermes_cli.sqlite_util", add_column_if_missing=add_column)
    module("hermes_constants", get_hermes_home=lambda: root)
    module("hermes_time", now=lambda: datetime.now(timezone.utc))
    module("hermes_state_wal",
           apply_wal_with_fallback=lambda conn, **kw: conn.execute("PRAGMA journal_mode=WAL"))
    queue = module("synthetic_queue")
    exec(compile(SOURCES["queue"], str(FILES["queue"]), "exec"), queue.__dict__)
    queue.DELIVERY_DB = root / "deliveries.db"
    return queue

def request(identity, message="synthetic-only"):
    return {
        "operation": "enqueue", "notification_id": identity, "message": message,
        "job": {
            "id": "synthetic-job", "name": "Synthetic review",
            "execution_id": identity, "deliver": "wecom:synthetic-chat",
            "attach_to_session": True,
            "origin": {"platform": "wecom", "chat_id": "synthetic-chat",
                       "user_id": "synthetic-user", "chat_type": "dm"},
        },
    }

def run_observations(root):
    directory = root
    queue = new_queue(Path(directory))
    notify = {"__name__": "synthetic_notify"}
    exec(compile(SOURCES["notify"], str(NOTIFY), "exec"), notify)
    handle = notify["handle_request"]
    counts = {"normal": 0, "ack_lost": 0}
    def normal(*args):
        counts["normal"] += 1
    first = request("synthetic-once")
    handle(first, queue)
    handle(first, queue)
    try:
        handle(request("synthetic-once", "different-before-terminal"), queue)
    except notify["BridgeError"] as error:
        pending_conflict = error.code
    else:
        pending_conflict = None
    queue.drain(normal)
    after = handle(first, queue)
    queue.drain(normal)
    terminal_changed_payload = handle(request("synthetic-once", "different-after-terminal"), queue)
    queue.MAX_TERMINAL_DELIVERIES = 0
    with queue._transaction() as conn:
        queue._prune_terminal_unlocked(conn)
    tombstone = queue.get_status("synthetic-once")
    handle(first, queue)
    queue.drain(normal)
    dedup = {
        "sendCallbackCount": counts["normal"],
        "status": after["status"],
        "pendingPayloadConflict": pending_conflict,
        "differentTerminalPayloadReturnsOriginalConfirmed": terminal_changed_payload["confirmed"],
        "retainedTombstoneStatus": tombstone["status"],
    }
    queue.MAX_TERMINAL_DELIVERIES = 1000

    pending = request("synthetic-pending")
    pending_wait = queue.enqueue_and_wait(
        pending["notification_id"], pending["job"], pending["message"], timeout=0)
    pending_status = queue.get_status(pending["notification_id"])["status"]
    queue.drain(normal)

    uncertain = request("synthetic-unknown")
    handle(uncertain, queue)
    queue.claim_next()
    queue._terminalize_wait_timeout(uncertain["notification_id"])
    late_finish = queue._finish(uncertain["notification_id"], error=None)
    before = counts["normal"]
    handle(uncertain, queue)
    queue.drain(normal)
    unknown = {
        "status": queue.get_status(uncertain["notification_id"])["status"],
        "lateSuccessCanOverwriteUnknown": late_finish,
        "repeatCausesAnotherCallback": counts["normal"] != before,
    }
    failed = request("synthetic-ack-lost")
    handle(failed, queue)
    def ack_lost(*args):
        counts["ack_lost"] += 1
        raise RuntimeError("synthetic lost confirmation after send attempt")
    queue.drain(ack_lost)
    handle(failed, queue)
    queue.drain(ack_lost)
    failed_outcome = {
        "status": queue.get_status(failed["notification_id"])["status"],
        "callbackCount": counts["ack_lost"],
        "failureDoesNotProveUnattempted": True,
    }

    # Run actual sender control flow. Only transport/config/media/mirror boundaries
    # are synthetic; shorten the Future wait to 0.2s, preserving real cancel().
    started, cancelled = threading.Event(), threading.Event()
    loop = asyncio.new_event_loop()
    owner = threading.Thread(target=loop.run_forever, daemon=True)
    owner.start()
    attempts = {"live": 0, "standalone": 0, "cancelReturned": None}
    async_ns = {"asyncio": asyncio, "logging": logging, "_DEFAULT_LOGGER": logging.getLogger("review")}
    selected("async", {"safe_schedule_threadsafe"}, async_ns)
    def schedule(coro, loop):
        actual = async_ns["safe_schedule_threadsafe"](coro, loop)
        class FutureProxy:
            def result(self, timeout):
                return actual.result(timeout=0.2)
            def cancel(self):
                value = actual.cancel()
                attempts["cancelReturned"] = value
                return value
        return FutureProxy()
    module("agent.async_utils", safe_schedule_threadsafe=schedule)
    class Router:
        def __init__(self, *args):
            pass
        async def _deliver_to_platform(self, *args):
            attempts["live"] += 1
            started.set()
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()
    module("gateway")
    module("gateway.delivery", DeliveryRouter=Router, DeliveryTarget=lambda **kw: types.SimpleNamespace(**kw))
    module("gateway.config", load_gateway_config=lambda: object())
    module("gateway.platforms")
    base = types.SimpleNamespace(extract_media=lambda content: ([], content),
                                 filter_media_delivery_paths=lambda media: media)
    module("gateway.platforms.base", BasePlatformAdapter=base)
    module("gateway.media_policy", apply_media_policy_env=lambda config: None)
    retry_request = request("synthetic-one-row-two-attempts")
    t = types.SimpleNamespace(
        job=retry_request["job"], platform="wecom", platform_name="wecom",
        chat_id="synthetic-chat", thread_id=None, where="wecom:synthetic-chat",
        config=object(), target_adapters=object(), loop=loop, is_relay=False,
        live_adapter_ready=True, mirror_text="synthetic-only",
        origin_user_id="synthetic-user", mirror_this_target=False)
    def standalone(*args):
        attempts["standalone"] += 1
        return {"success": True}, None
    delivery_ns = {
        "os": os, "contextlib": contextlib, "logger": logging.getLogger("review"),
        "_sched": types.SimpleNamespace(load_config=lambda: {"cron": {"wrap_response": False}}),
        "_resolve_delivery_targets": lambda *args, **kw: [{"platform": "wecom", "chat_id": "synthetic-chat"}],
        "_cron_delivery_notify_enabled": lambda config: True,
        "_cron_mirror_delivery_enabled": lambda *args: False,
        "_prepare_target_delivery": lambda *args, **kw: t,
        "_record_delivery_verification": lambda *args: None,
        "_live_route_metadata": lambda target: (None, {"job_id": target.job["id"]}, {}),
        "_warn_live_lane_failure": lambda *args: None,
        "_seed_live_delivery_sessions": lambda *args: None,
        "_maybe_mirror_cron_delivery": lambda *args, **kw: None,
        "_standalone_send": standalone, "BOT_CHAT_PLATFORM": "bot-chat",
    }
    selected("scheduler", {
        "_deliver_result", "_deliver_via_live_adapter", "_live_send_text", "_deliver_standalone"
    }, delivery_ns)
    handle(retry_request, queue)
    queue.drain(lambda job, content, failure: delivery_ns["_deliver_result"](
        job, content, adapters=object(), loop=loop, for_failure=failure))
    cancelled.wait(2)
    loop.call_soon_threadsafe(loop.stop)
    owner.join(2)
    loop.close()
    one_claim = {
        "coroutineEnteredBeforeTimeout": started.is_set(),
        **attempts,
        "queueStatus": queue.get_status(retry_request["notification_id"])["status"],
        "waitScaledFrom60SecondsTo": 0.2,
    }

    # Actual WeCom _send_inner passive-timeout fallback, without a WebSocket.
    passive_attempts = []
    async def passive(*args):
        passive_attempts.append("passive")
        raise asyncio.TimeoutError("synthetic lost passive confirmation")
    async def proactive(*args):
        passive_attempts.append("proactive")
        return {"errcode": 0, "headers": {"req_id": "synthetic-ack"}}
    sender = types.SimpleNamespace(
        _group_chat_ids=set(), _cached_reply_req_id=lambda *args: "synthetic-reply",
        _send_reply_markdown=passive, _send_proactive_markdown=proactive,
        _response_error=lambda response: None,
        _payload_req_id=lambda response: response["headers"]["req_id"], name="synthetic")
    wecom_ns = {"asyncio": asyncio, "logger": logging.getLogger("review"),
                "SendResult": lambda **kw: types.SimpleNamespace(**kw)}
    selected("wecom", {"_send_inner"}, wecom_ns)
    passive_result = asyncio.run(wecom_ns["_send_inner"](sender, "synthetic-chat", "synthetic-only"))

    # Two separately loaded queue modules have separate Python locks, like two
    # processes. Pause one producer after its tombstone SELECT has returned and
    # let another module prune the terminal row before the producer's INSERT.
    race_request = request("synthetic-pruning-race")
    before_race = counts["normal"]
    handle(race_request, queue)
    queue.drain(normal)
    other_queue = new_queue(Path(directory))
    other_queue.MAX_TERMINAL_DELIVERIES = 0
    original_transaction = queue._transaction
    selected_before_prune, pruning_finished = threading.Event(), threading.Event()
    class CursorProxy:
        def __init__(self, cursor):
            self.cursor = cursor
        def fetchone(self):
            row = self.cursor.fetchone()
            selected_before_prune.set()
            assert pruning_finished.wait(3)
            return row
    class ConnectionProxy:
        def __init__(self, conn):
            self.conn = conn
        def execute(self, sql, *args):
            cursor = self.conn.execute(sql, *args)
            return CursorProxy(cursor) if sql.startswith("SELECT terminal_status, finished_at") else cursor
    @contextlib.contextmanager
    def paused_transaction():
        with original_transaction() as conn:
            yield ConnectionProxy(conn)
    queue._transaction = paused_transaction
    race_reply = {}
    producer = threading.Thread(daemon=True, target=lambda: race_reply.update(
        queue.enqueue(race_request["notification_id"], race_request["job"], race_request["message"])))
    producer.start()
    assert selected_before_prune.wait(3)
    with other_queue._transaction() as conn:
        other_queue._prune_terminal_unlocked(conn)
    pruning_finished.set()
    producer.join(3)
    queue._transaction = original_transaction
    with queue._transaction() as conn:
        retained = conn.execute("SELECT COUNT(*) FROM delivery_tombstones WHERE execution_id=?",
                                (race_request["notification_id"],)).fetchone()[0]
    queue.drain(normal)
    pruning_race = {
        "producerReturnedStatus": race_reply["status"],
        "tombstoneStillPresent": retained == 1,
        "sameIdTotalCallbackCount": counts["normal"] - before_race,
        "crossProcessLockSemanticsModeledByIndependentModules": True,
        "onlyPausedBetweenActualSelectAndInsert": True,
    }
    return {
        "syntheticOnly": True, "realProfileRead": False, "realTransportUsed": False,
        "actualQueueSourceExecuted": True,
        "helperDependenciesStubbed": ["clock", "owner liveness", "redaction", "SQLite WAL setup"],
        "sourceSha256": {name: hashlib.sha256(source.encode()).hexdigest() for name, source in SOURCES.items()},
        "sameIdDedup": dedup,
        "pendingWait": {"returnedNone": pending_wait is None, "status": pending_status},
        "unknown": unknown, "failed": failed_outcome,
        "singleQueueClaimCanAttemptTwoSends": one_claim,
        "wecomPassiveTimeoutFallback": {"attempts": passive_attempts, "success": passive_result.success},
        "concurrentTombstonePruningRace": pruning_race,
    }


def contract_gaps(observations):
    gaps = []
    dedup = observations["sameIdDedup"]
    if dedup["sendCallbackCount"] != 1:
        gaps.append("SEQUENTIAL_ID_REPLAY_NOT_DEDUPLICATED")
    if dedup["pendingPayloadConflict"] != "identity_conflict":
        gaps.append("PENDING_PAYLOAD_BINDING_UNAVAILABLE")
    if dedup["differentTerminalPayloadReturnsOriginalConfirmed"]:
        gaps.append("TERMINAL_PAYLOAD_BINDING_UNAVAILABLE")
    pending = observations["pendingWait"]
    if pending["returnedNone"] and pending["status"] == "pending":
        gaps.append("PENDING_WAIT_RETURNS_NO_ERROR_WHILE_PENDING")
    unknown = observations["unknown"]
    if unknown["lateSuccessCanOverwriteUnknown"] or unknown["repeatCausesAnotherCallback"]:
        gaps.append("UNKNOWN_DELIVERY_FENCE_FAILED")
    if observations["failed"]["status"] == "failed":
        gaps.append("SEND_ERROR_DOES_NOT_DISTINGUISH_UNKNOWN")
    attempts = observations["singleQueueClaimCanAttemptTwoSends"]
    if attempts["coroutineEnteredBeforeTimeout"] and attempts["live"] and attempts["standalone"]:
        gaps.append("LIVE_TIMEOUT_RETRIES_AFTER_DISPATCH")
    if observations["wecomPassiveTimeoutFallback"]["attempts"] == ["passive", "proactive"]:
        gaps.append("WECOM_PASSIVE_TIMEOUT_RETRIES_PROACTIVELY")
    if observations["concurrentTombstonePruningRace"]["sameIdTotalCallbackCount"] != 1:
        gaps.append("TOMBSTONE_PRUNING_CAN_RESURRECT_ID")
    return gaps


def digest(data):
    return hashlib.sha256(data).hexdigest()


def install_guard(root, source, guard_bytes):
    tree = ast.parse(guard_bytes.decode("utf8"))
    definitions = [node for node in tree.body
                   if isinstance(node, ast.ClassDef) and node.name == "ProbeIOGuard"]
    if len(definitions) != 1:
        raise IncompatibleSource()
    namespace = {"Path": Path, "os": os}
    # Reuse the current guard implementation verbatim; do not fork its I/O policy.
    exec(compile(ast.Module(body=definitions, type_ignores=[]), "ProbeIOGuard", "exec"), namespace)
    sys.addaudithook(namespace["ProbeIOGuard"](
        source, root, (Path(sys.prefix), Path(sys.base_prefix))))


def worker(root):
    global SOURCES, FILES, NOTIFY
    root = root.resolve(strict=True)
    if not sys.flags.isolated or Path.cwd().resolve() != root:
        raise ValueError()
    if os.environ.get("HERMES_HOME") != str(root / "home"):
        raise ValueError()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf8"))
    guard_bytes = (root / "sources" / "guard.py").read_bytes()
    if digest(guard_bytes) != manifest["guardSha256"]:
        raise IncompatibleSource()
    install_guard(root, Path(manifest["sourceRoot"]), guard_bytes)
    FILES = {name: root / "sources" / (name + ".py") for name in REQUIRED_FUNCTIONS}
    SOURCES = {}
    for name, filename in FILES.items():
        data = filename.read_bytes()
        if digest(data) != manifest["sourceSha256"][name]:
            raise IncompatibleSource()
        SOURCES[name] = data.decode("utf8")
        exact_functions(SOURCES[name], REQUIRED_FUNCTIONS[name], str(filename))
    NOTIFY = FILES["notify"]
    logging.disable(logging.CRITICAL)
    observations = run_observations(root)
    gaps = contract_gaps(observations)
    return {
        "schemaVersion": 1, "status": "contract_gaps_observed" if gaps else "observed",
        "stage0Passed": False, "livePlatformVerified": False,
        "probeSha256": manifest["probeSha256"], "guardSha256": manifest["guardSha256"],
        "guardImplementation": "ProbeIOGuard from sibling probe-compatibility.py",
        "sourceSha256": manifest["sourceSha256"], "contractGaps": gaps,
        "isolation": {"pythonIsolated": bool(sys.flags.isolated), "temporaryHermesHome": True,
                      "credentialsInherited": False, "parentCleansAfterWorkerExit": True},
        "scope": {
            "sqliteConcurrency": "Separate loaded modules, locks and SQLite connections model different processes",
            "asyncCancellation": "Actual run_coroutine_threadsafe Future; only result timeout scaled from 60s to 0.2s",
            "platformTransport": "Synthetic callbacks only; no platform or account contacted",
            "exceptions": "Observation errors are fail-closed and report only their type",
        },
        "observations": observations,
    }


def blocked(error):
    return {"schemaVersion": 1, "status": "blocked", "stage0Passed": False,
            "livePlatformVerified": False, "errorType": type(error).__name__}


def collect_inputs(source, notify_bridge):
    source = source.resolve(strict=True)
    notify_bridge = notify_bridge.resolve(strict=True)
    if not source.is_dir() or not notify_bridge.is_file() or notify_bridge.suffix != ".py":
        raise ValueError()
    paths = {}
    for name, relative in SOURCE_FILES.items():
        path = (source / relative).resolve(strict=True)
        if not path.is_relative_to(source) or not path.is_file():
            raise ValueError()
        paths[name] = path
    paths["notify"] = notify_bridge
    inputs = {name: path.read_bytes() for name, path in paths.items()}
    for data in inputs.values():
        if len(data) > 2 * 1024 * 1024:
            raise ValueError()
        data.decode("utf8")
    return source, inputs


def run_parent(source, notify_bridge):
    source, inputs = collect_inputs(source, notify_bridge)
    script = Path(__file__).resolve()
    guard_bytes = script.with_name("probe-compatibility.py").read_bytes()
    manifest = {
        "sourceRoot": str(source), "probeSha256": digest(script.read_bytes()),
        "guardSha256": digest(guard_bytes),
        "sourceSha256": {name: digest(data) for name, data in inputs.items()},
    }
    # Parent has no audit hook. It removes only its own temporary fixtures after
    # subprocess.run has reaped the worker, including timeout/error paths.
    with tempfile.TemporaryDirectory(prefix="ccem-delivery-queue-probe-") as directory:
        root = Path(directory).resolve()
        (root / "sources").mkdir()
        (root / "home").mkdir()
        (root / "tmp").mkdir()
        (root / "home" / ".env").write_bytes(b"")
        (root / "home" / "config.yaml").write_text("plugins:\n  enabled: []\n", encoding="utf8")
        for name, data in inputs.items():
            (root / "sources" / (name + ".py")).write_bytes(data)
        (root / "sources" / "guard.py").write_bytes(guard_bytes)
        (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf8")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"),
               "HERMES_HOME": str(root / "home"), "HERMES_MANAGED_DIR": str(root / "managed"),
               "TMPDIR": str(root / "tmp"), "PYTHONDONTWRITEBYTECODE": "1",
               "PYTHONNOUSERSITE": "1", "PYTHONUNBUFFERED": "1", "NO_COLOR": "1"}
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(script), "--worker", str(root)],
            cwd=root, env=env, capture_output=True, timeout=30, check=False)
        if completed.returncode not in (0, 1, 2) or len(completed.stdout) > 65536:
            raise ValueError()
        report = json.loads(completed.stdout.decode("utf8", errors="strict"))
        if not isinstance(report, dict) or report.get("status") not in {
            "blocked", "observed", "contract_gaps_observed"
        }:
            raise ValueError()
        expected = 1 if report["status"] == "blocked" else (2 if report.get("contractGaps") else 0)
        if completed.returncode != expected:
            raise ValueError()
        report.setdefault("probeSha256", manifest["probeSha256"])
        report.setdefault("guardSha256", manifest["guardSha256"])
        report.setdefault("sourceSha256", manifest["sourceSha256"])
        return report, expected


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError()


def main(argv=None):
    args = None
    try:
        parser = QuietParser(description=__doc__)
        parser.add_argument("--source", type=Path)
        parser.add_argument("--notify-bridge", type=Path)
        parser.add_argument("--output", type=Path)
        parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
        args = parser.parse_args(argv)
        if args.worker:
            # Incidental source diagnostics never leave the worker.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    report = worker(args.worker)
                    code = 2 if report["contractGaps"] else 0
                except BaseException as error:
                    report, code = blocked(error), 1
        else:
            if args.source is None or args.notify_bridge is None or args.output is None:
                raise ValueError()
            report, code = run_parent(args.source, args.notify_bridge)
    except Exception as error:
        report, code = blocked(error), 1
    if args is not None and not args.worker and args.output is not None:
        try:
            output = args.output.resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        except Exception as error:
            report, code = blocked(error), 1
    print(json.dumps(report, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
