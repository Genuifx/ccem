# Managed Chromium runtime spike (Mode 1.5)

Date: 2026-07-10

## Decision

The managed-runtime architecture is technically viable, but the product runtime is **not ready**.

- `remote-debugging-pipe` works with POSIX FD 3 for commands and FD 4 for responses/events.
- NUL-delimited JSON supports target creation, flattened attach, navigation, runtime evaluation, PNG screenshot, target close, and browser close.
- No remote-debugging TCP listener is required.
- A dedicated process group plus private runtime metadata can close normally, survive forced SIGKILL cleanup, reap a verified stale process, and avoid an orphan when the controller exits abruptly.
- The locally cached full Chrome for Testing 147.0.7727.15 is rejected: `Page.captureScreenshot` never returned, even though the same target/session handled navigation and evaluation.
- Full installed Chrome 150.0.7871.49 passed the entire spike with an isolated temporary profile. This proves the full-Chrome shape, not permission to depend on or take over user Chrome.
- Headless Chrome 147.0.7727.15 also passed the entire pipe/lifecycle spike, but it cannot serve Mode 2's visible login workflow.

Do not expose `ready` until a CCEM-pinned full runtime artifact passes download integrity, executable identity, the private-pipe smoke, and lifecycle cleanup on every supported platform.

## What the spike implements

The disposable implementation lives behind Rust test compilation or the explicit `chromium-spike` feature:

- `apps/desktop/src-tauri/src/browser/chromium_spike.rs`
- `apps/desktop/src-tauri/src/browser/chromium_spike_tests.rs`

It does not hardcode the Playwright cache, system Chrome, a download URL, or a user profile. The executable and output directory must be supplied explicitly to the ignored test.

Transport and isolation:

1. Create two private Unix stream pairs.
2. Duplicate child endpoints above the reserved descriptor range.
3. In `pre_exec`, create a dedicated process group, map the command reader to FD 3, and map the response writer to FD 4.
4. Send and receive NUL-delimited JSON frames with a persistent 32 MiB bounded response buffer and
   a total 30-second request deadline that unrelated CDP events cannot extend indefinitely.
5. Launch with `--remote-debugging-pipe`, a unique `--user-data-dir`, and a unique CCEM runtime marker. No `--remote-debugging-port` flag is present.
6. Store the runtime directory as `0700` and runtime metadata/output files as `0600`.

Lifecycle and stale-process safety:

- Normal: send `Browser.close`, require exit status 0, and require the process group to disappear.
- Forced: SIGKILL the dedicated group, wait the main child, and require the group to disappear.
- Stale reaper: refuse while the recorded owner is alive; otherwise require the PID command line to match the canonical executable, unique profile, private-pipe flag, and unique runtime marker before signaling. Retain metadata until the process group is observably gone so a later pass never loses the only safe cleanup identity.
- Controller crash: intentionally skip Rust `Drop`, exit the controller test process, and prove pipe closure causes the Chromium process group to disappear. A later reaper removes only the stale metadata.

## Evidence

Ignored evidence files remain under `.artifacts/` and are not committed.

Full Chrome 150 proof:

- report: `.artifacts/system-chrome-spike/chromium-spike-report.json`
- screenshot: `.artifacts/system-chrome-spike/chromium-pipe-smoke.png`
- screenshot: 1280 × 720, 14,318 bytes
- screenshot SHA-256: `bd3e1f85db5e23fc78b0f997266785b07471e60e0ef4873622e272b712c255b6`
- TCP listeners: none
- normal close: exit 0, group gone
- forced close: SIGKILL, group gone
- stale reaper: verified runtime signaled, group gone
- controller exit: pipe closure removed the group; stale metadata cleanup returned `already_exited`

Headless Chrome 147 proof:

- report: `.artifacts/chromium-headless-shell-spike/chromium-spike-report.json`
- screenshot SHA-256: `cd595d50bc2521551c146fde4bfd5e2d96fb856860f05c0ac991ba6865fbc8ca`
- the same TCP and lifecycle gates passed

Rejected full CfT 147 candidate:

- `Browser.getVersion`, target creation, attach, `Page.enable`, `Runtime.enable`, `Page.navigate`, and marker evaluation succeeded.
- `Page.captureScreenshot` produced no response within 30 seconds.
- The local app bundle also failed `codesign --verify --deep --strict`; this cache entry is evidence only and is not a distributable candidate.

## Artifact selection and distribution

Official Chrome sources describe Chrome for Testing as a versioned, non-auto-updating Chrome flavor for automation, publish channel/version download metadata through JSON endpoints, and warn that it is intended for automation against trustworthy content:

- <https://developer.chrome.com/blog/chrome-for-testing>
- <https://github.com/GoogleChromeLabs/chrome-for-testing>
- <https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json>

At the time of this spike, the official stable metadata reported full CfT 150.0.7871.115 for mac-arm64. The ZIP is about 180.5 MB. Its storage response exposed CRC32C and MD5, while the official JSON contained version, revision, platform, and URL but no SHA-256.

Recommended release shape:

1. Maintain a CCEM-owned signed runtime manifest with exact version, platform, official URL, archive size, SHA-256, unpacked executable identity, and minimum CCEM protocol version.
2. Produce the SHA-256 during a trusted release-ingestion job; do not treat mutable “latest stable” metadata as the installed trust root.
3. Download to an app-owned temporary file, verify size and SHA-256 before extraction, extract to a versioned directory, and atomically activate only after the private-pipe smoke passes.
4. Keep the standard app small and prewarm in the background. A full/enterprise package may bundle the exact verified directory for offline deployment.
5. Retain the previous verified runtime until the new one passes smoke, then prune by policy.
6. Perform a separate legal/licensing and macOS signing/notarization review before redistribution. The technical spike does not settle that question.

Do not use these as production fallbacks:

- Playwright cache paths: mutable, outside CCEM ownership, and may contain an unsuitable or damaged build.
- User Chrome: auto-updating, shared with user state, and not reproducible.
- Headless shell: technically useful for CI but unable to provide the visible login surface required by Mode 2.

## Readiness contract for Mode 2

The trusted backend now exposes a read-only readiness model:

- `unavailable`: no verified CCEM runtime is installed.
- `preparing`: download, verification, extraction, or smoke is in progress.
- `ready`: the pinned artifact passed integrity, executable identity, pipe smoke, and lifecycle gates.
- `failed`: preparation or verification failed; include a bounded diagnostic and allow retry/reinstall.

Mode 1.5 intentionally always returns `unavailable`. There is no preparation manager yet, so there is no code path that can claim `ready`.

The future preparation manager must keep these proof states separate:

`downloaded → archive verified → extracted → executable verified → pipe smoke passed → activated → ready`

## Mode 2 backend boundary

Build Mode 2 behind a backend interface rather than widening Preview Browser internals:

- Runtime manager: prepare, inspect readiness, launch, stop, reap, update, reset.
- Profile manager: one app-global Default profile shared across workspaces plus app-owned Explicit New
  profiles isolated to their owner workspace; never point at a user Chrome profile.
- CDP adapter: private pipe only; CDP objects remain internal.
- Semantic capabilities: open, navigate, snapshot, screenshot, click, type, wait, console, network log.
- Policy gate: origin authorization and permission checks before every capability.
- Artifact store: reuse app-owned workspace/session scoping and retention.
- Audit: record policy decision before action and bounded result after action.
- Control: exact visible session, pause within one second, hot permission changes, and cancellation tokens.

Before calling Mode 2 ready, re-run the full spike against the exact pinned CfT archive on mac-arm64,
mac-x64, Windows, and Linux, then add app-global Default sharing, Explicit New isolation, and restart
tests.
