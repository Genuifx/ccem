import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { instrumentComponentRenders, interactionPerformancePlugin } from './helpers/workspace-interaction-performance-build.mjs';
import { installEditorStyleMutationProbe } from './helpers/workspace-input-style-probe.mjs';

function execute(source) {
  const instrumented = instrumentComponentRenders(source, 'fixture.tsx');
  const calls = [];
  const context = { __workspaceInteractionProbe: { render: (...args) => calls.push(args) } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(instrumented.source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return { context, calls, components: instrumented.components };
}

test('a declaration records actual native renders with its runtime, retaining output', () => {
  const { context, calls } = execute(`
    function WorkspaceNativeSessionView({ session }: { session: { runtime_id: string } }) {
      return session.runtime_id.toUpperCase();
    }
    globalThis.run = WorkspaceNativeSessionView;
  `);
  assert.equal(calls.length, 0);
  assert.equal(context.run({ session: { runtime_id: 'fixture-a' } }), 'FIXTURE-A');
  assert.deepEqual(calls, [['WorkspaceNativeSessionView', 'fixture-a']]);
});

test('a memo expression counts its body only when the wrapper invokes it', () => {
  const { context, calls } = execute(`
    function memo(render) {
      let previous;
      let result;
      return function wrapped(props) {
        if (props !== previous) { previous = props; result = render(props); }
        return result;
      };
    }
    const WorkspaceNativeSessionView = memo(function WorkspaceNativeSessionView({ session }) {
      return session.runtime_id;
    });
    globalThis.run = WorkspaceNativeSessionView;
  `);
  assert.equal(calls.length, 0, 'creating a memo component is not a render');
  const props = { session: { runtime_id: 'fixture-a' } };
  assert.equal(context.run(props), 'fixture-a');
  assert.equal(context.run(props), 'fixture-a');
  assert.equal(calls.length, 1, 'a skipped memo body must not increment the counter');
  assert.equal(context.run({ session: { runtime_id: 'fixture-b' } }), 'fixture-b');
  assert.deepEqual(calls, [['WorkspaceNativeSessionView', 'fixture-a'], ['WorkspaceNativeSessionView', 'fixture-b']]);
});

test('tool probe records group identity without modifying entries or invoking nested functions', () => {
  const { context, calls } = execute(`
    function WorkspaceToolDigestComponent({ entries }) {
      function nested() { return entries; }
      return nested();
    }
    globalThis.run = WorkspaceToolDigestComponent;
  `);
  const entries = [{ block: { id: 'fixture-a-turn-12-tool-0' } }];
  assert.equal(context.run({ entries }), entries);
  assert.deepEqual(calls, [['WorkspaceToolDigestComponent', 'fixture-a-turn-12-tool-0']]);
});

test('forwardRef named expressions preserve parameters and optional probes', () => {
  const { context, calls } = execute(`
    const forwardRef = (render) => render;
    const PromptArea = forwardRef(function PromptArea({ 'data-test-id': dataTestId }, ref) {
      return ref.value;
    });
    globalThis.run = PromptArea;
  `);
  assert.equal(context.run({ 'data-test-id': 'composer' }, { value: 42 }), 42);
  assert.deepEqual(calls, [['PromptArea', 'composer']]);
  delete context.__workspaceInteractionProbe;
  assert.equal(context.run({}, { value: 7 }), 7);
});

test('light native wrappers resolve the runtime from props or a rest binding', () => {
  for (const [parameter, expression] of [
    ['props', 'props.session.runtime_id'],
    ['{ isVisible = true, ...props }', 'props.session.runtime_id'],
  ]) {
    const { context, calls } = execute(`
      function WorkspaceNativeSessionView(${parameter}) { return ${expression}; }
      globalThis.run = WorkspaceNativeSessionView;
    `);
    assert.equal(context.run({ session: { runtime_id: 'fixture-c' } }), 'fixture-c');
    assert.deepEqual(calls, [['WorkspaceNativeSessionView', 'fixture-c']]);
  }
});

test('heavy native content is counted separately from the light context wrapper', () => {
  const { context, calls, components } = execute(`
    function WorkspaceNativeSessionViewContent({ session }) { return session.runtime_id; }
    function WorkspaceNativeSessionView(props) { return WorkspaceNativeSessionViewContent(props); }
    globalThis.run = WorkspaceNativeSessionView;
  `);
  assert.deepEqual(components, ['WorkspaceNativeSessionViewContent', 'WorkspaceNativeSessionView']);
  assert.equal(context.run({ session: { runtime_id: 'fixture-a' } }), 'fixture-a');
  assert.deepEqual(calls, [
    ['WorkspaceNativeSessionView', 'fixture-a'],
    ['WorkspaceNativeSessionViewContent', 'fixture-a'],
  ]);
});

test('relative Tauri core imports are isolated while unrelated core modules remain unchanged', () => {
  const resolvers = [];
  interactionPerformancePlugin({ desktop: '/fixture/apps/desktop', repository: '/fixture',
    baseline: false, revision: 'HEAD', manifest: { components: [], productionModules: [] } }).setup({
    onResolve(options, resolve) { resolvers.push({ ...options, resolve }); },
    onLoad() {},
  });
  const relative = resolvers.find(({ filter }) => filter.test('./core.js'));
  const expected = { path: 'core', namespace: 'interaction-performance-ipc' };
  assert.deepEqual(relative.resolve({ importer: '/fixture/node_modules/@tauri-apps/api/event.js' }), expected);
  assert.deepEqual(relative.resolve({ importer: '/fixture/node_modules/.pnpm/api/node_modules/@tauri-apps/api/window.js' }), expected);
  assert.equal(relative.resolve({ importer: '/fixture/node_modules/unrelated-package/event.js' }), undefined);
  assert.equal(relative.filter.test('/fixture/node_modules/@tauri-apps/api/core.js'), false,
    'the stub must retain its absolute original-core re-export');
});

function styleProbeHarness() {
  const observers = [];
  const editors = ['height: 40px;', 'height: 60px;'].map((style) => ({ style, getAttribute() { return this.style; } }));
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.pending = []; this.disconnected = false; observers.push(this); }
    observe() {}
    takeRecords() { const records = this.pending; this.pending = []; return records; }
    disconnect() { this.disconnected = true; }
  }
  const context = { document: { querySelectorAll: () => editors }, MutationObserver: FakeMutationObserver };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`globalThis.install = ${installEditorStyleMutationProbe.toString()}; install();`, context);
  const mutation = (target, oldValue) => ({ target, attributeName: 'style', oldValue });
  return { context, observers, editors, mutation };
}

test('style mutation probe retains synchronous auto-to-pixel transitions across interleaved editors', () => {
  const { context, observers, editors: [first, second], mutation } = styleProbeHarness();
  first.style = 'height: 40px;';
  second.style = 'height: 80px;';
  observers[0].callback([
    mutation(first, 'height: 40px;'), mutation(second, 'height: 60px;'),
    mutation(first, 'height: auto;'),
  ]);
  const result = context.__workspaceInputStyleProbe.stop();
  assert.equal(result.heightStyleMutations, 3);
  assert.equal(result.heightAutoMutations, 1);
  assert.equal(result.styleMutationRecords, 3);
  assert.equal(result.editorCount, 2);
});

test('style probe drains stop records, ignores same-height assignments and rejects late generation callbacks', () => {
  const { context, observers, editors: [first], mutation } = styleProbeHarness();
  first.style = 'height: 40px; width: 200px;';
  observers[0].callback([mutation(first, 'height: 40px; width: 100px;')]);
  assert.equal(context.__workspaceInputStyleProbe.sample().heightStyleMutations, 0);
  first.style = 'height: auto;';
  observers[0].pending = [mutation(first, 'height: 40px;')];
  const stopped = context.__workspaceInputStyleProbe.stop();
  assert.equal(stopped.heightStyleMutations, 1);
  assert.equal(stopped.heightAutoMutations, 1);
  assert.equal(observers[0].disconnected, true);
  context.install();
  observers[0].callback([mutation(first, 'height: 40px;')]);
  assert.equal(context.__workspaceInputStyleProbe.stop().heightStyleMutations, 0);
});
