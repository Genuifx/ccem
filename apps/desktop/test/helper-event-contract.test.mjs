import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const helperPath = path.join(repoRoot, 'packages/native-runtime-helper/src/index.ts');
const eventBusPath = path.join(
  repoRoot,
  'apps/desktop/src-tauri/src/event_bus.rs',
);

function camelToSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

test('every helper emitEvent type is decodable by the Rust SessionEventPayload enum', async () => {
  const helperSource = await fs.readFile(helperPath, 'utf8');
  const rustSource = await fs.readFile(eventBusPath, 'utf8');

  // Extract enum variant names (and explicit serde renames) from the Rust enum.
  const enumBlock = rustSource.match(
    /pub enum SessionEventPayload \{([\s\S]*?)\n\}/,
  );
  assert.ok(enumBlock, 'SessionEventPayload enum not found');
  const variants = new Set();
  const variantMatches = enumBlock[1].matchAll(/(?:#\[[^\]]*\]\s*)*(\w+)\s*\{/g);
  for (const match of variantMatches) {
    variants.add(camelToSnake(match[1]));
  }
  const renameMatches = enumBlock[1].matchAll(/rename\s*=\s*"([a-z_]+)"/g);
  for (const match of renameMatches) {
    variants.add(match[1]);
  }

  // Extract types from every emitEvent({ ... type: 'x' }) call (multiline).
  const helperTypes = new Set();
  const emitMatches = helperSource.matchAll(/emitEvent\(\s*\{[\s\S]{0,400}?type:\s*'([a-z_]+)'/g);
  for (const match of emitMatches) {
    helperTypes.add(match[1]);
  }
  assert.ok(helperTypes.size >= 10, `unexpectedly few helper event types: ${[...helperTypes]}`);

  const missing = [...helperTypes].filter((type) => !variants.has(type));
  assert.deepEqual(
    missing,
    [],
    `helper emits event types the Rust enum cannot decode: ${missing}. ` +
      'A single unknown type kills the runtime stdout pump and historical replay.',
  );
});
