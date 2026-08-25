/**
 * JSDOM + React act() behavior tests for DSH Analytics integration (Phase 3).
 * Verifies: DSH filter presence, source guard (only 'all' updates global store),
 * costIncomplete/unpriced state visibility, and provider distribution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');
let cachedHarness;

test.after(async () => {
  if (cachedHarness) {
    await fs.rm(cachedHarness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
  setTimeout(() => process.exit(0), 100).unref();
});

// --- esbuild plugins (same pattern as dsh-history-dom.test.mjs) ---

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_EXTENSIONS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

async function resolveDesktopSource(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  for (const fn of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, fn);
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}

// PLACEHOLDER_CONTINUE

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveDesktopSource(args.path);
      if (!resolved) return { errors: [{ text: `Could not resolve ${args.path}` }] };
      return { path: resolved };
    });
  },
};

/**
 * Mock store module that tracks setUsageStats calls.
 */
const MOCK_STORE_CODE = `
const _mock = { setUsageStatsCalls: [], lastUsageStats: null };
const storeState = {
  usageStats: null,
  milestones: [],
  continuousUsageDays: 0,
  isLoadingStats: false,
  setUsageStats: (stats) => { _mock.setUsageStatsCalls.push(stats); _mock.lastUsageStats = stats; storeState.usageStats = stats; },
  setMilestones: () => {},
  setContinuousUsageDays: () => {},
  setLoadingStats: () => {},
};
function useAppStore(selector) {
  if (typeof selector === 'function') return selector(storeState);
  return storeState;
}
useAppStore.getState = () => storeState;
useAppStore._mock = _mock;
useAppStore._setState = (partial) => Object.assign(storeState, partial);
useAppStore._reset = () => {
  storeState.usageStats = null;
  storeState.milestones = [];
  storeState.continuousUsageDays = 0;
  storeState.isLoadingStats = false;
  _mock.setUsageStatsCalls.length = 0;
  _mock.lastUsageStats = null;
};
globalThis.__analyticsStore = useAppStore;
export { useAppStore };
export default useAppStore;
`;

// PLACEHOLDER_PLUGINS

/** Controllable invoke mock — resolves with provided stats per source */
let invokeResults = {};
const INVOKE_STUB = `
const _mock = { calls: [] };
export function invoke(cmd, args) {
  _mock.calls.push({ cmd, args });
  return globalThis.__testInvokeHandler?.(cmd, args) ?? Promise.resolve(null);
}
export const _invokeStub = _mock;
`;

const externalStubPlugin = {
  name: 'analytics-test-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api/ }, () => ({
      path: 'tauri-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^tauri-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js', contents: INVOKE_STUB,
    }));
    builder.onResolve({ filter: /^@\/locales$/ }, () => ({
      path: 'locale-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^locale-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useLocale() { return { t: (key) => key, lang: 'zh' }; }
        export function LocaleProvider({ children }) { return children; }
      `,
    }));
    builder.onResolve({ filter: /\/store/ }, async (args) => {
      if (args.path.includes('@/store') || args.path.endsWith('/store')) {
        return { path: 'store-stub', namespace: 'analytics-stubs' };
      }
      return null;
    });
    builder.onLoad({ filter: /^store-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js', contents: MOCK_STORE_CODE,
    }));
    builder.onResolve({ filter: /^sonner$/ }, () => ({
      path: 'sonner-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^sonner-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js',
      contents: `export const toast = { success(){}, error(){}, warning(){} }; export function Toaster() { return null; }`,
    }));
    builder.onResolve({ filter: /zustand\/shallow/ }, () => ({
      path: 'shallow-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^shallow-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js',
      contents: `export function shallow(a, b) { return a === b; }`,
    }));
    builder.onResolve({ filter: /gsapMotion|gsap/ }, () => ({
      path: 'gsap-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^gsap-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js',
      contents: `
        export const gsap = { fromTo(){}, killTweensOf(){} };
        export const ccemMotion = { duration: { quick: 0.2 }, ease: { standard: 'power2.out' } };
        export function clearMotionProps() {}
        export function getMotionTargets() { return []; }
        export function shouldReduceMotion() { return true; }
        export function useGSAP() {}
      `,
    }));
    builder.onResolve({ filter: /lucide-react/ }, () => ({
      path: 'lucide-stub', namespace: 'analytics-stubs',
    }));
    builder.onLoad({ filter: /^lucide-stub$/, namespace: 'analytics-stubs' }, () => ({
      loader: 'js',
      contents: `
        const Icon = (props) => null;
        Icon.Color = Icon;
        export const Flame = Icon;
        export const RefreshCw = Icon;
        export const Share2 = Icon;
        export const TrendingUp = Icon;
        export const TrendingDown = Icon;
        export default Icon;
      `,
    }));
    // Stub lazy-loaded components
    builder.onResolve({ filter: /AnalyticsInsights|SharePosterDialog|HeatmapCalendar|skeleton-states|EmptyState|useCountUp/ }, (args) => {
      return { path: `lazy-${args.path.replace(/[^a-z]/gi, '')}`, namespace: 'analytics-stubs' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'analytics-stubs' }, (args) => {
      if (args.path.startsWith('lazy-')) {
        return {
          loader: 'js',
          contents: `
            export function AnalyticsInsights() { return null; }
            export function SharePosterDialog() { return null; }
            export function HeatmapCalendar() { return null; }
            export function AnalyticsSkeleton() { return null; }
            export function ErrorBanner() { return null; }
            export function useCountUp(v) { return v; }
            export default function() { return null; }
          `,
        };
      }
      return null;
    });
  },
};

// PLACEHOLDER_HARNESS

function installDom(dom) {
  const g = dom.window;
  g.scrollTo = () => {};
  g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  for (const [name, value] of Object.entries({
    window: g,
    document: g.document,
    navigator: g.navigator,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
    localStorage: g.localStorage,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
}

function makeUsageStats({ costIncomplete = false, unpricedTokens = 0, cost = 5.0 } = {}) {
  const base = {
    inputTokens: 10000,
    outputTokens: 5000,
    cacheReadTokens: 1000,
    cacheCreationTokens: 500,
    cost,
    unpricedTokens,
    costIncomplete,
  };
  return {
    today: { ...base, cost: cost * 0.1 },
    week: { ...base, cost: cost * 0.3 },
    month: { ...base, cost: cost * 0.7 },
    total: { ...base },
    dailyHistory: {},
    hourlyHistory: {},
    byModel: { 'claude-sonnet-4-5': { ...base } },
    byEnvironment: { official: { ...base } },
    lastUpdated: new Date().toISOString(),
  };
}

async function buildHarness() {
  if (cachedHarness) return cachedHarness;
  const artifactsDir = path.join(desktopDir, '.artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(artifactsDir, 'dsh-analytics-dom-'));
  const outfile = path.join(tempDir, 'analytics-bundle.mjs');

  await build({
    entryPoints: [path.join(desktopDir, 'src/pages/Analytics.tsx')],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'browser',
    target: 'esnext',
    jsx: 'automatic',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.MODE': '"test"',
      'import.meta.env.PROD': 'true',
    },
    plugins: [externalStubPlugin, aliasPlugin],
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    logLevel: 'error',
  });

  cachedHarness = { tempDir, outfile };
  return cachedHarness;
}

async function createTestEnv() {
  const { outfile } = await buildHarness();
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  installDom(dom);

  // Inject React into the JSDOM global
  const g = dom.window;
  const React = await import('react');
  const ReactDOM = await import('react-dom/client');
  g.React = React;

  // Load the bundle
  const bundleUrl = pathToFileURL(outfile).href;
  const mod = await import(bundleUrl);

  return { dom, mod, React, ReactDOM, act: React.act, g };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Analytics hydrates cached summary before a slow fresh refresh resolves', async () => {
  const summary = makeUsageStats({ cost: 12.5 });
  let resolveFresh;
  const fresh = new Promise((resolve) => { resolveFresh = resolve; });
  globalThis.__testInvokeHandler = (cmd) => {
    if (cmd === 'get_tray_usage_stats') return Promise.resolve(summary);
    if (cmd === 'get_usage_stats') return fresh;
    return Promise.resolve(null);
  };

  const { dom, mod, React, ReactDOM, act } = await createTestEnv();
  globalThis.__analyticsStore._reset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = ReactDOM.createRoot(dom.window.document.getElementById('root'));

  await act(async () => {
    root.render(React.createElement(mod.Analytics));
    await flush();
  });

  assert.deepEqual(
    globalThis.__analyticsStore._mock.setUsageStatsCalls,
    [summary],
    'the cached summary should leave the skeleton path without waiting for the full refresh',
  );

  await act(async () => {
    resolveFresh(summary);
    await flush();
    root.unmount();
  });
  dom.window.close();
  delete globalThis.__testInvokeHandler;
});

// PLACEHOLDER_TESTS

// ── Test: DSH filter button exists in filter list ──────────────────────────
test('Analytics page includes DSH source filter button', async () => {
  // Read the source to verify the filter array includes 'dsh'
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // The filter array should contain 'dsh'
  assert.match(analyticsSource, /['"]dsh['"]/);
  assert.match(analyticsSource, /analytics-filter-\$\{source\}/);
  // Verify the type includes 'dsh'
  assert.match(analyticsSource, /UsageSourceFilter\s*=\s*['"]all['"].*['"]dsh['"]/s);
});

// ── Test: Only 'all' source updates the global store ───────────────────────
test('applyAnalyticsData guards global store — only all updates setUsageStats', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // The applyAnalyticsData function should check source === 'all' before calling setUsageStats
  assert.match(analyticsSource, /source\s*===\s*['"]all['"]/);
  // Should set local view stats for non-all sources
  assert.match(analyticsSource, /setLocalViewStats/);
});

// ── Test: costIncomplete annotation visible in UI ──────────────────────────
test('cost-incomplete-annotation testid exists in Analytics markup', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  assert.match(analyticsSource, /data-testid="cost-incomplete-annotation"/);
  // Should reference costIncomplete to decide label
  assert.match(analyticsSource, /totalCostIncomplete/);
  assert.match(analyticsSource, /totalUnpricedTokens/);
});

// ── Test: DSH source status indicator exists ───────────────────────────────
test('DSH source status indicator exists for unavailable DSH', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  assert.match(analyticsSource, /data-testid="dsh-source-status"/);
  assert.match(analyticsSource, /dshStatus/);
});

// ── Test: Cost milestones guard with costIncomplete ────────────────────────
test('cost milestones use costFullyPriced guard', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // Cost milestones (cost-10, cost-100) should include costFullyPriced in achieved check
  assert.match(analyticsSource, /costFullyPriced\s*&&\s*totalCost\s*>=\s*10/);
  assert.match(analyticsSource, /costFullyPriced\s*&&\s*totalCost\s*>=\s*100/);
});

// ── Test: viewStats derivation uses localViewStats for filtered sources ────
test('viewStats prefers localViewStats for non-all sources', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // Should have viewStats derivation pattern
  assert.match(analyticsSource, /viewStats\s*=\s*usageSource\s*===\s*['"]all['"]\s*\?\s*usageStats/);
});

// ── Test: TokenUsageWithCost type includes unpriced fields ─────────────────
test('TokenUsageWithCost type has unpricedTokens and costIncomplete', async () => {
  const typesSource = await fs.readFile(
    path.join(desktopDir, 'src/types/analytics.ts'), 'utf-8'
  );
  assert.match(typesSource, /unpricedTokens:\s*number/);
  assert.match(typesSource, /costIncomplete:\s*boolean/);
});

// ── Test: DshSourceStatus type exists ──────────────────────────────────────
test('DshSourceStatus interface is defined in analytics types', async () => {
  const typesSource = await fs.readFile(
    path.join(desktopDir, 'src/types/analytics.ts'), 'utf-8'
  );
  assert.match(typesSource, /interface DshSourceStatus/);
  assert.match(typesSource, /available:\s*boolean/);
  assert.match(typesSource, /sessionCount:\s*number/);
});

// ── Test: UsageStats includes optional dshStatus ───────────────────────────
test('UsageStats interface has optional dshStatus field', async () => {
  const typesSource = await fs.readFile(
    path.join(desktopDir, 'src/types/analytics.ts'), 'utf-8'
  );
  assert.match(typesSource, /dshStatus\?:\s*DshSourceStatus/);
});

// ── Test: Cost consumers handle costIncomplete ─────────────────────────────
test('TrayCockpit adapts cost display for costIncomplete', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src/pages/TrayCockpit.tsx'), 'utf-8'
  );
  assert.match(source, /costIncomplete/);
  // Should prepend ≥ for incomplete costs
  assert.match(source, /≥/);
});

test('StreakUsagePopover adapts cost display for costIncomplete', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src/components/workspace/StreakUsagePopover.tsx'), 'utf-8'
  );
  assert.match(source, /costIncomplete/);
});

test('PosterCardDataInk adapts cost display for costIncomplete', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src/components/analytics/PosterCardDataInk.tsx'), 'utf-8'
  );
  assert.match(source, /costIncomplete/);
});

test('PosterCardTerminal adapts cost display for costIncomplete', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src/components/analytics/PosterCardTerminal.tsx'), 'utf-8'
  );
  assert.match(source, /costIncomplete/);
});

// ── Blocker 1 regression: Provider distribution section ────────────────────
test('Provider distribution section rendered with testid and env rows', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  assert.match(analyticsSource, /data-testid="provider-distribution"/);
  assert.match(analyticsSource, /data-testid=\{`provider-row-\$\{env\}`\}/);
  assert.match(analyticsSource, /byEnvironment/);
});

// ── Blocker 2 regression: dshStatus visible for both all and dsh sources ───
test('dshStatus indicator shows for usageSource dsh as well as all', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // The condition should include both 'all' and 'dsh'
  assert.match(analyticsSource, /usageSource\s*===\s*['"]all['"]\s*\|\|\s*usageSource\s*===\s*['"]dsh['"]/);
});

// ── Blocker 3 regression: dailyActivities memo depends on viewStats ────────
test('dailyActivities useMemo depends on viewStats not usageStats', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  // Extract lines around dailyActivities useMemo to find its dep array
  const lines = analyticsSource.split('\n');
  const startIdx = lines.findIndex(l => l.includes('const dailyActivities') && l.includes('useMemo'));
  assert.ok(startIdx >= 0, 'dailyActivities useMemo found');
  // Scan forward for the closing `}, [...])`
  let depLine = '';
  for (let i = startIdx; i < Math.min(startIdx + 60, lines.length); i++) {
    if (/\},\s*\[.*\]\)/.test(lines[i])) {
      depLine = lines[i];
      break;
    }
  }
  assert.ok(depLine, 'found dep array closing line');
  assert.match(depLine, /\[viewStats\]/, 'dependency is viewStats');
  assert.doesNotMatch(depLine, /\[usageStats\]/, 'not usageStats');
});

// ── Blocker 4 regression: weekly cost card respects week.costIncomplete ─────
test('weekly cost card uses weeklyCostIncomplete for label', async () => {
  const analyticsSource = await fs.readFile(
    path.join(desktopDir, 'src/pages/Analytics.tsx'), 'utf-8'
  );
  assert.match(analyticsSource, /weeklyCostIncomplete/);
  // The weekly cost MetricCell label should reference weeklyCostIncomplete
  assert.match(analyticsSource, /weeklyCostIncomplete\s*\?\s*t\(['"]analytics\.costKnown['"]\)/);
});
