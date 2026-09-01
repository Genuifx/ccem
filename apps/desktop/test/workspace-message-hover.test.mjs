import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_EXTENSIONS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.json'];

async function resolveSourcePath(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

const desktopAliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveSourcePath(args.path);
      if (!resolved) {
        return { errors: [{ text: `Could not resolve ${args.path}` }] };
      }
      return { path: resolved };
    });
  },
};

async function importWorkspaceMessageRenderer() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-message-render-'));
  const outputPath = path.join(tempDir, 'workspace-message-renderer.cjs');
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { LocaleProvider } from '@/locales';
        import { TooltipProvider } from '@/components/ui/tooltip';
        import { WorkspaceMessageBubble } from '@/components/workspace/WorkspaceMessageBubble';
        import { buildWorkspaceTranscriptItems } from '@/components/workspace/WorkspaceTranscriptList';

        function installNodeGlobals() {
          const store = new Map();
          Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
              getItem: (key) => store.get(key) ?? null,
              setItem: (key, value) => store.set(key, String(value)),
              removeItem: (key) => store.delete(key),
              clear: () => store.clear(),
            },
          });
        }

        export function renderUserPromptWithInlineImage() {
          installNodeGlobals();
          const message = {
            msgType: 'user',
            uuid: 'user-with-image',
            content: [
              {
                type: 'text',
                text: '/lightweight-dev-mode 我想给我们这个审查的面板[Image #1]新增todo模块\\n\\nImages attached: 1',
              },
              {
                type: 'image',
                mediaType: 'image/png',
                base64Data: 'iVBORw0KGgo=',
                placeholder: '[Image #1]',
              },
            ],
            timestamp: Date.parse('2026-05-01T00:00:01.000Z'),
            segmentIndex: 0,
            isCompactBoundary: false,
          };
          return renderToStaticMarkup(
            React.createElement(LocaleProvider, null,
              React.createElement(TooltipProvider, null,
                React.createElement(WorkspaceMessageBubble, { message, prevRole: null })
              )
            )
          );
        }

        export function summarizeTranscriptItems(messages) {
          return buildWorkspaceTranscriptItems(messages).map((item) => ({
            key: item.key,
            type: item.type,
            marker: item.type === 'message'
              ? item.message.isCompactBoundary
                ? 'compact'
                : typeof item.message.content === 'string'
                  ? item.message.content
                  : item.message.msgType
              : item.type,
          }));
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-message-renderer.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [desktopAliasPlugin],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outputPath).href);
}

function extractBalancedDivByClass(html, classNamePart) {
  const classIndex = html.indexOf(classNamePart);
  assert.notEqual(classIndex, -1, `expected rendered HTML to include ${classNamePart}`);
  const openStart = html.lastIndexOf('<div', classIndex);
  assert.notEqual(openStart, -1, `expected ${classNamePart} to be on a div`);

  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = openStart;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) != null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(openStart, tagRe.lastIndex);
    }
  }

  assert.fail(`could not find closing div for ${classNamePart}`);
}

test('workspace message actions are revealed by explicit transcript content hover state', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceMessageBubble.tsx'),
    'utf8',
  );

  assert.match(component, /className=\{cn\(spacingClass,\s*'workspace-msg-virtualized'\)\}/);
  assert.doesNotMatch(component, /workspace-msg-virtualized\s+group\/msg/);
  assert.doesNotMatch(component, /group\/msg\s+workspace-msg-virtualized/);
  assert.doesNotMatch(component, /group-hover\/msg/);
  assert.doesNotMatch(component, /group-focus-within\/msg/);
  assert.doesNotMatch(component, /absolute top-full/);
  assert.doesNotMatch(
    component,
    /absolute bottom-0 z-10[^\n']*(?:border-border\/35|bg-background\/95|shadow-sm|backdrop-blur)/,
  );

  assert.match(component, /const \[isActionHovering,\s*setIsActionHovering\] = useState\(false\);/);
  assert.match(component, /const showMessageActions = isActionHovering \|\| isActionFocusWithin;/);

  assert.match(
    component,
    /className="relative ml-auto max-w-\[78%\] min-w-\[220px\] pb-6"[\s\S]*?onPointerEnter=\{\(\) => setIsActionHovering\(true\)\}[\s\S]*?onPointerLeave=\{\(\) => setIsActionHovering\(false\)\}/,
  );
  assert.match(
    component,
    /className="relative w-fit max-w-full pb-6"[\s\S]*?onPointerEnter=\{\(\) => setIsActionHovering\(true\)\}[\s\S]*?onPointerLeave=\{\(\) => setIsActionHovering\(false\)\}/,
  );
  assert.match(
    component,
    /visible \? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'/,
  );
  assert.match(component, /absolute bottom-0 z-10/);
  assert.match(
    component,
    /<MessageMetaBar message=\{message\} isUser visible=\{showMessageActions\} t=\{t\} \/>/,
  );
  assert.match(
    component,
    /<MessageMetaBar\s+message=\{message\}\s+isUser=\{false\}\s+visible=\{showMessageActions\}\s+t=\{t\}\s+onForkTurn=\{onForkTurn && hasProviderMessageUuid\(message\) \? onForkTurn : undefined\}\s+\/>/,
  );
});

test('workspace does not render estimated token speed in transcript or session rows', async () => {
  const [messageBubble, projectTree, sidebarSessions] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceMessageBubble.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'ProjectTree.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceSidebarSessions.ts'),
      'utf8',
    ),
  ]);

  assert.match(
    messageBubble,
    /visible \? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'/,
  );
  assert.doesNotMatch(messageBubble, /outputTokensPerSecond|output_tokens_per_second|t\/s/);
  assert.doesNotMatch(projectTree, /outputTokensPerSecond|output_tokens_per_second|t\/s/);
  assert.doesNotMatch(sidebarSessions, /outputTokensPerSecond|output_tokens_per_second|t\/s/);
});

test('user prompt image thumbnails render inside the rounded user message bubble', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceMessageBubble.tsx'),
    'utf8',
  );

  assert.match(
    component,
    /<div className="rounded-\[24px\][\s\S]*?\{renderedContent\}[\s\S]*?\{hasImages \? <WorkspaceImageStrip blocks=\{imageBlocks\} isUser t=\{t\} \/> : null\}[\s\S]*?<\/div>/,
  );
  assert.doesNotMatch(
    component,
    /hasImages \? \(\s*<div[\s\S]*?<WorkspaceImageStrip blocks=\{imageBlocks\} isUser=\{isUser\} t=\{t\} \/>[\s\S]*?<\/div>\s*\) : null/,
  );
});

test('rendered user prompt keeps inline image thumbnails inside the same user bubble', async () => {
  const { renderUserPromptWithInlineImage } = await importWorkspaceMessageRenderer();
  const html = renderUserPromptWithInlineImage();
  const userBubbleHtml = extractBalancedDivByClass(html, 'rounded-[24px] border border-border/30');

  assert.match(userBubbleHtml, /\/lightweight-dev-mode/);
  assert.match(userBubbleHtml, /审查的面板/);
  assert.match(userBubbleHtml, /新增todo模块/);
  assert.match(userBubbleHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(userBubbleHtml, /aria-label="[^"]*图片[^"]*"/);
  assert.doesNotMatch(userBubbleHtml, /\[Image #1\]/);
  assert.doesNotMatch(userBubbleHtml, /Images attached/);
});

test('native queued state is not rendered inside transcript message bubbles', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceMessageBubble.tsx'),
    'utf8',
  );

  assert.doesNotMatch(component, /queuedPending|queuedDeliveryState/);
});

test('uuid-less transcript item keys stay stable when older messages are prepended', async () => {
  const { summarizeTranscriptItems } = await importWorkspaceMessageRenderer();
  const olderCompactBoundary = {
    msgType: 'compact_boundary',
    content: 'Conversation compacted',
    segmentIndex: 0,
    isCompactBoundary: true,
  };
  const currentMessage = {
    msgType: 'assistant',
    content: 'current answer',
    segmentIndex: 0,
    isCompactBoundary: false,
  };

  const tailItems = summarizeTranscriptItems([currentMessage]);
  const prependedItems = summarizeTranscriptItems([olderCompactBoundary, currentMessage]);
  const tailKey = tailItems.find((item) => item.marker === 'current answer')?.key;
  const prependedKey = prependedItems.find((item) => item.marker === 'current answer')?.key;
  const compactKey = prependedItems.find((item) => item.marker === 'compact')?.key;

  assert.ok(tailKey);
  assert.equal(prependedKey, tailKey);
  assert.notEqual(compactKey, tailKey);
});

test('workspace history rendering is isolated from the app root', async () => {
  const [workspacePage, errorBoundary, historyDetail] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceHistoryErrorBoundary.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceConversationDetail.tsx'),
      'utf8',
    ),
  ]);

  assert.match(workspacePage, /<WorkspaceHistoryErrorBoundary[\s\S]*?<LazyHistoryDetail/);
  assert.match(errorBoundary, /static getDerivedStateFromError/);
  assert.match(errorBoundary, /componentDidCatch/);
  assert.match(errorBoundary, /this\.setState\(\{ hasError: false \}\)/);
  assert.match(
    historyDetail,
    /\[hasMoreMessages, messageBatchSize, renderedMessageCount, startTransition, visibleMessages\.length\]/,
  );
});
