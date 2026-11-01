import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build, stop: stopEsbuild } = require('esbuild');
const { JSDOM } = require('jsdom');

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let harnessPromise;

test.after(async () => {
  if (harnessPromise) await fs.rm((await harnessPromise).tempDir, { recursive: true, force: true });
  stopEsbuild();
});

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try next shape.
    }
  }
  return null;
}

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({ path: await resolveDesktopSource(args.path) }));
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-replay-state-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      resolveDir: desktopDir,
      sourcefile: 'harness.jsx',
      loader: 'jsx',
      contents: `
        const React = require('react');
        const { useMemo, useState, startTransition } = require('react');
        const { createRoot } = require('react-dom/client');
        const { flushSync } = require('react-dom');
        const { memoizeReplayUpdater, usePruneConfirmedLocalUserPrompts } = require('@/components/workspace/workspaceReplayState');
        const { appendSessionEvents, filterConfirmedLocalUserPrompts } = require('@/components/workspace/workspaceEventTranscript');

        const event = (seq, payload = { type: 'system_message', message: 'chunk ' + seq }) => ({
          runtime_id: 'native-test', seq, occurred_at: '2026-11-01T00:00:00Z', payload,
        });
        exports.event = event;

        // A poll batch committed inside a transition stays pending while
        // synchronous renders keep interrupting it; React then replays every
        // later updater from the frozen base on each render.
        exports.runReplayScenario = async function runReplayScenario(container, { memoize, interrupts }) {
          const stats = { merges: 0 };
          let setEvents;
          let setTick;
          let latest = [];
          function Harness() {
            const [events, nextEvents] = useState([]);
            const [, nextTick] = useState(0);
            setEvents = nextEvents;
            setTick = nextTick;
            latest = events;
            return null;
          }
          const merge = (batch) => {
            const update = (previous) => { stats.merges += 1; return appendSessionEvents(previous, batch); };
            return memoize ? memoizeReplayUpdater(update) : update;
          };
          const root = createRoot(container);
          flushSync(() => root.render(React.createElement(Harness)));
          startTransition(() => setEvents(merge([event(1)])));
          flushSync(() => setEvents(merge([event(2)])));
          for (let index = 0; index < interrupts; index += 1) flushSync(() => setTick((tick) => tick + 1));
          await new Promise((resolve) => setTimeout(resolve, 30));
          const seqs = latest.map((item) => item.seq);
          root.unmount();
          return { merges: stats.merges, seqs };
        };

        exports.runPruneScenario = async function runPruneScenario(container, { prompts }) {
          const stats = { setterCalls: 0, renders: 0 };
          let setEvents;
          let latestPrompts = prompts;
          function Harness() {
            stats.renders += 1;
            const [events, nextEvents] = useState([]);
            const [localUserPrompts, setLocalUserPromptsRaw] = useState(prompts);
            setEvents = nextEvents;
            latestPrompts = localUserPrompts;
            const setLocalUserPrompts = React.useCallback((value) => {
              stats.setterCalls += 1;
              setLocalUserPromptsRaw(value);
            }, []);
            const unconfirmed = useMemo(
              () => filterConfirmedLocalUserPrompts(localUserPrompts, events),
              [events, localUserPrompts],
            );
            usePruneConfirmedLocalUserPrompts(events, localUserPrompts, unconfirmed, setLocalUserPrompts);
            return null;
          }
          const root = createRoot(container);
          flushSync(() => root.render(React.createElement(Harness)));
          return {
            stats,
            prompts: () => latestPrompts,
            async append(batch, { transition = false } = {}) {
              const apply = () => setEvents((previous) => appendSessionEvents(previous, batch));
              if (transition) startTransition(apply); else flushSync(apply);
              await new Promise((resolve) => setTimeout(resolve, 20));
            },
            unmount() { root.unmount(); },
          };
        };
      `,
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    outfile,
    plugins: [aliasPlugin],
    logLevel: 'silent',
  });
  const harness = await import(pathToFileURL(outfile).href);
  return { ...harness, tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = new Map();
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('IS_REACT_ACT_ENVIRONMENT', false);
  return {
    container: dom.window.document.getElementById('root'),
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    },
  };
}

function harness() {
  harnessPromise ??= importHarness();
  return harnessPromise;
}

test('React replays committed updaters from the frozen base while a transition is pending', async () => {
  const { runReplayScenario } = await harness();
  const dom = installDom();
  try {
    const { merges, seqs } = await runReplayScenario(dom.container, { memoize: false, interrupts: 20 });
    assert.deepEqual(seqs, [1, 2]);
    // Control: without memoization the second batch is merged again on every
    // interrupting render. This is the cost that grew with uptime.
    assert.ok(merges >= 20, `expected at least 20 replayed merges, got ${merges}`);
  } finally {
    dom.restore();
  }
});

test('memoized replay updaters merge each batch once per distinct input', async () => {
  const { runReplayScenario } = await harness();
  const dom = installDom();
  try {
    const { merges, seqs } = await runReplayScenario(dom.container, { memoize: true, interrupts: 20 });
    assert.deepEqual(seqs, [1, 2], 'events must not be lost or reordered');
    // Sync render, then the transition render rebases batch 2 onto batch 1.
    assert.ok(merges <= 4, `expected at most 4 merges, got ${merges}`);
  } finally {
    dom.restore();
  }
});

test('pruning never schedules a state update when nothing was confirmed', async () => {
  const { runPruneScenario, event } = await harness();
  const dom = installDom();
  try {
    const scenario = await runPruneScenario(dom.container, { prompts: [] });
    for (let seq = 1; seq <= 10; seq += 1) {
      await scenario.append([event(seq)], { transition: seq % 2 === 0 });
    }
    assert.equal(scenario.stats.setterCalls, 0, 'an empty prompt list must not trigger setState');
    scenario.unmount();
  } finally {
    dom.restore();
  }
});

test('pruning still removes a prompt once its user_prompt event arrives', async () => {
  const { runPruneScenario, event } = await harness();
  const dom = installDom();
  try {
    const prompt = { id: 'client-1', text: 'hello', afterEventSeq: 0 };
    const scenario = await runPruneScenario(dom.container, { prompts: [prompt] });
    await scenario.append([event(1)]);
    assert.equal(scenario.prompts().length, 1, 'unrelated events keep the prompt');
    assert.equal(scenario.stats.setterCalls, 0);
    await scenario.append([event(2, { type: 'user_prompt', text: 'hello', client_message_id: 'client-1' })]);
    assert.equal(scenario.prompts().length, 0, 'the confirming event removes the prompt');
    assert.equal(scenario.stats.setterCalls, 1);
    scenario.unmount();
  } finally {
    dom.restore();
  }
});
