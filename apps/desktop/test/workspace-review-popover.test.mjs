import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...parts) {
  try {
    return await fs.readFile(path.join(desktopDir, ...parts), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

test('review capsule is the accessible external dialog trigger', async () => {
  const statusStrip = await readSource('src', 'components', 'workspace', 'WorkspaceStatusStrip.tsx');
  const anchor = await readSource('src', 'components', 'workspace', 'workspaceReviewAnchor.ts');
  const markerIndex = statusStrip.indexOf('data-ccem-workspace-review-trigger');
  const buttonStart = statusStrip.lastIndexOf('<button', markerIndex);
  const buttonEnd = statusStrip.indexOf('</button>', markerIndex);
  const reviewButton = statusStrip.slice(buttonStart, buttonEnd + '</button>'.length);

  assert.match(
    anchor,
    /createRef<HTMLButtonElement>\(\)/,
    'review anchor module should expose one shared button ref',
  );
  assert.match(
    reviewButton,
    /ref=\{workspaceReviewTriggerRef\}/,
    'the review capsule should own the shared trigger ref',
  );
  assert.match(reviewButton, /data-ccem-workspace-review-trigger/, 'review capsule should be inspectable');
  assert.match(reviewButton, /aria-haspopup=["']dialog["']/, 'review capsule should announce a dialog popup');
  assert.match(reviewButton, /aria-expanded=\{reviewPanelOpen\}/, 'review capsule should expose open state');
  assert.match(
    reviewButton,
    /aria-controls=\{reviewPanelOpen\s*\?\s*WORKSPACE_REVIEW_POPOVER_ID\s*:\s*undefined\}/,
    'review capsule should only control the mounted popover while open',
  );
  assert.doesNotMatch(reviewButton, /aria-pressed=/, 'review capsule is a popup trigger, not a toggle button');
});

test('review popover stays open as a modeless inspector while users interact with Workspace', async () => {
  const popover = await readSource('src', 'components', 'workspace', 'WorkspaceReviewPopover.tsx');
  const outsideHandler = popover.match(/const handleInteractOutside[\s\S]*?\n  }, \[\]\);/)?.[0] ?? '';

  assert.match(
    popover,
    /<Popover\s+modal=\{false\}\s+open=\{isOpen\}\s+onOpenChange=\{handleOpenChange\}>/,
    'review inspector should explicitly use Radix non-modal behavior',
  );
  assert.match(
    popover,
    /<PopoverAnchor\s+virtualRef=\{workspaceReviewTriggerRef\}\s*\/>/,
    'review popover should anchor to the external capsule ref',
  );
  assert.match(popover, /side=["']bottom["']/, 'popover should open below the capsule');
  assert.match(popover, /align=["']end["']/, 'popover right edge should align with the capsule');
  assert.match(popover, /sideOffset=\{10\}/, 'popover should sit 10px below the capsule');
  assert.match(popover, /collisionPadding=\{12\}/, 'popover should keep 12px viewport collision padding');
  assert.match(popover, /data-ccem-workspace-review-popover/, 'popover should expose a stable QA hook');
  assert.match(
    popover,
    /onInteractOutside=\{handleInteractOutside\}/,
    'background interaction should be intercepted before Radix dismisses the inspector',
  );
  assert.match(outsideHandler, /event\.preventDefault\(\)/, 'all outside interactions should keep the inspector open');
  assert.doesNotMatch(outsideHandler, /\bif\s*\(/, 'outside dismissal must not depend on the interaction target');
  assert.doesNotMatch(outsideHandler, /\.contains\(/, 'conversation and composer interactions should be treated like the capsule');
  assert.doesNotMatch(popover, /onPointerDownOutside=/, 'one outside-interaction handler should own dismissal prevention');
  assert.match(
    popover,
    /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/,
    'opening the inspector should not steal focus from the conversation or composer',
  );
  assert.doesNotMatch(
    popover,
    /(?:Overlay|Backdrop|data-ccem-workspace-review-overlay|fixed\s+inset-0)/,
    'review popover must not add a modal overlay or fullscreen backdrop',
  );
});

test('review detail requests are isolated when users switch files quickly', async () => {
  const details = await readSource('src', 'components', 'workspace', 'WorkspaceReviewDetails.tsx');

  assert.match(details, /fileRequestSeqRef/, 'file preview requests should carry a monotonic request id');
  assert.match(
    details,
    /requestSeq\s*!==\s*fileRequestSeqRef\.current/,
    'stale diff and media responses should not overwrite the latest file selection',
  );
});

test('explicit or Escape close restores focus to the review capsule', async () => {
  const popover = await readSource('src', 'components', 'workspace', 'WorkspaceReviewPopover.tsx');

  assert.match(
    popover,
    /onOpenChange=\{handleOpenChange\}/,
    'controlled popover should funnel explicit and Escape close through one handler',
  );
  assert.match(
    popover,
    /onCloseAutoFocus=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?focusTrigger\(\);[\s\S]*?\}\}/,
    'the close autofocus hook should return focus to the external capsule once',
  );
});

test('retained Workspace closes the portalled review surface before tab or owner changes paint', async () => {
  const workspace = await readSource('src', 'pages', 'Workspace.tsx');

  assert.match(
    workspace,
    /useLayoutEffect\(\(\) => \{[\s\S]*?\(!isActive \|\| ownerChanged\)[\s\S]*?setWorkspaceReviewOpen\(false\)/,
    'hidden retained Workspace tabs and session-owner switches must close the body portal before paint',
  );
});

test('task flow exposes ordered steps, current state, and progress semantics', async () => {
  const popover = await readSource('src', 'components', 'workspace', 'WorkspaceReviewPopover.tsx');

  assert.match(popover, /role=["']progressbar["']/, 'task completion should expose progressbar semantics');
  assert.match(popover, /aria-valuemin=\{0\}/, 'progressbar should expose its minimum');
  assert.match(popover, /aria-valuemax=\{100\}/, 'progressbar should expose its maximum');
  assert.match(popover, /aria-valuenow=\{progressPercent\}/, 'progressbar should expose current completion');
  assert.match(popover, /<ol\b/, 'task groups should preserve ordered task semantics');
  assert.match(popover, /<li\b/, 'each task should render as an ordered-list item');
  assert.match(popover, /aria-current=\{[^}]*["']step["']/, 'the active task should announce the current step');
  assert.match(
    popover,
    /inProgressTodos[\s\S]*?todo\.status === ['"]in_progress['"][\s\S]*?currentId = inProgressTodos\[0\]/,
    'failed tasks must not steal current-step semantics from the task that is actually in progress',
  );
  assert.match(
    popover,
    /\[['"]initializing['"], ['"]processing['"], ['"]running['"]\]\.includes\(session\.status\)/,
    'native initializing and processing states should render as active instead of completed',
  );
});
