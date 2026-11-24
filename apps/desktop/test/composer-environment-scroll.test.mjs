import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

function extractOpeningTags(source, tagName) {
  const tags = [];
  const openToken = `<${tagName}`;
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const start = source.indexOf(openToken, searchFrom);
    if (start === -1) break;
    const afterName = source[start + openToken.length];
    if (afterName && !/[\s/>]/.test(afterName)) {
      searchFrom = start + openToken.length;
      continue;
    }

    let index = start + openToken.length;
    let braceDepth = 0;
    let quote = null;
    let inLineComment = false;
    let inBlockComment = false;

    while (index < source.length) {
      const ch = source[index];
      const next = source[index + 1];

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        index += 1;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          index += 2;
          continue;
        }
        if (ch === quote) quote = null;
        index += 1;
        continue;
      }

      if (ch === '/' && next === '/') {
        inLineComment = true;
        index += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        index += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        continue;
      }
      if (ch === '>' && braceDepth === 0) {
        tags.push(source.slice(start, index + 1));
        index += 1;
        break;
      }
      index += 1;
    }

    searchFrom = index;
  }

  return tags;
}

test('composer keeps the environment overflow affordance visible', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'ComposerControls.tsx'),
    'utf8',
  );

  const scrollAreas = extractOpeningTags(component, 'ScrollArea');
  const environmentScrollArea = scrollAreas.find((tag) =>
    /data-ccem-composer-environment-scroll\b/.test(tag),
  );
  assert.ok(environmentScrollArea, 'composer environment ScrollArea should exist');
  assert.match(environmentScrollArea, /type="always"/);

  const agyModelScrollArea = scrollAreas.find((tag) =>
    /data-ccem-composer-agy-model-scroll\b/.test(tag),
  );
  assert.ok(agyModelScrollArea, 'composer agy model ScrollArea should exist');
  assert.match(agyModelScrollArea, /type="always"/);
});
