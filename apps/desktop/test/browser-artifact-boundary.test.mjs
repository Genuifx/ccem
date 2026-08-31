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

test('Mode 2 interaction refs are opaque and invalidated with their guarded document', async () => {
  const [agentServiceSource, semanticsSource, navigationSource, helperSource] = await Promise.all([
    fs.readFile(path.join(rustDir, 'browser', 'login', 'agent_service.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'login', 'cdp', 'semantics.rs'), 'utf8'),
    fs.readFile(path.join(rustDir, 'browser', 'login', 'cdp', 'semantics', 'navigation.rs'), 'utf8'),
    fs.readFile(path.join(repoDir, 'packages', 'native-runtime-helper', 'src', 'browserMcp.ts'), 'utf8'),
  ]);

  assert.match(agentServiceSource, /required_string\(&request\.args, "elementRef"\)/);
  assert.match(semanticsSource, /self\.elements\.resolve\(element_ref\)/);
  assert.match(semanticsSource, /revalidate_guarded_document/);
  assert.match(navigationSource, /self\.invalidate_document\(\)/);
  assert.doesNotMatch(helperSource, /accessibility-style snapshot/);
  assert.match(helperSource, /elementRef: z\.string\(\)\.min\(1\)/);
  assert.doesNotMatch(helperSource, /snapshotId: z\.string\(\)\.min\(1\)/);
  assert.doesNotMatch(helperSource, /ref: z\.number\(\)/);
});
