import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// GHSA-mrhx-c7xc-m3w5: reject oversized collections before allocating
// validation results for every element. Keep the fixture deliberately small.
for (const [name, schemaFor, valid, oversized] of [
  ['array', (item) => z.array(item).max(1), ['ok'], [1, 2, 3]],
  ['set', (item) => z.set(item).max(1), new Set(['ok']), new Set([1, 2, 3])],
  ['map', (item) => z.map(z.string(), item).max(1),
    new Map([['a', 'ok']]), new Map([['a', 1], ['b', 2], ['c', 3]])],
]) {
  test(`bounded ${name} rejects oversize input before visiting elements`, () => {
    let visits = 0;
    const item = z.preprocess((value) => {
      visits += 1;
      return value;
    }, z.string());
    const schema = schemaFor(item);

    assert.deepEqual(schema.parse(valid), valid);
    assert.equal(visits, 1);
    visits = 0;

    const result = schema.safeParse(oversized);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
    assert.equal(visits, 0);
  });
}
