import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

test('ComposerControls renders dynamic Antigravity models and per-model effort levels', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-agy-dom-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const saved = new Map();
  const MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  const ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let mounted;
  try {
    const outfile = path.join(directory, 'harness.cjs');
    await build({
      stdin: {
        contents: `
          import React, { act } from 'react';
          import { createRoot } from 'react-dom/client';
          import { TooltipProvider } from './src/components/ui/tooltip';
          import { ComposerControls } from './src/components/workspace/ComposerControls';

          export { act };
          export function mount(container, props) {
            const root = createRoot(container);
            const render = (nextProps) => {
              root.render(
                <TooltipProvider>
                  <ComposerControls {...nextProps} />
                </TooltipProvider>
              );
            };
            render(props);
            return { render, unmount: () => root.unmount() };
          }
        `,
        loader: 'tsx',
        resolveDir: path.resolve(import.meta.dirname, '..'),
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [{
        name: 'composer-agy-stubs',
        setup(builder) {
          builder.onResolve(
            { filter: /^(@tauri-apps\/api\/core|@lobehub\/icons|@\/locales|@\/components\/ui\/dropdown-menu|@\/components\/ui\/scroll-area|@\/components\/ui\/select|@\/components\/ui\/tooltip)$/ },
            ({ path: p }) => ({ path: p, namespace: 'fixture' }),
          );
          const resolveDir = path.resolve(import.meta.dirname, '..');
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: p }) => {
            if (p === '@tauri-apps/api/core') {
              return { contents: 'export const invoke = async () => null;', loader: 'js', resolveDir };
            }
            if (p === '@lobehub/icons') {
              return {
                contents: `
                  function Icon() { return null; }
                  Icon.Color = Icon;
                  Icon.Avatar = Icon;
                  export const Antigravity = Icon;
                  export const Claude = Icon;
                  export const Codex = Icon;
                  export const OpenAI = Icon;
                  export const DeepSeek = Icon;
                  export const Grok = Icon;
                  export const Minimax = Icon;
                  export const Moonshot = Icon;
                  export const Zhipu = Icon;
                  export const Gemini = Icon;
                  export const Ollama = Icon;
                  export const OpenCode = Icon;
                  export const OpenRouter = Icon;
                  export const Qwen = Icon;
                  export const XiaomiMiMo = Icon;
                `,
                loader: 'js',
                resolveDir,
              };
            }
            if (p === '@/locales') {
              return {
                contents: `
                  const LABELS = {
                    'workspace.effortMinimal': 'Minimal',
                    'workspace.effortLow': 'Low',
                    'workspace.effortMedium': 'Medium',
                    'workspace.effortHigh': 'High',
                    'workspace.effortXhigh': 'Extra High',
                    'workspace.effortMax': 'Max',
                    'workspace.effortLabel': 'Effort',
                    'workspace.modelLabel': 'Model',
                    'workspace.agyModelsLoading': 'Loading models...',
                    'workspace.agyModelsEmpty': 'No models available',
                    'workspace.agyModelsRefresh': 'Refresh models',
                  };
                  export function useLocale() { return { t: (k) => LABELS[k] ?? k }; }
                `,
                loader: 'js',
                resolveDir,
              };
            }
            if (p === '@/components/ui/dropdown-menu') {
              return {
                contents: `
                  import React from 'react';
                  export const DropdownMenu = ({ children }) => <div data-dropdown>{children}</div>;
                  export const DropdownMenuTrigger = ({ children }) => <>{children}</>;
                  export const DropdownMenuContent = React.forwardRef(({ children, ...rest }, ref) => <div ref={ref} data-dropdown-content {...rest}>{children}</div>);
                  export const DropdownMenuItem = ({ children, onSelect, ...rest }) => (
                    <button type="button" role="menuitem" onClick={(e) => onSelect?.(e)} {...rest}>{children}</button>
                  );
                  export const DropdownMenuSeparator = () => <hr />;
                `,
                loader: 'tsx',
                resolveDir,
              };
            }
            if (p === '@/components/ui/scroll-area') {
              return {
                contents: `
                  import React from 'react';
                  export const ScrollArea = ({ children, ...rest }) => <div {...rest}>{children}</div>;
                `,
                loader: 'tsx',
                resolveDir,
              };
            }
            if (p === '@/components/ui/select') {
              return {
                contents: `
                  import React from 'react';
                  export const Select = ({ children }) => <div>{children}</div>;
                  export const SelectTrigger = ({ children }) => <button type="button">{children}</button>;
                  export const SelectContent = ({ children }) => <div>{children}</div>;
                  export const SelectItem = ({ children }) => <div>{children}</div>;
                `,
                loader: 'tsx',
                resolveDir,
              };
            }
            return {
              contents: `
                import React from 'react';
                export const TooltipProvider = ({ children }) => <>{children}</>;
                export const Tooltip = ({ children }) => <>{children}</>;
                export const TooltipTrigger = ({ children }) => <>{children}</>;
                export const TooltipContent = ({ children }) => <div>{children}</div>;
              `,
              loader: 'tsx',
              resolveDir,
            };
          });
        },
      }],
    });

    const { mount, act } = await import(pathToFileURL(outfile).href);
    const container = dom.window.document.getElementById('root');

    const agyModels = [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', efforts: [], defaultEffort: null },
    ];
    const selectedModels = [];
    const selectedEfforts = [];

    const baseProps = {
      provider: 'agy',
      envName: 'Antigravity',
      permMode: 'dev',
      effort: 'xhigh',
      model: 'gemini-4-neon',
      agyModels,
      environments: [],
      onEnvChange: () => {},
      onPermModeChange: () => {},
      onEffortChange: (next) => selectedEfforts.push(next),
      onModelChange: (next) => selectedModels.push(next),
    };

    // 1. Gemini 4 Neon: shows model name + Extra High, 4 slider stops (0..3)
    await act(async () => { mounted = mount(container, baseProps); });
    const trigger = container.querySelector('[data-testid="composer-model-effort-trigger"]');
    assert.ok(trigger);
    assert.match(trigger.textContent, /Gemini 4 Neon/);
    assert.match(trigger.textContent, /Extra High/);
    let slider = container.querySelector('[role="slider"]');
    assert.ok(slider);
    assert.equal(slider.getAttribute('aria-valuemax'), '3');
    assert.equal(slider.getAttribute('aria-valuetext'), 'Extra High');

    // Clicking Claude Opus 5.5 triggers onModelChange
    const opusItem = container.querySelector('[data-agy-model-option="claude-opus-5-5"]');
    assert.ok(opusItem);
    await act(async () => { opusItem.click(); });
    assert.deepEqual(selectedModels, ['claude-opus-5-5']);

    // 2. Rerender with Claude Opus 5.5 (3 effort stops, effort xhigh clamped to High)
    await act(async () => {
      mounted.render({ ...baseProps, model: 'claude-opus-5-5', effort: 'xhigh' });
    });
    assert.match(trigger.textContent, /Claude Opus 5\.5/);
    assert.match(trigger.textContent, /High/);
    assert.doesNotMatch(trigger.textContent, /Extra High/);
    slider = container.querySelector('[role="slider"]');
    assert.ok(slider);
    assert.equal(slider.getAttribute('aria-valuemax'), '2');
    assert.equal(slider.getAttribute('aria-valuetext'), 'High');

    // 3. Rerender with Orchestrator (Neon) (no effort support -> hides slider & effort badge)
    await act(async () => {
      mounted.render({ ...baseProps, model: 'gemini-pro-orchestrator-neon', effort: 'high' });
    });
    assert.match(trigger.textContent, /Orchestrator \(Neon\)/);
    assert.doesNotMatch(trigger.textContent, /High/);
    assert.equal(container.querySelector('[role="slider"]'), null);

    // 4. Live ACP configOptions override static catalog
    await act(async () => {
      mounted.render({
        ...baseProps,
        model: 'gemini-4-neon',
        effort: 'medium',
        liveConfigOptions: {
          current_model: 'gemini-4-neon',
          current_effort: 'medium',
          supports_effort: true,
          models: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon Live' }],
          efforts: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        },
      });
    });
    assert.match(trigger.textContent, /Gemini 4 Neon Live/);
    assert.match(trigger.textContent, /Medium/);
    slider = container.querySelector('[role="slider"]');
    assert.ok(slider);
    assert.equal(slider.getAttribute('aria-valuemax'), '1');

    await act(async () => mounted.unmount());
    mounted = null;
  } finally {
    mounted?.unmount();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
