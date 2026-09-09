# Hermes remote event bridge (migration groundwork)

This is an opt-in CLI integration for native CCEM Desktop sessions. Hermes is the
only delivery transport for `ccem remote relay`; there is no SDK fallback. This
change does **not** make Hermes the Desktop-wide default or retire existing
Telegram/WeCom/Weixin integrations. Their existing configuration and behavior
remain available. Do not run a legacy relay and Hermes relay for the same route.

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
telemetry filtered out of the chat projection. Integrity flags are preserved;
the CLI refuses unavailable or gapped history instead of silently skipping it.

## Use from Hermes

Hermes authenticates the source platform and chat, decides which sessions the
caller may access, and asks the user to confirm writes. The CCEM CLI only uses
the local authenticated control endpoint. Platform/chat strings are provenance,
not credentials. Do not expose the CLI or the Desktop token directly to chats.

```sh
ccem remote status <runtime-id>
ccem remote events <runtime-id> --since 0
ccem remote relay <runtime-id> --to feishu:<chat-id> --since <acknowledged-seq>
ccem remote send <runtime-id> --platform feishu --chat-id <chat-id> \
  --message-id <stable-source-message-id> --text '<confirmed input>' \
  --confirm <runtime-id>
```

`relay` sends one batch (at most 100 source events) via the installed `hermes`
executable using `send --to ... --file - --json`. It requires an explicit chat;
no implicit home channel is selected. Hermes must already be configured by its
owner. Any platform supported by that Hermes installation can be targeted.

After success, retain the returned `nextCursor` and use it on the next call.
Use exactly one relay owner per route. No scheduler, cursor file, or migration
state is installed by this command. Starting at zero intentionally replays
available history. `hasMore` distinguishes normal pagination from missing history. Decode failures
and oversized omitted rows cause delivery to stop; they are never acknowledged
as delivered events.

Each successful send requires both exit code zero and JSON `success: true` with
no error/skip. Failure stops the batch and reports the last confirmed cursor.
There is no automatic retry or transport fallback. A timeout or lost response
may mean the message arrived: inspect the destination before retrying, using the
visible event ID to identify it. This is not an exactly-once delivery guarantee.
The child process has a 30-second timeout and a bounded response buffer.

Session text is piped without a shell and media/control directives are broken
with a zero-width separator so output cannot request local file uploads.

`send` requires confirmation matching the target runtime and a stable message ID.
Hermes must obtain real user confirmation before supplying that option. Retries
reuse a source-scoped idempotency key. Personal Weixin/Wechat writes are rejected;
it is notification-only. This adapter exposes input, not session termination,
permission approval, or arbitrary RPC dispatch. Existing local Desktop CLI
commands remain local administrative capabilities.

## Migration and acceptance still required

Before changing defaults, verify real Hermes delivery and authenticated chat
queries on the intended platforms. Then implement persisted single-owner route
switching and rollback, migrate channels one at a time (personal Weixin last),
and observe stability before deleting SDKs and external bot pairing. This patch
contains no automatic migration and cannot establish those acceptance results.

Local regression tests use an HTTP loopback server and a fake Hermes executable;
they exercise RPC requests and real subprocess delivery mechanics without sending
external messages. They are not evidence of receipt on a real messaging platform.
