import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importBrowserMcpModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-mcp-test-'));
  const outfile = path.join(tempDir, 'browserMcp.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'browserMcp.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function registeredToolNames(server) {
  return Object.keys(server.instance?._registeredTools ?? {}).sort();
}

test('browser MCP keeps a stable tool surface and enforces hot permission changes', async () => {
  const {
    browserToolNamesForPermissionMode,
    createCcemBrowserMcpServer,
  } = await importBrowserMcpModule();

  const readTools = [
    'get_url',
    'read_console_log',
    'read_network_log',
    'screenshot',
    'snapshot',
  ];
  const allTools = browserToolNamesForPermissionMode('dev').sort();

  for (const mode of ['readonly', 'audit', 'plan', 'safe', 'ci']) {
    assert.deepEqual(browserToolNamesForPermissionMode(mode).sort(), readTools);
    assert.deepEqual(registeredToolNames(createCcemBrowserMcpServer(mode, async () => ({}))), allTools);
  }
  assert.deepEqual(browserToolNamesForPermissionMode('custom').sort(), readTools);

  let mode = 'readonly';
  const requests = [];
  const server = createCcemBrowserMcpServer(
    () => mode,
    async (toolName, args) => {
      requests.push({ toolName, args });
      return { ok: true };
    },
  );
  const navigate = server.instance._registeredTools.navigate.handler;
  await assert.rejects(
    navigate({ url: 'https://example.com' }),
    /blocked by current permission mode readonly/,
  );
  assert.equal(requests.length, 0);

  mode = 'dev';
  await navigate({ url: 'https://example.com' });
  assert.deepEqual(requests, [{ toolName: 'navigate', args: { url: 'https://example.com' } }]);
});

test('browser MCP exposes interactive tools for development modes', async () => {
  const {
    browserToolNamesForPermissionMode,
    browserMcpToolNamesForPermissionMode,
    createCcemBrowserMcpServer,
    ensureBrowserMcpToolsAllowed,
    isBrowserEvaluateToolName,
  } = await importBrowserMcpModule();

  const devTools = browserToolNamesForPermissionMode('dev');
  assert.ok(devTools.includes('navigate'));
  assert.ok(devTools.includes('click'));
  assert.ok(devTools.includes('type'));
  assert.ok(devTools.includes('evaluate'));
  assert.equal(isBrowserEvaluateToolName('mcp__ccem-browser__evaluate'), true);
  assert.equal(isBrowserEvaluateToolName('mcp__ccem-browser__snapshot'), false);
  assert.ok(browserMcpToolNamesForPermissionMode('dev').includes('mcp__ccem-browser__navigate'));
  const readonlyAllowed = ensureBrowserMcpToolsAllowed(
    ['Read', 'mcp__ccem-browser__snapshot'],
    'readonly',
  );
  assert.ok(readonlyAllowed?.includes('mcp__ccem-browser__get_url'));
  assert.equal(readonlyAllowed?.includes('mcp__ccem-browser__evaluate'), false);
  assert.equal(
    ensureBrowserMcpToolsAllowed(['Read'], 'dev')?.includes('mcp__ccem-browser__evaluate'),
    false,
  );
  assert.ok(ensureBrowserMcpToolsAllowed(
    ['Read', 'mcp__ccem-browser__evaluate'],
    'dev',
  )?.includes('mcp__ccem-browser__evaluate'));
  assert.equal(ensureBrowserMcpToolsAllowed(undefined, 'dev'), undefined);

  const server = createCcemBrowserMcpServer('dev', async (toolName, args) => ({ toolName, args }));
  assert.ok(registeredToolNames(server).includes('evaluate'));
  assert.ok(registeredToolNames(server).includes('read_network_log'));

  const navigate = server.instance._registeredTools.navigate.handler;
  const result = await navigate({ url: 'https://example.com' });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    toolName: 'navigate',
    args: { url: 'https://example.com' },
  });

  const click = server.instance._registeredTools.click.handler;
  const clickResult = await click({ elementRef: 'element-7-opaque' });
  assert.deepEqual(JSON.parse(clickResult.content[0].text), {
    toolName: 'click',
    args: { elementRef: 'element-7-opaque' },
  });

  const readNetworkLog = server.instance._registeredTools.read_network_log.handler;
  const networkResult = await readNetworkLog({});
  assert.deepEqual(JSON.parse(networkResult.content[0].text), {
    toolName: 'read_network_log',
    args: {},
  });

  const pressKeyTool = server.instance._registeredTools.press_key;
  const pressKey = pressKeyTool.handler;
  const pressKeyResult = await pressKey({ key: 'Enter' });
  assert.deepEqual(JSON.parse(pressKeyResult.content[0].text), {
    toolName: 'press_key',
    args: { key: 'Enter' },
  });

  const scrollTool = server.instance._registeredTools.scroll;
  const scroll = scrollTool.handler;
  const scrollResult = await scroll({ deltaY: -600 });
  assert.deepEqual(JSON.parse(scrollResult.content[0].text), {
    toolName: 'scroll',
    args: { deltaY: -600 },
  });

  const evaluateTool = server.instance._registeredTools.evaluate;
  const evaluate = evaluateTool.handler;
  const evaluateResult = await evaluate({ script: 'document.title' });
  assert.deepEqual(JSON.parse(evaluateResult.content[0].text), {
    toolName: 'evaluate',
    args: { script: 'document.title' },
  });

  assert.equal(pressKeyTool.inputSchema.safeParse({ key: 'Meta+L' }).success, false);
  assert.equal(scrollTool.inputSchema.safeParse({ deltaY: 0 }).success, false);
  assert.equal(scrollTool.inputSchema.safeParse({ deltaY: 2_001 }).success, false);
  assert.equal(scrollTool.inputSchema.safeParse({ deltaY: 1.5 }).success, false);
  assert.equal(evaluateTool.inputSchema.safeParse({ script: 'x'.repeat(32_769) }).success, false);
  assert.equal(evaluateTool.inputSchema.safeParse({ script: '你'.repeat(11_000) }).success, false);
});

test('registered MCP tools exactly match the shared Rust parser vocabulary', async () => {
  const vocabulary = JSON.parse(await fs.readFile(
    path.join(packageDir, 'src', 'browser-tool-vocabulary.json'),
    'utf8',
  ));
  const { createCcemBrowserMcpServer } = await importBrowserMcpModule();

  assert.deepEqual(
    registeredToolNames(createCcemBrowserMcpServer('dev', async () => ({}))),
    [...vocabulary].sort(),
  );
});

test('browser tool bridge resolves successful responses and rejects failures', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  const requests = [];
  const bridge = createBrowserToolBridge((request) => requests.push(request), 1_000);

  const success = bridge.sendBrowserToolRequest('navigate', { url: 'https://example.com' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'browser_tool_request');
  assert.equal(requests[0].tool, 'navigate');
  assert.deepEqual(requests[0].args, { url: 'https://example.com' });

  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: requests[0].request_id,
    ok: true,
    result: { ok: true },
  }), true);
  assert.deepEqual(await success, { ok: true });

  const failure = bridge.sendBrowserToolRequest('click', { ref: 1 });
  assert.equal(requests.length, 2);
  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: requests[1].request_id,
    ok: false,
    error: 'missing ref',
  }), true);
  await assert.rejects(failure, /missing ref/);

  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: 'missing',
    ok: true,
  }), false);
});

test('browser bridge caller deadline stays beyond the production backend deadline', async () => {
  const { BROWSER_TOOL_BRIDGE_TIMEOUT_MS } = await importBrowserMcpModule();
  assert.equal(BROWSER_TOOL_BRIDGE_TIMEOUT_MS, 45_000);
  assert.ok(BROWSER_TOOL_BRIDGE_TIMEOUT_MS > 30_000);
});

test('browser tool bridge rejects all pending requests when the session closes', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  const bridge = createBrowserToolBridge(() => {}, 1_000);

  const pending = bridge.sendBrowserToolRequest('snapshot', {});
  bridge.rejectAll('session closed');

  await assert.rejects(pending, /session closed/);
});

test('browser tool bridge can reject foreground work without cancelling background agents', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  let owner = 'foreground';
  const requests = [];
  const bridge = createBrowserToolBridge(
    (request) => requests.push(request),
    1_000,
    () => owner,
  );

  const foreground = bridge.sendBrowserToolRequest('snapshot', {});
  owner = 'background';
  const background = bridge.sendBrowserToolRequest('get_url', {});
  bridge.rejectOwned('foreground', 'foreground interrupted');

  await assert.rejects(foreground, /foreground interrupted/);
  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: requests[1].request_id,
    ok: true,
    result: { url: 'https://example.com' },
  }), true);
  assert.deepEqual(await background, { url: 'https://example.com' });
});

test('browser tool ownership follows the matching permission request instead of global ingress order', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  const requests = [];
  const bridge = createBrowserToolBridge((request) => requests.push(request), 1_000);
  bridge.recordOwner('click', { snapshotId: 'one', ref: 1 }, 'foreground');
  bridge.recordOwner('click', { ref: 2, snapshotId: 'two' }, 'background');

  const background = bridge.sendBrowserToolRequest('click', { snapshotId: 'two', ref: 2 });
  const foreground = bridge.sendBrowserToolRequest('click', { ref: 1, snapshotId: 'one' });
  bridge.rejectOwned('foreground', 'foreground interrupted');

  await assert.rejects(foreground, /foreground interrupted/);
  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: requests[0].request_id,
    ok: true,
    result: { kept: true },
  }), true);
  assert.deepEqual(await background, { kept: true });
});

test('browser tool bridge cancels only the selected background task owner', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  const requests = [];
  const bridge = createBrowserToolBridge((request) => requests.push(request), 1_000);
  bridge.recordOwner('snapshot', {}, 'background:task-one');
  bridge.recordOwner('get_url', {}, 'background:task-two');

  const first = bridge.sendBrowserToolRequest('snapshot', {});
  const second = bridge.sendBrowserToolRequest('get_url', {});
  bridge.rejectOwned('background:task-one', 'task one stopped');

  await assert.rejects(first, /task one stopped/);
  assert.equal(bridge.handleBrowserToolResponse({
    type: 'browser_tool_response',
    request_id: requests[1].request_id,
    ok: true,
    result: { kept: true },
  }), true);
  assert.deepEqual(await second, { kept: true });
});

test('browser tool bridge discards queued owners when their turn or task is cancelled', async () => {
  const { createBrowserToolBridge } = await importBrowserMcpModule();
  const requests = [];
  const bridge = createBrowserToolBridge((request) => requests.push(request), 1_000);

  bridge.recordOwner('snapshot', {}, 'background:stale-task');
  bridge.rejectOwned('background:stale-task', 'stale task stopped before dispatch');
  const foreground = bridge.sendBrowserToolRequest('snapshot', {});
  bridge.rejectOwned('foreground', 'foreground interrupted');
  await assert.rejects(foreground, /foreground interrupted/);

  bridge.recordOwner('get_url', {}, 'background:stale-task');
  bridge.rejectAll('session closed before dispatch');
  const nextSessionForeground = bridge.sendBrowserToolRequest('get_url', {});
  bridge.rejectOwned('foreground', 'next foreground interrupted');
  await assert.rejects(nextSessionForeground, /next foreground interrupted/);
  assert.equal(requests.length, 2);
});
