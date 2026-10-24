import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { setTimeout } from 'node:timers/promises';
import express from 'express';

test('Express JSON parser survives trailing bytes after a compressed body', { timeout: 5000 }, async (t) => {
  // Exercise the body-parser version resolved by our production Express graph.
  // GHSA-27r3-jxmh-p828 used to emit an uncaught decoder error after responding.
  const app = express();
  app.use(express.json());
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');

  const payload = { message: 'parser smoke' };
  const body = Buffer.concat([
    gzipSync(JSON.stringify(payload)),
    Buffer.from([0]),
    Buffer.alloc(100 * 1024, 0x58),
  ]);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/echo', method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': body.length,
      },
    }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Parser request timed out')));
    request.end(body);
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, payload);
  // The old decoder error arrived asynchronously after the valid response.
  await setTimeout(200);
  const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});
