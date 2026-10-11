# Workspace interaction performance fixture

The fixture mounts three real `WorkspaceNativeSessionView` components, with their
production transcript, rich composer, markdown/code rendering, GSAP animation and
CSS. Its real `useWorkspaceSidePanelController` changes owner on session selection;
both side-panel and file-link context providers change as they do in Workspace.
The file-link handler records synthetic paths and selects the synthetic files tab;
it never invokes a native file operation. It substitutes only the imported Tauri `invoke` boundary with deterministic
synthetic session data. It never forwards native commands, sends a provider
request, or loads a user conversation. Native mutations (including Send) fail
closed and appear in `blockedCommands`; leave the typed draft unsent.

This is real UI and replay/poll integration under synthetic IPC, not provider or
storage end-to-end proof. Test the ordinary Workspace separately for integration
with its surrounding sidebar, browser surfaces and session-selection callbacks.
The session region matches Workspace's `relative min-h-0 flex-1 overflow-hidden`
container and absolute inset session panes. Warmup and measurement start reject an
unbounded or zero-height viewport; `layout.valid` must be true in every result.

## Build and open

From `apps/desktop`:

```sh
node test/build-workspace-interaction-performance.mjs --baseline
node test/build-workspace-interaction-performance.mjs
node --test test/workspace-interaction-performance-instrumentation.test.mjs
```

`--baseline` loads every imported tracked production TS/JS source module and
`index.css` from the current `HEAD` without changing the checkout. New fixture
files are shared by both builds. Pin an older baseline with `--revision <commit>`.
The CSS utility scan and dependency/assets versions come from the current
checkout, so CSS utility/config/dependency changes require a separate comparable
baseline checkout. This task's TS-only production change uses identical visuals.
Each generated `manifest.json` records the source commit and probe inventory.

Use only your own canonical `pnpm tauri:dev` instance, targeted through its exact
`.artifacts/tauri-dev` manifest. Open these paths on that instance's Vite origin:

```text
/test/.artifacts/workspace-interaction-performance/baseline/index.html
/test/.artifacts/workspace-interaction-performance/current/index.html
```

Both bundles use production React and minification. Rendering probes are inserted
in component function bodies at build time, including named functions wrapped in
`memo` or `forwardRef`; production sources are not instrumented. The light native
context wrapper and heavy `WorkspaceNativeSessionViewContent` are counted
separately, so baseline/current comparisons must use the heavy body counter for
the optimized build. All effects and
animations remain enabled. Record `environment.reducedMotion` and use the same
foreground WebView size, machine, power mode and display for each comparison.
Do not benchmark while building another bundle or running the test suite.

## Measurement API

```js
const f = window.__workspaceInteractionPerf;
await f.warmup();             // Visit A, B, C and return to A; wait for replay.
f.resetMetrics('native-input');
// Drive actual keyboard/mouse/scroll gestures here.
f.finishMetrics();           // Stop capture, then return a JSON-safe snapshot.
```

`reset()` creates fresh fixture runtime IDs, remounts and warms all three sessions.
`resetMetrics()` clears measurements only, preserving drafts/folds/scroll. Prefer
`finishMetrics()` over repeated `diagnostics()` while measuring: diagnostics reads
DOM geometry. Never clear all browser storage: fixture IDs isolate its drafts.

The snapshot contains actual render invocations (including per-runtime session
renders and per-tool-group digest renders), frame interval distributions, input,
keypress and switch two-rAF timings, editor height writes and `scrollHeight` reads,
DOM row counts, top spacer height, current reading anchor, drafts and selection.
It also records native replay marks, generated chunks, IPC calls, errors and
blocked native commands. Counts report invocation work, not React commit counts.
Two-rAF latency is a presentation proxy, not a hardware paint timestamp. Safari
may not support Long Task entries; `supported: false` is not zero main-thread work.

The fixed data contains 3 sessions × 120 turns, 2 completed tools in each turn,
Chinese/English text and fenced TypeScript in every third answer. Initial reads
respect their requested tail limit and full pagination runs through production
replay recovery. Streams append 200 chunks at 40 ms, then complete the turn;
the production poller decides its own polling/commit cadence.

Repeatable DOM-button workloads (use after warmup, at least three runs per build):

```js
await f.benchmarkSwitches(18, 120);
await f.reset();
await f.benchmarkStream({ chunks: 200, intervalMs: 40 });
```

Those helpers dispatch DOM button clicks or generate events. They are useful for
repeatable work-count comparisons; native gesture checks below remain necessary.
Save raw JSON snapshots and screenshots under the task's `.artifacts/` directory.
Do not interpret this host's milliseconds as proof of performance on another Air.

## Native behavior smoke contract

Use Tauri MCP or an equivalent actual WebView control surface. The toolbar has
`data-testid="perf-session-A"` through `C`, `perf-start-stream`, `perf-stop-stream`,
`perf-reset-metrics`, and `perf-finish-metrics`. A session pane is selected with
`[data-perf-session="A"]`; its real editor is `[contenteditable="true"]` and its
scroll viewport is `[data-radix-scroll-area-viewport]`.

1. Warm all sessions, begin capture, focus A's editor and type a deterministic
   200-character sentence one key at a time. Verify the exact draft text; record
   native key/input counts and height-write counters. No Send or plain Return.
2. Add enough lines using Shift+Return to reach the 260 px height cap; verify the
   editor grows while focused. Continue typing at the cap, blur and refocus, then
   narrow the viewport and type again. Verify the draft and capped height survive.
   Delete back to one short Chinese/English line and verify it shrinks without
   clipping the caret or changing text. Exercise composition separately
   if the available control surface supports an actual input method; a synthetic
   `compositionend` is not native IME proof.
3. With the draft retained, click A → B → C → A. Verify A's exact draft survives,
   B/C remain independent, selection buttons respond, and the unused session's
   invocation counter is not inflated by switches between the other two.
4. Start streaming, type more text, and scroll upward through several screens.
   The reading anchor must remain stable during output; the transcript must not
   jump to the latest message. Inspect top spacer/visible rows and confirm older
   rows become reachable when scrolling further up. After output stops, scroll to
   the tail and verify chunk 200 is visible with no gaps or repeated text.
5. Click a tool digest's `button[aria-expanded]` to open and close it. Verify the
   tool details appear, remain clickable, and the viewport anchor is reasonable.
   Scroll away/back and switch away/back to exercise the retained fold state.
6. Select prose with actual pointer gestures and copy via the normal shortcut or
   production copy button. Verify the selected/copied fixture text, then scroll
   and continue typing. There must be no stuck selection overlay or broken input.
7. End capture. Require no unhandled errors and no blocked mutation attempts.
   Compare identical workloads; use render/layout work counts to explain timing
   changes and retain outliers instead of cherry-picking one fast sample.

Check the real main Workspace route separately for session switching and composer
behavior. Finish and stop only the development stack launched by the owning task;
the installed app and other worktree instances are outside this test's boundary.

## Repeatable browser runner

After building both fixtures and starting the owning task's server:

```sh
PERF_BASE_URL=http://localhost:18980 PERF_BROWSER=webkit \
  node test/workspace-interaction-performance.e2e.mjs
```

The runner dynamically imports `playwright`; set `PLAYWRIGHT_MODULE` to the absolute
path of an existing Playwright entry module when it is provided outside this repo.
`PERF_EXECUTABLE_PATH` optionally selects a browser executable. It never installs
dependencies, launches a server, or changes a desktop instance. Browser metadata
and callback bootstrap are synthetic, with all IPC routed into the isolated fixture.

Default: both builds, behavior checks and three alternating benchmark rounds.
Use `--bench` or `--behavior` to run just one category,
and `--variant current` for a focused behavior recheck. `PERF_ROUNDS`, `PERF_WIDTH`,
`PERF_HEIGHT`, `PERF_HEADLESS` and `PERF_OUTPUT_DIR` are optional. Defaults are three
rounds, 900×700, headless, and repository `.artifacts/interaction-performance`.
Full diagnostic JSON and success/failure screenshots are retained. Performance
differences are reported without noisy millisecond pass/fail thresholds.

Typing uses browser keyboard input with a 16 ms delay; multiline, deletion, draft
switching, tool toggles, text selection and scrolling use actual browser gestures.
Clipboard verification is explicitly marked unsupported when that engine cannot
grant read/write access. Unicode `keyboard.type()` does not prove native IME
composition, and browser results do not prove Tauri/native/backend performance.

Safari can expose a non-configurable `CSSStyleDeclaration.height` accessor. When
`editorCounters.supported.height` is false, the setter counters are unavailable,
not evidence of zero work. The runner additionally installs an identical
`MutationObserver` on both builds. `editorStyleMutations.heightStyleMutations`
counts real inline height transitions; `heightAutoMutations` counts transitions
to `auto`. It uses each next mutation's old style to retain synchronous auto→px
transitions, and drains pending records before capture stops. Repeated assignments
of the same value are not setter counts and are intentionally kept separate.

For an input-only script, import `installEditorStyleMutationProbe` from
`test/helpers/workspace-input-style-probe.mjs`, pass it to `page.evaluate()`, drive
the input, then collect `window.__workspaceInputStyleProbe.stop()` through another
evaluation. This needs no fixture rebuild and cannot change production layout.
