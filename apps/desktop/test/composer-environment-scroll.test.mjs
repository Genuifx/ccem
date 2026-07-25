import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('composer keeps the environment overflow affordance visible', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'ComposerControls.tsx'),
    'utf8',
  );

  const scrollArea = component.match(/<ScrollArea\s+([\s\S]*?)>/)?.[0];
  assert.ok(scrollArea, 'composer environment ScrollArea should exist');
  assert.match(scrollArea, /data-ccem-composer-environment-scroll/);
  assert.match(scrollArea, /type="always"/);
});
