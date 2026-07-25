import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...parts) {
  return fs.readFile(path.join(desktopDir, ...parts), 'utf8');
}

test('workspace review popover stays lazy and only mounts while open', async () => {
  const workspace = await readSource('src', 'pages', 'Workspace.tsx');
  const nativeView = await readSource('src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx');

  assert.doesNotMatch(
    workspace,
    /from ['"]@\/components\/workspace\/WorkspaceReviewPopover['"]/,
    'Workspace page must not statically import the heavy review popover',
  );
  assert.doesNotMatch(
    nativeView,
    /from ['"]\.\/WorkspaceReviewPopover['"]/,
    'Native session view must not statically import the heavy review popover',
  );
  assert.match(
    workspace,
    /shouldRenderWorkspaceReview && workspaceReviewOpen && workspaceReviewModel/,
    'Workspace page should only mount the lazy popover when the review panel is open',
  );
  assert.match(
    nativeView,
    /isReviewPopoverOpen && reviewModel/,
    'Native session view should only mount the lazy popover when the review panel is open',
  );

  assert.match(
    workspace,
    /from ['"]@\/components\/workspace\/LazyWorkspaceReviewPopover['"]/,
    'Workspace page should load the review UI through its lazy boundary',
  );
  assert.match(
    nativeView,
    /from ['"]\.\/LazyWorkspaceReviewPopover['"]/,
    'Native session view should load the review UI through its lazy boundary',
  );
  assert.match(
    workspace,
    /key=\{`\$\{workspaceReviewSession\.runtime_id\}:\$\{workspaceReviewSession\.project_dir\}`\}/,
    'history and compose review state should reset when the reviewed session identity changes',
  );
  assert.match(
    nativeView,
    /key=\{`\$\{session\.runtime_id\}:\$\{session\.project_dir\}`\}/,
    'live review state should reset when the reviewed session identity changes',
  );
});

test('prompt input avoids unconditional URL decoration and trigger scans', async () => {
  const hook = await readSource('src', 'components', 'use-prompt-area.ts');

  assert.match(
    hook,
    /function segmentsContainUrlHint/,
    'PromptArea should keep a cheap URL hint guard before DOM URL decoration',
  );
  assert.match(
    hook,
    /if \(segmentsContainUrlHint\(segments\)\) \{\s*decorateURLsInEditor\(editor\)/,
    'PromptArea input should not decorate URLs unless text contains a URL hint',
  );
  assert.match(
    hook,
    /function shouldRunTriggerDetectionAfterInput/,
    'PromptArea should guard trigger detection with cursor-local text checks',
  );
  assert.match(
    hook,
    /if \(shouldRunTriggerDetectionAfterInput\(segments, savedCursorOffset, triggers, activeTrigger\)\) \{\s*runTriggerDetection\(\)/,
    'PromptArea input should not run trigger detection on every ordinary keystroke',
  );
  assert.match(
    hook,
    /let editorDomChanged = false/,
    'PromptArea input should track whether DOM normalization or decoration actually changed the editor',
  );
  assert.match(
    hook,
    /if \(editorDomChanged && savedCursorOffset !== null\) \{\s*setCursorAtOffset\(editor, savedCursorOffset\)/,
    'PromptArea input should not remap the caret on every ordinary keystroke',
  );
});

test('workspace composer skips skill parsing for ordinary typing', async () => {
  const composer = await readSource('src', 'components', 'workspace', 'WorkspaceSessionComposer.tsx');
  const model = await readSource('src', 'components', 'workspace', 'composerModel.ts');

  assert.match(
    model,
    /function composerTextMayContainSkillReference\(text: string\): boolean/,
    'Composer model should expose a cheap skill-reference hint',
  );
  assert.match(
    composer,
    /composerTextMayContainSkillReference\(composerPlainText\)\s*\?\s*parseComposerTokens/,
    'Workspace composer should only parse installed skills when text may contain a skill reference',
  );
});

test('live workspace transcript keeps streaming layout eagerly painted', async () => {
  const css = await readSource('src', 'index.css');
  const sectionStart = css.indexOf('Live workspace transcript items stream and auto-scroll');
  const sectionEnd = css.indexOf('/* === Reduced Performance Mode === */');
  const liveTranscriptSection = css.slice(sectionStart, sectionEnd);

  assert.notEqual(sectionStart, -1, 'workspace transcript CSS should explain why paint skipping is disabled');
  assert.notEqual(sectionEnd, -1, 'workspace transcript CSS should remain before reduced performance mode rules');

  assert.match(
    css,
    /\.history-msg-virtualized,[\s\S]*?content-visibility: auto;/,
    'static history timelines can still use browser paint skipping',
  );
  assert.match(
    liveTranscriptSection,
    /\.workspace-msg-virtualized,[\s\S]*?contain: layout paint;/,
    'live workspace transcript items should keep cheap containment',
  );
  assert.doesNotMatch(
    liveTranscriptSection,
    /content-visibility:/,
    'live workspace transcript items should not use paint skipping during streaming turns',
  );
  assert.doesNotMatch(
    liveTranscriptSection,
    /contain-intrinsic-size:/,
    'live workspace transcript items should not reserve guessed heights that can shift scroll position',
  );
});

test('workspace overview requests a limited history payload', async () => {
  const workspace = await readSource('src', 'pages', 'Workspace.tsx');
  const projectTree = await readSource('src', 'components', 'workspace', 'ProjectTree.tsx');
  const historyData = await readSource('src', 'features', 'conversations', 'historyData.ts');
  const backendHistory = await readSource('src-tauri', 'src', 'history.rs');

  assert.match(
    workspace,
    /const WORKSPACE_HISTORY_SESSION_LIMIT = 240;/,
    'Workspace should define an explicit recent-history cap for overview startup',
  );
  assert.match(
    workspace,
    /fetchWorkspaceOverviewSnapshot\(\s*WORKSPACE_HISTORY_SESSION_LIMIT,\s*force,\s*\)/,
    'Workspace refresh should request the Rust overview snapshot on startup',
  );
  assert.match(
    workspace,
    /precomputedProjectNodes=\{precomputedProjectNodes\}/,
    'Workspace should pass Rust-grouped project nodes into ProjectTree',
  );
  assert.match(
    historyData,
    /limit: options\.limit \?\? null/,
    'historyData should pass the optional limit through to the Tauri history command',
  );
  assert.match(
    historyData,
    /\$\{sourceFilter\}:limit:\$\{options\.limit\}/,
    'limited history results should not share the full-history cache entry',
  );
  assert.match(
    historyData,
    /get_workspace_overview_snapshot/,
    'historyData should expose the Rust workspace overview snapshot command',
  );
  assert.match(
    projectTree,
    /precomputedProjectNodes\?\./,
    'ProjectTree should consume precomputed project nodes before rebuilding locally',
  );
  assert.match(
    backendHistory,
    /pub struct WorkspaceOverviewSnapshot/,
    'Rust history backend should define the overview snapshot payload',
  );
  assert.match(
    backendHistory,
    /pub session_keys: Vec<String>/,
    'Rust project nodes should send lightweight session keys instead of duplicating session payloads',
  );
});

test('conversation detail uses single Rust preprocessing command', async () => {
  const historyData = await readSource('src', 'features', 'conversations', 'historyData.ts');
  const messageState = await readSource('src', 'features', 'conversations', 'messageState.ts');
  const backendHistory = await readSource('src-tauri', 'src', 'history.rs');
  const backendMain = await readSource('src-tauri', 'src', 'main.rs');

  assert.match(
    historyData,
    /get_conversation_detail/,
    'conversation detail should use the combined Rust detail command',
  );
  assert.doesNotMatch(
    historyData,
    /Promise\.all\(\s*\[[\s\S]*get_conversation_messages[\s\S]*get_conversation_segments/,
    'conversation detail should not read the same transcript through two IPC commands',
  );
  assert.match(
    messageState,
    /toolResultsMerged[\s\S]*return msgs;/,
    'frontend mergeToolResults should skip arrays already preprocessed by Rust',
  );
  assert.match(
    backendHistory,
    /pub struct ConversationDetailPayload/,
    'Rust backend should expose a combined detail payload',
  );
  assert.match(
    backendHistory,
    /fn merge_tool_results_into_messages/,
    'Rust backend should merge tool results before sending detail messages',
  );
  assert.match(
    backendMain,
    /get_conversation_detail/,
    'Tauri handler should register the combined detail command',
  );
});

test('history search is routed through Rust for non-empty queries', async () => {
  const historyList = await readSource('src', 'components', 'history', 'HistoryList.tsx');
  const historyData = await readSource('src', 'features', 'conversations', 'historyData.ts');
  const backendHistory = await readSource('src-tauri', 'src', 'history.rs');
  const backendMain = await readSource('src-tauri', 'src', 'main.rs');

  assert.match(
    historyList,
    /searchHistorySessions\(normalizedDeferredSearch, sourceFilter, 120\)/,
    'HistoryList should send non-empty search queries to Rust',
  );
  assert.match(
    historyList,
    /searchBaseSessions\.filter/,
    'HistoryList should filter the Rust search result set instead of always scanning all loaded sessions',
  );
  assert.match(
    historyData,
    /search_conversation_history/,
    'historyData should expose the Rust history search command',
  );
  assert.match(
    backendHistory,
    /pub async fn search_conversation_history/,
    'Rust backend should define the history search command',
  );
  assert.match(
    backendMain,
    /search_conversation_history/,
    'Tauri handler should register the history search command',
  );
});

test('workspace runtime decorations use a Rust snapshot command', async () => {
  const hook = await readSource('src', 'components', 'workspace', 'useWorkspaceSessionDecorations.ts');
  const backendDecorations = await readSource('src-tauri', 'src', 'workspace_decorations.rs');
  const backendMain = await readSource('src-tauri', 'src', 'main.rs');

  assert.match(
    hook,
    /get_workspace_session_decorations/,
    'Workspace decoration hook should request the Rust decoration snapshot',
  );
  assert.doesNotMatch(
    hook,
    /function buildRuntimeMatchMap/,
    'Workspace decoration hook should not rebuild runtime match maps on the JS render path',
  );
  assert.match(
    backendDecorations,
    /pub fn build_workspace_session_decorations/,
    'Rust backend should own the runtime decoration matcher',
  );
  assert.match(
    backendDecorations,
    /fn resolve_attention_kind/,
    'Rust backend should resolve attention state from runtime events',
  );
  assert.match(
    backendMain,
    /get_workspace_session_decorations/,
    'Tauri handler should register the workspace decoration snapshot command',
  );
  assert.match(
    backendMain,
    /async fn get_workspace_session_decorations/,
    'Workspace decoration snapshots should not execute sync event-log work on the WebView IPC path',
  );
  assert.match(
    backendMain,
    /spawn_blocking\(move \|\| \{[\s\S]*build_workspace_session_decorations/,
    'Workspace decoration snapshots should move runtime/event inspection onto a blocking worker',
  );
  assert.match(
    backendDecorations,
    /pub fn should_replay_decoration_events/,
    'Rust backend should centrally gate which runtime statuses need event replay',
  );
  assert.match(
    backendDecorations,
    /"interrupted"[\s\S]*should not replay historical event logs/,
    'Interrupted recovery rows should stay visible without replaying old event logs during polling',
  );
});

test('ProjectTree keeps session order stable and gates FLIP measurement', async () => {
  const projectTree = await readSource('src', 'components', 'workspace', 'ProjectTree.tsx');
  const projectTreeModel = await readSource('src', 'components', 'workspace', 'workspaceProjectTreeModel.ts');

  assert.match(
    projectTreeModel,
    /export function stabilizeProjectNodeSessions/,
    'ProjectTree model should expose a stable project-session merge helper',
  );
  assert.match(
    projectTree,
    /stabilizeProjectNodeSessions\(/,
    'ProjectTree should stabilize project sessions before rendering sidebar rows',
  );
  assert.match(
    projectTree,
    /const treeMotionKey = useMemo/,
    'ProjectTree should derive a structural motion key for reorder animations',
  );
  assert.match(
    projectTree,
    /useLayoutEffect\(\(\) => \{[\s\S]*getBoundingClientRect\(\)[\s\S]*\}, \[treeMotionKey\]\)/,
    'ProjectTree should not run layout measurement after every render',
  );
});

test('GSAP page motion targets stay scoped and capped outside hot paths', async () => {
  const gsapMotion = await readSource('src', 'lib', 'gsapMotion.ts');
  const motionFiles = [
    ['src', 'pages', 'Skills.tsx'],
    ['src', 'components', 'skills', 'InstallDialog.tsx'],
    ['src', 'pages', 'Analytics.tsx'],
    ['src', 'components', 'app-update', 'GlobalUpdateIndicator.tsx'],
    ['src', 'pages', 'CronTasks.tsx'],
    ['src', 'pages', 'ChatApp.tsx'],
  ];

  assert.match(
    gsapMotion,
    /export function getMotionTargets\([\s\S]*limit = 12/,
    'shared motion selector should default to a small target cap',
  );
  assert.match(
    gsapMotion,
    /querySelectorAll<HTMLElement>\(selector\)\)\.slice\(0, limit\)/,
    'shared motion selector should slice query results before callers animate them',
  );

  for (const parts of motionFiles) {
    const source = await readSource(...parts);
    const file = parts.join('/');

    assert.match(
      source,
      /getMotionTargets\(/,
      `${file} should use the capped motion selector helper`,
    );
    assert.doesNotMatch(
      source,
      /gsap\.utils\.toArray/,
      `${file} should not animate unbounded selector arrays`,
    );
    assert.doesNotMatch(
      source,
      /document\.querySelectorAll/,
      `${file} should keep motion selectors scoped to component roots`,
    );
  }
});

test('doctor perf smoke is explicit, budgeted, and exportable', async () => {
  const settings = await readSource('src', 'pages', 'Settings.tsx');
  const perfSmoke = await readSource('src', 'lib', 'doctor-perf-smoke.ts');
  const perfLog = await readSource('src', 'lib', 'perf-log.ts');
  const packageJson = JSON.parse(await readSource('package.json'));

  assert.match(
    settings,
    /runDoctorPerfSmoke/,
    'Settings Doctor panel should expose the perf smoke runner',
  );
  assert.match(
    settings,
    /onClick=\{handleRunPerfSmoke\}/,
    'Doctor perf smoke should run from an explicit user action',
  );
  assert.match(
    settings,
    /perfSmoke: perfSmoke \?\? undefined/,
    'Doctor export should include the most recent perf smoke report',
  );
  assert.match(
    perfLog,
    /perfSmoke\?: unknown/,
    'Doctor envelope should reserve a perfSmoke section',
  );
  assert.match(
    perfSmoke,
    /DOCTOR_PERF_SMOKE_HISTORY_LIMIT = 240/,
    'Perf smoke should reuse the Workspace overview session cap',
  );
  assert.match(
    perfSmoke,
    /\{ name: 'workspaceOverview', budgetMs: 500 \}/,
    'Perf smoke should codify the Workspace overview budget',
  );
  assert.equal(
    packageJson.scripts['perf:smoke'],
    'node scripts/perf-smoke.mjs',
    'Desktop package should expose the perf smoke report gate',
  );
});
