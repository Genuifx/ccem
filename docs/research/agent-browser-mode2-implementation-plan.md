# CCEM Secure Login Browser implementation plan (Mode 2)

Date: 2026-07-11

Status: implementation in progress on `codex/agent-browser-mode2`

Depends on: Preview Browser final native-flow gate and a verified full Chrome for Testing runtime

## Outcome

Build a visible Secure Login Browser that runs a CCEM-owned Chromium process and profile. A user
can log in manually, hand control to an Agent, pause it immediately, restart CCEM without losing
that profile's login state, and inspect redacted artifacts and audit records afterward.

The first release uses a separate, CCEM-launched Chromium window. It does not embed Chromium into
the Tauri view hierarchy. Tauri remains the application shell and control surface; managed
Chromium is the logged-in work engine.

## Decisions carried forward

- Keep Preview Browser and Secure Login Browser as two backends behind shared semantic capability,
  policy, artifact, audit, and session contracts.
- Do not reuse the user's Chrome executable as a product dependency or point at a user Chrome
  profile. The successful system-Chrome spike is architecture evidence only.
- Do not expose raw CDP, cookies, storage databases, browser handles, or arbitrary JavaScript to an
  Agent.
- Use `remote-debugging-pipe`; do not open a debug TCP port.
- Treat every page-derived string and structure as untrusted data.
- Prepare the runtime before the user's first login-browser workflow. Standard builds prewarm in
  the background with visible progress and pause/retry controls; full and enterprise builds may
  include the same pinned artifact.
- Keep runtime readiness, browser-session readiness, user login, Agent authorization, and artifact
  delivery as separate proof states.

## Changes from the Fable draft

The Fable plan had the right sequence but mixed feasibility proof with production delivery. This
plan separates them:

1. Mode 1.5 proves private-pipe CDP and lifecycle assumptions. It does not download, install, or
   trust a production runtime.
2. Runtime preparation is the first Mode 2 production slice and may not return `ready` until every
   integrity and smoke gate passes.
3. The first Mode 2 UI is a managed external window plus CCEM controls. Embedding Chromium or
   maintaining CEF is explicitly out of scope.
4. Persistent profiles belong to CCEM's app-data directory, keyed and scoped by workspace/profile;
   they never live inside the user's repository and never reuse browser data owned by another app.

## Current evidence and remaining gates

| Surface | Current proof | Gate still required |
| --- | --- | --- |
| Preview Browser | Registry, policy, artifacts, console, audit, and native tool routing are implemented and covered by tests | Complete the fixed native Agent sequence through the visible Tauri UI and capture the recent-activity control state |
| Private CDP transport | FD 3/4 NUL-delimited JSON, no debug TCP listener, navigation, evaluation, screenshot, close | Re-run against the exact pinned full CfT archives used by releases |
| Lifecycle | Normal close, forced process-group kill, verified stale-process signal, controller pipe-close cleanup | Implement platform supervisors for macOS/Linux and Windows Job Objects; verify real app crash/restart |
| Full Chromium | Installed full Chrome 150 passed the headless architecture spike with an isolated profile | Verify a signed/pinned full CfT build in headed mode; never fall back to user Chrome |
| Runtime delivery | Official version/download metadata and a signed-manifest design are known | Legal/signing review, trusted ingestion, downloader, atomic activation, rollback, multi-platform CI |
| Login profile | Product boundary and directory ownership are decided | Persistence, isolation, lock, migration, reset, and restart behavior tests |

## Architecture boundary

```text
Agent / trusted CCEM UI
          |
BrowserCapabilityService       semantic requests and bounded results
          |
BrowserPolicyGate              origin, permission, pause, upload/download rules
          |
BrowserSessionRegistry         lifecycle, visibility, generation, cancellation
          |
ChromiumLoginBackend           no raw handle crosses this boundary
      /          \
RuntimeManager   ProfileManager
      |               |
CDP pipe adapter      CCEM-owned user-data-dir
      |
Pinned managed Chromium process group / Job Object

All actions -> BrowserAuditLog
All outputs -> BrowserArtifactStore (page data remains untrusted)
```

The backend interface is semantic, not mechanism-shaped. Initial operations:

- `open`, `navigate`, `get_url`, `snapshot`, `screenshot`
- `click`, `type`, `wait`
- `read_console_log`, `read_network_log`
- `pause`, `resume`, `close`

CDP sessions, request ids, target ids, cookies, and storage internals remain private to the backend.

## Slice M2.0: trusted runtime preparation

### Build

- Add a CCEM-signed runtime manifest containing platform, architecture, exact version, official
  source URL, archive byte size, SHA-256, unpacked executable identity, minimum OS version, and
  minimum protocol version.
- Download into an app-owned temporary directory with bounded retries, cancellation, progress, and
  resume only when the server validators still match.
- Verify archive size and SHA-256 before extraction. Reject path traversal, unexpected file types,
  undeclared links, and executable layouts not present in the manifest. A platform artifact may
  declare an exact allowlist of relative symlinks only when both the lexical and final target stay
  inside the candidate root; absolute, escaping, cyclic, hardlink, and undeclared link entries are
  rejected.
- Extract into a new versioned directory; apply private permissions; verify signing/notarization or
  platform-native executable identity where available.
- Run a private-pipe smoke against the unpacked binary before atomic activation.
- Keep the previous verified runtime until the new one activates successfully. Failed candidates
  never replace the active runtime.
- Extend readiness with phase, progress, active version, candidate version, bounded error code, and
  retryability while preserving the existing four top-level states.
- Add settings actions: prepare, pause/resume download, retry, reinstall, delete, and show disk use.

### Acceptance

- An interrupted download or app restart never produces `ready` and resumes or restarts safely.
- A corrupted archive, wrong hash, wrong executable, failed smoke, or failed signature leaves the
  previous runtime active.
- No mutable `latest` URL or local Playwright/system-Chrome path can become the trust root.
- Unsupported OS versions fail with a stable non-retryable error while Preview Browser remains
  available.
- `ready` identifies the exact activated version and changes atomically.
- Standard app startup and Preview Browser remain usable while preparation runs.

### Stop conditions

- Stop redistribution work if legal/licensing or signing review is unresolved.
- Stop activation if an official full CfT artifact cannot pass the headed pipe smoke on a supported
  platform.
- Do not add system Chrome as a fallback to make a gate green.

## Slice M2.1: headed process and persistent profile manager

### Build

- Launch the pinned full runtime without headless mode in a dedicated process group on Unix and a
  kill-on-close Job Object on Windows.
- Give each profile an opaque id and an exclusive lock. Map it to exactly one workspace identity;
  never derive authorization from a mutable display path alone.
- Store profiles under CCEM app data with private permissions, versioned metadata, last-use time,
  runtime compatibility, and cleanup state.
- Reject concurrent launches of the same profile unless the existing owner is the live matching
  CCEM runtime. Never bypass Chrome's lock files by deleting them blindly.
- Keep startup metadata sufficient to verify exact executable, profile, transport, runtime marker,
  pid/group or Job Object ownership, and controller identity before cleanup.
- Retain cleanup metadata until process disappearance is proven. Reap only verified owned
  processes; never kill by name.
- Support close, force stop, crash recovery, profile reset, and delete. Reset/delete must require a
  user confirmation and a stopped runtime.
- Present a visible CCEM control surface containing profile identity, current origin, Agent control
  state, pause/takeover, and close. The separate browser window must not be mistaken for user
  Chrome.

### Acceptance

- A user can log into a representative owned or staging site, close CCEM, restart it, and remain
  logged in only in the same CCEM profile.
- Two workspaces and two profiles share no cookie, localStorage, IndexedDB, cache, download, or
  service-worker state.
- CCEM crash, forced browser kill, and machine restart leave no live owned runtime after recovery.
- A forged or mismatched metadata record is refused without signaling an unrelated process.
- Headed OAuth redirect, popup, iframe, and manual 2FA paths are exercised; passkeys are classified
  separately and are not promised until verified.

## Slice M2.2: production CDP adapter and semantic backend

### Build

- Replace the synchronous spike client with a single owner task that multiplexes responses and
  events by request/session/target id.
- Give every request a total deadline, cancellation token, bounded response size, and structured
  error. Continuous events may not extend a request forever.
- Track target creation, navigation, redirect, frame, dialog, download, renderer crash, and process
  termination in the shared registry. Increment generation when a target/session is recreated so
  stale element references fail closed.
- Before activating an Agent handoff, run a bounded owner-side inventory barrier over the exact
  primary page target and its recursive frame tree. Reject extra page targets, opaque/cross-origin
  frames, malformed inventories, or inventory changes during the barrier; a failed preflight rolls
  policy and capture back to manual user control and grants no semantic capability.
- Implement Chromium screenshot and true accessibility snapshot, with a documented DOM interaction
  fallback only when the AX result cannot represent a necessary control.
- Implement trusted input through CDP input dispatch. Do not expose arbitrary page evaluation as an
  Agent capability.
- Reuse the Mode 1 artifact and audit contracts so callers receive stable paths and bounded
  summaries independent of backend.
- Keep one backend conformance suite and backend-specific capability flags; do not force Mode 1 to
  imitate Chromium-only features.

### Acceptance

- The same native Agent script can select either backend for open, navigate, snapshot, screenshot,
  click, type, wait, console, and close without receiving backend handles.
- Pause or permission change cancels an active operation within one second and blocks the next one.
- Cancellation first retires the effect epoch, then waits on a bounded owner acknowledgement. If
  the owner cannot acknowledge within the UI deadline, CCEM signals only the identity-verified
  owned process domain, marks cleanup required, and still returns without permitting a late effect.
- Renderer crash, target close, pipe EOF, timeout, and oversized frame produce explicit registry
  states and bounded errors rather than hanging or crashing the desktop app.
- Old element references fail after navigation or target generation change.

## Slice M2.3: origin, network, upload, and download policy

### Build

- Authorize normalized scheme/host/port rules per workspace and profile. Check initial URLs,
  redirects, popups, iframes used for action, and every mutating semantic capability.
- Track the source origin of page-derived data. Cross-origin read-to-write is denied by default;
  a one-shot trusted UI confirmation bound to the exact source, destination, profile, session, and
  handoff epoch is required before it can proceed.
- Until that one-shot confirmation UI ships, retain a conservative workspace-plus-actor provenance
  taint across handoff epochs and browser sessions. A later write at a different origin is an
  unsupported transfer and fails closed; a fresh handoff must not silently erase the taint.
- Keep page text unable to grant origins, change permission mode, select local files, or resume a
  paused session.
- Capture CDP Network metadata into a separate untrusted JSONL log. Request/response bodies remain
  off by default.
- Redact before disk: URL credentials and sensitive query values, Authorization, Cookie,
  Set-Cookie, tokens, API keys, passwords, OTP-like fields, and configured secret values.
- Default downloads to block or prompt, then write only to a CCEM-owned quarantine directory with
  provenance. No automatic open or execute.
- Permit uploads only after trusted UI selection from workspace-approved paths. The Agent receives
  an opaque approved-file handle, never an arbitrary filesystem path picker.
- Write the trusted audit decision before each action and a bounded result afterward. Typed content,
  secrets, bodies, and raw page text must not enter the trusted audit log.

### Acceptance

- Unauthorized navigation, redirect, popup action, download, and upload are denied before effect.
- A red-team fixture cannot expand origin authorization, read an unapproved file, resume control,
  or place a secret in network/audit artifacts.
- Two separately authorized origins do not implicitly authorize moving page-derived data from one
  origin into the other.
- Network logs contain no plaintext values for the blocked header, query, and body classes.
- Audit records can reconstruct who/what/when/decision/result without storing typed secrets.

## Slice M2.4: user journey and native Agent proof

### Build

- Add a clear Preview Browser / Login Browser entry split. Show readiness before the Login Browser
  action; never replace the primary UI with a long explanation.
- When unavailable, offer background prepare, progress, and Preview Browser. When failed, show a
  bounded reason and retry/reinstall. When ready, open the profile immediately.
- Make manual login the initial state. Agent control begins only after explicit handoff and displays
  the active profile/origin.
- Keep pause/takeover visible and reachable while the browser window is frontmost. Close and profile
  reset have distinct consequences and labels.
- Surface recent screenshot/snapshot/console/network/audit artifacts from the trusted CCEM UI.
- Keep console and network recorders disabled during manual login. A successful handoff begins a
  new opaque capture segment only after an owner round-trip barrier; pause, takeover, and close stop
  it. New handoffs cannot read prior live segments, while already-issued immutable snapshot ids
  remain independently revalidatable.

### End-to-end acceptance script

1. Start with no runtime; verify Preview Browser remains immediate while background preparation
   transitions through visible states.
2. Activate the exact verified runtime and open a headed CCEM Login Browser profile.
3. Log into a representative owned/staging app manually, close, restart, and prove persistence.
4. Open a second workspace/profile and prove storage isolation.
5. Authorize one origin and run a native Agent sequence: navigate, snapshot, type, click, wait,
   screenshot, read console, and read redacted network metadata.
6. Attempt an unauthorized redirect, blocked download, and unapproved upload; prove denial before
   effect and inspect the audit record.
7. Pause during an in-flight wait/action; prove cancellation within one second and no later action.
8. Kill the renderer, browser process, and desktop controller in separate runs; prove explicit state,
   recovery, and no orphan runtime.
9. Inspect real UI state and saved artifacts. Build/test success and source assertions are supporting
   evidence, not substitutes for this flow.

## Verification matrix

Run each production slice on the repository's actual desktop release matrix: macOS arm64, macOS
x64, and Windows x64. Treat Windows arm64 and Linux as future platform work until the release
workflow, signed runtime manifest, installer, and cleanup implementation add them explicitly.

- Unit: manifest verification, extraction traversal, readiness transitions, profile mapping/locks,
  origin normalization, redaction, stale metadata refusal, generation invalidation.
- Integration: exact pinned archive download, headed private-pipe smoke, process/job cleanup, profile
  restart/isolation, CDP event routing, renderer crash, network/download/upload fixtures.
- Desktop behavior: real gestures and state transitions through Tauri MCP or the strongest available
  app automation, including manual-login handoff and pause.
- Regression: Preview Browser native Agent flow on every Mode 2 milestone.
- Delivery: separately verify branch/commit, merged local main, release tag, and downloadable artifact
  when those stages are actually requested.

## Rollout

1. Developer flag: owned fixtures and staging apps only; collect classified failures locally.
2. Internal opt-in: pinned runtime, explicit profiles, origin allowlist, downloads blocked.
3. Public preview: normal SaaS with a documented compatibility matrix; no universal login claim.
4. General availability only after multi-platform cleanup, redaction, update rollback, and runtime
   signing gates remain green across at least one runtime update.

## Explicitly out of scope

- Taking over user Chrome, tabs, extensions, cookies, passwords, or profile directories.
- CEF integration, Chromium fork maintenance, or an embedded browser engine in the first Mode 2.
- Raw CDP, arbitrary JavaScript evaluation, raw cookie/storage export, or response bodies for Agents.
- Universal anti-bot, passkey, payment, or every-site compatibility claims.
- Semantic sensitive-action classification as the sole security boundary. Origin, permission, pause,
  upload/download, and audit enforcement remain authoritative.

## Definition of ready

Mode 2 is ready only when all of these are true at the same time:

- exact runtime artifact verified and activated;
- headed runtime and isolated persistent profile proven;
- private-pipe semantic backend and cancellation proven;
- origin/upload/download/network-redaction policy proven before effect;
- visible user handoff and pause proven through the real app;
- crash/restart cleanup proven with no owned orphan process;
- Preview Browser regression remains green.

Anything less should be reported by its actual proof state, not summarized as “Login Browser ready”.
