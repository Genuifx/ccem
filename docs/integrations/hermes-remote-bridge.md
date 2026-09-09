# Hermes remote event bridge (migration groundwork)

This is local administrative event inspection for native CCEM Desktop sessions.
The prototype's `remote relay` and `remote send` commands now fail with
`CAPABILITY_UNAVAILABLE` before any RPC or process launch. REQ-0007 phase 0 found
that their contracts cannot safely support a managed chat integration. Existing
Desktop channels are unchanged; Hermes is not enabled or migrated by this work.

See [the takeover review and stage gates](hermes-phase0-review.md).
The subsequent [live verification record](hermes-live-verification.md) proves one
real CCEM task notification to the user's WeCom chat and a native Hermes status
round trip. It also reproduces timeout fallback and concurrent queue-pruning
duplicate-send risks. The test does not enable the managed bridge or certify
its pending authentication, idempotency, installation, or migration contracts.

## Protocol

The existing authenticated Desktop control server remains bound to loopback.
`ccem.remote.getEvents` accepts `{runtimeId, sinceSeq, limit}`. It returns:

```json
{
  "version": 1,
  "sourceAvailable": true,
  "gapDetected": false,
  "hasMore": false,
  "decodeFailureCount": 0,
  "oversizedEventCount": 0,
  "nextCursor": 42,
  "events": [{
    "version": 1,
    "event_id": "runtime-example:42",
    "runtime_id": "runtime-example",
    "seq": 42,
    "occurred_at": "2026-09-09T00:00:00Z",
    "kind": "session_completed",
    "title": "Session completed",
    "text": "completed"
  }]
}
```

The projection lives in `remote_bridge.rs` and is shared with legacy bot-binding
outboxes. Wire names of legacy frames are unchanged. Stable event identities
combine runtime ID and sequence. The cursor advances over raw records, including
telemetry filtered out of the chat projection. Local inspection prints integrity
flags; the preserved batch helper refuses unavailable or gapped history before sending.

## Local inspection

These commands use the existing local administrative control token, which has
broader access than a chat plugin should receive. Do not expose this CLI or the
Desktop token to chats. A future Hermes plugin needs a distinct scoped token,
trusted source context, workspace policy, and a real confirmation contract.

```sh
ccem remote status <runtime-id>
ccem remote events <runtime-id> --since 0
```

## Preserved transport groundwork (not enabled)

The batch renderer and subprocess helper remain available to regression tests
and later managed transport work. They are not wired to an active sender.
The prototype invoked `send --to ... --file - --json`; this cannot be the default
for every Hermes platform. The pinned WeCom sender opens a second WebSocket in
a standalone process, while an in-process call can reuse the gateway adapter.
The pinned Telegram sender may remove an invalid thread ID and retry in the
parent chat. Neither behavior meets the managed route contract.

The batch helper validates source integrity before any send. `hasMore`
distinguishes pagination from missing history; decode failures and oversized
omitted rows stop delivery. Its returned cursor is not a durable outbox or a
delivery ledger. A future service must persist scanning and receipt state
separately and must never retry an uncertain send automatically.

Each successful send requires both exit code zero and JSON `success: true` with
no error/skip. Failure stops the batch and reports the last confirmed cursor.
There is no automatic retry or transport fallback. A timeout or lost response
may mean the message arrived: inspect the destination before retrying, using the
visible event ID to identify it. This is not an exactly-once delivery guarantee.
The child process has a 30-second timeout, a 64 KiB byte limit and strict UTF-8
decoding. Failure terminates only the owned child, escalating to SIGKILL after
a 250 ms grace period. Pipe cleanup is also bounded. A syntactically valid
receipt still cannot prove exact target delivery or platform read status.

Session text is piped without a shell and media/control directives are broken
with a zero-width separator so output cannot request local file uploads.

The old `--confirm <runtimeId>` flag was a caller assertion, not proof of user
confirmation. A repeated `clientMessageId` also did not deduplicate every native
Provider. Therefore `remote send` is blocked for all platform names, including
aliases and unknown platforms. Future personal Weixin routes remain notification
only through route permissions enforced by the restricted bridge itself.

## Reproduce phase 0 locally

```sh
<absolute-python> scripts/hermes/probe-compatibility.py \
  --source <absolute-hermes-checkout> --python <absolute-python> \
  --output .artifacts/hermes-phase0/compatibility.json

python3 -m unittest discover -s scripts/hermes -p 'test_*.py' -v
```

The probe runs actual Hermes receipt/command/sender implementations with
synthetic inputs and SDK fixtures in a temporary `HERMES_HOME`. Its workers
inherit no credentials, allow writes only under their temporary directory,
refuse external profile/data reads, and deny Python socket connections, datagram
sends and subprocess launches. Source reads are limited to code; the Python runtime can read its own
dependencies. The synthetic gateway lookup avoids importing the live runner and
its project `.env` loader. This guard is not a sandbox for arbitrary untrusted native code;
run it only against a reviewed checkout. It does not start a gateway, register
a real account, install dependencies, or send a platform message. Exit 2 means
phase 0 is incomplete; the JSON report names the remaining gates. The current
probe is deliberately unable to certify the full integration.

## Migration and acceptance still required

Before changing defaults, verify real Hermes delivery and authenticated chat
queries on the intended platforms. Then implement persisted single-owner route
switching and rollback, migrate channels one at a time (personal Weixin last),
and observe stability before deleting SDKs and external bot pairing. This patch
contains no automatic migration and cannot establish those acceptance results.

Local regression tests use an HTTP loopback server and a fake Hermes executable;
they exercise RPC requests and real subprocess delivery mechanics without sending
external messages. They are not evidence of receipt on a real messaging platform.
