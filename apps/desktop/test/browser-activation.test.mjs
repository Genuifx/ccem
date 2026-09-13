import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/components/workspace/browserActivation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const { createBrowserActivationController } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);
const summary = (runtime_id) => ({ runtime_id, provider: 'claude', is_active: true, project_dir: '/workspace' });
const request = (runtime_id, request_id = 'request-1') => ({ runtime_id, request_id });
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function harness(claim = async ({ runtime_id }) => summary(runtime_id)) {
  const revealed = [];
  const rolledBack = [];
  const visible = new Set();
  const rejected = [];
  const claimed = [];
  const controller = createBrowserActivationController({
    claim: (value) => { claimed.push(value); return claim(value); },
    reject: async (value, reason) => { rejected.push({ ...value, reason }); },
    ownerFor: (session) => `owner:${session.runtime_id}`,
    reveal: (session, owner) => {
      revealed.push({ session, owner });
      if (visible.has(owner)) return;
      visible.add(owner);
      return () => { visible.delete(owner); rolledBack.push(owner); };
    },
  });
  return { controller, revealed, rejected, claimed, rolledBack, visible };
}

test('each new conversation opens its own browser by default without an extra approval', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.complete({ ...request('a'), activated: true });
  await h.controller.request(request('b'));
  assert.deepEqual(h.revealed.map(({ owner }) => owner), ['owner:a', 'owner:b']);
  assert.deepEqual(h.rejected, []);
  assert.deepEqual(h.rolledBack, []);
});

test('duplicate activation events share the in-flight claim and never toggle the browser', async () => {
  const gate = deferred();
  const h = harness(() => gate.promise);
  const first = h.controller.request(request('a'));
  await h.controller.request(request('a'));
  gate.resolve(summary('a'));
  await first;
  await h.controller.request(request('a'));
  assert.equal(h.claimed.length, 1);
  assert.equal(h.revealed.length, 1);
});

test('explicit user takeover rejects pending and future calls for that panel, while a new session stays enabled', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.status('owner:a', 'disabled');
  await h.controller.request(request('a', 'request-2'));
  await h.controller.request(request('b'));
  assert.deepEqual(h.rejected.map(({ reason }) => reason), ['disabled', 'disabled']);
  assert.deepEqual(h.revealed.map(({ owner }) => owner), ['owner:a', 'owner:b']);
  h.controller.status('owner:a', 'ready');
  await h.controller.request(request('a', 'request-3'));
  assert.equal(h.revealed.at(-1).owner, 'owner:a');
});

test('explicit close suppresses reopening until the user opens the panel again', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.cancel('owner:a', true);
  await h.controller.request(request('a', 'request-2'));
  assert.equal(h.revealed.length, 1);
  h.controller.reopen('owner:a');
  await h.controller.request(request('a', 'request-3'));
  assert.equal(h.revealed.length, 2);
});

test('user takeover during activation keeps the opened panel after the tool is rejected', async () => {
  let rollbacks = 0;
  const controller = createBrowserActivationController({
    claim: async () => summary('a'), reject: async () => {},
    ownerFor: () => 'owner:a', reveal: () => () => { rollbacks += 1; },
  });
  await controller.request(request('a'));
  controller.status('owner:a', 'disabled');
  controller.complete({ ...request('a'), activated: false });
  assert.equal(rollbacks, 0);
});

test('revealing a retained panel never clears its authoritative user takeover', async () => {
  const h = harness();
  h.controller.status('owner:a', 'disabled');
  h.controller.cancel('owner:a', true);
  h.controller.reopen('owner:a');
  await h.controller.request(request('a'));
  assert.equal(h.revealed.length, 0);
  assert.equal(h.rejected[0].reason, 'disabled');
  h.controller.reopen('owner:a', true);
  await h.controller.request(request('a', 'request-2'));
  assert.equal(h.revealed.length, 1);
});

test('a request completed or cancelled natively before claim resolution cannot open a panel late', async () => {
  const gate = deferred();
  const h = harness(() => gate.promise);
  const work = h.controller.request(request('a'));
  h.controller.complete({ ...request('a'), activated: false });
  gate.resolve(summary('a'));
  await work;
  assert.deepEqual(h.revealed, []);
});

test('changing conversation while activation is being validated cancels late activation', async () => {
  const gate = deferred();
  const h = harness(() => gate.promise);
  h.controller.selectionChanged('owner:a');
  const work = h.controller.request(request('a'));
  h.controller.selectionChanged('owner:b');
  gate.resolve(summary('a'));
  await work;
  assert.deepEqual(h.revealed, []);
  assert.equal(h.rejected[0].reason, 'cancelled');
});

test('two different tools for the same new conversation survive its initial shell selection', async () => {
  const gate = deferred();
  const h = harness((value) => value.request_id === 'second' ? gate.promise : Promise.resolve(summary('a')));
  h.controller.selectionChanged('compose');
  const second = h.controller.request(request('a', 'second'));
  await h.controller.request(request('a'));
  h.controller.selectionChanged('owner:a');
  gate.resolve(summary('a'));
  await second;
  assert.equal(h.revealed.length, 2);
  assert.deepEqual(h.rejected, []);
});

test('switching away after opening rejects the waiting request', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.selectionChanged('owner:b');
  assert.equal(h.rejected[0].reason, 'cancelled');
});

test('a queued retry cannot undo cancellation while native rejection is still in transit', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.selectionChanged('owner:b');
  await h.controller.request(request('a'));
  assert.equal(h.claimed.length, 1);
  assert.equal(h.revealed.length, 1);
  assert.deepEqual(h.rejected.map(({ reason }) => reason), ['cancelled']);
  h.controller.complete({ ...request('a'), activated: false });
  await h.controller.request(request('a', 'new-command'));
  assert.equal(h.revealed.length, 2);
});

test('leaving Workspace cancels a pending claim, while a later new request can still open it', async () => {
  const gate = deferred();
  const h = harness(() => gate.promise);
  const work = h.controller.request(request('a'));
  h.controller.leaveWorkspace();
  gate.resolve(summary('a'));
  await work;
  await h.controller.request(request('a'));
  assert.equal(h.revealed.length, 0);
  await h.controller.request(request('a', 'new-command'));
  assert.equal(h.revealed.length, 1);
});

test('unavailable native state and mismatched runtime identities cannot reveal a browser', async () => {
  for (const claim of [async () => { throw new Error('expired'); }, async () => summary('wrong')]) {
    const h = harness(claim);
    await h.controller.request(request('a'));
    assert.equal(h.revealed.length, 0);
    assert.equal(h.rejected[0].reason, 'unavailable');
  }
});

test('unmount rejects outstanding activation and ignores late claim resolution', async () => {
  const gate = deferred();
  const h = harness(() => gate.promise);
  const work = h.controller.request(request('a'));
  h.controller.dispose();
  gate.resolve(summary('a'));
  await work;
  assert.equal(h.revealed.length, 0);
  assert.equal(h.rejected[0].reason, 'cancelled');
  h.controller.resume();
  await h.controller.request(request('a', 'second'));
  assert.equal(h.revealed.length, 1);
});

test('native Stop rolls back an automatic reveal even after a late ready projection', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.status('owner:a', 'ready');
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, ['owner:a']);
  assert.equal(h.visible.has('owner:a'), false);

  await h.controller.request(request('a', 'new-command'));
  assert.equal(h.visible.has('owner:a'), true);
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, ['owner:a'], 'a repeated old completion cannot close the new panel');
});

test('concurrent tools keep the original reveal until all requests fail', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  await h.controller.request(request('a', 'second'));
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, []);
  h.controller.complete({ ...request('a', 'second'), activated: false });
  assert.deepEqual(h.rolledBack, ['owner:a']);
});

test('a same-runtime claim still in flight keeps the automatic reveal alive', async () => {
  const gate = deferred();
  const h = harness((value) => value.request_id === 'second' ? gate.promise : Promise.resolve(summary('a')));
  const second = h.controller.request(request('a', 'second'));
  await h.controller.request(request('a'));
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, []);
  gate.resolve(summary('a'));
  await second;
  h.controller.complete({ ...request('a', 'second'), activated: false });
  assert.deepEqual(h.rolledBack, ['owner:a']);
});

test('any native successful activation retains the panel when sibling requests fail', async () => {
  for (const successFirst of [false, true]) {
    const h = harness();
    await h.controller.request(request('a'));
    await h.controller.request(request('a', 'second'));
    const success = { ...request('a'), activated: true };
    const failure = { ...request('a', 'second'), activated: false };
    h.controller.complete(successFirst ? success : failure);
    h.controller.complete(successFirst ? failure : success);
    assert.deepEqual(h.rolledBack, []);
    assert.equal(h.visible.has('owner:a'), true);
  }
});

test('cancelling all same-owner requests rolls back once and queued events cannot reopen it', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  await h.controller.request(request('a', 'second'));
  h.controller.selectionChanged('owner:b');
  assert.deepEqual(h.rolledBack, ['owner:a']);
  await h.controller.request(request('a'));
  await h.controller.request(request('a', 'second'));
  assert.equal(h.revealed.length, 2);
  h.controller.complete({ ...request('a'), activated: false });
  h.controller.complete({ ...request('a', 'second'), activated: false });
  assert.deepEqual(h.rolledBack, ['owner:a']);
});

test('manual hide and reopen preserve the user-selected panel through native cancellation', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.cancel('owner:a', true);
  assert.deepEqual(h.rolledBack, [], 'Workspace owns the explicit hide/close mutation');
  h.visible.delete('owner:a');
  h.controller.reopen('owner:a');
  h.visible.add('owner:a');
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, []);
  assert.equal(h.visible.has('owner:a'), true);
});

test('manually retaining an automatic panel discards its rollback', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.reopen('owner:a');
  h.controller.complete({ ...request('a'), activated: false });
  assert.deepEqual(h.rolledBack, []);
  assert.equal(h.visible.has('owner:a'), true);
});

test('a failed new panel can retry in a later command without keeping its unavailable status', async () => {
  const h = harness();
  await h.controller.request(request('a'));
  h.controller.status('owner:a', 'unavailable');
  assert.deepEqual(h.rolledBack, ['owner:a']);
  h.controller.complete({ ...request('a'), activated: false });
  await h.controller.request(request('a', 'new-command'));
  assert.equal(h.revealed.length, 2);
  assert.equal(h.visible.has('owner:a'), true);
});
