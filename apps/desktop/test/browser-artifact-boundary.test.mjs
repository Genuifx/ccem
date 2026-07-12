import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const rustDir = path.join(desktopDir, 'src-tauri', 'src');
const repoDir = path.resolve(desktopDir, '..', '..');

test('agent browser artifacts are app-owned while UI screenshot remains inline', async () => {
  const [artifactSource, browserSource, toolSource, nativeRuntimeSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'artifacts.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'tools.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'native_runtime.rs'), 'utf8'),
  ]);

  const agentScreenshot = toolSource.match(
    /"screenshot"\s*=>[\s\S]*?"evaluate"\s*=>/,
  )?.[0] ?? '';
  assert.match(agentScreenshot, /capture_screenshot_artifact/);
  assert.doesNotMatch(agentScreenshot, /screenshot_base64|"data"/);

  const uiScreenshot = browserSource.match(
    /pub async fn browser_screenshot\([\s\S]*?\n\}/,
  )?.[0] ?? '';
  assert.match(uiScreenshot, /screenshot_base64/);

  assert.match(nativeRuntimeSource, /record\.project_dir\.clone\(\)/);
  assert.match(
    nativeRuntimeSource,
    /browser\.run_tool_with_permission\(\s*app,\s*runtime_id,\s*&workspace_dir,\s*&request,\s*&authority,?\s*\)/,
  );

  assert.match(artifactSource, /config::get_ccem_dir\(\)\.join\("browser"\)/);
  assert.match(artifactSource, /join\("workspaces"\)[\s\S]*join\("sessions"\)[\s\S]*join\("artifacts"\)/);
  assert.match(artifactSource, /Sha256::digest/);
  assert.match(artifactSource, /create_new\(true\)/);
  assert.match(artifactSource, /from_mode\(0o700\)/);
  assert.match(artifactSource, /from_mode\(0o600\)/);
});

test('interaction refs require the matching generation-safe snapshot id', async () => {
  const [toolSource, registrySource, helperSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'tools.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'registry.rs'), 'utf8'),
    fs.readFile(path.join(repoDir, 'packages', 'native-runtime-helper', 'src', 'browserMcp.ts'), 'utf8'),
  ]);

  assert.match(toolSource, /required_string_arg\(&request\.args, "snapshotId"\)/);
  assert.match(toolSource, /validate_interaction_snapshot/);
  assert.match(toolSource, /__ccemSnapshot_/);
  assert.match(toolSource, /hidden_text_count/);
  assert.match(toolSource, /value_redacted/);
  assert.doesNotMatch(helperSource, /accessibility-style snapshot/);
  assert.match(helperSource, /snapshotId: z\.string\(\)\.min\(1\)/);

  const navigation = registrySource.match(
    /pub fn mark_navigation\([\s\S]*?Ok\(\(session\.clone\(\), token\)\)/,
  )?.[0] ?? '';
  assert.match(navigation, /latest_snapshot = None/);
  assert.match(registrySource, /token\.navigation_seq != session\.navigation_seq/);
});
