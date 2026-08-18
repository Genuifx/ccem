import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('useTauriCommands exposes a single-session native summary wrapper', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'hooks', 'useTauriCommands.ts'),
    'utf8',
  );

  const wrapper = source.match(/const getNativeSessionSummary = useCallback\(([\s\S]*?)\n  \}, \[\]\);/)?.[0];
  assert.ok(wrapper, 'getNativeSessionSummary wrapper should exist');
  assert.match(wrapper, /invoke<NativeSessionSummary \| null>\('get_native_session_summary'/);
  assert.match(wrapper, /runtimeId,/);
  assert.ok(
    source.includes('    getNativeSessionSummary,'),
    'getNativeSessionSummary should be returned from the hook',
  );
});

test('live session view refreshes its summary without listing every session', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx'),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /listNativeSessions\(\)/,
    'the live session view must not list all sessions to refresh one summary',
  );
  assert.match(source, /await getNativeSessionSummary\(session\.runtime_id\)/);
});

test('workspace live view stops polling while the page is inactive', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /isVisible=\{isActiveLiveEntry\}/,
    'live view visibility must include the page-active flag',
  );
  assert.match(source, /isVisible=\{isActive && isActiveLiveEntry\}/);
});
