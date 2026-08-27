import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const rustDir = path.join(desktopDir, 'src-tauri', 'src');
const repoDir = path.resolve(desktopDir, '..', '..');

test('Mode 2 agent browser artifacts are app-owned and routed through the exact handoff', async () => {
  const [agentServiceSource, artifactSource, nativeRuntimeSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'login', 'agent_service.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'login', 'agent_service', 'artifacts.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'native_runtime.rs'), 'utf8'),
  ]);

  assert.match(nativeRuntimeSource, /record\.project_dir\.clone\(\)/);
  assert.match(
    nativeRuntimeSource,
    /prepare_agent_tool_if_handed_off\([\s\S]*&workspace_dir,[\s\S]*&browser_actor_id,[\s\S]*authority,[\s\S]*&request/,
  );
  assert.match(nativeRuntimeSource, /login\.execute_prepared_agent_tool\(&request, prepared\)/);
  assert.doesNotMatch(nativeRuntimeSource, /browser\.run_tool_with_permission/);

  assert.match(agentServiceSource, /serialize_agent_result\(result, &lease\.artifact_root\)/);
  assert.match(agentServiceSource, /resolve_screenshot_artifact\(/);
  assert.match(agentServiceSource, /insert_artifact_path\(&mut value, path\)/);
  assert.match(artifactSource, /Agent input can neither choose the path/);
  assert.match(artifactSource, /Sha256::digest/);
  assert.match(artifactSource, /canonicalize\(\)/);
  assert.match(artifactSource, /canonical_path\.parent\(\) != Some\(canonical_root\.as_path\(\)\)/);
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
