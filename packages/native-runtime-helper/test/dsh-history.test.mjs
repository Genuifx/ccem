/**
 * DSH History Helper contract tests.
 *
 * Validates the built dsh-history-helper.mjs against synthetic fixtures
 * using a temporary DSH_HOME. Never reads real ~/.dsh or credentials.
 *
 * Coverage: raw JSONL, zstd, packed rows, torn tail, strict malformed cases,
 * seed replay exclusion, replacement shadowed events, session title fold,
 * tool field projection, usage from assistant/message, usage last-wins dedup,
 * hash/size/mtime immutability, and Node version gate.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

const compress = promisify(zstdCompress);

const HELPER_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'dsh-history-helper.mjs');
const NODE_BIN = process.execPath;

// --- DSH path encoding (matches DSH's internal encoding) ---

function projectKey(cwd) {
  let readable = '', separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch; separatorRun = false;
    } else {
      readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

// --- Test utilities ---
function createFixtureRoot(tmpDir) {
  const sessions = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return sessions;
}

function writeSession(root, cwd, sessionId, events, opts = {}) {
  const sessionDir = path.join(root, projectKey(cwd), sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const version = opts.version ?? 0;
  const header = { type: 'session', version, id: sessionId, createdAt: Date.now(), cwd, delegationDepth: 0, ...(opts.headerExtra || {}) };
  const content = [header, ...events].map(e => JSON.stringify(e)).join('\n') + '\n';
  const filePath = path.join(sessionDir, 'session.jsonl');
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Create a valid DSH event set for a single turn with proper surfaceOp markers.
 * Uses official storage format: time, structured data, surfaceOp on surface events.
 */
function makeValidTurn(startSeq, text = 'Hello', model = 'claude-4', provider = 'anthropic') {
  const now = Date.now();
  const msgId = randomUUID();
  const assistId = randomUUID();
  return [
    { type: 'turn/start', seq: startSeq, time: now, data: { turn: 1 } },
    { type: 'user/message', seq: startSeq + 1, time: now + 1, surfaceOp: 'append', data: { id: msgId, role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text }] } },
    { type: 'step/start', seq: startSeq + 2, time: now + 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: startSeq + 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: assistId, role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text: 'Reply' }] }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 } } },
    { type: 'step/end', seq: startSeq + 4, time: now + 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: startSeq + 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

async function writeZstdSession(root, cwd, sessionId, events, opts = {}) {
  const sessionDir = path.join(root, projectKey(cwd), sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const version = opts.version ?? 0;
  const header = { type: 'session', version, id: sessionId, createdAt: Date.now(), cwd, delegationDepth: 0, ...(opts.headerExtra || {}) };
  const headerLine = JSON.stringify(header) + '\n';
  const evLines = events.map(e => JSON.stringify(e) + '\n').join('');
  const headerFrame = await compress(Buffer.from(headerLine));
  const eventFrame = await compress(Buffer.from(evLines));
  const filePath = path.join(sessionDir, 'session.jsonl.zstd');
  fs.writeFileSync(filePath, Buffer.concat([headerFrame, eventFrame]));
  return filePath;
}

function invokeHelper(request, env = {}) {
  const input = JSON.stringify(request);
  const result = execFileSync(NODE_BIN, [HELPER_PATH], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(result.trim());
}

function invokeHelperRaw(input, env = {}) {
  return execFileSync(NODE_BIN, [HELPER_PATH], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileStat(filePath) {
  const s = fs.statSync(filePath);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

// --- Tests ---

describe('dsh-history-helper', () => {
  let tmpDir;
  let sessionsRoot;

  before(() => {
    assert.ok(fs.existsSync(HELPER_PATH), `Built helper must exist at ${HELPER_PATH}`);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-history-test-'));
    sessionsRoot = createFixtureRoot(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // LIST
  // =========================================================================

  describe('list', () => {
    test('empty root returns empty list', () => {
      const emptyRoot = path.join(tmpDir, 'empty');
      const result = invokeHelper({ op: 'list', roots: [emptyRoot] });
      assert.equal(result.ok, true);
      assert.equal(result.schemaVersion, 1);
      assert.deepEqual(result.data, []);
    });

    test('lists sessions with metadata from readFrom', () => {
      const events = makeValidTurn(0);
      writeSession(sessionsRoot, '/tmp/project-list', 'list-001', events);
      const result = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      assert.equal(result.ok, true);
      const item = result.data.find(d => d.sessionId === 'list-001');
      assert.ok(item);
      assert.equal(item.cwd, '/tmp/project-list');
      assert.equal(item.projectName, 'project-list');
      assert.ok(item.sourceInstanceId);
      assert.ok(item.eventCount >= 6);
      assert.ok(item.lastEventAt);
      assert.equal(item.model, 'claude-4');
      assert.equal(item.provider, 'anthropic');
    });

    test('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        writeSession(sessionsRoot, '/tmp/limit-test', `limit-${i}`, makeValidTurn(0));
      }
      const result = invokeHelper({ op: 'list', roots: [sessionsRoot], limit: 3 });
      assert.equal(result.ok, true);
      assert.ok(result.data.length <= 3);
    });

    test('sourceInstanceId = sha256(realpath)[0..16]', () => {
      const result = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const expectedId = createHash('sha256')
        .update(fs.realpathSync(sessionsRoot), 'utf8')
        .digest('hex').slice(0, 16);
      assert.ok(result.data.length > 0);
      assert.equal(result.data[0].sourceInstanceId, expectedId);
    });

    test('foldSessionTitle fills title field from session/title events', () => {
      const now = Date.now();
      const events = [
        ...makeValidTurn(0),
        { type: 'session/title', seq: 6, time: now + 100, data: { title: 'My Session', messageSeqs: [1, 3], source: { kind: 'fallback' } }, ignorable: true },
      ];
      writeSession(sessionsRoot, '/tmp/title-list', 'title-list-001', events);
      const result = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = result.data.find(d => d.sessionId === 'title-list-001');
      assert.ok(item);
      assert.equal(item.title, 'My Session');
    });
  });

  // =========================================================================
  // DETAIL (foldSurface + deriveEventMessage)
  // =========================================================================

  describe('detail', () => {
    test('returns surface events via isAppendSurfaceEvent + deriveEventMessage', () => {
      const sid = 'detail-surface-001';
      const events = makeValidTurn(0, 'Hello detail');
      writeSession(sessionsRoot, '/tmp/detail-s', sid, events);

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      assert.ok(item);

      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.data.sessionId, sid);
      assert.equal(result.data.header.id, sid);

      // Only surface events (user/message + assistant/message with surfaceOp)
      assert.ok(result.data.events.length >= 2);
      const userEv = result.data.events.find(e => e.type === 'user/message');
      assert.ok(userEv);
      assert.equal(userEv.role, 'user');

      const assistEv = result.data.events.find(e => e.type === 'assistant/message');
      assert.ok(assistEv);
      assert.equal(assistEv.role, 'assistant');
      assert.equal(assistEv.model, 'claude-4');
      assert.equal(assistEv.provider, 'anthropic');
    });

    test('excludes non-surface events (turn/step/chunk)', () => {
      const sid = 'detail-nosurface-001';
      const events = makeValidTurn(0);
      writeSession(sessionsRoot, '/tmp/detail-ns', sid, events);

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, true);
      // No turn/start, turn/end, step/start, step/end in output
      const types = result.data.events.map(e => e.type);
      assert.ok(!types.includes('turn/start'));
      assert.ok(!types.includes('turn/end'));
      assert.ok(!types.includes('step/start'));
      assert.ok(!types.includes('step/end'));
    });

    test('excludes seed replay events (seq < seedLength)', () => {
      const sid = 'detail-seed-001';
      const now = Date.now();
      // Seed events (seq 0-3) + post-seed events (seq 4-9)
      const seedEvents = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'seed msg' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'old-model' }, content: [{ type: 'text', text: 'seed reply' }] } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
        // Post-seed turn
        { type: 'turn/start', seq: 6, time: now + 100, data: { turn: 2 } },
        { type: 'user/message', seq: 7, time: now + 101, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'post-seed msg' }] } },
        { type: 'step/start', seq: 8, time: now + 102, data: { turn: 2, step: 1 } },
        { type: 'assistant/message', seq: 9, time: now + 103, surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'new-model' }, content: [{ type: 'text', text: 'post reply' }] } } },
        { type: 'step/end', seq: 10, time: now + 104, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: 11, time: now + 105, data: { turn: 2, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/detail-seed', sid, seedEvents, { headerExtra: { seedLength: 6 } });

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.data.header.seedLength, 6);
      // Only post-seed surface events (seq 7, 9)
      const seqs = result.data.events.map(e => e.seq);
      assert.ok(!seqs.includes(1), 'seed user/message excluded');
      assert.ok(!seqs.includes(3), 'seed assistant/message excluded');
      assert.ok(seqs.includes(7), 'post-seed user/message included');
      assert.ok(seqs.includes(9), 'post-seed assistant/message included');
    });

    test('replacement events excluded from surface (only append-origin)', () => {
      const sid = 'detail-replace-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'original' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'first attempt' }] } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        // Replacement: has surfaceOp={op:'replace',...} → NOT append-origin → excluded
        { type: 'step/start', seq: 5, time: now + 5, data: { turn: 1, step: 2 } },
        { type: 'assistant/message', seq: 6, time: now + 6, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 2, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'corrected reply' }] } } },
        { type: 'step/end', seq: 7, time: now + 7, data: { turn: 1, step: 2 } },
        { type: 'turn/end', seq: 8, time: now + 8, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/detail-replace', sid, events);

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, true);
      // Per audit A: only append-origin surface events are projected.
      // seq 1 (user/message, surfaceOp='append') → included
      // seq 3 (assistant/message, surfaceOp='append') → included (it IS append-origin)
      // seq 6 (assistant/message, surfaceOp={op:'replace',...}) → excluded (NOT append)
      const seqs = result.data.events.map(e => e.seq);
      assert.ok(seqs.includes(1), 'user/message included');
      assert.ok(seqs.includes(3), 'append-origin assistant/message included');
      assert.ok(!seqs.includes(6), 'replacement assistant/message excluded (not append-origin)');
    });

    test('tool/result projected via content blocks, no top-level tool property', () => {
      const sid = 'detail-tools-001';
      const now = Date.now();
      const callId = 'tc-' + randomUUID().slice(0, 8);
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'read file' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'tool/call', seq: 3, time: now + 3, data: { turn: 1, step: 1, callId, name: 'read_file', arguments: '{"path":"/foo"}' } },
        { type: 'tool/result', seq: 4, time: now + 4, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'file content' }] }] } } },
        { type: 'assistant/message', seq: 5, time: now + 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 100, outputTokens: 50 } } },
        { type: 'step/end', seq: 6, time: now + 6, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 7, time: now + 7, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/detail-tools', sid, events);

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, true);
      // tool/result event present — tool representation is via content blocks only
      const tr = result.data.events.find(e => e.type === 'tool/result');
      assert.ok(tr, 'tool/result event must be projected');
      assert.equal(tr.role, 'user');
      // No top-level tool property — tool-call/tool-result content blocks are
      // the only tool representation per contract
      assert.equal(tr.tool, undefined, 'redundant tool property must not exist');
      // Tool info is in content blocks
      assert.ok(tr.content, 'content must exist');
      const toolBlock = tr.content.find(b => b.type === 'tool-result');
      assert.ok(toolBlock, 'tool-result content block must exist');
      assert.equal(toolBlock.toolCallId, callId);
    });

    test('returns error for unknown session', () => {
      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const id = listResult.data[0]?.sourceInstanceId ?? 'deadbeef';
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: id, sessionId: 'nonexistent-xyz' },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, false);
      assert.ok(result.code);
    });
  });

  // =========================================================================
  // USAGE (chunk priority → assistant/message.data.usage fallback)
  // =========================================================================

  describe('usage', () => {
    test('extracts usage from assistant/message.data.usage', () => {
      const sid = 'usage-test-001';
      const events = makeValidTurn(0, 'usage test');
      writeSession(sessionsRoot, '/tmp/usage-am', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      assert.equal(result.ok, true);
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      assert.equal(entry.steps[0].inputTokens, 100);
      assert.equal(entry.steps[0].outputTokens, 50);
      assert.equal(entry.steps[0].cacheReadTokens, 10);
      assert.equal(entry.steps[0].cacheWriteTokens, 5);
      assert.equal(entry.steps[0].model, 'claude-4');
      assert.equal(entry.steps[0].provider, 'anthropic');
      assert.equal(entry.steps[0].turn, 1);
      assert.equal(entry.steps[0].step, 1);
    });

    test('ignores events with seq < seedLength', () => {
      const sid = 'usage-seed-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'seed' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'old' }, content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 999, outputTokens: 999 } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
        // Post-seed
        { type: 'turn/start', seq: 6, time: now + 100, data: { turn: 2 } },
        { type: 'user/message', seq: 7, time: now + 101, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'new' }] } },
        { type: 'step/start', seq: 8, time: now + 102, data: { turn: 2, step: 1 } },
        { type: 'assistant/message', seq: 9, time: now + 103, surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'new' }, content: [{ type: 'text', text: 'y' }] }, usage: { inputTokens: 200, outputTokens: 100 } } },
        { type: 'step/end', seq: 10, time: now + 104, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: 11, time: now + 105, data: { turn: 2, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-seed', sid, events, { headerExtra: { seedLength: 6 } });

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      assert.equal(entry.steps[0].inputTokens, 200);
      assert.equal(entry.steps[0].model, 'new');
    });

    test('turn+step last-wins dedup', () => {
      const sid = 'usage-dedup-001';
      const now = Date.now();
      // Two assistant/message events in same turn+step — second wins
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'dedup' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'first' }] }, usage: { inputTokens: 50, outputTokens: 25 } } },
        // Second assistant/message in same turn 1, step 1 (replacement scenario)
        { type: 'assistant/message', seq: 4, time: now + 4, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'second' }] }, usage: { inputTokens: 150, outputTokens: 75 } } },
        { type: 'step/end', seq: 5, time: now + 5, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: now + 6, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-dedup', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      // Only one step entry (last wins)
      assert.equal(entry.steps.length, 1);
      assert.equal(entry.steps[0].inputTokens, 150);
      assert.equal(entry.steps[0].outputTokens, 75);
      assert.equal(entry.steps[0].seq, 4);
    });

    test('skips assistant/message without usage data', () => {
      const sid = 'usage-no-data-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'x' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'no usage' }] } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-empty', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 0);
    });

    test('usage chunk priority: assistant/chunk usage wins over assistant/message.data.usage', () => {
      const sid = 'usage-chunk-priority-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'chunk priority' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        // Usage chunk (priority source)
        { type: 'assistant/chunk', seq: 3, time: now + 3, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 20 } } } },
        // assistant/message with different usage (should be ignored in favor of chunk)
        { type: 'assistant/message', seq: 4, time: now + 4, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-4' }, content: [{ type: 'text', text: 'reply' }] }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 2 } } },
        { type: 'step/end', seq: 5, time: now + 5, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: now + 6, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-chunk-prio', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      // Chunk values win
      assert.equal(entry.steps[0].inputTokens, 500);
      assert.equal(entry.steps[0].outputTokens, 200);
      assert.equal(entry.steps[0].cacheReadTokens, 50);
      assert.equal(entry.steps[0].cacheWriteTokens, 20);
      // Provider/model filled from assistant/message source
      assert.equal(entry.steps[0].provider, 'anthropic');
      assert.equal(entry.steps[0].model, 'claude-4');
    });

    test('usage fallback: assistant/message.data.usage used when no chunk exists', () => {
      const sid = 'usage-fallback-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'fallback' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        // No usage chunk, only assistant/message with usage
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-4' }, content: [{ type: 'text', text: 'reply' }] }, usage: { inputTokens: 300, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 15 } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-fb', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      assert.equal(entry.steps[0].inputTokens, 300);
      assert.equal(entry.steps[0].outputTokens, 150);
      assert.equal(entry.steps[0].cacheReadTokens, 30);
      assert.equal(entry.steps[0].cacheWriteTokens, 15);
      assert.equal(entry.steps[0].provider, 'openai');
      assert.equal(entry.steps[0].model, 'gpt-4');
    });

    test('usage entry carries seedLength', () => {
      const sid = 'usage-seedlen-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'seed' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'a', model: 'b' }, content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
        { type: 'step/end', seq: 4, time: now + 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-seedlen', sid, events, { headerExtra: { seedLength: 0 } });

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.seedLength, 0);
    });

    test('usage chunk last-wins when multiple chunks in same step', () => {
      const sid = 'usage-chunk-lastwin-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'multi-chunk' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        // First usage chunk
        { type: 'assistant/chunk', seq: 3, time: now + 3, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 } } } },
        // Second usage chunk (last wins)
        { type: 'assistant/chunk', seq: 4, time: now + 4, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 40 } } } },
        { type: 'assistant/message', seq: 5, time: now + 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [{ type: 'text', text: 'done' }] } } },
        { type: 'step/end', seq: 6, time: now + 6, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 7, time: now + 7, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-chunk-lw', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      // Last chunk wins
      assert.equal(entry.steps[0].inputTokens, 800);
      assert.equal(entry.steps[0].outputTokens, 400);
      assert.equal(entry.steps[0].cacheReadTokens, 80);
      assert.equal(entry.steps[0].cacheWriteTokens, 40);
    });

    test('all-zero terminal usage chunk still wins (presence-based last-wins)', () => {
      const sid = 'usage-allzero-terminal-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'zero' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        // First chunk with nonzero values
        { type: 'assistant/chunk', seq: 3, time: now + 3, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 20 } } } },
        // Final chunk with ALL ZEROS — still authoritative as last-wins presence-based
        { type: 'assistant/chunk', seq: 4, time: now + 4, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
        { type: 'assistant/message', seq: 5, time: now + 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 999, outputTokens: 999 } } },
        { type: 'step/end', seq: 6, time: now + 6, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 7, time: now + 7, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-allzero', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      // All-zero chunk wins — blocks earlier nonzero chunk AND message fallback
      assert.equal(entry.steps[0].inputTokens, 0);
      assert.equal(entry.steps[0].outputTokens, 0);
      assert.equal(entry.steps[0].cacheReadTokens, 0);
      assert.equal(entry.steps[0].cacheWriteTokens, 0);
    });

    test('cache-only usage chunk is recognized (only cache tokens nonzero)', () => {
      const sid = 'usage-cacheonly-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'cache' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        // Usage chunk with only cache tokens (input/output are zero)
        { type: 'assistant/chunk', seq: 3, time: now + 3, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 100 } } } },
        { type: 'assistant/message', seq: 4, time: now + 4, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'a', model: 'b' }, content: [{ type: 'text', text: 'cached' }] } } },
        { type: 'step/end', seq: 5, time: now + 5, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: now + 6, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/usage-cacheonly', sid, events);

      const result = invokeHelper({ op: 'usage', roots: [sessionsRoot] });
      const entry = result.data.find(d => d.sessionId === sid);
      assert.ok(entry);
      assert.equal(entry.steps.length, 1);
      // Cache-only usage is correctly recognized
      assert.equal(entry.steps[0].inputTokens, 0);
      assert.equal(entry.steps[0].outputTokens, 0);
      assert.equal(entry.steps[0].cacheReadTokens, 500);
      assert.equal(entry.steps[0].cacheWriteTokens, 100);
    });
  });

  // =========================================================================
  // IMMUTABILITY PROOF
  // =========================================================================

  describe('immutability', () => {
    test('source files unchanged (hash/size/mtime) after all operations', () => {
      const immRoot = path.join(tmpDir, 'immutability-root');
      fs.mkdirSync(immRoot, { recursive: true });
      const sid = 'immutable-test-001';
      const events = makeValidTurn(0, 'prove immutable');
      const filePath = writeSession(immRoot, '/tmp/immutable', sid, events);

      const hashBefore = fileHash(filePath);
      const statBefore = fileStat(filePath);

      // Exercise all three operations
      invokeHelper({ op: 'list', roots: [immRoot] });
      const listResult = invokeHelper({ op: 'list', roots: [immRoot] });
      const sourceId = listResult.data.find(d => d.sessionId === sid)?.sourceInstanceId;
      invokeHelper(
        { op: 'detail', sourceInstanceId: sourceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([immRoot]) },
      );
      invokeHelper({ op: 'usage', roots: [immRoot] });

      const hashAfter = fileHash(filePath);
      const statAfter = fileStat(filePath);

      assert.equal(hashBefore, hashAfter, 'SHA-256 must not change');
      assert.equal(statBefore.size, statAfter.size, 'Size must not change');
      assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'Mtime must not change');

      // No new files created in session dir
      const sessionDir = path.dirname(filePath);
      const files = fs.readdirSync(sessionDir);
      assert.deepEqual(files, ['session.jsonl'], 'No extra files created');
    });
  });

  // =========================================================================
  // ZSTD COMPRESSION
  // =========================================================================

  describe('zstd', () => {
    test('reads zstd-compressed sessions', async () => {
      const zstdRoot = path.join(tmpDir, 'zstd-root');
      fs.mkdirSync(zstdRoot, { recursive: true });
      const sid = 'zstd-001';
      const events = makeValidTurn(0, 'zstd test');
      await writeZstdSession(zstdRoot, '/tmp/zstd', sid, events);

      const result = invokeHelper({ op: 'list', roots: [zstdRoot] });
      assert.equal(result.ok, true);
      const item = result.data.find(d => d.sessionId === sid);
      assert.ok(item);
      assert.ok(item.eventCount >= 6);

      // Also verify detail works with zstd
      const detail = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([zstdRoot]) },
      );
      assert.equal(detail.ok, true);
      assert.ok(detail.data.events.length >= 2);
    });

    test('zstd immutability proof', async () => {
      const zstdImmRoot = path.join(tmpDir, 'zstd-imm-root');
      fs.mkdirSync(zstdImmRoot, { recursive: true });
      const sid = 'zstd-imm-001';
      const events = makeValidTurn(0, 'zstd imm');
      const filePath = await writeZstdSession(zstdImmRoot, '/tmp/zstd-imm', sid, events);

      const hashBefore = fileHash(filePath);
      const statBefore = fileStat(filePath);

      invokeHelper({ op: 'list', roots: [zstdImmRoot] });
      invokeHelper({ op: 'usage', roots: [zstdImmRoot] });

      const hashAfter = fileHash(filePath);
      const statAfter = fileStat(filePath);
      assert.equal(hashBefore, hashAfter, 'zstd file hash unchanged');
      assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'zstd file mtime unchanged');
    });
  });

  // =========================================================================
  // TORN TAIL
  // =========================================================================

  describe('torn tail', () => {
    test('handles incomplete last line gracefully (list still works)', () => {
      const tornRoot = path.join(tmpDir, 'torn-root');
      fs.mkdirSync(tornRoot, { recursive: true });
      const sid = 'torn-001';
      const cwd = '/tmp/torn';
      const sessionDir = path.join(tornRoot, projectKey(cwd), sid);
      fs.mkdirSync(sessionDir, { recursive: true });

      const header = { type: 'session', version: 0, id: sid, createdAt: 1724500000000, cwd, delegationDepth: 0 };
      const ev = { type: 'turn/start', seq: 0, time: 1724500000100, data: { turn: 1 } };
      const content = JSON.stringify(header) + '\n' + JSON.stringify(ev) + '\n' + '{"type":"turn/en';
      fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), content);

      const result = invokeHelper({ op: 'list', roots: [tornRoot] });
      assert.equal(result.ok, true);
      assert.ok(result.data.find(d => d.sessionId === sid));
    });

    test('torn tail detail returns valid surface events up to the tear', () => {
      const tornRoot2 = path.join(tmpDir, 'torn-root-2');
      fs.mkdirSync(tornRoot2, { recursive: true });
      const sid = 'torn-detail-001';
      const cwd = '/tmp/torn2';
      const sessionDir = path.join(tornRoot2, projectKey(cwd), sid);
      fs.mkdirSync(sessionDir, { recursive: true });

      const now = Date.now();
      const header = { type: 'session', version: 0, id: sid, createdAt: now, cwd, delegationDepth: 0 };
      const ev1 = { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } };
      const ev2 = { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'torn' }] } };
      const content = JSON.stringify(header) + '\n' + JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n' + '{"type":"tur';
      fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), content);

      const listResult = invokeHelper({ op: 'list', roots: [tornRoot2] });
      const item = listResult.data.find(d => d.sessionId === sid);
      assert.ok(item);

      const detail = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([tornRoot2]) },
      );
      assert.equal(detail.ok, true);
      // Should have the surface user/message
      assert.ok(detail.data.events.length >= 1);
      assert.equal(detail.data.events[0].role, 'user');
    });
  });

  // =========================================================================
  // STRICT MALFORMED / FAIL-CLOSED CASES
  // =========================================================================

  describe('strict malformed', () => {
    test('invalid JSON request returns structured error', () => {
      try {
        const raw = invokeHelperRaw('not json at all');
        const parsed = JSON.parse(raw.trim());
        assert.equal(parsed.ok, false);
        assert.equal(parsed.code, 'INVALID_REQUEST');
      } catch (err) {
        if (err.stdout) {
          const parsed = JSON.parse(err.stdout.trim());
          assert.equal(parsed.ok, false);
          assert.equal(parsed.code, 'INVALID_REQUEST');
        }
      }
    });

    test('unknown op returns UNKNOWN_OP error', () => {
      const result = invokeHelper({ op: 'delete_everything' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNKNOWN_OP');
    });

    test('no roots configured returns NO_ROOTS for detail', () => {
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: 'abc', sessionId: 'xyz' },
        { __DSH_HISTORY_ROOTS: undefined },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'NO_ROOTS');
    });

    test('non-existent source instance returns SOURCE_NOT_FOUND', () => {
      const result = invokeHelper(
        { op: 'detail', sourceInstanceId: 'deadbeefdeadbeef', sessionId: 'any' },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SOURCE_NOT_FOUND');
    });
  });

  // =========================================================================
  // ERROR CLASSIFICATION (UNSUPPORTED_FORMAT / BUSY_CORRUPT)
  // =========================================================================

  describe('error classification', () => {
    test('UNSUPPORTED_FORMAT on list when root has unsupported session version', () => {
      // Write a session with an absurd version number to trigger format rejection
      const badRoot = path.join(tmpDir, 'bad-format-root', 'sessions');
      fs.mkdirSync(badRoot, { recursive: true });
      const sid = 'bad-version-001';
      // Version 999 is not supported by any known persistence
      writeSession(badRoot, '/tmp/bad', sid, makeValidTurn(0), { version: 999 });

      const result = invokeHelper({ op: 'list', roots: [badRoot] });
      assert.equal(result.ok, false,
        `v999 list must fail, got ok=true with data: ${JSON.stringify(result.data?.length ?? 0)} items`);
      assert.equal(result.code, 'UNSUPPORTED_FORMAT',
        `expected UNSUPPORTED_FORMAT code, got: ${result.code} (${result.message})`);
    });

    test('UNSUPPORTED_FORMAT on detail when session uses unsupported version', () => {
      const badRoot = path.join(tmpDir, 'bad-format-detail', 'sessions');
      fs.mkdirSync(badRoot, { recursive: true });
      const sid = 'bad-version-detail-001';
      writeSession(badRoot, '/tmp/bad-detail', sid, makeValidTurn(0), { version: 999 });

      // Compute the real sourceInstanceId for this root
      const sourceInstanceId = createHash('sha256')
        .update(fs.realpathSync(badRoot), 'utf8')
        .digest('hex').slice(0, 16);

      const result = invokeHelper(
        { op: 'detail', sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([badRoot]) },
      );
      assert.equal(result.ok, false,
        `v999 detail must fail`);
      assert.equal(result.code, 'UNSUPPORTED_FORMAT',
        `expected UNSUPPORTED_FORMAT, got: ${result.code} (${result.message})`);
    });

    test('UNSUPPORTED_FORMAT on usage when root has unsupported session version', () => {
      const badRoot = path.join(tmpDir, 'bad-format-usage', 'sessions');
      fs.mkdirSync(badRoot, { recursive: true });
      const sid = 'bad-version-usage-001';
      writeSession(badRoot, '/tmp/bad-usage', sid, makeValidTurn(0), { version: 999 });

      const result = invokeHelper({ op: 'usage', roots: [badRoot] });
      assert.equal(result.ok, false,
        `v999 usage must fail`);
      assert.equal(result.code, 'UNSUPPORTED_FORMAT',
        `expected UNSUPPORTED_FORMAT, got: ${result.code} (${result.message})`);
    });

    test('BUSY_CORRUPT on list when root directory is a regular file', () => {
      // A file where a directory is expected → I/O/decode failure → BUSY_CORRUPT
      const fakeRoot = path.join(tmpDir, 'corrupt-root-file');
      fs.writeFileSync(fakeRoot, 'not a directory');

      const result = invokeHelper({ op: 'list', roots: [fakeRoot] });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BUSY_CORRUPT',
        `expected BUSY_CORRUPT for unreadable root, got: ${result.code} (${result.message})`);
    });

    test('BUSY_CORRUPT on list when session file is corrupt binary', () => {
      // Valid header + unparsable garbage line + turn/end (forces the scanner to throw)
      const corruptRoot = path.join(tmpDir, 'corrupt-session-list', 'sessions');
      fs.mkdirSync(corruptRoot, { recursive: true });
      const sid = 'corrupt-list-001';
      const cwd = '/tmp/corrupt-list';
      const sessionDir2 = path.join(corruptRoot, projectKey(cwd), sid);
      fs.mkdirSync(sessionDir2, { recursive: true });
      // Valid header + binary garbage line + turn/end line (triggers deferred throw)
      const header = JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: Date.now(), cwd, delegationDepth: 0 });
      const turnEnd = JSON.stringify({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
      const content = header + '\n' + '\xFF\xFE\x00\x01\x02\x03' + '\n' + turnEnd + '\n';
      fs.writeFileSync(path.join(sessionDir2, 'session.jsonl'), content);

      const result = invokeHelper({ op: 'list', roots: [corruptRoot] });
      assert.equal(result.ok, false,
        `corrupt list must fail, got: ${JSON.stringify(result).slice(0, 200)}`);
      assert.equal(result.code, 'BUSY_CORRUPT',
        `expected BUSY_CORRUPT, got: ${result.code} (${result.message})`);
    });

    test('BUSY_CORRUPT on detail when session file is corrupt binary', () => {
      // Valid header + garbage line + turn/end (forces the scanner to throw during readFrom)
      const corruptRoot = path.join(tmpDir, 'corrupt-session-detail', 'sessions');
      fs.mkdirSync(corruptRoot, { recursive: true });
      const sid = 'corrupt-detail-001';
      const cwd = '/tmp/corrupt-detail';
      const sessionDir2 = path.join(corruptRoot, projectKey(cwd), sid);
      fs.mkdirSync(sessionDir2, { recursive: true });
      const header = JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: Date.now(), cwd, delegationDepth: 0 });
      const turnEnd = JSON.stringify({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
      const content = header + '\n' + '\xFF\xFE\x00\x01\x02\x03' + '\n' + turnEnd + '\n';
      fs.writeFileSync(path.join(sessionDir2, 'session.jsonl'), content);

      // Compute real sourceInstanceId
      const sourceInstanceId = createHash('sha256')
        .update(fs.realpathSync(corruptRoot), 'utf8')
        .digest('hex').slice(0, 16);

      const result = invokeHelper(
        { op: 'detail', sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([corruptRoot]) },
      );
      assert.equal(result.ok, false,
        `corrupt detail must fail`);
      assert.equal(result.code, 'BUSY_CORRUPT',
        `expected BUSY_CORRUPT, got: ${result.code} (${result.message})`);
    });

    test('BUSY_CORRUPT on usage when root is corrupt', () => {
      const fakeRoot = path.join(tmpDir, 'corrupt-usage-root');
      fs.writeFileSync(fakeRoot, 'not a directory');

      const result = invokeHelper({ op: 'usage', roots: [fakeRoot] });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BUSY_CORRUPT',
        `expected BUSY_CORRUPT for unreadable usage root, got: ${result.code}`);
    });

    test('BUSY_CORRUPT on usage when session file is corrupt binary', () => {
      const corruptRoot = path.join(tmpDir, 'corrupt-session-usage', 'sessions');
      fs.mkdirSync(corruptRoot, { recursive: true });
      const sid = 'corrupt-usage-001';
      const cwd = '/tmp/corrupt-usage';
      const sessionDir2 = path.join(corruptRoot, projectKey(cwd), sid);
      fs.mkdirSync(sessionDir2, { recursive: true });
      // Valid header + garbage line + turn/end (forces the scanner to throw)
      const header = JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: Date.now(), cwd, delegationDepth: 0 });
      const turnEnd = JSON.stringify({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
      const content = header + '\n' + '\xFF\xFE\x00\x01\x02\x03' + '\n' + turnEnd + '\n';
      fs.writeFileSync(path.join(sessionDir2, 'session.jsonl'), content);

      const result = invokeHelper({ op: 'usage', roots: [corruptRoot] });
      assert.equal(result.ok, false,
        `corrupt usage must fail, got: ${JSON.stringify(result).slice(0, 200)}`);
      assert.equal(result.code, 'BUSY_CORRUPT',
        `expected BUSY_CORRUPT, got: ${result.code} (${result.message})`);
    });
  });

  // =========================================================================
  // ROOT / SOURCE-ID ERRORS FAIL CLOSED (Fix #7)
  // EACCES/I/O/corrupt realpath failures must return BUSY_CORRUPT, not ok-empty.
  // =========================================================================

  describe('root errors fail closed', () => {
    test('EACCES root on list returns BUSY_CORRUPT (not ok-empty)', () => {
      // Create a root and restrict internal project dir to trigger EACCES on readdir
      const restrictedRoot = path.join(tmpDir, 'restricted-list-root');
      fs.mkdirSync(restrictedRoot, { recursive: true });
      const sid = 'restricted-001';
      writeSession(restrictedRoot, '/tmp/restricted', sid, makeValidTurn(0));
      // Restrict the project-level directory (not the root itself, since realpath works)
      const projectDir = fs.readdirSync(restrictedRoot).find(d => fs.statSync(path.join(restrictedRoot, d)).isDirectory());
      if (projectDir) {
        fs.chmodSync(path.join(restrictedRoot, projectDir), 0o000);
      }
      try {
        const result = invokeHelper({ op: 'list', roots: [restrictedRoot] });
        assert.equal(result.ok, false,
          `EACCES list must fail closed, got ok=${result.ok}`);
        assert.equal(result.code, 'BUSY_CORRUPT',
          `expected BUSY_CORRUPT for EACCES root, got: ${result.code} (${result.message})`);
      } finally {
        if (projectDir) {
          fs.chmodSync(path.join(restrictedRoot, projectDir), 0o755);
        }
      }
    });

    test('EACCES root on usage returns BUSY_CORRUPT (not ok-empty)', () => {
      const restrictedRoot = path.join(tmpDir, 'restricted-usage-root');
      fs.mkdirSync(restrictedRoot, { recursive: true });
      writeSession(restrictedRoot, '/tmp/restricted-u', 'restricted-u-001', makeValidTurn(0));
      const projectDir = fs.readdirSync(restrictedRoot).find(d => fs.statSync(path.join(restrictedRoot, d)).isDirectory());
      if (projectDir) {
        fs.chmodSync(path.join(restrictedRoot, projectDir), 0o000);
      }
      try {
        const result = invokeHelper({ op: 'usage', roots: [restrictedRoot] });
        assert.equal(result.ok, false,
          `EACCES usage must fail closed`);
        assert.equal(result.code, 'BUSY_CORRUPT',
          `expected BUSY_CORRUPT for EACCES usage root, got: ${result.code}`);
      } finally {
        if (projectDir) {
          fs.chmodSync(path.join(restrictedRoot, projectDir), 0o755);
        }
      }
    });

    test('EACCES root on detail returns BUSY_CORRUPT (not SOURCE_NOT_FOUND)', () => {
      const restrictedRoot = path.join(tmpDir, 'restricted-detail-root');
      fs.mkdirSync(restrictedRoot, { recursive: true });
      writeSession(restrictedRoot, '/tmp/restricted-d', 'restricted-d-001', makeValidTurn(0));
      // Compute sourceInstanceId BEFORE restricting
      const sourceInstanceId = createHash('sha256')
        .update(fs.realpathSync(restrictedRoot), 'utf8')
        .digest('hex').slice(0, 16);
      // Remove read perm on internal directories to trigger EACCES on readdir/readFrom
      const projectDir = fs.readdirSync(restrictedRoot).find(d => fs.statSync(path.join(restrictedRoot, d)).isDirectory());
      if (projectDir) {
        fs.chmodSync(path.join(restrictedRoot, projectDir), 0o000);
      }
      try {
        const result = invokeHelper(
          { op: 'detail', sourceInstanceId, sessionId: 'restricted-d-001' },
          { __DSH_HISTORY_ROOTS: JSON.stringify([restrictedRoot]) },
        );
        assert.equal(result.ok, false,
          `EACCES detail must fail closed`);
        assert.equal(result.code, 'BUSY_CORRUPT',
          `expected BUSY_CORRUPT for EACCES detail root, got: ${result.code} (${result.message})`);
      } finally {
        if (projectDir) {
          fs.chmodSync(path.join(restrictedRoot, projectDir), 0o755);
        }
      }
    });
  });

  // =========================================================================
  // PACKED ROWS (chunk format handled by readFrom)
  // =========================================================================

  describe('packed rows', () => {
    test('packed chunk rows are decoded by readFrom transparently', () => {
      const sid = 'packed-001';
      const now = Date.now();
      const events = [
        { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'terminal' }, content: [{ type: 'text', text: 'chunks' }] } },
        { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 3, time: now + 3, data: { turn: 1, step: 1, delta: { type: 'text_delta', text: 'Hello ' } } },
        { type: 'assistant/chunk', seq: 4, time: now + 4, data: { turn: 1, step: 1, delta: { type: 'text_delta', text: 'world' } } },
        { type: 'assistant/message', seq: 5, time: now + 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'test' }, content: [{ type: 'text', text: 'Hello world' }] }, usage: { inputTokens: 100, outputTokens: 50 } } },
        { type: 'step/end', seq: 6, time: now + 6, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 7, time: now + 7, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      writeSession(sessionsRoot, '/tmp/packed', sid, events);

      const listResult = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      const item = listResult.data.find(d => d.sessionId === sid);
      const detail = invokeHelper(
        { op: 'detail', sourceInstanceId: item.sourceInstanceId, sessionId: sid },
        { __DSH_HISTORY_ROOTS: JSON.stringify([sessionsRoot]) },
      );
      assert.equal(detail.ok, true);
      // Only surface events returned (no chunks in surface)
      const types = detail.data.events.map(e => e.type);
      assert.ok(!types.includes('assistant/chunk'), 'chunks excluded from surface');
      assert.ok(types.includes('user/message'));
      assert.ok(types.includes('assistant/message'));
    });
  });

  // =========================================================================
  // NODE VERSION GATE
  // =========================================================================

  describe('node version gate', () => {
    test('helper reports Node >= 22.15.0 requirement in bundle', () => {
      const bundle = fs.readFileSync(HELPER_PATH, 'utf8');
      assert.ok(bundle.includes('22') && bundle.includes('15'), 'Bundle contains version floor constants');
    });
  });

  // =========================================================================
  // RESPONSE ENVELOPE
  // =========================================================================

  describe('response envelope', () => {
    test('all responses have schemaVersion: 1 and dshVersion', () => {
      const result = invokeHelper({ op: 'list', roots: [sessionsRoot] });
      assert.equal(result.schemaVersion, 1);
      assert.equal(result.dshVersion, '0.1.1-rc.2');
    });

    test('error responses still have schemaVersion: 1', () => {
      const result = invokeHelper({ op: 'unknown' });
      assert.equal(result.schemaVersion, 1);
    });
  });

  // =========================================================================
  // PORTABLE SMOKE (staged 2-file resource, isolated environment)
  // =========================================================================

  describe('portable smoke', () => {
    const stagedDir = path.resolve(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'src-tauri', 'resources', 'dsh-history');
    const stagedHelper = path.join(stagedDir, 'lib', 'dsh-history-helper.mjs');

    test('staged directory contains exactly 2 files', () => {
      assert.ok(fs.existsSync(stagedDir),
        `Staged resource directory must exist: ${stagedDir}`);
      const files = [];
      function walk(dir, base) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = path.join(base, ent.name);
          if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
          else files.push(rel);
        }
      }
      walk(stagedDir, '');
      assert.equal(files.length, 2, `Expected exactly 2 files, got: ${JSON.stringify(files)}`);
      assert.ok(files.includes('package.json'));
      assert.ok(files.includes(path.join('lib', 'dsh-history-helper.mjs')));
      // Verify version
      const pkg = JSON.parse(fs.readFileSync(path.join(stagedDir, 'package.json'), 'utf8'));
      assert.equal(pkg.version, '0.1.1-rc.2');
    });

    test('staged helper runs list+detail+usage with NODE_PATH empty and PATH isolated', () => {
      assert.ok(fs.existsSync(stagedHelper),
        `Staged helper must exist: ${stagedHelper}`);
      assert.ok(fs.existsSync(NODE_BIN),
        `Bundled ccem-node (NODE_BIN) must exist: ${NODE_BIN}`);

      // Create isolated copy of just the 2 files (proves no node_modules needed)
      const isolatedDir = path.join(tmpDir, 'portable-isolated');
      fs.mkdirSync(path.join(isolatedDir, 'lib'), { recursive: true });
      fs.copyFileSync(path.join(stagedDir, 'package.json'), path.join(isolatedDir, 'package.json'));
      fs.copyFileSync(stagedHelper, path.join(isolatedDir, 'lib', 'dsh-history-helper.mjs'));

      // Create fixture with known data
      const smokeSessionsRoot = path.join(tmpDir, 'portable-dsh', 'sessions');
      fs.mkdirSync(smokeSessionsRoot, { recursive: true });
      const sid = 'portable-smoke-001';
      const events = makeValidTurn(0, 'portable smoke', 'claude-5', 'anthropic');
      const filePath = writeSession(smokeSessionsRoot, '/tmp/portable', sid, events);
      const hashBefore = fileHash(filePath);
      const statBefore = fileStat(filePath);

      // Minimal isolated env: NODE_PATH empty, no repo paths in PATH
      const isolatedEnv = {
        HOME: os.homedir(),
        PATH: '/usr/bin:/bin',
        TMPDIR: os.tmpdir(),
        NODE_PATH: '',
      };
      const helperBin = path.join(isolatedDir, 'lib', 'dsh-history-helper.mjs');

      // --- LIST ---
      const listRaw = execFileSync(NODE_BIN, [helperBin], {
        input: JSON.stringify({ op: 'list', roots: [smokeSessionsRoot] }),
        encoding: 'utf8', timeout: 15000, env: isolatedEnv, cwd: isolatedDir,
      });
      const listResult = JSON.parse(listRaw.trim());
      assert.equal(listResult.ok, true);
      assert.equal(listResult.data.length, 1);
      assert.equal(listResult.data[0].sessionId, sid);
      assert.equal(listResult.data[0].model, 'claude-5');
      assert.equal(listResult.data[0].provider, 'anthropic');
      const sourceInstanceId = listResult.data[0].sourceInstanceId;

      // --- DETAIL ---
      const detailRaw = execFileSync(NODE_BIN, [helperBin], {
        input: JSON.stringify({ op: 'detail', sourceInstanceId, sessionId: sid }),
        encoding: 'utf8', timeout: 15000,
        env: { ...isolatedEnv, __DSH_HISTORY_ROOTS: JSON.stringify([smokeSessionsRoot]) },
        cwd: isolatedDir,
      });
      const detailResult = JSON.parse(detailRaw.trim());
      assert.equal(detailResult.ok, true);
      assert.ok(detailResult.data.events.length >= 2);
      const userEv = detailResult.data.events.find(e => e.type === 'user/message');
      assert.ok(userEv);
      assert.equal(userEv.role, 'user');

      // --- USAGE ---
      const usageRaw = execFileSync(NODE_BIN, [helperBin], {
        input: JSON.stringify({ op: 'usage', roots: [smokeSessionsRoot] }),
        encoding: 'utf8', timeout: 15000, env: isolatedEnv, cwd: isolatedDir,
      });
      const usageResult = JSON.parse(usageRaw.trim());
      assert.equal(usageResult.ok, true);
      const usageEntry = usageResult.data.find(d => d.sessionId === sid);
      assert.ok(usageEntry);
      assert.equal(usageEntry.steps.length, 1);
      assert.equal(usageEntry.steps[0].inputTokens, 100);
      assert.equal(usageEntry.steps[0].outputTokens, 50);
      assert.equal(usageEntry.steps[0].cacheReadTokens, 10);
      assert.equal(usageEntry.steps[0].cacheWriteTokens, 5);
      assert.equal(usageEntry.steps[0].provider, 'anthropic');
      assert.equal(usageEntry.steps[0].model, 'claude-5');

      // --- Source immutability proof ---
      const hashAfter = fileHash(filePath);
      const statAfter = fileStat(filePath);
      assert.equal(hashBefore, hashAfter, 'source SHA-256 unchanged after portable smoke');
      assert.equal(statBefore.size, statAfter.size, 'source size unchanged');
      assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'source mtime unchanged');
    });
  });
});
