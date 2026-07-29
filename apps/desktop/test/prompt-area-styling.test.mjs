import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('prompt area editor wraps long input without horizontal scrolling', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'prompt-area.tsx'),
    'utf8',
  );

  assert.match(component, /overflow-x-hidden/);
  assert.match(component, /\[overflow-wrap:anywhere\]/);
  assert.match(component, /\[word-break:break-word\]/);
});

test('prompt area keeps its trailing-newline sentinel inline without clipping IME text', async () => {
  const promptAreaHook = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'use-prompt-area.ts'),
    'utf8',
  );
  const domHelpers = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'dom-helpers.ts'),
    'utf8',
  );
  const css = await fs.readFile(
    path.join(desktopDir, 'src', 'index.css'),
    'utf8',
  );

  assert.match(promptAreaHook, /document\.createElement\('span'\)/);
  assert.match(promptAreaHook, /prompt-area-trailing-newline-sentinel/);
  assert.doesNotMatch(promptAreaHook, /const sentinel = document\.createElement\('br'\)/);
  assert.match(domHelpers, /isPromptAreaSentinel/);
  const sentinelRule = css.match(
    /\.ccem-prompt-area \.prompt-area-trailing-newline-sentinel\s*\{(?<body>[^}]*)\}/,
  );
  assert.ok(sentinelRule?.groups?.body, 'missing trailing-newline sentinel rule');
  assert.match(sentinelRule.groups.body, /line-height: inherit;/);
  assert.doesNotMatch(sentinelRule.groups.body, /\bdisplay\s*:/);
  assert.doesNotMatch(
    sentinelRule.groups.body,
    /\b(?:width|min-width|max-width|inline-size|min-inline-size|max-inline-size|overflow|overflow-x|overflow-y|clip|clip-path|visibility)\s*:/,
  );
});
