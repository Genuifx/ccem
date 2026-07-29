import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isEnvironmentEnabled(name, enabledEnvironments) {
  if (enabledEnvironments == null) return true;
  return enabledEnvironments.includes(name);
}

function filterRuntimeEnvironments(environments, enabledEnvironments, options = {}) {
  if (enabledEnvironments == null) return environments;
  const enabledSet = new Set(enabledEnvironments);
  const currentEnv = options.currentEnv ?? null;
  return environments.filter((env) => enabledSet.has(env.name) || env.name === currentEnv);
}

function suggestCopiedEnvironmentName(sourceName, existingNames) {
  const existing = new Set(existingNames);
  const base = `${sourceName}-copy`;
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function toggleEnabledEnvironment(name, enabledEnvironments, allEnvironmentNames) {
  if (enabledEnvironments == null) {
    return allEnvironmentNames.filter((envName) => envName !== name);
  }
  if (enabledEnvironments.includes(name)) {
    return enabledEnvironments.filter((envName) => envName !== name);
  }
  return [...enabledEnvironments, name];
}

const envs = [
  { name: 'official' },
  { name: 'glm' },
  { name: 'kimi' },
];

test('treats null/undefined enable list as all enabled', () => {
  assert.equal(isEnvironmentEnabled('glm', null), true);
  assert.equal(isEnvironmentEnabled('glm', undefined), true);
  assert.deepEqual(filterRuntimeEnvironments(envs, null), envs);
});

test('filters runtime environments by explicit enable list', () => {
  assert.deepEqual(filterRuntimeEnvironments(envs, ['glm']), [{ name: 'glm' }]);
});

test('keeps current env visible even when disabled', () => {
  assert.deepEqual(
    filterRuntimeEnvironments(envs, ['glm'], { currentEnv: 'official' }),
    [{ name: 'official' }, { name: 'glm' }],
  );
});

test('bootstraps enable list on first toggle (legacy → managed)', () => {
  assert.deepEqual(
    toggleEnabledEnvironment('kimi', null, ['official', 'glm', 'kimi']),
    ['official', 'glm'],
  );
});

test('toggles within an explicit enable list', () => {
  assert.deepEqual(
    toggleEnabledEnvironment('kimi', ['official', 'glm'], ['official', 'glm', 'kimi']),
    ['official', 'glm', 'kimi'],
  );
  assert.deepEqual(
    toggleEnabledEnvironment('glm', ['official', 'glm'], ['official', 'glm', 'kimi']),
    ['official'],
  );
});

test('suggests unique copied environment names', () => {
  assert.equal(suggestCopiedEnvironmentName('glm', ['official', 'glm']), 'glm-copy');
  assert.equal(
    suggestCopiedEnvironmentName('glm', ['official', 'glm', 'glm-copy']),
    'glm-copy-2',
  );
  assert.equal(
    suggestCopiedEnvironmentName('glm', ['official', 'glm', 'glm-copy', 'glm-copy-2']),
    'glm-copy-3',
  );
});

test('environment enablement persists through its field-scoped command', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../src/hooks/useTauriCommands.ts'),
    'utf8',
  );

  assert.equal(
    source.match(/invoke\('save_enabled_environments', \{ names(?:: next)? \}\)/g)?.length,
    4,
    'add, rename, delete, and explicit toggle paths must avoid stale full-settings writes',
  );
  assert.doesNotMatch(
    source,
    /invoke\('save_settings',[\s\S]{0,180}enabledEnvironments/,
  );
});
