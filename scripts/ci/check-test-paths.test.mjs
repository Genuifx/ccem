import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSource } from './check-test-paths.mjs';

const js = 'apps/desktop/test/example.test.mjs';
const rust = 'apps/desktop/src-tauri/src/example_tests.rs';

test('rejects raw filesystem dynamic imports, including multiline and hand-built file URLs', () => {
  for (const source of [
    'await import(outfile);',
    'await import("C:relative.mjs");',
    'await import(\n path.join(directory, "fixture.mjs")\n);',
    'await import(`file://${outfile}`);',
    'await import("/tmp/fixture.mjs");',
    'await import("C:\\\\temp\\\\fixture.mjs");',
    'await import(new URL("file://" + outfile));',
  ]) assert.equal(checkSource(js, source)[0]?.rule, 'esm-fixture-import', source);
});

test('keeps safe imports, embedded fixture text and non-filesystem imports working', () => {
  for (const source of [
    "const fixture = await importFixture(outfile);",
    "await import(pathToFileURL(outfile).href);",
    "await import(`data:text/javascript;base64,${encoded}`);",
    "await import(`${pathToFileURL(outfile).href}?test=${id}`);",
    "await import('./fixture.mjs'); await import('node:fs'); await import('@ccem/core/browser');",
    "const source = `await import(outfile)`; // import(otherPath)",
  ]) assert.deepEqual(checkSource(js, source), [], source);
});

test('rejects bare read_link equality without changing snapshots or security checks', () => {
  const violation = checkSource(rust, 'assert_eq!(\n fs::read_link(&link).unwrap(),\n expected\n);');
  assert.equal(violation[0]?.rule, 'rust-link-target');
  assert.equal(violation[0]?.line, 1);
  assert.equal(checkSource(rust, 'assert_ne!(expected, std::fs::read_link(link).unwrap());')[0]?.rule, 'rust-link-target');
  assert.deepEqual(checkSource(rust, 'let bytes = fs::read_link(path).unwrap().into_os_string();\nassert!(validate_no_symlinks(path).is_err());'), []);
  assert.deepEqual(checkSource(rust, '// assert_eq!(fs::read_link(link), target);\nlet text = "assert_eq!(read_link(link), target)";'), []);
});

test('requires a reason on a local exception and does not exempt the next assertion', () => {
  const assertion = 'assert_eq!(fs::read_link(link).unwrap(), PathBuf::from("Browser"));';
  assert.deepEqual(checkSource(rust, `// test-path-allow: rust-link-target -- Archive contract requires exact relative link spelling.\n${assertion}`), []);
  assert.equal(checkSource(rust, `// test-path-allow: rust-link-target\n${assertion}`).length, 1);
  assert.equal(checkSource(rust, `// test-path-allow: rust-link-target -- Exact archive spelling.\n${assertion}\n${assertion}`).length, 1);
  assert.deepEqual(checkSource(js, '// test-path-allow: esm-fixture-import -- Browser evaluator imports a served URL, not a disk fixture.\nawait import("/node_modules/api.js");'), []);
});


test('applies the same narrow import guard to TypeScript and TSX tests', () => {
  for (const filename of ['apps/cli/src/__tests__/fixture.test.ts', 'apps/desktop/src/fixture.test.tsx']) {
    assert.equal(checkSource(filename, 'const loaded: unknown = await import(outfile);')[0]?.rule, 'esm-fixture-import');
    assert.deepEqual(checkSource(filename, "const loaded: unknown = await import('./fixture.js');"), []);
  }
});

test('preserves Rust read_link error and boolean security assertions', () => {
  for (const expression of [
    'fs::read_link(link).unwrap_err().kind(), ErrorKind::NotFound',
    'fs::read_link(link).is_ok(), false',
    'fs::read_link(link).unwrap().is_absolute(), false',
    'is_safe(fs::read_link(link).unwrap()), false',
    'fs::read_link(link).is_err(), true',
    'fs::read_link(link).err(), Some(error)',
    'fs::read_link(link).expect_err("must reject a regular file").kind(), ErrorKind::InvalidInput',
  ]) assert.deepEqual(checkSource(rust, `assert_eq!(${expression});`), [], expression);
});

test('Rust character and raw string literals do not affect assertion boundaries', () => {
  for (const literal of ["'('", "b')'", 'r#"(assert_eq!(read_link(link), target))"#']) {
    const source = `assert_eq!(left(${literal}), "ok");\nassert_eq!(fs::read_link(link).unwrap(), expected);`;
    assert.deepEqual(checkSource(rust, source).map(({ line, rule }) => ({ line, rule })), [
      { line: 2, rule: 'rust-link-target' },
    ]);
  }
});
