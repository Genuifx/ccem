import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const projectTreePath = path.join(desktopDir, 'src', 'components', 'workspace', 'ProjectTree.tsx');
const projectTreeSectionsPath = path.join(
  desktopDir,
  'src',
  'components',
  'workspace',
  'ProjectTreeSections.tsx',
);

async function readSources() {
  const [projectTree, projectTreeSections] = await Promise.all([
    fs.readFile(projectTreePath, 'utf8'),
    fs.readFile(projectTreeSectionsPath, 'utf8'),
  ]);
  return { projectTree, projectTreeSections };
}

test('active temporary section renders as a flat sidebar section, not a floating card', async () => {
  const { projectTreeSections } = await readSources();

  // Section header matches the sibling temporary-projects block — single
  // vocabulary across the sidebar.
  assert.match(
    projectTreeSections,
    /text-\[10px\] font-semibold uppercase tracking-\[0\.08em\] text-muted-foreground[\s\S]*?workspace\.activeTemporaryProjects/,
  );
  assert.match(projectTreeSections, /workspace\.activeTemporaryProjects/);

  // Rendered inside ScrollArea as part of the content flow (mt-2 indicates
  // in-flow spacing, not a shrink-0 bottom-docked layer that leaves whitespace
  // when the project list is short) and separated from the tree by a hairline
  // top border — not wrapped in a bg-background floating card.
  assert.match(
    projectTreeSections,
    /mt-2 border-t border-border\/60[\s\S]*?workspace\.activeTemporaryProjects/,
  );

  // Bans: no ghost-card dock, no nested-card padding wrapper, no decorative
  // drop shadows on chrome surfaces, no backdrop-blur layering.
  assert.doesNotMatch(projectTreeSections, /active-temporary-dock/);
  assert.doesNotMatch(
    projectTreeSections,
    /shadow-\[0_-?\d+px_\d+px_rgba\(15,23,42,0\.0\d\)\]/,
  );
  assert.doesNotMatch(
    projectTreeSections,
    /shadow-\[0_6px_18px_rgba\(15,23,42,0\.05\)\]/,
  );
  assert.doesNotMatch(
    projectTreeSections,
    /rounded-\[1[0-9]px\]/,
    'no over-rounded (>10px) panels — codex tell',
  );
});

test('project rows share one vocabulary across main / temporary / activeTemporary sections', async () => {
  const { projectTreeSections } = await readSources();

  // Single canonical row class for every section.
  const canonicalRow =
    /'group\/project relative mx-1 flex items-center gap-2 rounded-md px-3 py-2 transition-colors duration-150'/;
  assert.match(projectTreeSections, canonicalRow);

  // Bans: no per-section visual branch in the project row markup.
  assert.doesNotMatch(
    projectTreeSections,
    /active-temporary-project/,
    'no special active-temporary project row class',
  );
  assert.doesNotMatch(
    projectTreeSections,
    /grid-cols-\[20px_28px_minmax\(0,1fr\)\]/,
    'no separate grid layout for active-temporary project rows',
  );
  assert.doesNotMatch(
    projectTreeSections,
    /shadow-\[0_0_0_3px_hsl\(var\(--primary\)\/0\.12\)\]/,
    'no decorative primary glow ring on the active-temporary folder chip',
  );
  assert.doesNotMatch(
    projectTreeSections,
    /bg-primary shadow-\[0_0_0_3px/,
    'no primary glow dot decoration',
  );

  // The dismiss (X) button for the active-temporary section must occupy the
  // SAME slot/shape as the SquarePen create button — one shared action slot,
  // not two different grammars.
  const sharedActionSlot =
    /'absolute right-2 top-1\/2 z-10 flex h-7 w-7 -translate-y-1\/2 items-center justify-center rounded-md'/;
  assert.match(projectTreeSections, sharedActionSlot);
});

test('session rows in the active-temporary section use the same chrome as everywhere else', async () => {
  const { projectTree, projectTreeSections } = await readSources();

  // The activeTemporarySection option still exists in the type (so callers can
  // mark intent) but is documented as a visual no-op.
  assert.match(projectTree, /activeTemporarySection\?: boolean/);
  assert.match(
    projectTree,
    /activeTemporarySection is intentionally a no-op visually/,
  );

  // No special-case padding / chrome branches.
  assert.doesNotMatch(
    projectTree,
    /isActiveTemporarySession/,
    'no visual branch on isActiveTemporarySession',
  );
  assert.doesNotMatch(
    projectTree,
    /grid-cols-\[20px_28px_minmax\(0,1fr\)_40px\]/,
    'no separate grid layout for active-temporary session rows',
  );
  assert.doesNotMatch(
    projectTree,
    /isActiveTemporarySession \? 'px-2\.5'/,
    'no separate padding branch for active-temporary session rows',
  );

  // Bans: no 2px primary side-stripe (absolute ban in the design system).
  assert.doesNotMatch(
    projectTree,
    /border-l-2 border-l-primary/,
    'side-stripe borders are banned',
  );
  assert.doesNotMatch(
    projectTree,
    /border-l-2 border-l-transparent/,
    'no invisible side-stripe placeholder either',
  );

  // Selected state is the unified `bg-primary/[0.08] text-primary` — no
  // muted-background + ring variant for any section.
  assert.match(projectTree, /'bg-primary\/\[0\.08\] text-primary'/);

  // Section content no longer passes the activeTemporary flag to the session
  // renderer (callers may still pass it from other paths for intent only).
  assert.doesNotMatch(
    projectTreeSections,
    /activeTemporarySection: true/,
    'do not signal a separate visual mode to the session renderer',
  );

  // Time text stays on one line in narrow widths.
  assert.match(projectTree, /whitespace-nowrap/);
});
