import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, '..');

// Execute the production memo and commit effect in React. In particular, do
// not pre-populate refs with replay metadata: layout effects run after render.
async function loadRender() {
  const source = await fs.readFile(path.join(desktopDir,
    'src/components/workspace/WorkspaceNativeSessionView.tsx'), 'utf8');
  const ast = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let memo;
  let effect;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'transcriptDerivation') {
      memo = node.initializer.getText(ast);
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
      && node.arguments[0]?.getText(ast).includes('const marker = pollReplayCommitMarker;')
      && node.arguments[0]?.getText(ast).includes('resolveCommittedReplayCursor(')) {
      effect = node.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(memo && effect);
  const compiled = ts.transpileModule(`${effect}; const transcriptDerivation = ${memo};
    useLayoutEffect(() => {
      transcriptDerivationRef.current = transcriptDerivation;
      transcriptDerivationBackfillMarkerRef.current = transcriptBackfillCommitMarker;
    }, [transcriptDerivation, transcriptBackfillCommitMarker]);
    return finalizeTranscriptMessages(transcriptDerivation);`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-gap-render-'));
  const output = path.join(temp, 'helpers.cjs');
  await build({
    stdin: {
      contents: `export * from './src/components/workspace/workspaceEventTranscript';
        export * from './src/components/workspace/workspaceTranscriptBackfill';`,
      resolveDir: desktopDir, loader: 'ts',
    },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  return { compiled, helpers: require(output), cleanup: () => fs.rm(temp, { recursive: true }) };
}

for (const scenario of [
  { name: 'empty mount', cached: false, stale: false },
  { name: 'cached head', cached: true, stale: false },
  { name: 'authoritative partial corrects a cached seam', cached: true, stale: false, seam: true },
  { name: 'stale generation cannot suppress real gaps', cached: false, stale: true },
  { name: 'fast backfill refs cannot outrun the committed events', cached: false, stale: false, fast: true },
]) test(`initial replay gap rendering: ${scenario.name}`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { compiled, helpers, cleanup } = await loadRender();
  const container = document.getElementById('root');
  const root = createRoot(container);
  const session = { runtime_id: 'gap-render-runtime' };
  const scope = { runtimeId: session.runtime_id, generation: 1 };
  const seedMessages = [];
  const replayLocalPrompts = { initialPrompt: null, remainingPrompts: [] };
  const ev = (seq, text) => ({ runtime_id: session.runtime_id, seq,
    occurred_at: '2026-09-07T00:00:00Z', payload: { type: 'assistant_chunk', text } });
  let execute;
  let applyPruneSeams;
  function Harness({ events, marker, backfillMarker = null }) {
    const bindings = {
      ...helpers,
      useMemo: React.useMemo, useLayoutEffect: React.useLayoutEffect,
      session, seedMessages, replayLocalPrompts, events,
      transcriptTerminalError: null, pollReplayCommitMarker: marker,
      transcriptBackfillCommitMarker: backfillMarker,
      runtimeRequestScopeRef: React.useRef(scope),
      transcriptDerivationRef: React.useRef(null),
      transcriptDerivationBackfillMarkerRef: React.useRef(null),
      transcriptCommitRecovery: { acknowledge() {} },
      initialReplayRuntimeRef: React.useRef(null),
      rawTailSeamsRef: React.useRef(scenario.seam ? [5] : []),
      rawTailSettledRef: React.useRef(scenario.fast === true),
      initialReplayUnloadedGapStartsRef: React.useRef([]),
      lastSeenSeqRef: React.useRef(null),
      pendingTranscriptPartialObservationRef: React.useRef(null),
      readCachedNativeEvents: () => ({ events: [], seams: [] }),
    };
    applyPruneSeams = (seams) => { bindings.rawTailSeamsRef.current = seams; };
    execute ??= new Function(...Object.keys(bindings), compiled);
    const messages = execute(...Object.values(bindings));
    return React.createElement('div', null, ...messages.map((message, index) =>
      React.createElement('p', { key: index }, message.summary || JSON.stringify(message.content))));
  }
  const render = (events, marker, backfillMarker) => React.act(() => root.render(
    React.createElement(Harness, { events, marker, backfillMarker })));
  const marker = { ...scope, generation: scenario.stale ? 0 : scope.generation,
    commitId: 1, isInitialReplay: true,
    acknowledgedSeq: 20, resetLastSeen: false, rawTailSettled: false,
    clearRawTailSeams: false, initialUnloadedGapStarts: [20], partial: false };
  try {
    await render(scenario.cached ? [ev(1, 'first')] : [], null);
    // 1 -> 5 is a real hole; 5 -> 20 is an intentionally unloaded range.
    await render([ev(1, 'first'), ev(5, 'anchor'), ev(20, 'tail')], marker);
    const expectedGaps = scenario.stale ? 2 : scenario.seam ? 0 : 1;
    assert.equal(container.textContent.split(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN).length - 1, expectedGaps,
      'only the real hole may render a gap in the first committed replay');
    assert.match(container.textContent, /tail/);
    await render([ev(1, 'first'), ev(5, 'anchor'), ev(20, 'tail'), ev(21, 'new tail')], marker);
    assert.equal(container.textContent.split(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN).length - 1, expectedGaps);
    if (scenario.seam) {
      await render([ev(1, 'first'), ev(5, 'anchor'), ev(20, 'tail'), ev(21, 'new tail')], marker,
        { ...scope, commitId: 3, clearProvisionalGaps: true });
      assert.equal(container.textContent.split(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN).length - 1, 2,
        'authoritative partial removes cache/unloaded seam suppression in the same render');
    }
    await render(Array.from({ length: 21 }, (_, i) => ev(i + 1, `entry ${i + 1}`)),
      { ...marker, commitId: 2, rawTailSettled: true, initialUnloadedGapStarts: [] });
    assert.ok(!container.textContent.includes(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN));
    assert.match(container.textContent, /entry 21/);
    // An authoritative backfill confirming a hole supersedes the initial
    // unloaded marker, even when it lands before another poll does.
    await render([ev(1, 'first'), ev(20, 'confirmed missing range')], marker,
      { ...scope, commitId: 3, clearProvisionalGaps: true });
    assert.ok(container.textContent.includes(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN));
    const settledFullMarker = { ...scope, commitId: 4, clearProvisionalGaps: true };
    await render(Array.from({ length: 21 }, (_, i) => ev(i + 1, `complete ${i + 1}`)), marker, settledFullMarker);
    assert.ok(!container.textContent.includes(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN));
    applyPruneSeams([20, 22]);
    await render([ev(1, 'first'), ev(20, 'prune anchor'), ev(22, 'tail after pruning')], marker,
      settledFullMarker);
    assert.ok(!container.textContent.includes(helpers.TRANSCRIPT_GAP_SUMMARY_TOKEN),
      'a consumed authoritative marker must honor subsequently created prune seams');
  } finally {
    await React.act(() => root.unmount());
    await cleanup();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
