import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function importOcclusionStore() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'nativeSurfaceOcclusionStore.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-native-occlusion-'));
  const outputPath = path.join(tempDir, 'nativeSurfaceOcclusionStore.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

async function importBrowserPanelParticipant() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'browserPanelNativeSurfaceParticipant.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-panel-occlusion-'));
  const outputPath = path.join(tempDir, 'browserPanelNativeSurfaceParticipant.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('BrowserPanel occlusion pauses Preview before hide and never resumes authority', async () => {
  const { createBrowserPanelNativeSurfaceParticipant } = await importBrowserPanelParticipant();
  const events = [];
  const participant = createBrowserPanelNativeSurfaceParticipant({
    backend: 'preview',
    preparePreviewHide: () => events.push('prepare'),
    pausePreview: async () => events.push('pause:ack'),
    hidePreview: async () => events.push('hide:ack'),
    occludeLogin: async () => events.push('unexpected:login'),
    restore: async () => events.push('restore:visibility-only'),
  });

  participant.prepareHide();
  await participant.hide();
  await participant.restore();
  assert.deepEqual(events, [
    'prepare',
    'pause:ack',
    'hide:ack',
    'restore:visibility-only',
  ]);
});

test('BrowserPanel Login occlusion uses one atomic backend barrier', async () => {
  const { createBrowserPanelNativeSurfaceParticipant } = await importBrowserPanelParticipant();
  const events = [];
  const participant = createBrowserPanelNativeSurfaceParticipant({
    backend: 'login',
    preparePreviewHide: () => events.push('unexpected:prepare'),
    pausePreview: async () => events.push('unexpected:pause'),
    hidePreview: async () => events.push('unexpected:hide'),
    occludeLogin: async () => events.push('occlude:pause-then-hide:ack'),
    restore: async () => events.push('restore:visibility-only'),
  });

  participant.prepareHide();
  await participant.hide();
  await participant.restore();
  assert.deepEqual(events, [
    'occlude:pause-then-hide:ack',
    'restore:visibility-only',
  ]);
});

test('a failed Preview pause prevents native hide and overlay readiness', async () => {
  const { createBrowserPanelNativeSurfaceParticipant } = await importBrowserPanelParticipant();
  const events = [];
  const participant = createBrowserPanelNativeSurfaceParticipant({
    backend: 'preview',
    preparePreviewHide() {},
    pausePreview: async () => {
      events.push('pause:failed');
      throw new Error('pause ACK missing');
    },
    hidePreview: async () => events.push('unsafe:hide'),
    occludeLogin() {},
    restore() {},
  });

  await assert.rejects(participant.hide(), /pause ACK missing/);
  assert.deepEqual(events, ['pause:failed']);
});

test('overlay readiness waits for native hide ACK and overlapping leases restore once', async () => {
  const { createNativeSurfaceOcclusionStore } = await importOcclusionStore();
  const hideAck = deferred();
  const overlayClosed = deferred();
  const events = [];
  const states = [];
  const store = createNativeSurfaceOcclusionStore({
    deferRestore: () => overlayClosed.promise,
  });
  store.subscribe(() => states.push(store.isOccluded()));
  store.registerParticipant({
    async hide() {
      events.push('hide:start');
      await hideAck.promise;
      events.push('hide:ack');
    },
    restore() {
      events.push('restore');
    },
  });

  const dialog = store.acquire();
  const drawer = store.acquire();
  let dialogReady = false;
  let drawerReady = false;
  void dialog.ready.then(() => { dialogReady = true; });
  void drawer.ready.then(() => { drawerReady = true; });

  await Promise.resolve();
  assert.deepEqual(events, ['hide:start']);
  assert.equal(dialogReady, false);
  assert.equal(drawerReady, false);
  assert.equal(store.isOccluded(), true);

  hideAck.resolve();
  await Promise.all([dialog.ready, drawer.ready]);
  assert.equal(dialogReady, true);
  assert.equal(drawerReady, true);
  assert.deepEqual(events, ['hide:start', 'hide:ack']);

  await dialog.release();
  assert.equal(store.isOccluded(), true);
  assert.deepEqual(events, ['hide:start', 'hide:ack']);

  const finalRelease = drawer.release();
  await Promise.resolve();
  assert.equal(store.isOccluded(), true);
  assert.deepEqual(events, ['hide:start', 'hide:ack']);

  overlayClosed.resolve();
  await finalRelease;
  assert.equal(store.isOccluded(), false);
  await drawer.release();
  assert.deepEqual(events, ['hide:start', 'hide:ack', 'restore']);
  assert.deepEqual(states, [true, false]);
});

test('a new overlay waits for a fresh hide when restore is already running', async () => {
  const { createNativeSurfaceOcclusionStore } = await importOcclusionStore();
  const restoreAck = deferred();
  const restoreStarted = deferred();
  const events = [];
  let hideCount = 0;
  const store = createNativeSurfaceOcclusionStore({ deferRestore: async () => {} });
  store.registerParticipant({
    hide() {
      hideCount += 1;
      events.push(`hide:${hideCount}`);
    },
    async restore() {
      events.push('restore:start');
      restoreStarted.resolve();
      await restoreAck.promise;
      events.push('restore:ack');
    },
  });

  const first = store.acquire();
  await first.ready;
  const firstRelease = first.release();
  await restoreStarted.promise;

  const second = store.acquire();
  let secondReady = false;
  void second.ready.then(() => { secondReady = true; });
  await Promise.resolve();
  assert.equal(secondReady, false);
  assert.deepEqual(events, ['hide:1', 'restore:start']);

  restoreAck.resolve();
  await firstRelease;
  await second.ready;
  assert.equal(secondReady, true);
  assert.deepEqual(events, ['hide:1', 'restore:start', 'restore:ack', 'hide:2']);
  await second.release();
});

test('a failed hide blocks overlay readiness instead of mounting above a native surface', async () => {
  const { createNativeSurfaceOcclusionStore } = await importOcclusionStore();
  const store = createNativeSurfaceOcclusionStore({ deferRestore: async () => {} });
  store.registerParticipant({
    hide() {
      throw new Error('hide IPC failed');
    },
    restore() {},
  });

  const lease = store.acquire();
  await assert.rejects(lease.ready, /Failed to hide 1 native surface participant/);
  await lease.release();
});

test('an active overlay fail-closes late registration before delayed native creation', async () => {
  const { createNativeSurfaceOcclusionStore } = await importOcclusionStore();
  const createNativeSurface = deferred();
  const hideAck = deferred();
  const store = createNativeSurfaceOcclusionStore({ deferRestore: async () => {} });

  const overlay = store.acquire();
  await overlay.ready;

  let desiredVisible = true;
  let visibleAtCreation = null;
  const unregister = store.registerParticipant({
    prepareHide() {
      desiredVisible = false;
    },
    async hide() {
      desiredVisible = false;
      await hideAck.promise;
    },
    restore() {
      desiredVisible = true;
    },
  });

  // Registration itself must publish hidden intent synchronously. Waiting for
  // the fire-and-forget hide ACK would allow a delayed child to flash visible.
  assert.equal(desiredVisible, false);
  const creation = (async () => {
    await createNativeSurface.promise;
    visibleAtCreation = desiredVisible;
  })();
  createNativeSurface.resolve();
  await creation;
  assert.equal(visibleAtCreation, false);

  hideAck.resolve();
  unregister();
  await overlay.release();
});

test('without an overlay delayed native creation keeps its normal visible intent', async () => {
  const { createNativeSurfaceOcclusionStore } = await importOcclusionStore();
  const createNativeSurface = deferred();
  const store = createNativeSurfaceOcclusionStore({ deferRestore: async () => {} });
  let desiredVisible = true;
  let visibleAtCreation = null;

  const unregister = store.registerParticipant({
    prepareHide() {
      desiredVisible = false;
    },
    hide() {
      desiredVisible = false;
    },
    restore() {
      desiredVisible = true;
    },
  });

  const creation = (async () => {
    await createNativeSurface.promise;
    visibleAtCreation = desiredVisible;
  })();
  createNativeSurface.resolve();
  await creation;

  assert.equal(visibleAtCreation, true);
  unregister();
});

test('BrowserPanel and every overlapping React surface use the acknowledgement gate', async () => {
  const [
    workspace,
    browserPanel,
    browserPanelParticipant,
    browserBackend,
    browserCommands,
    previewWebview,
    tauriIpc,
    hook,
    dialog,
    allProjects,
    projectPicker,
    reviewPopover,
    app,
  ] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'lib', 'browserPanelNativeSurfaceParticipant.ts'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'commands.rs'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src-tauri', 'src', 'browser', 'webview.rs'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'tauri-ipc.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'nativeSurfaceOcclusion.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'ui', 'dialog.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'AllProjectsModal.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'ProjectPickerModal.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceReviewPopover.tsx'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'App.tsx'), 'utf8'),
  ]);

  assert.match(workspace, /const nativeSurfaceModalOccluded = useNativeSurfaceOccluded\(\)/);
  assert.match(workspace, /\|\| nativeSurfaceModalOccluded/);

  assert.match(hook, /lease\.ready\.then/);
  assert.match(hook, /return active && readySequence === requestSequence/);
  assert.match(dialog, /const gatedOpen = useNativeSurfaceOcclusion\(modal && resolvedOpen\)/);
  assert.match(dialog, /open=\{primitiveOpen\}/);

  assert.match(
    browserPanel,
    /useNativeSurfaceOcclusionParticipant\(createBrowserPanelNativeSurfaceParticipant\(\{/,
  );
  assert.match(browserPanelParticipant, /await options\.pausePreview\(\)/);
  assert.match(browserPanelParticipant, /await options\.hidePreview\(\)/);
  assert.match(browserPanelParticipant, /await options\.occludeLogin\(\)/);
  assert.match(browserPanelParticipant, /await options\.restore\(\)/);
  assert.match(browserPanel, /previewDesiredVisibilityRef\.current = false/);
  assert.match(
    browserPanel,
    /\.then\(\(\) => setNativeSurfaceVisible\(previewDesiredVisibilityRef\.current\)\)/,
  );
  assert.match(browserPanel, /hidePreview: \(\) => setNativeSurfaceVisible\(false\)/);
  assert.match(browserPanel, /action: 'occlude'/);
  assert.match(browserPanel, /await syncLoginSurface\(visible\)/);
  assert.match(browserPanel, /await invoke\('browser_set_visible', \{ sessionId, visible \}\)/);
  assert.match(
    browserPanel,
    /invoke<BrowserInfo>\('browser_open', \{[\s\S]*?sessionId,[\s\S]*?url: url \|\| null,[\s\S]*?visible: false,[\s\S]*?\}\)/,
  );
  assert.match(
    tauriIpc,
    /browser_open: \[[\s\S]*?sessionId\?: string \| null; url\?: string \| null; visible\?: boolean \| null[\s\S]*?BrowserInfo[\s\S]*?\];/,
  );
  assert.match(browserBackend, /pub fn open_with_visibility\(/);
  assert.match(browserCommands, /visible\.unwrap_or\(true\)/);
  for (const command of [
    'browser_set_active_session',
    'browser_open',
    'browser_set_visible',
    'browser_navigate',
  ]) {
    const commandStart = browserCommands.indexOf(`pub async fn ${command}(`);
    const commandEnd = browserCommands.indexOf('\n}\n', commandStart);
    assert.ok(commandStart > 0 && commandEnd > commandStart, `${command} must be async`);
    assert.match(
      browserCommands.slice(commandStart, commandEnd),
      /run_blocking_browser_command\(/,
      `${command} must leave the Tauri UI thread before waiting for the native surface lane`,
    );
  }
  const hiddenOpenStart = browserBackend.indexOf('if !visible {');
  const hiddenOpenReturn = browserBackend.indexOf(
    'return self.info(app, Some(&session_id));',
    hiddenOpenStart,
  );
  const ensurePreview = browserBackend.indexOf(
    'let webview = ensure_browser_webview(',
    hiddenOpenStart,
  );
  assert.ok(hiddenOpenStart > 0);
  assert.ok(hiddenOpenReturn > hiddenOpenStart);
  assert.ok(
    hiddenOpenReturn < ensurePreview,
    'hidden open must return unconditionally before the only native creation path',
  );
  const hiddenOpen = browserBackend.slice(hiddenOpenStart, hiddenOpenReturn);
  assert.match(hiddenOpen, /if let Some\(webview\) = app\.get_webview\(&session\.label\)/);
  assert.match(hiddenOpen, /webview[\s\S]*?\.hide\(\)/);
  assert.match(hiddenOpen, /parsed_requested\.as_ref\(\)/);
  assert.match(hiddenOpen, /webview\.navigate\(parsed\.clone\(\)\)/);
  assert.doesNotMatch(hiddenOpen, /ensure_browser_webview\(/);
  const visibleOpenStart = browserBackend.indexOf(
    'self.with_preview_surface_slot(app, || {',
    hiddenOpenReturn,
  );
  const visibleOpenEnd = browserBackend.indexOf(
    'self.info(app, Some(&session_id))',
    visibleOpenStart,
  );
  const visibleOpen = browserBackend.slice(visibleOpenStart, visibleOpenEnd);
  assert.ok(visibleOpenStart > hiddenOpenReturn && visibleOpenEnd > visibleOpenStart);
  assert.match(visibleOpen, /ensure_browser_webview\(/);
  assert.match(visibleOpen, /webview\.navigate\(parsed\)/);
  assert.match(visibleOpen, /apply_browser_bounds\(&webview, session\.bounds\)/);
  assert.match(visibleOpen, /self\.registry\.set_visible\(&session_id, true\)/);
  const navigateStart = browserBackend.indexOf('    pub fn navigate(');
  const navigateEnd = browserBackend.indexOf('    pub fn reload(', navigateStart);
  const navigate = browserBackend.slice(navigateStart, navigateEnd);
  const navigateSlot = navigate.indexOf('self.with_preview_surface_slot(app, || {');
  assert.ok(navigateSlot > 0);
  assert.ok(
    navigate.indexOf('ensure_browser_webview(') > navigateSlot,
    'missing Preview child creation must happen only after Login CEF is hidden',
  );
  assert.ok(
    navigate.indexOf('webview.navigate(parsed)') > navigateSlot,
    'Preview navigation must stay inside the native surface ownership lane',
  );
  assert.match(
    browserBackend,
    /if visible && app\.get_webview\(&session\.label\)\.is_none\(\) \{[\s\S]*?ensure_browser_webview\(/,
  );
  assert.match(previewWebview, /initially_visible: bool/);
  assert.match(previewWebview, /if !initially_visible \{[\s\S]*?webview[\s\S]*?\.hide\(\)/);

  assert.match(allProjects, /const gatedOpen = useNativeSurfaceOcclusion\(open\)/);
  assert.match(allProjects, /if \(!gatedOpen\) return null/);
  assert.match(projectPicker, /const gatedOpen = useNativeSurfaceOcclusion\(open\)/);
  assert.match(projectPicker, /if \(!gatedOpen\)/);
  assert.match(reviewPopover, /const gatedOpen = useNativeSurfaceOcclusion\(isOpen\)/);
  assert.match(reviewPopover, /open=\{gatedOpen\}/);
  assert.match(app, /const gatedOpen = useNativeSurfaceOcclusion\(true\)/);
  assert.match(app, /if \(!gatedOpen\) return null/);
});
