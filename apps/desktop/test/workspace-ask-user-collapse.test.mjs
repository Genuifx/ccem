import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...parts) {
  return fs.readFile(path.join(desktopDir, ...parts), 'utf8');
}

test('ask-user-question panel supports collapse/expand toggle above composer', async () => {
  const nativeView = await readSource('src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const zh = JSON.parse(await readSource('src', 'locales', 'zh.json'));
  const en = JSON.parse(await readSource('src', 'locales', 'en.json'));

  assert.match(
    nativeView,
    /const \[collapsedPromptIds, setCollapsedPromptIds\] = useState<Set<string>>\(new Set\(\)\)/,
    'Attention panel should track collapsed ask-user prompts',
  );
  assert.match(
    nativeView,
    /const togglePromptCollapsed = useCallback\(\(toolUseId: string\) => \{/,
    'Attention panel should expose a per-prompt collapse toggle',
  );
  assert.match(
    nativeView,
    /data-collapsed=\{isCollapsed \? 'true' : 'false'\}/,
    'Ask-user cards should expose collapsed state for verification',
  );
  assert.match(
    nativeView,
    /aria-expanded=\{!isCollapsed\}/,
    'Collapse controls should advertise expanded state',
  );
  assert.match(
    nativeView,
    /t\('workspace\.nativePromptCollapse'\)/,
    'Collapse control should use i18n collapse label',
  );
  assert.match(
    nativeView,
    /t\('workspace\.nativePromptExpand'\)/,
    'Collapse control should use i18n expand label',
  );
  assert.match(
    nativeView,
    /\{!isCollapsed \? \([\s\S]*?id=\{`ask-user-body-\$\{promptOccurrenceId\}`\}/,
    'Question options and actions should hide while collapsed',
  );
  assert.match(
    nativeView,
    /isCollapsed && 'line-clamp-2'/,
    'Collapsed header should keep a compact question preview',
  );

  assert.equal(zh.workspace.nativePromptCollapse, '收起问题');
  assert.equal(zh.workspace.nativePromptExpand, '展开问题');
  assert.equal(en.workspace.nativePromptCollapse, 'Collapse question');
  assert.equal(en.workspace.nativePromptExpand, 'Expand question');
});
