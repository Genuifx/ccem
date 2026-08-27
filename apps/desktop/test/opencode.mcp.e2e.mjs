import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoFixtureDir = path.join(__dirname, 'fixtures', 'opencode');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 250, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function tailLogs(lines, max = 80) {
  return lines.slice(-max).join('');
}

function decodeDataUrl(dataUrl) {
  const [, base64] = dataUrl.split(',', 2);
  return Buffer.from(base64, 'base64');
}

class BridgeClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      const id = payload?.id;
      if (!id || !this.pending.has(id)) {
        return;
      }

      const { resolve } = this.pending.get(id);
      this.pending.delete(id);
      resolve(payload);
    });

    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('Tauri MCP bridge connection closed'));
      }
      this.pending.clear();
    });
  }

  async call(command, args) {
    const id = `req-${this.nextId++}`;
    const payload = args === undefined ? { id, command } : { id, command, args };

    const response = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });

    return response;
  }

  async executeJs(script) {
    const response = await this.call('execute_js', { script });
    if (!response.success) {
      throw new Error(response.error || 'execute_js failed');
    }
    return response.data;
  }

  async invokePlugin(command, args = {}) {
    const response = await this.call('invoke_tauri', { command, args });
    if (!response.success) {
      throw new Error(response.error || `invoke_tauri failed: ${command}`);
    }
    return response.data;
  }

  async screenshot(filePath) {
    const response = await this.call('capture_native_screenshot', { format: 'png' });
    if (!response.success || typeof response.data !== 'string') {
      throw new Error(response.error || 'capture_native_screenshot failed');
    }
    await fs.writeFile(filePath, decodeDataUrl(response.data));
  }

  close() {
    this.ws.close();
  }
}

async function openBridgeSocket(port) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out connecting to ws://127.0.0.1:${port}`));
    }, 1500);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(event.error || new Error(`Failed to connect to ws://127.0.0.1:${port}`));
    });
  });
}

async function connectBridge({ timeoutMs = 120000 } = {}) {
  return await waitFor(async () => {
    for (let port = 9223; port <= 9322; port += 1) {
      try {
        const ws = await openBridgeSocket(port);
        const bridge = new BridgeClient(ws);
        const windows = await bridge.call('list_windows');
        if (windows.success) {
          return bridge;
        }
        bridge.close();
      } catch {
        // keep scanning ports
      }
    }
    return null;
  }, {
    timeoutMs,
    intervalMs: 1000,
    description: 'the Tauri MCP bridge websocket',
  });
}

async function readIpcEvents(bridge) {
  const events = await bridge.invokePlugin('plugin:mcp-bridge|get_ipc_events');
  return Array.isArray(events) ? events : [];
}

async function waitForIpcEvent(bridge, predicate, options = {}) {
  const baseline = options.baseline ?? 0;
  return await waitFor(async () => {
    const events = await readIpcEvents(bridge);
    const sliced = events.slice(baseline);
    return sliced.find(predicate) ?? null;
  }, {
    timeoutMs: options.timeoutMs ?? 30000,
    intervalMs: options.intervalMs ?? 300,
    description: options.description ?? 'the expected IPC event',
  });
}

async function clickSelector(bridge, selector, { delayMs = 200 } = {}) {
  const clicked = await bridge.executeJs(`
    (async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      element.focus?.();
      element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      element.dispatchEvent(new MouseEvent('mousedown', eventInit));
      element.dispatchEvent(new PointerEvent('pointerup', eventInit));
      element.dispatchEvent(new MouseEvent('mouseup', eventInit));
      element.click();
      await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
      return true;
    })()
  `);
  assert.equal(clicked, true, `Expected selector ${selector} to be clickable`);
}

async function writeFixtureConfig(homeDir) {
  const ccemDir = path.join(homeDir, '.ccem');
  await fs.mkdir(path.join(ccemDir, 'sessions'), { recursive: true });

  const config = {
    registries: {
      'Fixture Anthropic': {
        ANTHROPIC_BASE_URL: 'https://example.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'fixture-token',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_MODEL: 'sonnet',
      },
    },
    current: 'Fixture Anthropic',
    defaultMode: 'dev',
  };

  await fs.writeFile(
    path.join(ccemDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-opencode-e2e-'));
  const tempHome = path.join(tempRoot, 'home');
  const tempFixtureDir = path.join(tempRoot, 'fixtures', 'opencode');
  const tempWorkspaceDir = path.join(tempRoot, 'workspace');
  const screenshotsDir = path.join(tempRoot, 'screenshots');
  const logLines = [];
  let createdSessionId = null;
  let bridge = null;
  let child = null;

  await fs.mkdir(tempHome, { recursive: true });
  await fs.mkdir(tempWorkspaceDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.cp(repoFixtureDir, tempFixtureDir, { recursive: true });
  await writeFixtureConfig(tempHome);

  const childEnv = {
    ...process.env,
    HOME: tempHome,
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'),
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'),
    CCEM_OPENCODE_FIXTURE_DIR: tempFixtureDir,
    CCEM_TEST_DIRECTORY_PICKER_PATH: tempWorkspaceDir,
    PATH: `${path.join(tempFixtureDir, 'bin')}:${process.env.PATH ?? ''}`,
  };

  child = spawn('pnpm', ['tauri', 'dev', '--no-watch'], {
    cwd: desktopDir,
    env: childEnv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    logLines.push(String(chunk));
  });
  child.stderr.on('data', (chunk) => {
    logLines.push(String(chunk));
  });

  try {
    bridge = await connectBridge({ timeoutMs: 180000 });

    await waitFor(async () => {
      const state = await bridge.invokePlugin('plugin:mcp-bridge|get_backend_state');
      return state?.window_count >= 1 ? state : null;
    }, { timeoutMs: 30000, description: 'the desktop window to become visible' });

    await waitFor(async () => {
      const readyState = await bridge.executeJs('document.readyState');
      return readyState === 'complete' ? readyState : null;
    }, { timeoutMs: 30000, description: 'the desktop webview to finish loading' });

    await bridge.invokePlugin('plugin:mcp-bridge|start_ipc_monitor');

    await waitFor(async () => {
      const ready = await bridge.executeJs(`
        Boolean(document.querySelector('[data-testid="workspace-launch-claude"]')) &&
        Boolean(document.querySelector('[data-testid="workspace-launch-codex"]')) &&
        Boolean(document.querySelector('[data-testid="workspace-launch-menu-trigger"]'))
      `);
      return ready ? true : null;
    }, { timeoutMs: 20000, description: 'the workspace launch controls' });

    assert.equal(
      await bridge.executeJs("Boolean(document.querySelector('[data-testid=\"workspace-launch-opencode\"]'))"),
      false
    );

    const menuOpened = await bridge.executeJs(`
      (async () => {
        const trigger = document.querySelector('[data-testid="workspace-launch-menu-trigger"]');
        if (!trigger) return false;
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return Boolean(document.querySelector('[data-testid="workspace-launch-opencode"]'));
      })()
    `);
    assert.equal(menuOpened, true);

    await clickSelector(bridge, '[data-testid="workspace-launch-opencode"]', { delayMs: 400 });

    const invocationLog = await waitFor(async () => {
      try {
        const text = await fs.readFile(path.join(tempFixtureDir, 'invocations.log'), 'utf8');
        return /load the pua skill/i.test(text) ? text : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 30000, description: 'the OpenCode fixture invocation log' });

    assert.match(invocationLog, /load the pua skill/i);
    assert.match(invocationLog, /OPENCODE_CONFIG_CONTENT|has_config=yes/i);

    await bridge.screenshot(path.join(screenshotsDir, 'workspace-opencode.png'));

    await clickSelector(bridge, '[data-testid="nav-sessions"]');
    await waitFor(async () => (
      (await bridge.executeJs(
        "document.querySelectorAll('[data-testid=\"session-card\"][data-client=\"opencode\"]').length"
      )) ? true : null
    ), { timeoutMs: 30000, description: 'an OpenCode session card in the sessions view' });

    if (!createdSessionId) {
      createdSessionId = await bridge.executeJs(
        "document.querySelector('[data-testid=\"session-card\"][data-client=\"opencode\"]')?.getAttribute('data-session-id') || null"
      );
    }

    await clickSelector(bridge, '[data-testid="nav-history"]');
    await waitFor(async () => (
      (await bridge.executeJs(
        "Boolean(document.querySelector('[data-testid=\"history-filter-other\"]'))"
      )) ? true : null
    ), { timeoutMs: 15000, description: 'the history page filter bar' });

    await clickSelector(bridge, '[data-testid="history-filter-other"]');
    await waitFor(async () => (
      (await bridge.executeJs(
        "Boolean(document.querySelector('[data-testid=\"history-filter-opencode-option\"]'))"
      )) ? true : null
    ), { timeoutMs: 5000, description: 'the Other source dropdown' });
    await clickSelector(bridge, '[data-testid="history-filter-opencode-option"]');
    const historyFilterActive = await bridge.executeJs(
      "Boolean(document.querySelector('[data-testid=\"history-filter-other\"]')?.className.includes('border-primary') && document.querySelector('[data-testid=\"history-filter-other\"]')?.textContent.includes('OpenCode'))"
    );
    assert.equal(historyFilterActive, true);

    await waitFor(async () => {
      const count = await bridge.executeJs(
        "document.querySelectorAll('[data-testid=\"history-session-item\"][data-source=\"opencode\"]').length"
      );
      return Number(count) > 0 ? count : null;
    }, { timeoutMs: 15000, description: 'an OpenCode history row' });

    await clickSelector(bridge, '[data-testid="history-session-item"][data-source="opencode"]');

    const historyDetailText = await waitFor(async () => {
      const matched = await bridge.executeJs(
        "document.body.innerText.includes('请帮我检查 OpenCode 接入') || document.body.innerText.includes('已经开始检查 OpenCode 接入。')"
      );
      return matched ? true : null;
    }, { timeoutMs: 15000, description: 'the OpenCode history detail content' });
    assert.equal(historyDetailText, true);
    await bridge.screenshot(path.join(screenshotsDir, 'history-opencode.png'));

    await clickSelector(bridge, '[data-testid="nav-analytics"]');
    await waitFor(async () => (
      (await bridge.executeJs(
        "Boolean(document.querySelector('[data-testid=\"analytics-filter-opencode\"]'))"
      )) ? true : null
    ), { timeoutMs: 15000, description: 'the analytics page filter bar' });

    await clickSelector(bridge, '[data-testid="analytics-filter-opencode"]');
    const analyticsFilterActive = await bridge.executeJs(
      "document.querySelector('[data-testid=\"analytics-filter-opencode\"]')?.className.includes('seg-active') || false"
    );
    assert.equal(analyticsFilterActive, true);

    const totalTokensText = await waitFor(async () => {
      const text = await bridge.executeJs(
        "document.querySelector('[data-testid=\"analytics-total-tokens\"]')?.textContent?.trim() || ''"
      );
      return text && text !== '0' ? text : null;
    }, { timeoutMs: 20000, description: 'the OpenCode analytics total tokens value' });

    const totalCostText = await bridge.executeJs(
      "document.querySelector('[data-testid=\"analytics-total-cost\"]')?.textContent?.trim() || ''"
    );

    assert.match(totalTokensText, /[1-9]/);
    assert.match(totalCostText, /\$/);
    await bridge.screenshot(path.join(screenshotsDir, 'analytics-opencode.png'));
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    let ipcDump = '';
    if (bridge) {
      try {
        const events = await readIpcEvents(bridge);
        ipcDump = `\n\nCaptured IPC events:\n${JSON.stringify(events.slice(-20), null, 2)}`;
      } catch {
        // best-effort debugging
      }
      try {
        const domSummary = await bridge.executeJs(`({
          ready: document.readyState,
          location: window.location.href,
          buttons: Array.from(document.querySelectorAll('button,[role="menuitem"]'))
            .slice(0, 30)
            .map((element) => ({
              tag: element.tagName,
              role: element.getAttribute('role'),
              testid: element.getAttribute('data-testid'),
              aria: element.getAttribute('aria-label'),
              text: element.textContent?.trim() || ''
            })),
          body: document.body.innerHTML.slice(0, 6000)
        })`);
        ipcDump += `\n\nDOM summary:\n${JSON.stringify(domSummary, null, 2)}`;
      } catch {
        // best-effort debugging
      }
    }
    throw new Error(`${detail}${ipcDump}\n\nTauri dev log tail:\n${tailLogs(logLines)}`);
  } finally {
    try {
      if (createdSessionId) {
        spawnSync(
          'tmux',
          ['kill-session', '-t', `ccem-${createdSessionId}`],
          { env: childEnv, stdio: 'ignore' }
        );
      }
    } catch {
      // best-effort cleanup
    }

    bridge?.close();

    if (child) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      await delay(2000);
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  }
}

main()
  .then(() => {
    console.log('OpenCode Tauri MCP E2E passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
