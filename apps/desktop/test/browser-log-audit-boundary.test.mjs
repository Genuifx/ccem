import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const rustDir = path.join(desktopDir, 'src-tauri', 'src');
const repoDir = path.resolve(desktopDir, '..', '..');

test('preview browser console logs are untrusted, bounded, redacted JSONL', async () => {
  const [logsSource, webviewSource, toolsSource, helperSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'logs.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'webview.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'tools.rs'), 'utf8'),
    fs.readFile(path.join(repoDir, 'packages', 'native-runtime-helper', 'src', 'browserMcp.ts'), 'utf8'),
  ]);

  assert.match(webviewSource, /initialization_script\(BROWSER_CONSOLE_INIT_SCRIPT\)/);
  assert.match(logsSource, /console\[level\] = \(\.\.\.values\)/);
  assert.match(logsSource, /unhandledrejection/);
  assert.match(logsSource, /MAX_CONSOLE_FILE_BYTES/);
  assert.match(logsSource, /rotate_log/);
  assert.match(logsSource, /redact_json_secrets/);
  assert.match(logsSource, /"untrusted": true/);
  assert.match(toolsSource, /"read_console_log" => self\.read_console_log/);
  assert.match(helperSource, /'read_console_log'/);
  assert.match(helperSource, /recent redacted events/);
});

test('Mode 2 durable audit precedes browser effects and never stores typed text or scripts', async () => {
  const [nativeRuntimeSource, capabilitySource, logsSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'native_runtime.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'login', 'capability.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'logs.rs'), 'utf8'),
  ]);

  const dispatch = nativeRuntimeSource.match(
    /fn handle_browser_tool_request\([\s\S]*?\n    fn mark_process_exit/,
  )?.[0] ?? '';
  assert.match(dispatch, /login\.execute_prepared_agent_tool\(&request, prepared\)/);
  assert.doesNotMatch(dispatch, /browser\.run_tool/);
  assert.ok(
    capabilitySource.indexOf('self.audit.write_pre(&pre_record)')
      < capabilitySource.indexOf('self.backend.execute(&command, &cancellation)'),
  );
  assert.ok(
    capabilitySource.indexOf('self.backend.execute(&command, &cancellation)')
      < capabilitySource.indexOf('self.audit.write_result(&result_record)'),
  );
  assert.match(logsSource, /"text_chars"/);
  assert.match(logsSource, /"script_sha256"/);
  assert.doesNotMatch(logsSource, /"text": request\.args/);
  assert.doesNotMatch(logsSource, /"script": request\.args/);
});

test('Mode 2 Browser does not expose the legacy Preview artifact UI', async () => {
  const panelSource = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
    'utf8',
  );

  assert.doesNotMatch(panelSource, /browser_recent_activity/);
  assert.doesNotMatch(panelSource, /browserRecentArtifacts/);
  assert.doesNotMatch(panelSource, /console_log_path|audit_log_path/);
});
