import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('environment advanced setting persists the write-tool limit toggle', async () => {
  const [dialog, commands] = await Promise.all([
    fs.readFile(path.resolve(__dirname, '../src/components/EnvironmentDialog.tsx'), 'utf8'),
    fs.readFile(path.resolve(__dirname, '../src/hooks/useTauriCommands.ts'), 'utf8'),
  ]);

  assert.match(dialog, /id="limitWriteTools"/);
  assert.match(dialog, /checked=\{limitWriteTools\}/);
  assert.match(dialog, /onCheckedChange=\{setLimitWriteTools\}/);
  assert.match(dialog, /limitWriteTools,/);
  assert.match(
    dialog,
    /-mx-1\.5 flex-1 overflow-y-auto px-1\.5 min-h-0/,
    'the scrolling dialog keeps horizontal room for the input focus ring',
  );
  assert.match(commands, /CCEM_LIMIT_WRITE_TOOLS\?: boolean/);
  assert.match(commands, /limitWriteTools: Boolean\(displayConfig\.CCEM_LIMIT_WRITE_TOOLS\)/);
  assert.match(commands, /limitWriteTools: env\.limitWriteTools/);
});
