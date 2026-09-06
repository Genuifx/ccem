# Main WebContent recovery

The main WKWebView can disappear while the Rust application and its native
sessions remain alive. A JavaScript error boundary cannot run after that process
has been terminated. On macOS, CCEM uses Tauri's public WebContent termination
callback to recover the existing `main` WebView.

## Recovery contract

- Reload only the main renderer. The recovery controller does not stop, restart,
  create, or send input to a session.
- Retry after 1, 3, then 10 seconds, with at most three automatic attempts in a
  rolling ten-minute window. A briefly successful render does not reset this
  budget. After exhaustion, show a native dialog with explicit retry and retain
  scene actions. Manual retry starts a new budget.
- Resolve the native document identity before mounting session effects. A timed
  out or rejected handshake fails closed for persisted input replay. A late valid
  identity can acknowledge readiness without lifting that replay protection.
- Require a React-ready acknowledgement within 20 seconds after reload dispatch.
  This acknowledges the mounted renderer, including a healthy startup progress
  screen. Native startup completion separately gates access to the workspace;
  slow backend recovery must not spend the renderer's retry budget.
  Hidden windows use a timer fallback because WebKit may suspend animation frames.
  Generation and document UUID reject old callbacks, samples and queued reloads.
  Main-thread dispatch has its own 20-second bound; an unresponsive dispatch
  opens the circuit and invalidates the delayed reload.
- Reattach through existing native-session discovery. Restore unsent editor text
  and attachments from a document-session journal. Journal before submission;
  records whose acceptance is unknown are not restored as sendable drafts after
  recovery; the live editor remains intact. Sending a new prompt
  never implicitly flushes the old renderer queue after recovery. The existing
  explicit queue send action remains available.
- Route the visible workspace submit button, editor shortcut and workspace
  menu/global shortcut through the same draft capture and admission guard.
  Workspace Cmd+Enter cannot also launch a terminal through the app shortcut.

Draft storage uses `sessionStorage`, with separate attachment records so ordinary
keystrokes do not repeatedly serialize image data. Accepted submissions and
removed attachments release their records. Storage errors do not block the live
editor and are counted. Like other browser storage, this cache has a quota; it is
not a durable backup across app exits. Unknown submissions must be checked
against the session transcript before the user decides whether to send again.

## Diagnostic evidence

The native log is `<app_log_dir>/webcontent-recovery.jsonl`. On macOS this is
normally `~/Library/Logs/<bundle identifier>/webcontent-recovery.jsonl`. The
installed app and each named development worktree have different identifiers.
Use the canonical launcher's `.artifacts/tauri-dev/*.json` manifest to identify a
development instance.

Each JSON line records timestamp, application version/identifier/PID, phase,
document UUID/generation, attempts, termination count and the last numeric
frontend sample. The sample keeps its own document identity and timestamp, so a
pre-crash reading is not attributed to the new renderer. Logs rotate at 2 MiB
and retain one `webcontent-recovery.previous.jsonl` file.

Frontend samples run every 30 seconds: DOM/transcript row counts, mounted session
count, raw events, projected messages, tool-result character count, draft and
uncertain-submission counts, and persistence failure count. They contain no
prompt text, event bodies, API keys, attachment payloads, URLs or workspace paths.
JavaScriptCore normally does not expose `performance.memory`; `heapUsedBytes`
is therefore `null`, not zero. These counters help correlate growth but do not
replace a heap snapshot or process-footprint measurement.

The termination callback does **not** reveal its cause. `terminationReason` is
`unknown`; an OOM conclusion requires the corresponding macOS/WebKit system log
(for example, `ExceededMemoryLimit`). Keep both rotated files and the system-log
time window when reporting an incident.

## Local verification

Run the Desktop Node tests, TypeScript/build, and locked Rust tests. For actual
process termination use an owned, canonically launched development instance:

```sh
cd apps/desktop
CCEM_WEBCONTENT_RECOVERY_SMOKE=1 pnpm tauri:dev
```

Connect Tauri MCP to the manifest's exact port. The debug-only
`webcontent_debug_main_process_id` command returns the current main WKWebView's
process ID; it requires the explicit environment flag, main WebView identity,
and a named development bundle. It does not terminate anything. The command and
private WebKit process-ID probe are absent in release builds.

Before terminating that exact renderer, verify its process identity and save
unsent fixture text plus a small image. After termination, verify the native log
contains termination → reload → boot → ready, the application PID is unchanged,
the editor draft and image return, and no persisted input is replayed. For a live
session test use only an owned QA task, and compare runtime identity, event
sequence, prompt count, and completion. Exercise repeated failures separately to
prove the retry limit and explicit manual recovery. Never kill by an unscoped
process name or disturb another development/release instance.

## Animation retention

Long-lived GSAP effects with changing dependencies use `revertOnUpdate: true`.
This releases the previous context's tweens and detached element references at
each update. Regression tests exercise interrupted entrance animations,
windowing, hide/return, detail panels, and reduced motion. This change does not
reduce history retention or impose a new frontend byte budget.
