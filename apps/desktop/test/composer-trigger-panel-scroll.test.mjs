import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readSource(relativePath) {
  return fs.readFile(path.join(desktopDir, relativePath), 'utf8');
}

/**
 * REQ-0042: the composer @ trigger panel must own its scrolling through the
 * shared shadcn ScrollArea exactly once. Before the fix, two native
 * overflow-y-auto wrappers (attention dock max-h-[min(35vh,280px)] plus the
 * panel's own max-h-[min(42vh,320px)]) stacked around a ScrollArea disabled
 * with max-h-none, so long suggestion lists rendered two simultaneous native
 * scrollbars and a nested scroll trap.
 */
test('composer trigger suggestion panel scrolls through a single shared ScrollArea', async () => {
  const composer = await readSource('src/components/workspace/WorkspaceSessionComposer.tsx');
  const start = composer.indexOf('function ComposerTriggerSuggestionPanel');
  const nextDecl = start === -1 ? null : composer.slice(start + 10).match(/\n(?:export )?function /);
  const end = nextDecl ? start + 10 + nextDecl.index : composer.length;
  assert.ok(start !== -1, 'ComposerTriggerSuggestionPanel should exist');
  const panel = composer.slice(start, end);

  assert.doesNotMatch(
    panel,
    /overflow-y-auto/,
    'the @ panel must not wrap TriggerPopover in a native overflow-y-auto scroller',
  );
  assert.match(
    panel,
    /max-h-\[min\(35vh,280px\)\]/,
    'the ScrollArea cap must match the attention dock budget so the dock never scrolls for this section alone',
  );
});

test('static trigger popover renders one always-mounted shadcn overlay scrollbar', async () => {
  const popover = await readSource('src/components/trigger-popover.tsx');
  assert.match(
    popover,
    /'w-full min-w-0 bg-transparent p-0 shadow-none ccem-overlay-scroll'/,
    'static placement should use the repo overlay thumb pattern for a visible styled scrollbar',
  );
  assert.match(
    popover,
    /type=\{placement === 'static' \? 'always' : undefined\}/,
    'static placement should mount the Radix scrollbar with type="always" (hover-type never mounts in this webview)',
  );
});

test('attention dock keeps one outer clamp for stacked attention sections', async () => {
  const composer = await readSource('src/components/workspace/WorkspaceSessionComposer.tsx');
  assert.match(
    composer,
    /max-h-\[min\(35vh,280px\)\] space-y-1 overflow-y-auto overscroll-contain/,
    'the attention dock clamp should stay in place as the fallback scroller for multi-section stacks',
  );
});
