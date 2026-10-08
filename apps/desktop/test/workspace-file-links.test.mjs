import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/components/workspace/workspaceFileLinks.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
const { workspaceFileLinkPath: parse, resolveWorkspaceDocumentLink: resolve } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);

test('workspace file links handle encoded, absolute and document-relative paths', () => {
  assert.equal(parse('ccem-file://preview?path=docs%2F%E6%8A%A5%E5%91%8A%20one.md'), 'docs/报告 one.md');
  assert.equal(parse('ccem-file://preview/?path=README'), 'README');
  assert.equal(parse('file:///project/report%20one.md'), '/project/report one.md');
  assert.equal(parse('report.md:12:3'), 'report.md');
  assert.equal(parse('docs/report.md#summary'), 'docs/report.md');
  assert.equal(resolve('../next.md', 'docs/report.md'), 'docs/../next.md');
  assert.equal(resolve('/project/next.md', 'docs/report.md'), '/project/next.md');
});

test('web URLs, unsafe schemes, authorities and malformed local links are not file links', () => {
  for (const href of ['https://example.com/report.md', '//example.com/file.md', '#summary', 'javascript:alert(1)',
    'data:text/plain,hello', 'ccem-file://other?path=report.md', 'ccem-file://preview?path=%00',
    'ccem-file://user:password@preview?path=file.md', 'file://remote/file.md', 'file:///project/%00.md', '%ZZ.md',
    'ccem-file://preview/extra?path=report.md', 'ccem-file:///other?path=report.md', 'ccem-file://preview?path=',
    'ccem-file://preview', 'ccem-file://download?path=report.md']) {
    assert.equal(parse(href), null, href);
  }
});

test('ccem-file preview links tolerate agent drift from the canonical form', () => {
  assert.equal(parse('ccem-file://Preview?path=design-demos%2Fnatgeo-p1.html'), 'design-demos/natgeo-p1.html');
  assert.equal(parse('CCEM-FILE://PREVIEW?path=docs%2Freport.md'), 'docs/report.md');
  assert.equal(parse('ccem-file:///preview?path=docs%2Freport.md'), 'docs/report.md');
  assert.equal(parse('ccem-file:preview?path=docs%2Freport.md'), 'docs/report.md');
  // Unencoded '#' and '&' must stay part of the path instead of truncating it.
  assert.equal(parse('ccem-file://preview?path=docs/a#section.md'), 'docs/a#section.md');
  assert.equal(parse('ccem-file://preview?path=docs/a&b.md'), 'docs/a&b.md');
  // '+' is a literal plus in URLs, not a form-encoded space.
  assert.equal(parse('ccem-file://preview?path=docs/a+b.md'), 'docs/a+b.md');
  // Stray percent signs that are not valid escapes stay literal.
  assert.equal(parse('ccem-file://preview?path=docs/50%.md'), 'docs/50%.md');
  assert.equal(parse('ccem-file://preview?path=docs%2Fmy%20report.md'), 'docs/my report.md');
  assert.equal(parse('ccem-file://preview?x=1&path=docs%2Freport.md'), 'docs/report.md');
  assert.equal(parse('ccem-file://preview?path=%2FUsers%2Fwzt%2Fproj%2Fdocs%2Freport.md'), '/Users/wzt/proj/docs/report.md');
});
