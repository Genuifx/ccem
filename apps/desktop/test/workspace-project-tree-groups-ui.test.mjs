import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const workspaceDir = path.join(desktopDir, 'src', 'components', 'workspace');

async function readSources() {
  const [projectTree, projectTreeSections, grouping] = await Promise.all([
    fs.readFile(path.join(workspaceDir, 'ProjectTree.tsx'), 'utf8'),
    fs.readFile(path.join(workspaceDir, 'ProjectTreeSections.tsx'), 'utf8'),
    fs.readFile(path.join(workspaceDir, 'workspaceSidebarGrouping.ts'), 'utf8'),
  ]);
  return { projectTree, projectTreeSections, grouping };
}

test('fixed groups follow the main content as one flat, in-flow block', async () => {
  const { projectTreeSections } = await readSources();

  // One hairline divider separates the groups from projects (or the recent
  // timeline); it is part of the scroll flow, not a docked floating card.
  assert.match(projectTreeSections, /data-sidebar-groups/);
  assert.match(projectTreeSections, /hasPrimaryContent && 'mt-2 border-t border-border\/45 pt-2'/);
  assert.match(projectTreeSections, /groupNodes\.map\(\(node\) => renderProjectNode\(node, 'group'\)\)/);

  // The retired active-temporary strip stays gone.
  assert.doesNotMatch(projectTreeSections, /activeTemporary/);
  assert.doesNotMatch(projectTreeSections, /active-temporary-dock/);

  // Bans: no decorative drop shadows or over-rounded panels on chrome surfaces.
  assert.doesNotMatch(projectTreeSections, /shadow-\[0_-?\d+px_\d+px_rgba\(15,23,42,0\.0\d\)\]/);
  assert.doesNotMatch(projectTreeSections, /rounded-\[1[0-9]px\]/, 'no over-rounded (>10px) panels');
});

test('group headers reuse the project header vocabulary with localized labels', async () => {
  const { projectTree, projectTreeSections, grouping } = await readSources();

  const canonicalHeader =
    /'group\/project relative mx-1 flex items-center gap-2 rounded-md px-3 py-2 transition-colors duration-150'/;
  assert.match(projectTreeSections, canonicalHeader);
  assert.equal(projectTreeSections.match(canonicalHeader).length, 1, 'one header grammar for projects and groups');

  // Group names are translation keys, rendered through the shared label helper.
  for (const key of ['workspace.groupChat', 'workspace.groupAgent', 'workspace.groupScheduled', 'workspace.temporaryProjects']) {
    assert.match(grouping, new RegExp(key.replace('.', '\\.')));
  }
  assert.match(projectTree, /t\(SIDEBAR_GROUP_LABEL_KEYS\[groupId\]\)/);
  assert.match(projectTreeSections, /groupId \? groupLabel\(groupId\) : node\.projectName/);

  // Folder color stays semantic: primary when open, muted otherwise. No amber
  // "temporary" tint, no per-section badges inside the header.
  assert.doesNotMatch(projectTreeSections, /text-amber-500/);
  assert.doesNotMatch(projectTreeSections, /metaLabel/);

  // Only real directories offer "new session here", in the shared action slot.
  assert.match(projectTreeSections, /createPath && onCreateForProject/);
  assert.match(
    projectTreeSections,
    /'absolute right-2 top-1\/2 z-10 flex h-7 w-7 -translate-y-1\/2 items-center justify-center rounded-md'/,
  );
});

test('session rows keep one chrome everywhere and explain where they ran', async () => {
  const { projectTree } = await readSources();

  // Selected state is the unified `bg-primary/[0.08] text-primary`.
  assert.match(projectTree, /'bg-primary\/\[0\.08\] text-primary'/);
  assert.doesNotMatch(projectTree, /activeTemporary/);
  assert.doesNotMatch(projectTree, /border-l-2 border-l-primary/, 'side-stripe borders are banned');
  assert.doesNotMatch(projectTree, /border-l-2 border-l-transparent/);

  // Recent rows name the origin (group, worktree, project) on the second line;
  // tree rows only add it when a node mixes origins.
  assert.match(projectTree, /describeSessionOrigin\(origin, groupLabel\)/);
  assert.match(projectTree, /nodesWithMixedOrigins\.has\(origin\.nodeKey\)/);

  // Directory-derived placements can be undone from the row itself.
  assert.match(projectTree, /canPromoteSessionOrigin\(origin\)/);
  assert.match(projectTree, /workspace\.showAsSeparateProject/);
  assert.match(projectTree, /workspace\.resetProjectClassification/);

  // Time text stays on one line in narrow widths.
  assert.match(projectTree, /whitespace-nowrap/);
});
