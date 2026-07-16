# CCEM Mode 2 embedded CEF architecture

Date: 2026-07-12

Status: accepted target architecture; implementation in progress on
`codex/agent-browser-mode2`

Supersedes: [`agent-browser-mode2-implementation-plan.md`](agent-browser-mode2-implementation-plan.md)

## Product outcome

Mode 2 is a real Chromium browser embedded inside the existing Workspace browser panel. It is not
an external Chrome window, user-Chrome takeover, or a migration of the CCEM shell to an
experimental renderer.

```text
Tauri main window
├── Wry WebView: CCEM React shell and trusted controls
└── fixed BrowserPanel viewport
    ├── Mode 1: system WebView preview surface
    └── Mode 2: windowed CEF child surface
```

Only one browser surface is visible in the viewport at a time. Mode 1 remains lightweight and
ephemeral. Mode 2 uses a CCEM-owned persistent profile and the bundled CEF runtime.

## Non-negotiable decisions

- Keep the stable Tauri/Wry runtime for the CCEM shell.
- Embed CEF as a native child of the Tauri main window (`NSView` on macOS, `HWND` on Windows).
- Ship the exact CEF framework, resources, and subprocess bootstrap required by each platform with
  CCEM release artifacts.
- Keep every host control outside the browser viewport. React overlays do not cross the native
  browser rectangle.
- Before a global confirmation, pause Agent effects, disable or hide the active browser surface,
  show the trusted host modal, then restore visibility and focus deliberately.
- Preserve CCEM-owned workspace/profile isolation. Never read user Chrome state.
- Preserve the semantic capability, policy, provenance, redaction, artifact, and audit layers from
  the external-runtime checkpoint.
- Replace the external process supervisor, private Chrome pipe owner, runtime downloader, separate
  control window, and Chrome for Testing manifests.
- Keep CEF DevTools messages internal. Agents never receive raw CDP, cookies, browser handles, or
  profile paths.
- Do not fall back to system Chrome or an external window when embedded CEF is unavailable.

## Runtime architecture

```text
Trusted Workspace UI
  ├── BrowserLauncherPopover
  └── LoginBrowserPanel controls
             │
             ▼
LoginBrowserSessionManager
  ├── BrowserProfileManager
  ├── LoginBrowserControl / capability gates
  ├── BrowserPolicy / provenance / transfer guards
  └── CEF surface handle
             │
             ▼
CefHost (one per app process)
  ├── CEF initialization and external message pump
  ├── CefSurfaceRegistry (one browser per active Mode 2 session)
  ├── per-profile CefRequestContext
  ├── bounds / visibility / focus / close dispatch
  └── CefDevToolsBridge
             │
             ▼
Existing semantic CDP engine
  ├── navigate / snapshot / screenshot / click / type / wait
  ├── console and network projection
  └── download / file-chooser interception
```

The semantic CDP engine stays mechanism-independent. `CefDevToolsBridge` converts bounded JSON
commands to `CefBrowserHost::SendDevToolsMessage` and converts observer callbacks back to the same
bounded frame contract. The bridge must dispatch CEF calls on the CEF UI thread and must preserve
the existing cancellation/effect fence before any input or navigation effect.

## Viewport contract

The browser viewport is an explicit native-surface slot owned by Workspace:

- React multiplies DOM CSS coordinates by current app zoom and reports host-window logical bounds.
- Rust applies only the platform coordinate transform (AppKit origin or Windows monitor DPI) and
  outward rounding; app zoom must not be applied or inverted a second time.
- Hidden and inactive session surfaces are actually hidden, not merely covered with DOM.
- Mode switches hide the previous surface before showing the next surface.
- Surface acquisition creates CEF hidden and unfocused. Only a still-current frontend lease sync
  may reveal it; native clicks, not geometry/visibility/app-activation sync, own content focus.
- Moving, resizing, zooming, minimizing, restoring, entering fullscreen, and changing display scale
  all resynchronize bounds.
- Host menus, tooltips, popovers, and dialogs stay outside the viewport.
- A trusted global modal follows `pause -> hide/disable -> prompt -> restore -> refocus`.

## Lifecycle contract

CEF is multi-process even though the browser surface is embedded. On macOS the browser-process
library runs inside CCEM. Windows must use the sandbox entry architecture described below.
Renderer, GPU, and utility work always runs in CEF subprocesses.

- Initialize CEF once, before the first Mode 2 surface.
- Before `cef_initialize`, call only the audited loader/API-table/Args/`cef_execute_process`
  bootstrap sequence. In CEF 150, a pre-initialize `cef_base64encode` call deterministically
  poisons the global initialization guard and makes `cef_initialize` trap; URL/resource encoding
  must use Rust code or run after initialization.
- Integrate the external message pump with the existing AppKit/Win32 event loop without polling
  threads or unbounded wakeups.
- Create one request context per persistent profile and reject cross-workspace reuse.
- Closing a Mode 2 session closes its browser, waits for `OnBeforeClose`, releases its profile
  lease, and removes its surface registry entry.
- Closing before a BrowserHost exists retires the pending RequestContext immediately and publishes
  `Closed`; a late initialization callback must not recreate the browser.
- Renderer termination produces a recoverable session state where possible.
- CEF browser-process failures are not advertised as fully isolated from CCEM.
- CCEM exit first revokes Agent authority, closes all browsers, drains helpers, then calls CEF
  shutdown on the initializing thread.
- A clean exit leaves no CCEM-owned CEF helper process.

### Windows sandbox boundary

Windows Mode 2 must never ship with `no_sandbox=1`. CEF 150 no longer treats an ordinary helper
executable plus a null `windows_sandbox_info` pointer as a production configuration. Its supported
sandbox path uses the CEF-distributed `bootstrap.exe`, a client DLL exporting `RunWinMain`, and the
same broker-owned sandbox information for browser initialization and subprocess execution.
This follows the pinned [CEF 150 Windows sandbox API](https://cef-builds.spotifycdn.com/docs/150.0/cef__sandbox__win_8h.html)
and the [cef-rs Windows sandbox bundle contract](https://github.com/tauri-apps/cef-rs#run-the-cefsimple-example).

CCEM now implements the first entry architecture: the pinned CEF `bootstrap.exe` becomes the signed
`ccem-desktop.exe`, loads the signed `ccem-desktop.dll`, and calls its exact five-argument
`RunWinMain` export. The client DLL first routes CEF child processes through `cef_execute_process`,
then keeps the bootstrap-owned sandbox context alive while it starts the Tauri application and later
initializes the browser process. Release staging rejects a missing context, a mismatched bootstrap or
client DLL, a foreign executable, and any `no_sandbox` configuration.

That implementation is necessary but is not, by itself, production evidence. Windows Mode 2 remains
fail-closed until the signed runner installs the exact NSIS artifact, verifies the LPAC inherited
read/execute rule, observes browser/renderer/GPU/utility processes reusing the installed executable,
and consumes a current-run receipt for Ready, CDP, hide/show, close/reopen, and clean termination.
If that lifecycle cannot be proved, the remaining alternative is a separately owned sandboxed CEF
host process with equivalent child-window, focus, IME, IPC, termination, and updater contracts.

An unsandboxed fallback, a separately launched ordinary Chromium window, or a build flag that merely
hides `--no-sandbox` does not satisfy this boundary.

## Platform and packaging contract

Supported release targets remain:

- macOS arm64
- macOS x86_64
- Windows x86_64

macOS artifacts must contain `Chromium Embedded Framework.framework` plus all required Helper app
bundles under `Contents/Frameworks`. Nested code is signed from the inside out before the main app,
then the complete app is notarized and stapled. Before signing, staging performs one deterministic,
length-preserving replacement of the pinned runtime's `Chromium Safe Storage` service slot with
null-padded `CCEM Safe Storage`. The release inventory binds the unbranded and branded executable
digests plus the exact byte offset, and release bootstrap scans the installed framework again before
allowing system-Keychain-backed profiles. Debug and test builds always use an isolated profile and
CEF's mock keychain; they never share release profiles. Windows artifacts must include the exact CEF
DLLs, GPU libraries, resources, snapshots, locales, sandbox bootstrap executable, and client DLL
required by the pinned CEF release.

The signed macOS Safe Storage runtime smoke is the only automated system-Keychain exception. It is
admitted only by a release-only early-app gate bound to GitHub Actions macOS identity, the embedded
run id/attempt/source commit, a 32-byte nonce, exact `RUNNER_TEMP` paths, and a create-once ticket.
Its runner replaces the user search list and default with one unlocked temporary CI keychain, runs
the copied signed app twice against the same isolated persistent profile, then restores the original
search list/default before deleting the temporary keychain. The clean fixture must create only
`CCEM Safe Storage`; the conflict fixture seeds `Chromium Safe Storage` and proves its secret is
byte-for-byte unchanged. A cross-process encrypted-cookie read, bounded watchdog, exact branded
framework slot, zero owned helper processes, and complete temporary cleanup are all required before
the attestation can pass. Release credentials and GitHub tokens are not inherited by the app or CEF
children.

Development and release builds use the same pinned CEF crate/runtime version. CEF downloads during
build are cache inputs, not a mutable product runtime channel. Release jobs verify the resolved CEF
version and expected file inventory before packaging.

## Migration map from checkpoint `2155b1a`

Keep and adapt:

- semantic command/result types and bounded Agent surface;
- session, control, capability, origin, provenance, and execution-fence state machines;
- persistent profile descriptors, locks, reset/delete flows, and workspace identities;
- screenshot/snapshot, console/network projection, redaction, audit, and artifact retention;
- download/upload policy and one-shot confirmation capabilities;
- BrowserLauncher profile inventory and maintenance UI.

Replace or delete:

- Chrome for Testing download, activation, manifest, and smoke pipeline;
- Unix process-group and Windows Job Object browser supervisor;
- FD 3/4 Chrome pipe ownership and `Browser.close` process cleanup assumptions;
- `LoginBrowserControl` as a separate always-on-top Tauri window;
- external-window wording, readiness states, capabilities, schemas, tests, and release checks.

## Implementation gates

### Gate 1: CEF host boot

- CEF initializes under the existing Tauri process on macOS.
- Windows initializes only through a proved sandbox bootstrap/client-DLL or sandboxed host-process
  architecture; the unsandboxed prototype is release-disabled.
- The platform message pump remains responsive during idle, menus, resize, and modal loops.
- Development launch and clean shutdown leave no helper process.

### Gate 2: embedded surface

- A real windowed CEF browser occupies only the BrowserPanel viewport.
- Resize, zoom, hide/show, focus, Chinese IME, keyboard shortcuts, and display-scale changes work.
- Mode 1 and Mode 2 switch without overlap or stale native surfaces.

### Gate 3: semantic backend

- `navigate -> AX snapshot -> click -> type -> screenshot` runs through the existing semantic
  capability path using the CEF DevTools observer bridge.
- Pause/takeover cancels active effects within one second and no later write reaches CEF.
- Redirect, popup, iframe, download, and file chooser policy remains fail-closed.

### Gate 4: profile and recovery

- Manual login survives CCEM restart in the same opaque profile.
- Two workspaces and two profiles do not share cookies or local storage.
- Reset/delete works only after the browser is closed and trusted confirmation is current.
- Renderer crash, browser close, forced app exit, and restart have explicit recovery states.

### Gate 5: delivery

- macOS arm64/x86_64 and Windows x86_64 release jobs build the pinned CEF inventory.
- Signed/notarized installed macOS app and signed Windows installer launch on clean machines.
- Signed macOS smoke opens the branded CEF runtime twice on an isolated profile, both on a clean
  Keychain fixture and with an unrelated generic Chromium Safe Storage item present, without a
  prompt/timeout loop or modification of that unrelated item.
- Windows release verification proves renderer/GPU/utility subprocesses run with the CEF sandbox;
  `--no-sandbox` or `no_sandbox=1` is a hard failure.
- Updater replacement preserves app integrity and does not leave mixed CEF versions.
- Preview Browser regression remains green.

### Signed readiness and release boundary

The three-platform signing path is implemented once in
`.github/workflows/mode2-signed-producer.yml`. It is a reusable, production-only evidence producer:
its jobs receive read-only repository and Actions permissions, always build the current run attempt
from source, and cannot call a GitHub Release mutation API. Apple, Windows, notarization, and updater
signing secret names are declared explicitly by the producer; callers pass no repository secret and
release-only tokens are not inherited.
Both secret-consuming jobs target the fixed `mode2-signing` Actions Environment. Before enabling
either caller, configure that Environment with required reviewers and deployment rules limited to
protected `main` plus formal `v*` release tags, move every Apple, Windows, and updater signing secret
into it, and delete repository-level duplicates. The reusable secret declarations are optional only
so the Environment can supply them without a caller value; the producer still fails closed unless
the full cross-platform signing set is present.

`.github/workflows/mode2-signed-readiness.yml` is the non-publishing entry. A manual run must select
`main`, repeat the exact 40-character source SHA, and use a package version whose `v<version>` tag is
still absent from origin. It exports only current-attempt Actions evidence. The aggregate verifier
requires exactly the macOS arm64, macOS x86_64, and Windows x86_64 inventories and binds their nested
Safe Storage, Windows runtime, and updater-replacement receipts to the same source, run, attempt,
repository, caller workflow, job, and target.

`.github/workflows/release-desktop.yml` keeps the existing tag/source gate and is the only caller that
sets `export_release_payload: true`. Only after the shared producer and aggregate evidence gate pass
does its separate publication job receive `contents: write`. Re-running only a failed publication job
cannot reuse payloads from another attempt; the current attempt must contain all three exact payloads.

This structure makes signed readiness possible without creating a tag, draft, release asset, or
`latest.json`. It does not itself provide current signed-runner evidence: a successful readiness run
for the exact candidate SHA is still required before Gate 5 can be marked complete.

## Definition of production ready

Mode 2 is production ready only when every gate above has current evidence. Required behavioral
proof is a real installed-app flow:

1. Open a Workspace and select Login Browser.
2. Confirm CEF appears inside BrowserPanel, never as a separate browser/control window.
3. Log in manually, hand control to the Agent, run a semantic read and write action, then pause.
4. Show a trusted confirmation while the native browser is hidden or disabled, then restore focus.
5. Restart CCEM, reopen the same profile, and prove login persistence.
6. Open another workspace/profile and prove storage isolation.
7. Close the browser and CCEM, then prove no owned helper remains.
8. Inspect redacted audit, network, console, screenshot, and snapshot artifacts.

Build success, source assertions, unit tests, or a static screenshot are supporting evidence only.
They cannot independently satisfy this definition.

## Stop and redesign conditions

- If the existing Tao `NSApplication` cannot safely satisfy CEF's required protocols and message
  pump after a real prototype, evaluate the official Tauri CEF runtime migration as a separate
  architecture decision. Do not fall back to an external Chrome product surface.
- If nested helper signing, notarization, or updater integrity cannot be reproduced on the release
  matrix, Mode 2 remains unavailable in release builds even if local development works.
- If Windows cannot use CEF's sandbox bootstrap/client-DLL contract without breaking the Tauri
  lifecycle, redesign Windows around a separately owned sandboxed CEF host process or keep Mode 2
  unavailable on Windows. Never ship the in-process `no_sandbox=1` prototype.
- If a CEF DevTools method cannot satisfy an existing semantic safety invariant, change the adapter
  or capability contract explicitly; do not bypass policy with raw CEF/CDP access.
