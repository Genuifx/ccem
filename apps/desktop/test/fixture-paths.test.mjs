import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixturePath, importFixture } from './helpers/fixture-paths.mjs';

test('fixture paths preserve spaces, Unicode and URL-reserved filesystem characters', () => {
  const directory = path.join(os.tmpdir(), 'fixture space # % 中文');
  const moduleUrl = pathToFileURL(path.join(directory, 'test.mjs')).href;
  assert.equal(fixturePath(moduleUrl, 'nested', 'file # %.mjs'), path.join(directory, 'nested', 'file # %.mjs'));
  assert.equal(fixturePath(moduleUrl, '..', 'sibling.mjs'), path.resolve(directory, '..', 'sibling.mjs'));
});

test('imports a real fixture containing URL-reserved characters without changing its identity', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem fixture # % 中文-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'module # %.mjs');
  await fs.writeFile(fixture, 'export const marker = {}; export const value = "fixture loaded";');
  const first = await importFixture(fixture);
  assert.equal(first.value, 'fixture loaded');
  assert.equal((await importFixture(fixture)).marker, first.marker);
});

test('missing fixture imports reject instead of silently returning an empty module', async () => {
  await assert.rejects(importFixture(fixturePath(import.meta.url, 'missing-fixture.mjs')), { code: 'ERR_MODULE_NOT_FOUND' });
});
