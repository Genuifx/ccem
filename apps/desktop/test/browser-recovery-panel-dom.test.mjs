import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const sourceDir = path.resolve(import.meta.dirname, '../src');

function effectContaining(source, marker) {
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `Workspace effect fixture: ${marker}`);
  return source.slice(source.lastIndexOf('  useEffect(() => {', markerAt), source.indexOf('\n\n', markerAt));
}

async function recoveryModules(restored) {
  const modules = new Map();
  const files = {
    '@/lib/webcontentRecovery': 'lib/webcontentRecovery.ts',
    './browserPanelTarget': 'components/workspace/browserPanelTarget.ts',
    './hook': 'components/workspace/useBrowserWorkspaceRecovery.ts',
  };
  const sources = new Map();
  for (const [name, file] of Object.entries(files)) {
    sources.set(name, ts.transpileModule(await fs.readFile(path.join(sourceDir, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  const saves = [];
  function load(name) {
    if (name === 'react') return React;
    if (name === './recoveryDrafts') return { recoveryDraftDiagnostics: () => ({}) };
    if (name === '@tauri-apps/api/core') return { async invoke(command, args) {
      if (command === 'webcontent_frontend_boot') {
        return { documentId: args.documentId, generation: 0, recovered: true, browserWorkspace: restored };
      }
      if (command === 'webcontent_browser_workspace_save') saves.push(args.workspace);
      else throw new Error(`Unexpected recovery command: ${command}`);
    } };
    if (modules.has(name)) return modules.get(name);
    assert.ok(sources.has(name), `Unexpected recovery dependency: ${name}`);
    const module = {};
    modules.set(name, module);
    new Function('require', 'exports', 'window', 'crypto', sources.get(name))(
      load, module, { __TAURI_INTERNALS__: {} }, { randomUUID: () => 'restored-document' },
    );
    return module;
  }
  return {
    recovery: load('@/lib/webcontentRecovery'), hook: load('./hook'),
    target: load('./browserPanelTarget'), saves,
  };
}

test('StrictMode restores a retained compose panel before directory retirement and preserves deliberate folder changes', async t => {
  const restored = {
    version: 1, instanceSequence: 3,
    targets: { 'draft:workspace': {
      backend: 'login', instanceId: 3, surfaceSessionId: 'draft:workspace:3',
      workingDir: '/retained-draft', profileMode: 'default', visible: true,
    } },
    sessionKeys: { runtime: [], provider: [] },
  };
  const modules = await recoveryModules(restored);
  await modules.recovery.initializeWebcontentRecovery();
  const source = await fs.readFile(path.join(sourceDir, 'pages/Workspace.tsx'), 'utf8');
  // Run the real Workspace effects with the real hydration hook. Assertions
  // inspect React state and acknowledged host snapshots, not source strings.
  const directorySync = effectContaining(source, 'if (selectedWorkingDir && selectedWorkingDir !== composeDir)');
  const draftRecovery = effectContaining(source, 'const restoredDraft = browserTargetBySessionIdRef.current[WORKSPACE_BROWSER_COMPOSE_SESSION_ID]');
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(document.querySelector('#root'));
  t.after(() => {
    React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let state, choose;
  const Harness = new Function('React', 'modules', 'record', `return function Harness() {
    const {useEffect,useRef,useState}=React;
    const {ready:browserWorkspaceReady,targets,targetsRef:browserTargetBySessionIdRef,updateTargets:updateBrowserPanelTargets}=modules.hook.useBrowserWorkspaceRecovery();
    const browserComposeRecoveryCheckedRef=useRef(false);
    const [composeDir,setComposeDir]=useState('/fresh-default');
    const [selectedWorkingDir,setSelectedWorkingDir]=useState('/fresh-default');
    const workspaceMode='compose';
    const skillsContext={workingDir:composeDir};
    const {WORKSPACE_BROWSER_COMPOSE_SESSION_ID,retireBrowserPanelTargetForWorkingDirChange}=modules.target;
    ${directorySync}
    ${draftRecovery}
    record({targets,composeDir,selectedWorkingDir},dir=>{setSelectedWorkingDir(dir);setComposeDir(dir);});
    return React.createElement('div',null,Object.keys(targets).join(','));
  }`)(React, modules, (next, select) => { state = next; choose = select; });
  await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  await modules.recovery.flushBrowserWorkspace();
  assert.equal(state.composeDir, '/retained-draft');
  assert.equal(state.selectedWorkingDir, '/retained-draft');
  assert.deepEqual(state.targets, restored.targets, 'effect replay must not retire the restored draft');
  assert.deepEqual(modules.saves.at(-1).targets, restored.targets);
  assert.ok(modules.saves.every(save => save.targets['draft:workspace']), 'no intermediate empty snapshot may discard the retained identity');
  await React.act(async () => choose('/intentional-new-folder'));
  await modules.recovery.flushBrowserWorkspace();
  assert.deepEqual(state.targets, {}, 'an intentional directory change still retires the prior draft');
  assert.deepEqual(modules.saves.at(-1).targets, {});
});
