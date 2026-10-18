import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalyticsInsights } from '../../src/components/analytics/AnalyticsInsights';
import { LocaleProvider } from '../../src/locales';
import { buildWeekBucketKey } from '../../src/lib/analyticsTimeBuckets';

const usage = (tokens = 888100000) => ({
  inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  cost: 0, unpricedTokens: 0, costIncomplete: false,
});
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const now = new Date();
const today = dayKey(now);
const hour = `${today}T${String(now.getHours()).padStart(2, '0')}`;
const keys = { hour, day: today, week: buildWeekBucketKey(today), month: today.slice(0, 7) };
const dailyHistory = Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
  const date = new Date(now);
  date.setDate(date.getDate() - 6 + index);
  return [dayKey(date), usage(index === 6 ? 888100000 : 100000000)];
}));
const initialStats = {
  today: usage(), week: usage(), month: usage(), total: usage(),
  dailyHistory, hourlyHistory: { [hour]: usage() },
  byModel: { 'fixture-model': usage() }, byEnvironment: {}, lastUpdated: 'fixture:1',
};

const requests: any[] = [];
const fixture: any = {
  requests,
  refreshes: 0,
  mode: 'pending',
  breakdown(granularity: keyof typeof keys, model = 'fixture-model') {
    return { [keys[granularity]]: { [model]: usage() } };
  },
  resolve(index: number, model?: string) {
    const request = requests[index];
    request.resolve(fixture.breakdown(request.args.granularity, model));
  },
  reject(index: number) { requests[index].reject(new Error('Fixture breakdown failed')); },
  async invoke(command: string, args: any) {
    if (command === 'get_settings') return { language: 'zh' };
    if (command !== 'get_usage_model_breakdown') throw new Error(`Unexpected fixture command: ${command}`);
    return new Promise((resolve, reject) => {
      requests.push({ args, resolve, reject });
      if (fixture.mode === 'success') resolve(fixture.breakdown(args.granularity));
    });
  },
};
(window as any).__analyticsFixture = fixture;
document.addEventListener('click', (event) => {
  const radio = (event.target as Element).closest('[role="radio"]');
  if (radio) queueMicrotask(() => {
    fixture.selectionAfterClick = { label: radio.textContent, selected: radio.getAttribute('aria-checked') };
  });
});
document.documentElement.dataset.performanceMode = new URLSearchParams(location.search).get('mode') ?? 'default';

function Fixture() {
  const [stats, setStats] = useState(initialStats);
  const [source, setSource] = useState<any>('all');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  fixture.setBusy = setBusy;
  fixture.update = (lastUpdated: string) => setStats({ ...initialStats, lastUpdated });
  fixture.source = setSource;
  return <LocaleProvider>{busy && <PollingSibling />}<AnalyticsInsights
    usageStats={stats} usageSource={source} enableModelBreakdown milestones={[]}
    isRefreshing={false} refreshRevision={refreshRevision}
    onRefresh={async () => { fixture.refreshes += 1; setRefreshRevision((value) => value + 1); }}
  /></LocaleProvider>;
}

// The desktop keeps the workspace mounted while viewing analytics. Its urgent
// polling updates can interrupt unrelated concurrent work in the same root.
function PollingSibling() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 10);
    return () => clearInterval(id);
  }, []);
  return <div hidden>{Array.from({ length: 30 }, (_, index) => <BusyRow key={index} tick={tick} />)}</div>;
}
function BusyRow({ tick }: { tick: number }) {
  const started = performance.now();
  while (performance.now() - started < 1) { /* Simulate transcript render work. */ }
  return <span>{tick}</span>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
