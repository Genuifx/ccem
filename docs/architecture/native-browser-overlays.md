# React overlays above the embedded browser

## Behavior contract

On macOS, opening review or a global dialog keeps the same CEF page visible and running behind the React content. The dialog receives mouse and keyboard input. A modal blocks the entire browser; a non-modal popover blocks only its bounds and dismisses on an outside browser click. Closing the last modal restores the prior browser focus when that surface is still active. Switching side-panel tabs or conversations still hides inactive surfaces. Agent pause/restore continues through the existing acknowledgement barrier.

Nested overlays, unmount, resize, app zoom, native popup close, and frontend reload must not leave stale input regions or restore focus to an inactive surface. Other platforms and `CCEM_NATIVE_BROWSER_OVERLAY=0` keep the existing hide/restore path.

## Evidence and choice

- [Atrium's implementation report](https://getatrium.dev/blog/embedding-real-browser-tauri): transparent WKWebView, CEF inside a stable NSView wrapper, negative CALayer zPosition, independent native hit testing, React overlay registry. This is a reported production technique, not proof for CCEM.
- Local Wry 0.55.1 uses `drawsBackground` for WK transparency. Local CEF 150 and objc2 support an owned NSView wrapper and focus handler without new dependencies.
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

The native wrapper immediately hides and declines hits on close, including the interval before CEF's asynchronous close callback. A transparent empty wrapper also declines hits. React waits for the current modal geometry ACK before the separate Agent pause/occlude transaction; revision ordering therefore rejects an older modal-close message before the next dialog can open.

Remaining real desktop acceptance: verify the live page remains visible underneath dimmed dialogs; click and type in the dialog; verify no click-through; close and continue typing in the same page; scroll, resize, zoom, and cross the CEF/React boundary with the pointer; open/close an OAuth popup while a modal is active. This requires an unlocked desktop. Transient geometry IPC failures retry with capped backoff; total bridge loss is not claimed to provide native input isolation.

## Local evidence (2026-09-27)

- Desktop build and type check passed. Frontend regression: 1365 passed, 0 failed, 2 skipped. CEF surface tests: 32 passed. New native overlay policy tests: 3 passed.
- The timer-driven native fixture passed 13 checks: native CEF hit before overlay; modal hit/focus transfer; show-during-modal protection; nested close; final focus restoration; actual review component; partial bounds; Radix outside dismissal; zoom 0.9/1.0; hide/restore; unchanged live-page boot ID with advancing ticks; immediate hit release on close.
- A separate native window resize to 1100×780 verified the newly exposed browser area receives CEF hits, becomes React-owned during a modal, and returns to CEF afterward. Independent review found and resolved the asynchronous-close wrapper and cross-channel modal ordering issues.
- Evidence lives in the owning worktree's ignored `.artifacts/react-overlay-*` files. CUA confirmed the Mac is locked; physical gesture, compositor, hover/cursor, and real OAuth popup acceptance remain unverified. Nothing in this record is an installed-release claim.
