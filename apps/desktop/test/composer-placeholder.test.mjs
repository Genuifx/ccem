import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importComposerAttachments() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'composerAttachments.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-placeholder-test-'));
  const outputPath = path.join(tempDir, 'composerAttachments.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('splits image placeholders for highlighted composer rendering', async () => {
  const { splitComposerImagePlaceholders } = await importComposerAttachments();

  assert.deepEqual(splitComposerImagePlaceholders('这是啥 [Image #1] 然后 [Image #2]'), [
    { kind: 'text', text: '这是啥 ' },
    { kind: 'image', text: '[Image #1]' },
    { kind: 'text', text: ' 然后 ' },
    { kind: 'image', text: '[Image #2]' },
  ]);
});

test('ensures image attachments have request text placeholders', async () => {
  const { ensureComposerImagePlaceholders } = await importComposerAttachments();
  const imageAttachment = (placeholder) => ({
    id: `attachment-${placeholder}`,
    kind: 'image',
    source: 'paste',
    name: 'Pasted image',
    placeholder,
    mediaType: 'image/png',
    base64Data: 'abc',
    byteSize: 3,
    objectUrl: null,
  });

  assert.equal(
    ensureComposerImagePlaceholders('看这个', [imageAttachment('[Image #1]')]),
    '看这个\n[Image #1]',
  );
  assert.equal(
    ensureComposerImagePlaceholders('看这个 [Image #1]', [imageAttachment('[Image #1]')]),
    '看这个 [Image #1]',
  );
  assert.equal(
    ensureComposerImagePlaceholders('', [imageAttachment('[Image #1]'), imageAttachment('[Image #2]')]),
    '[Image #1]\n[Image #2]',
  );
});

test('builds composer image preview src from the submitted base64 payload', async () => {
  const { getComposerImageAttachmentSrc } = await importComposerAttachments();

  assert.equal(
    getComposerImageAttachmentSrc({
      id: 'image-1',
      kind: 'image',
      source: 'paste',
      name: 'Pasted image',
      placeholder: '[Image #1]',
      mediaType: 'image/png',
      base64Data: 'abc123',
      byteSize: 6,
      objectUrl: 'blob:stale-preview',
    }),
    'data:image/png;base64,abc123',
  );

  assert.equal(
    getComposerImageAttachmentSrc({
      id: 'image-2',
      kind: 'image',
      source: 'paste',
      name: 'Pasted image',
      placeholder: '[Image #2]',
      mediaType: 'image/jpeg',
      base64Data: '   ',
      byteSize: 6,
      objectUrl: 'blob:fallback-preview',
    }),
    'blob:fallback-preview',
  );
});

test('builds selected skill prompt attachments inside user request', async () => {
  const { buildComposerPromptText } = await importComposerAttachments();
  const prompt = [
    '<selected_skills>',
    '<skill name="lightweight-dev-mode" path="/tmp/lightweight-dev-mode/SKILL.md">',
    '<instruction>Use this selected skill for the user request.</instruction>',
    '</skill>',
    '</selected_skills>',
    '',
    '<user_request>',
    '/lightweight-dev-mode 修这个',
    '</user_request>',
  ].join('\n');

  const result = buildComposerPromptText(prompt, [
    {
      id: 'image-1',
      kind: 'image',
      source: 'paste',
      name: 'Pasted image',
      placeholder: '[Image #1]',
      mediaType: 'image/png',
      base64Data: 'abc',
      byteSize: 3,
      objectUrl: null,
    },
    {
      id: 'file-1',
      kind: 'file',
      source: 'drop',
      name: 'App.tsx',
      absolutePath: '/repo/src/App.tsx',
      relativePath: 'src/App.tsx',
      displayPath: 'src/App.tsx',
      isOutsideWorkspace: false,
    },
    {
      id: 'text-1',
      kind: 'text',
      source: 'paste',
      name: 'Pasted text',
      content: 'large paste',
      lineCount: 1,
      charCount: 11,
    },
  ]);

  const userRequest = /<user_request>([\s\S]*?)<\/user_request>/.exec(result)?.[1] ?? '';
  const afterUserRequest = result.slice(result.indexOf('</user_request>') + '</user_request>'.length);
  assert.match(userRequest, /\[Image #1\]/);
  assert.match(userRequest, /Attached files:\n- @src\/App\.tsx \(\/repo\/src\/App\.tsx\)/);
  assert.match(userRequest, /Attached text snippets:\n\n- Pasted text \(1 lines\)/);
  assert.match(userRequest, /```text\nlarge paste\n```/);
  assert.doesNotMatch(afterUserRequest, /Attached files:|Attached text snippets:|\[Image #1\]/);
});

test('classifies composer file attachments by extension for their icon', async () => {
  const { getComposerFileKind } = await importComposerAttachments();

  assert.equal(getComposerFileKind('shot.PNG'), 'image');
  assert.equal(getComposerFileKind('App.tsx'), 'code');
  assert.equal(getComposerFileKind('lib.rs'), 'code');
  assert.equal(getComposerFileKind('package.json'), 'data');
  assert.equal(getComposerFileKind('config.yaml'), 'data');
  assert.equal(getComposerFileKind('report.csv'), 'spreadsheet');
  assert.equal(getComposerFileKind('README.md'), 'document');
  assert.equal(getComposerFileKind('spec.pdf'), 'document');
  assert.equal(getComposerFileKind('build.tar.gz'), 'archive');
  assert.equal(getComposerFileKind('Makefile'), 'file');
  assert.equal(getComposerFileKind('.env'), 'file');
});
