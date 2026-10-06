# React overlays above the embedded browser

## Behavior contract

On macOS, opening review or a global dialog keeps the same CEF page visible and running behind the React content. The dialog receives mouse and keyboard input. A modal blocks the entire browser; a non-modal popover blocks only its bounds and dismisses on an outside browser click. Closing the last modal restores the prior browser focus when that surface is still active. Switching side-panel tabs or conversations still hides inactive surfaces. Agent pause/restore continues through the existing acknowledgement barrier.

Nested overlays, unmount, resize, app zoom, native popup close, and frontend reload must not leave stale input regions or restore focus to an inactive surface. Other platforms and `CCEM_NATIVE_BROWSER_OVERLAY=0` keep the existing hide/restore path.

Startup keeps the existing three-second recovery deadline. If no document identity has been acknowledged by then, React mounts in legacy mode for that document. A late ACK can restore browser access and readiness reporting but cannot change the selected presentation mode or authorize input replay.

## Evidence and choice

- [Atrium's implementation report](https://getatrium.dev/blog/embedding-real-browser-tauri): transparent WKWebView, CEF inside a stable NSView wrapper, negative CALayer zPosition, independent native hit testing, React overlay registry. This is a reported production technique, not proof for CCEM.
- Local Wry 0.55.1 uses `drawsBackground` for WK transparency. Local CEF 150 and objc2 support an owned NSView wrapper and focus handler without new dependencies.
- [Apple's layer hierarchy guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CoreAnimation_guide/BuildingaLayerHierarchy/BuildingaLayerHierarchy.html) describes visual ordering by zPosition before sibling index. CCEM keeps the wrapper at zero and raises WK to one; the native acceptance below explains why Atrium's negative wrapper position was not suitable for this host.
- [Wry overlap/cursor report](https://github.com/tauri-apps/wry/issues/1763): overlapping native views can still compete for cursor state. Native gesture and cursor checks remain necessary.
- Snapshot/hide implementations do not keep a live visible page. An extra overlay WebView duplicates React state and does not satisfy the requested single-tree architecture.

## Implementation stages

1. Initialize the trusted main WKWebView after the frontend document fence. Create CEF directly under its final wrapper, move only the wrapper bounds, and retire it after primary and popup close. Route input using validated revisioned geometry, and block CEF focus acquisition while modal.
2. Register shared React overlay primitives and browser viewports centrally. Punch transparent holes only through decorative background layers. Separate modal occlusion from inactive-surface visibility, preserving Agent pause barriers.
3. Verify registry lifecycle/races/zoom with behavior tests; verify native hit testing and live CEF state through an opt-in local fixture. Exercise actual native clicks, typing, scroll, close/reopen, and cursor behavior when the desktop is unlocked. Record build and native evidence separately.

## Validation and rollback

Use the canonical per-worktree `pnpm tauri:dev` launcher and its manifest. The smoke interface is macOS debug-only, main-document fenced, and additionally requires `CCEM_REACT_OVERLAY_SMOKE=1`; it opens only the fixed local fixture. Set `CCEM_BROWSER_DATA_ROOT` to a worktree artifact directory for isolated browser data. No installed application or user sessions are terminated.

Rollback uses `CCEM_NATIVE_BROWSER_OVERLAY=0` on process startup. No persisted workspace migration or dependency update is required. Do not infer actual compositor pixels or user gesture success from DOM snapshots, CEF timers, native programmatic hit tests, or compilation alone.

## Repeatable native check

Start the named dev instance with `CCEM_REACT_OVERLAY_SMOKE=1 pnpm tauri:dev` and connect Tauri MCP to the exact manifest port. In that main webview, open `/test/native-overlay-smoke.html`, then import `/test/run-native-overlay-smoke.mjs` and call its `run()` export. The fixture mounts the real shared Dialog/Popover and WorkspaceReviewPopover, then inspects actual AppKit hit-test and first-responder results around a live local CEF page.

If the Mac is locked, WKWebView suspends animation frames. The explicit `?timers=1` test-only variant substitutes timer-driven frames and disables animations; its receipt marks physical gestures and compositor verification false. This can test input routing and lifecycle, but is not native UI acceptance. The MCP bridge's WK snapshot does not include CEF pixels.

For document recovery, run the smoke runner's `runModeRecovery({ composition, reuse, before })` export. Use `/test/native-overlay-smoke.html?fallback=1` to explicitly skip composition initialization. Exercise normal creation → fallback reuse → normal reuse, then close the surface and exercise fallback creation → normal reuse. Pass the preceding result's `page` as `before`; reuse must preserve its boot ID. The fixture also exposes a fixed local `window.open` page for actual native popup gestures when desktop targeting is available.

The native wrapper immediately hides and declines hits on close, including the interval before CEF's asynchronous close callback. A transparent empty wrapper also declines hits. React waits for the current modal geometry ACK before the separate Agent pause/occlude transaction; revision ordering therefore rejects an older modal-close message before the next dialog can open.

Every macOS CEF surface is created inside its final wrapper at layer position zero, including legacy mode. Frontend boot hides retained wrappers, clears the old input/focus policy, and resets the WK layer to zero. Acknowledged composition initialization raises only the WK layer to one. Legacy hit testing delegates to CEF and modal occlusion hides it. This lets a retained page survive composition → legacy → composition without reparenting or allowing a legacy-created surface to cover the next document's dialogs. It also avoids placing CEF behind this host's opaque parent backing.

An opening modal waits for the newest successful geometry ACK, including automatic retries after a transient bridge error. Input stays blocked and the same opening request can finish when transport recovers. Pending waiters keep retries active even if their viewport unmounts. Closing the requested modal immediately notifies the manager to cancel its waiters, independently of the effective guard held through serialized restore. An immediate reopen gets a fresh barrier while that guard stays on. Disposing the manager also cancels pending waiters.

The native acceptance below covers live page pixels, dialog and browser input, blocked clicks, nested dialogs, partial overlays, scroll, resize, zoom, and a local webpage popup. System cursor appearance across the CEF/React boundary and real third-party OAuth remain unverified. Transient geometry IPC failures retry with capped backoff; total bridge loss is not claimed to provide native input isolation.

## Local evidence (2026-09-27)

- Desktop build and type check passed. Frontend regression: 1365 passed, 0 failed, 2 skipped. CEF surface tests: 32 passed. New native overlay policy tests: 3 passed.
- The timer-driven native fixture passed 13 checks: native CEF hit before overlay; modal hit/focus transfer; show-during-modal protection; nested close; final focus restoration; actual review component; partial bounds; Radix outside dismissal; zoom 0.9/1.0; hide/restore; unchanged live-page boot ID with advancing ticks; immediate hit release on close.
- A separate native window resize to 1100×780 verified the newly exposed browser area receives CEF hits, becomes React-owned during a modal, and returns to CEF afterward. Independent review found and resolved the asynchronous-close wrapper and cross-channel modal ordering issues.
- Evidence lives in the owning worktree's ignored `.artifacts/react-overlay-*` files. CUA confirmed the Mac is locked; physical gesture, compositor, hover/cursor, and real OAuth popup acceptance remain unverified. Nothing in this record is an installed-release claim.

## Integration evidence (2026-10-06)

- Integrated main `7ac61541` while retaining the current single-row browser toolbar. Desktop build/typecheck and Rust Clippy passed. Frontend regression: 1495 passed, 0 failed, 2 skipped. Rust: 32 CEF surface, 3 overlay policy, and 23 recovery tests passed.
- Independent review found two regressions and both were fixed: a timed-out boot could indefinitely block React mounting; a transient modal ACK error could strand the same search-open request. A further cancellation check found the failed ACK and restore queue could wait on each other. Behavior tests now exercise the actual main bootstrap and the real Dialog/occlusion hook through failure, retry, panel unmount, cancellation before recovery, immediate reopen, close, and late identity.
- The running named dev app passed the 13-check native fixture again, including a final rerun after the cancellation fix (`.artifacts/react-overlay-cancellation-native.json`). Five recovery stages (19 assertions) passed at 1100×780, including a retained composition → legacy → composition page and a legacy-created page subsequently reused in composition mode. CEF boot IDs and advancing timers were inspected, separately from native visibility flags.
- Tauri MCP opened the real Dialog and entered text; the native first responder and hit target were WK during the modal, then returned to CEF on close. Receipts are `.artifacts/react-overlay-refactor-native.json`, `react-overlay-refactor-mode-recovery.json`, and `react-overlay-refactor-dialog-input.json`.
- CUA could not bind the unbundled development process by either its exact bundle identifier or executable path. WK reported background visibility, so these fixture runs used explicit timer mode. Physical gestures, compositor pixels, hover/cursor, and real OAuth popup acceptance remain unverified. `react-overlay-refactor-wk-dialog.png` captures only WK and must not be used as proof that CEF pixels are visible.

## Native compositor and gesture acceptance (2026-10-06)

The follow-up used Cua Driver CLI with the exact owned process/window, which could target the unbundled development binary. The canonical launcher remained PID 90945, identifier `com.ccem.desktop.dev.ibcea7690`, MCP port 56500. The original test process/window was 91421/21757; the launcher's automatic rebuild replaced it with 14509/22113. No installed app was terminated.

The first real native capture exposed a failure missed by hit-test checks: the same retained CEF boot ID was visible in legacy mode but became a gray rectangle in composition mode, while its timer still advanced. Receipts are `react-overlay-e2e-legacy-control.png` and `react-overlay-e2e-composition-control.png`. Keeping the wrapper at zero and raising WK to one fixed the native pixels without changing NSView parentage or input order.

Actual native gestures, delivered through Cua Driver's foreground `global_input` route, then verified the following:

- In the real production Workspace and BrowserPanel, enter `workspace-before` in CEF, open session review, click the browser counter while guarded, close review with Esc, open the real global search dialog, type `overlay-e2e-verify`, click the covered browser counter, close with Esc, and continue typing/clicking in CEF. The same page boot ID survives, its timer advances, guarded clicks do not increment the counter, and the browser remains `visible=true` / `hidden=false` during overlays.
- In the shared-component fixture, native clicks open Dialog and its nested Dialog; native typing reaches the Dialog input. Clicking the covered browser counter leaves it unchanged. Closing the inner dialog leaves the parent barrier active; closing the parent permits continued browser input and counting. The actual WorkspaceReviewPopover receives a native click in its region overlapping CEF. Generic Popover receives native input; an outside CEF click dismisses it and increments the browser counter normally.
- A native webpage button opens the fixed local `window.open` popup. Composition → legacy → composition retains both primary and popup boot IDs and popup ID 1, with CEF pixels present in all modes. A debug close of that popup while modal retains WK focus and returns to the unchanged primary page. This is local popup lifecycle coverage, not OAuth acceptance.
- Native Cmd+= reaches app zoom 1.1 and Cmd+0 restores 1.0. Resizing to 1100×780 updates native hit regions. A native mouse wheel scroll moves the CEF heading offscreen and exposes the retained page state below it. `react-overlay-e2e-zoom-settled-compositor.json` confirms both page background and browser control pixels after resize/zoom.

Cua Driver's action receipts report `effect: unverifiable`; acceptance comes from subsequent rendered state and CEF page values, not that receipt alone. One-shot captures can contain only Chromium's cached background while the window is off-Space or newly activated. Keep the exact dev window in the foreground and let it settle before capturing. The strict compositor check requires both fixture background and green browser-control pixels; a background-only capture fails. Capture metadata still reports freshness `unknown`, so it is not used as frame-timing proof.

Repeat the pixel regression against the fixed local page, using its current logical CEF bounds and exact owned native PID/window ID:

```sh
node test/check-native-overlay-compositor.mjs --pid PID --window WINDOW_ID --bounds x,y,width,height --output /absolute/path/receipt.json
```

Run from `apps/desktop`; Cua Driver must be available. The check never activates an app or delivers input. It verifies capture ownership/coherent bounds, saves the native PNG, and fails when fixture content is absent. Pair it with the actual gestures above and native/page-state checks.

This follow-up also passed 3 native overlay policy tests, 32 CEF surface tests, and locked Clippy with warnings denied. Full evidence is retained in the owning worktree's ignored `.artifacts/react-overlay-e2e-*` files. These are development-build results; no release, installed-app, system-cursor, or external OAuth claim is made.
