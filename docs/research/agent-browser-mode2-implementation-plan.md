# CCEM Mode 2 embedded CEF delivery plan

This plan implements the accepted architecture in
[`agent-browser-mode2-cef-architecture.md`](./agent-browser-mode2-cef-architecture.md). It replaces
the earlier external Chrome for Testing plan.

## Product contract

Mode 2 is a real Chromium browser embedded as a native child inside the Workspace BrowserPanel:

```text
Tauri main window
├── Wry WebView: CCEM React UI and Mode 1 Preview Browser
└── native CEF child surface: Mode 2 Login Browser
```

Mode 2 must never open a separately managed Chrome window or a separate always-on-top control
window. Mode 1 remains a Wry child webview and must continue to behave independently.

The user owns manual login and can hand control to the Agent, pause it, or take over again. Agent
actions use the bounded semantic backend; raw JavaScript, raw CDP, cookies, storage, passwords, and
arbitrary response bodies are not exposed as Agent capabilities.

## Hard safety constraints

- Development and automated tests must not access the macOS system Keychain. macOS debug CEF always
  uses `--use-mock-keychain`, an isolated `browser-dev` root, and non-persistent profile storage.
  Windows prototype data, when explicitly exercised on Windows, must remain under the isolated
  debug root and never be reused by a release profile.
- Ordinary tests must not execute `security`, signing, notarization, or Keychain tools. Code-signature
  integration checks are explicit opt-in tests only.
- A release build may use the system Keychain only after the final installed application has a stable,
  pinned Developer ID identity. Repeated Safe Storage prompts are a release-blocking failure.
- The pinned prebuilt CEF runtime starts with the generic `Chromium Safe Storage` service. Before any
  signing step, release staging must find exactly one copy of that literal, replace the same 21-byte
  slot with null-padded `CCEM Safe Storage`, and bind the source digest, branded digest, byte offset,
  and method into release inventory. Signing and runtime bootstrap both fail closed if that exact
  branding evidence is absent or the final framework contains the generic service. Release smoke
  must still cover both a clean machine and a machine with an existing Chromium item; static
  branding is necessary evidence, not proof that prompts cannot recur. Never delete or rewrite a
  user's existing Keychain item, and do not ask users to click “Always Allow”.
- The signed release smoke is CI-only and uses an exclusive temporary keychain under the exact
  current-run root. It launches the same copied signed app twice per fixture, proves an encrypted
  cookie survives the process restart in one isolated profile, compares the seeded generic Chromium
  secret before/after without retaining it, restores the original keychain search/default state,
  and removes every owned helper/profile/keychain temporary. The app/CEF child environment is an
  allowlist and never inherits Apple, updater, GitHub token, or signing-key secrets.
- Unsigned or partially signed macOS artifacts must not contain or enable the CEF overlay.
- Windows release builds must fail closed unless CEF's renderer/GPU/utility sandbox is active.
  `no_sandbox=1` is permitted only for an explicit local prototype and is never a release fallback.
- No production IPC may launch the retired external Chrome for Testing runtime.

## Release matrix

Required Mode 2 targets:

- macOS arm64
- macOS x86_64
- Windows x86_64

Linux and Windows arm64 remain out of scope until their native surface, packaging, signing, and
installed-app smoke paths are added explicitly.

## Phase 1: CEF host and process lifecycle

Deliverables:

- pin one exact CEF crate/runtime version;
- load CEF before constructing any CEF-owned value;
- initialize exactly once on the Tauri UI thread;
- run the platform message pump without starving Tauri menus, resize, modal loops, or idle work;
- bundle a dedicated CEF subprocess helper;
- on Windows, replace the unsandboxed helper prototype with the CEF 150 sandbox bootstrap plus a
  client DLL exporting `RunWinMain`, or an equally isolated sandboxed host-process architecture;
- revoke Agent authority, close surfaces, drain helpers, and call CEF shutdown in the required order;
- treat initialization failure as terminal for the current CCEM process.

Evidence:

- Rust lifecycle and pump tests;
- macOS and Windows target compilation;
- real close/restart smoke proving no owned helper remains.

## Phase 2: native BrowserPanel surface

Deliverables:

- attach CEF as an `NSView` child on macOS and an `HWND` child on Windows;
- acquire hidden, then resize/show/hide/navigate/close through a generation-bound surface lease;
- map DOM CSS coordinates to host logical bounds in the same direction as app zoom, then apply
  monitor DPI exactly once in the native backend;
- let real native-child clicks own browser focus; resize, zoom, visibility, and window activation
  synchronization must never steal focus from trusted React controls;
- keep Mode 1 and Mode 2 mutually exclusive with no stale native surface;
- hide or disable CEF before any host overlay that must appear above it;
- preserve Chinese IME, keyboard shortcuts, focus restoration, display scaling, and fullscreen changes;
- retire a creating surface synchronously when no BrowserHost exists, and make late CEF callbacks
  observe cancellation rather than resurrecting the surface or retaining its profile lease;
- expose one controlled OAuth popup inside the BrowserPanel ownership boundary.

Popup policy:

- require a user gesture and foreground disposition;
- preserve the original CEF opener relationship so `postMessage` and `window.closed` work;
- allow HTTPS and strict HTTP loopback navigation only;
- block nested or unowned windows;
- custom-scheme callbacks require an explicitly registered scheme, state, port/path policy, and
  trusted callback dispatcher; otherwise block and close the popup without wedging handoff.

Evidence:

- surface coordinator and popup policy tests;
- real resize/focus/IME/overlay/popup gestures on each platform.

## Phase 3: semantic control, profile, and recovery

Deliverables:

- connect CEF DevTools observers to the existing bounded semantic backend;
- run `navigate -> AX snapshot -> click -> type -> screenshot` without raw CDP exposure;
- make User/Agent/Paused transitions atomic with popup admission and the execution fence;
- cancel active Agent effects within one second on pause/takeover;
- persist opaque release profiles and isolate them by workspace/profile;
- make profile lock release retryable and never report cleanup success before persistence and unlock
  both succeed;
- recover explicitly from renderer crash, browser close, app force-exit, and restart;
- keep redacted audit, console, network, snapshot, and screenshot artifacts.

Evidence:

- semantic, cancellation, provenance, profile, cleanup, and recovery tests;
- real persistent-login restart and two-profile isolation smoke.

## Phase 4: packaging, signing, and updater integrity

macOS deliverables:

- stage the exact framework and all required Helper.app bundles atomically;
- sign nested code from the inside out with hardened runtime and the minimum helper entitlements;
- require the pinned Team ID, exact Developer ID identity, and notarization credentials together;
- notarize, staple, and verify the final installed artifact;
- fail closed when any signing or notarization input is absent.

Windows deliverables:

- stage the exact `libcef.dll`, GPU libraries, resources, snapshots, locales, sandbox bootstrap,
  and client DLL;
- pass one broker-owned Windows sandbox context through both browser initialization and subprocess
  execution, and reject any artifact or runtime carrying `--no-sandbox`;
- sign the application and installer with the configured Authenticode identity;
- install an inherited read/execute-only LPAC rule for `S-1-15-2-2` and fail installation if the
  rule cannot be applied;
- verify every signed executable/DLL, the final CEF inventory, and an installed-runtime attestation
  before publication. The attestation must bind the current run and exact installer/executable
  hashes, observe same-executable browser/renderer/GPU/utility processes without sandbox-disabling
  flags, exercise Ready/CDP/hide/show/close/reopen, and prove clean process teardown.

Updater deliverables:

- require repository immutable releases through the read-only GitHub settings endpoint before any
  production build starts, using a dedicated settings token that is never shared with release
  mutation; Preview builds skip this production-only gate;
- verify the final updater archive contains one complete pinned CEF inventory;
- test old-version to new-version replacement and prove no mixed CEF files remain;
- keep updater signature verification separate from platform code-signature verification.

Release transaction boundary:

- GitHub REST unsafe methods do not provide a compare-and-swap precondition for draft asset upload
  or publication. Immutable releases narrow the post-publication window but do not make the draft
  transaction atomic;
- one trusted release workflow must remain the unique writer for the tag and draft. Repository tag
  rules must prevent any other actor from moving or recreating the release tag;
- every mutation is fenced by the exact release id plus unique owner/source markers. Each uploaded
  or reused asset is read back while the release is still a draft, and publication succeeds only
  after both the PATCH response and a subsequent exact release GET preserve all nine asset ids,
  sizes, SHA-256 digests, and uploaded states;
- after publication, resolve the tag through GitHub's read-only commit-by-ref endpoint and require it
  to remain the exact source commit. Any competing writer, missing digest, mutable publication, or
  tag movement fails closed and produces no successful publication result.

Evidence:

- fixture-based staging/signing/inventory tests that never touch local credentials;
- signed CI artifacts plus post-build verification logs;
- clean-machine install and updater smoke on every required target.

## Phase 5: installed-app acceptance

Production readiness requires current evidence for this exact installed-app flow:

1. Open a Workspace and select Login Browser.
2. Confirm CEF appears only inside BrowserPanel.
3. Complete manual login, including a controlled OAuth popup where applicable.
4. Hand control to the Agent and perform one semantic read and one semantic write.
5. Pause, show a trusted host confirmation with CEF hidden/disabled, then restore focus.
6. Restart CCEM and prove login persistence in the same profile.
7. Open a second workspace/profile and prove cookie and local-storage isolation.
8. Exercise renderer crash, browser close, app force-exit, and recovery.
9. Close Mode 2 and CCEM, then prove no owned CEF helper remains.
10. Inspect redacted audit, network, console, snapshot, and screenshot artifacts.
11. Install an update and prove the pinned CEF inventory is complete and unmixed.
12. Prove development/test runs caused no macOS Safe Storage prompt; separately prove the stable
    signed release does not enter a repeated prompt loop.

Build success, source assertions, unit tests, or a static screenshot support this evidence but cannot
replace it.

## Stop conditions

- If a platform cannot host a reliable native child surface, Mode 2 stays unavailable on that
  platform; do not fall back to an external browser window.
- If a CEF DevTools method cannot preserve an existing semantic safety invariant, change the adapter
  or capability contract explicitly; do not bypass it with raw CDP.
- If Safe Storage, nested signing, notarization, Authenticode, or updater inventory cannot be
  reproduced on the release matrix, keep Mode 2 disabled in affected release artifacts.
- The sandbox bootstrap/client-DLL path and LPAC installer hook are implemented, but they do not
  become Windows production support until a real signed target build and installed-app attestation
  pass on the Windows release runner. Missing or stale evidence must keep release delivery blocked.
