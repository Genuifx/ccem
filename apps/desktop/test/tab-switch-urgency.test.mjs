import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readAppSource() {
  return fs.readFile(path.join(desktopDir, 'src', 'App.tsx'), 'utf8');
}

function extractNavigateToTabBody(appSource) {
  const marker = 'const navigateToTab = useCallback((tab: string) => {';
  const start = appSource.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const bodyStart = start + marker.length;
  // Walk to the matching closing brace of the callback body.
  let depth = 1;
  let index = bodyStart;
  while (index < appSource.length && depth > 0) {
    const char = appSource[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }
    index += 1;
  }
  if (depth !== 0) {
    return null;
  }
  return appSource.slice(bodyStart, index - 1);
}

test('navigateToTab commits setActiveTab urgently (no startTransition wrap)', async () => {
  const appSource = await readAppSource();
  const body = extractNavigateToTabBody(appSource);

  assert.ok(body, 'navigateToTab useCallback body must be findable in App.tsx');

  // The active-session transcript poll commits urgent setEvents batches every
  // 140ms. A transition-wrapped tab switch gets interrupted and restarted by
  // each of those updates and never commits on long transcripts, freezing
  // every tab entry point. setActiveTab must therefore stay urgent.
  assert.ok(
    body.includes('setActiveTab(tab)'),
    'navigateToTab must call setActiveTab(tab) directly',
  );
  assert.ok(
    !body.includes('startTransition'),
    'navigateToTab must not wrap setActiveTab in startTransition — the 140ms urgent poll starves the transition render on long transcripts',
  );
});

test('tab entry points route through the urgent navigateToTab choke point', async () => {
  const appSource = await readAppSource();

  // Sidebar rail.
  assert.match(appSource, /onTabChange=\{navigateToTab\}/);
  // ⌘N shortcuts.
  assert.match(appSource, /'meta\+1': \(\) => navigateToTab\('workspace'\)/);
  // Tray / menu navigation events.
  assert.match(appSource, /tray-open-tab/);
  assert.match(appSource, /navigateToTab\(event\.payload\.tab\)/);
});
