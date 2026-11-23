import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson, isTransientTransportError } from './release-http.mjs';

const token = 'fixture-secret-token';
const url = 'https://api.github.com/repos/Genuifx/ccem/actions/runs';
const response = (body) => ({ status: 200, ok: true, json: async () => body });
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });

test('retries a transport failure in a nested cause, bounded to three reads', async () => {
  let calls = 0;
  const delays = [];
  const body = await requestJson({ url, token, label: 'runs', sleepImpl: async (ms) => delays.push(ms), fetchImpl: async () => {
    calls += 1;
    if (calls < 3) throw reset();
    return response({ workflow_runs: [] });
  } });
  assert.deepEqual(body, { workflow_runs: [] });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(calls, 3);
});

test('retries interrupted response bodies instead of misclassifying them as JSON parse errors', async () => {
  let calls = 0;
  const body = await requestJson({ url, token, label: 'jobs', sleepImpl: async () => {}, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? { status: 200, ok: true, json: async () => { throw reset(); } } : response({ jobs: [] });
  } });
  assert.deepEqual(body, { jobs: [] });
  assert.equal(calls, 2);
});

test('invalid JSON and denied access are deterministic and never retried', async () => {
  for (const fetchResult of [
    { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } },
    { status: 403, ok: false, json: async () => ({ message: 'forbidden' }) },
  ]) {
    let calls = 0;
    await assert.rejects(requestJson({ url, token, label: 'runs', fetchImpl: async () => { calls += 1; return fetchResult; } }), /invalid JSON|read failed \(403\)/u);
    assert.equal(calls, 1);
  }
});

test('exhausted errors preserve safe cause codes without leaking authentication', async () => {
  let calls = 0;
  await assert.rejects(requestJson({ url, token, label: 'jobs', sleepImpl: async () => {}, fetchImpl: async () => {
    calls += 1;
    throw new Error(`Bearer ${token}`, { cause: Object.assign(new Error(token), { code: 'ENOTFOUND' }) });
  } }), (error) => {
    assert.match(error.message, /jobs request failed.*ENOTFOUND/u);
    assert.doesNotMatch(error.message, /fixture-secret-token/u);
    assert.equal(error.cause.cause.code, 'ENOTFOUND');
    assert.doesNotMatch(error.cause.message, /fixture-secret-token/u);
    return true;
  });
  assert.equal(calls, 3);
});

test('a generic failure or parse error with transport-like wording is not transient', () => {
  assert.equal(isTransientTransportError(new Error('ECONNRESET')), false);
  assert.equal(isTransientTransportError(new SyntaxError('network timeout')), false);
  assert.equal(isTransientTransportError(reset()), true);
});

test('transient HTTP failures retry, with a finite request timeout on every attempt', async () => {
  let calls = 0;
  const body = await requestJson({ url, token, label: 'runs', sleepImpl: async () => {}, fetchImpl: async (_, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    calls += 1;
    return calls === 1 ? { status: 503, ok: false } : response({ ok: true });
  } });
  assert.deepEqual(body, { ok: true });
  assert.equal(calls, 2);
});
