import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_DIR = path.join(ROOT, 'server');

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const requestJson = (port, pathname, options = {}) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    method: 'GET',
    headers: options.headers,
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      body += chunk;
    });
    res.on('end', () => {
      let json;
      try {
        json = body ? JSON.parse(body) : null;
      } catch (error) {
        reject(new Error(`Response was not JSON: ${error.message}\n${body}`));
        return;
      }
      resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
    });
  });
  req.on('error', reject);
  req.end();
});

const waitForHealth = async (port) => {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(port, '/health');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error('Timed out waiting for server health');
};

const withServer = async (t, callback) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-server-test-'));
  const keys = {
    test_key: {
      environments: ['dev'],
    },
  };
  const environments = {
    dev: {
      ANTHROPIC_BASE_URL: 'https://example.test',
      ANTHROPIC_AUTH_TOKEN: 'sk-placeholder-do-not-use',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-test',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-test',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-test',
    },
  };

  writeJson(path.join(tempDir, 'keys.json'), keys);
  writeJson(path.join(tempDir, 'environments.json'), environments);
  fs.copyFileSync(path.join(SERVER_DIR, 'index.js'), path.join(tempDir, 'index.js'));
  fs.symlinkSync(path.join(SERVER_DIR, 'node_modules'), path.join(tempDir, 'node_modules'));

  const port = 31000 + (process.pid % 10000);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: tempDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(port);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\nServer logs:\n${logs.join('')}`);
  }

  return callback(port);
};

test('remote config server preserves health and key authentication behavior', async (t) => {
  await withServer(t, async (port) => {
    const health = await requestJson(port, '/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    const missingKey = await requestJson(port, '/api/env');
    assert.equal(missingKey.statusCode, 400);
    assert.deepEqual(missingKey.body, { error: 'Missing key parameter' });

    const validKey = await requestJson(port, '/api/env', {
      headers: {
        'X-CCEM-Key': 'test_key',
      },
    });
    assert.equal(validKey.statusCode, 200);
    assert.equal(typeof validKey.body.encrypted, 'string');
    assert.ok(validKey.body.encrypted.length > 0);

    const invalidKey = await requestJson(port, '/api/env', {
      headers: {
        'X-CCEM-Key': 'wrong_key',
      },
    });
    assert.equal(invalidKey.statusCode, 401);
    assert.deepEqual(invalidKey.body, { error: 'Invalid key' });
  });
});
