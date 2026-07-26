import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const rustDir = path.join(desktopDir, 'src-tauri', 'src');

test('browser tool dispatch uses a current revision-bound native permission authority', async () => {
  const [nativeRuntimeSource, browserSource, policySource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'native_runtime.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'policy.rs'), 'utf8'),
  ]);

  const requestShape = browserSource.match(
    /pub struct BrowserToolRequest \{[\s\S]*?\n\}/,
  )?.[0] ?? '';
  assert.doesNotMatch(requestShape, /perm_mode|permission_mode/);

  const dispatch = nativeRuntimeSource.match(
    /fn handle_browser_tool_request\([\s\S]*?\n    fn mark_process_exit/,
  )?.[0] ?? '';
  assert.match(dispatch, /browser_permission_sync[\s\S]*current_ticket/);
  assert.match(dispatch, /effective_native_perm_mode[\s\S]*authority\.mode\(\)/);
  assert.ok(dispatch.indexOf('current_ticket') < dispatch.indexOf('prepare_agent_tool_if_handed_off'));
  assert.match(dispatch, /authority\.validate_current\(\)/);
  assert.match(dispatch, /authorize_browser_tool\(authority\.mode\(\), &request\.tool\)/);
  assert.match(
    dispatch,
    /browser\.run_tool_with_permission\([\s\S]*?&request,[\s\S]*?&authority/,
  );

  assert.match(policySource, /"readonly" \| "audit" \| "plan" \| "safe" \| "ci"/);
  assert.match(policySource, /READ_ONLY_BROWSER_TOOLS\.contains\(&tool\)/);
});

test('browser actions require exact visible session control and support cancellation', async () => {
  const [toolsSource, registrySource, panelSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'tools.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'registry.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'), 'utf8'),
  ]);

  const dispatch = toolsSource.match(/pub fn run_tool\([\s\S]*?\n    fn run_tool_inner/)?.[0] ?? '';
  assert.ok(dispatch.indexOf('wait_for_visible_agent_control') < dispatch.indexOf('begin_agent_action'));
  assert.match(toolsSource, /main_visible[\s\S]*get_webview[\s\S]*is_visible_for_agent/);
  assert.match(registrySource, /active_session_id == session_id[\s\S]*session\.visible && !session\.paused/);
  assert.match(registrySource, /cancel_epoch = session\.cancel_epoch\.saturating_add\(1\)/);
  assert.match(panelSource, /browser_set_paused/);
  assert.match(panelSource, /browserAgentControlling/);
});
