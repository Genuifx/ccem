import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importBrowserPanelTarget() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'browserPanelTarget.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-preview-alias-'));
  const outputPath = path.join(tempDir, 'browserPanelTarget.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('Preview target keeps its physical id while acquiring the native runtime alias', async () => {
  const {
    setPreviewBrowserPanelAgentSessionId,
  } = await importBrowserPanelTarget();
  const target = {
    backend: 'preview',
    instanceId: 3,
    surfaceSessionId: 'runtime:semantic-a:3',
    visible: true,
  };

  const bound = setPreviewBrowserPanelAgentSessionId(target, 'native-runtime-a');
  assert.equal(bound.agentSessionId, 'native-runtime-a');
  assert.equal(bound.surfaceSessionId, target.surfaceSessionId);
  assert.equal(bound.instanceId, target.instanceId);
  assert.equal(
    setPreviewBrowserPanelAgentSessionId(bound, 'native-runtime-a'),
    bound,
    'idempotent alias updates must not remount the panel',
  );
});

test('Browser Agent handoff is exposed only for an active non-terminal runtime', async () => {
  const {
    resolveActiveBrowserAgentSessionId,
    setPreviewBrowserPanelAgentSessionId,
  } = await importBrowserPanelTarget();
  const runtime = {
    runtime_id: 'native-runtime-a',
    status: 'processing',
    is_active: true,
  };

  assert.equal(resolveActiveBrowserAgentSessionId(runtime), 'native-runtime-a');
  assert.equal(resolveActiveBrowserAgentSessionId({ ...runtime, is_active: false }), null);
  for (const status of [
    'stopped',
    'error',
    'handoff',
    'interrupted',
    'closed_idle',
    'permission_quarantined',
  ]) {
    assert.equal(
      resolveActiveBrowserAgentSessionId({ ...runtime, status }),
      null,
      `${status} must not retain Browser Agent handoff authority`,
    );
  }

  const retained = {
    backend: 'preview',
    instanceId: 3,
    surfaceSessionId: 'runtime:semantic-a:3',
    visible: false,
    agentSessionId: runtime.runtime_id,
  };
  const unbound = setPreviewBrowserPanelAgentSessionId(
    retained,
    resolveActiveBrowserAgentSessionId({ ...runtime, status: 'stopped' }),
  );
  assert.equal(unbound.agentSessionId, undefined);
  assert.equal(unbound.instanceId, retained.instanceId);
  assert.equal(unbound.surfaceSessionId, retained.surfaceSessionId);
  assert.equal(unbound.visible, retained.visible);
});

test('UI-open-first and compose rebind bind Agent tools to the exact physical Preview instance', async () => {
  const [workspace, panel, tools, browser, browserCommands, nativeRuntime] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'tools.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'commands.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'native_runtime.rs'), 'utf8'),
  ]);

  const toggleStart = workspace.indexOf('const toggleActivePreviewBrowser = useCallback');
  const toggleEnd = workspace.indexOf('\n\n  const openActiveLoginBrowser', toggleStart);
  const toggle = workspace.slice(toggleStart, toggleEnd);
  assert.match(toggle, /agentSessionId: activeBrowserAgentSessionId/);

  const activeAgentStart = workspace.indexOf('const activeBrowserAgentSessionId = useMemo');
  const activeAgentEnd = workspace.indexOf('\n\n  const activeBrowserTarget', activeAgentStart);
  const activeAgent = workspace.slice(activeAgentStart, activeAgentEnd);
  assert.match(
    activeAgent,
    /resolveActiveBrowserAgentSessionId\(activeLiveEntry\?\.session\)/,
  );
  assert.match(
    activeAgent,
    /resolveActiveBrowserAgentSessionId\(matchingLiveEntry\?\.session\)/,
  );

  const previewAliasEffectStart = workspace.indexOf(
    'useEffect(() => {',
    activeAgentEnd,
  );
  const previewAliasEffectEnd = workspace.indexOf(
    '\n\n  const toggleActivePreviewBrowser',
    previewAliasEffectStart,
  );
  const previewAliasEffect = workspace.slice(
    previewAliasEffectStart,
    previewAliasEffectEnd,
  );
  assert.doesNotMatch(previewAliasEffect, /if \(!activeBrowserAgentSessionId\) return/);
  assert.match(
    previewAliasEffect,
    /setPreviewBrowserPanelAgentSessionId\([\s\S]*activeBrowserAgentSessionId/,
  );

  const rebindStart = workspace.indexOf('const liveBrowserSessionId =');
  const rebindEnd = workspace.indexOf('\n      upsertLiveSessionEntry', rebindStart);
  const rebind = workspace.slice(rebindStart, rebindEnd);
  assert.match(rebind, /setPreviewBrowserPanelAgentSessionId\([\s\S]*summary\.runtime_id/);

  const openStart = panel.indexOf('const openBrowser = useCallback');
  const openEnd = panel.indexOf('\n\n  useEffect(() => {', openStart);
  const open = panel.slice(openStart, openEnd);
  assert.match(
    open,
    /requestedAliasSessionId = previewAgentSessionIdRef\.current\?\.trim\(\) \|\| null[\s\S]*browser_open[\s\S]*aliasSessionId: requestedAliasSessionId/,
  );
  assert.match(
    open,
    /openAliasLease = info\.alias_lease \?\? null[\s\S]*currentAliasSessionId === requestedAliasSessionId[\s\S]*unbindPreviewAlias\(openAliasLease\)[\s\S]*syncPreviewAliasBinding\(\)/,
  );
  assert.ok(
    open.indexOf('await syncPreviewAliasBinding();')
      < open.indexOf('previewSurfaceReadyRef.current = true;'),
    'the UI-open path must bind before it advertises a ready/visible surface',
  );
  assert.match(panel, /browser_bind_preview_alias/);
  assert.match(panel, /browser_unbind_preview_alias/);
  assert.match(panel, /bindingId: lease\.binding_id/);
  assert.match(
    browser,
    /open_with_visibility_and_alias[\s\S]*Result<\(BrowserInfo, Option<BrowserSessionAliasLease>\), String>[\s\S]*Ok\(\(info, alias_lease\)\)/,
  );
  assert.match(
    browserCommands,
    /struct BrowserOpenResponse[\s\S]*#\[serde\(flatten\)\][\s\S]*info: BrowserInfo,[\s\S]*alias_lease: Option<BrowserSessionAliasLease>/,
  );

  const revealListenerStart = workspace.indexOf("void listen<{");
  const revealListenerEnd = workspace.indexOf("\n    }).then((nextUnlisten)", revealListenerStart);
  const revealListener = workspace.slice(revealListenerStart, revealListenerEnd);
  assert.match(revealListener, /agentSessionId\?: string/);
  assert.match(
    revealListener,
    /requestedAgentSessionId = event\.payload\?\.agentSessionId[\s\S]*requestedLiveEntry \? requestedSessionId : undefined/,
  );
  assert.match(
    revealListener,
    /requestedAgentSessionId[\s\S]*setPreviewBrowserPanelAgentSessionId\([\s\S]*requestedAgentSessionId/,
  );
  assert.match(
    browser,
    /fn emit_browser_opened_for_agent[\s\S]*"sessionId": session_id,[\s\S]*"agentSessionId": agent_session_id/,
  );

  const authorizedStart = tools.indexOf('fn run_tool_authorized(');
  const innerStart = tools.indexOf('\n    fn run_tool_inner(', authorizedStart);
  const authorized = tools.slice(authorizedStart, innerStart);
  assert.ok(
    authorized.indexOf('capture_preview_route_locked')
      < authorized.indexOf('begin_agent_action_expected_route'),
    'Agent authorization must freeze the physical route before beginning execution',
  );
  assert.match(
    authorized,
    /wait_for_visible_agent_control\(app, &mut route\)/,
  );
  assert.match(
    tools,
    /fn wait_for_visible_agent_control[\s\S]*preview_route_session_locked\(route\)/,
  );
  assert.match(
    authorized,
    /begin_agent_action_expected_route\([\s\S]*expected_generation,[\s\S]*expected_cancel_epoch/,
  );
  assert.doesNotMatch(
    tools.slice(
      tools.indexOf('fn prepare_existing_agent_tool_route_locked'),
      tools.indexOf('\n    fn discard_provisional_agent_route_locked'),
    ),
    /session_snapshot\(/,
  );

  const closeStart = browser.indexOf('pub fn close(');
  const closeEnd = browser.indexOf('\n\n    pub fn navigate(', closeStart);
  assert.match(
    browser.slice(closeStart, closeEnd),
    /registry\.actor\(&session\.session_id\)[\s\S]*actor[\s\S]*resolve_preview_session_id_locked\(&requested_session_id\)[\s\S]*current_generation != Some\(session\.generation\)/,
  );
  const policyStart = browser.indexOf('pub fn policy_changed(');
  assert.match(
    browser.slice(policyStart),
    /alias_operation\(\)[\s\S]*resolve_preview_session_id_locked\(session_id\)/,
  );
  assert.match(nativeRuntime, /browser\.retire_agent_control\(app, runtime_id\)/);
  assert.match(nativeRuntime, /browser\.policy_changed\(app, runtime_id, permission_revision\)/);
});
