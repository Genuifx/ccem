import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

const tauriInvokeStubPlugin = {
  name: 'ccem-locale-tauri-stub',
  setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: 'tauri-core',
      namespace: 'locale-test-stub',
    }));
    builder.onLoad(
      { filter: /^tauri-core$/, namespace: 'locale-test-stub' },
      () => ({
        loader: 'js',
        contents: `
          export function invoke(command, args) {
            return globalThis.__ccemLocaleInvoke(command, args);
          }
        `,
      }),
    );
  },
};

async function importLocaleHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-locale-provider-test-'));
  const outputPath = path.join(tempDir, 'locale-provider-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider, useLocale } from './src/locales/index.tsx';

        let latestLocale;

        function LocaleProbe() {
          latestLocale = useLocale();
          return (
            <output
              data-testid="language"
              data-hydrated={String(latestLocale.languageHydrated)}
            >
              {latestLocale.lang}
            </output>
          );
        }

        export function mountLocaleProbe(container) {
          const root = createRoot(container);
          act(() => {
            root.render(<LocaleProvider><LocaleProbe /></LocaleProvider>);
          });
          return {
            captureHydration() {
              return latestLocale.captureLanguageHydration();
            },
            hydrate(language, revision) {
              act(() => {
                latestLocale.hydratePersistedLanguage(language, revision);
              });
            },
            selectLanguage(language) {
              let savePromise;
              act(() => {
                savePromise = latestLocale.setLang(language);
              });
              return savePromise;
            },
            async selectLanguageAndWait(language) {
              let saveError;
              await act(async () => {
                try {
                  await latestLocale.setLang(language);
                } catch (error) {
                  saveError = error;
                }
              });
              if (saveError) throw saveError;
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }

        export async function flushLocaleEffects() {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'locale-provider-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [tauriInvokeStubPlugin],
    define: {
      'process.env.NODE_ENV': '"test"',
    },
    logLevel: 'silent',
  });

  return {
    harness: await import(pathToFileURL(outputPath).href),
    tempDir,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const previous = new Map();
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          queueMicrotask(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('Node', window.Node);
  expose('Element', window.Element);
  expose('HTMLElement', window.HTMLElement);
  expose('Event', window.Event);
  expose('MouseEvent', window.MouseEvent);
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
      delete globalThis.__ccemLocaleInvoke;
    },
  };
}

async function withLocaleProbe(run, { beforeMount } = {}) {
  const { container, restore } = installDom();
  const { harness, tempDir } = await importLocaleHarness();
  let mounted;
  try {
    beforeMount?.();
    mounted = harness.mountLocaleProbe(container);
    await run({ container, harness, mounted });
  } finally {
    mounted?.unmount();
    restore();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('backend language hydrates the provider and replaces the legacy cache', async () => {
  await withLocaleProbe(async ({ container, harness }) => {
    await harness.flushLocaleEffects();
    const output = container.querySelector('[data-testid="language"]');
    assert.equal(output.textContent, 'en');
    assert.equal(output.dataset.hydrated, 'true');
    assert.deepEqual(
      JSON.parse(localStorage.getItem('ccem-settings')),
      { theme: 'dark', language: 'en' },
    );
    assert.equal(localStorage.getItem('ccem-locale'), null);
  }, {
    beforeMount() {
      localStorage.setItem('ccem-settings', JSON.stringify({ theme: 'dark', language: 'zh' }));
      localStorage.setItem('ccem-locale', 'zh');
      globalThis.__ccemLocaleInvoke = async (command) => {
        assert.equal(command, 'get_settings');
        return { language: 'en' };
      };
    },
  });
});

test('Settings hydration plus a saved user choice rejects a late Provider response', async () => {
  const providerRead = deferred();
  globalThis.__ccemLocaleInvoke = (command, args) => {
    if (command === 'get_settings') return providerRead.promise;
    if (command === 'save_language') {
      assert.deepEqual(args, { language: 'zh' });
      return Promise.resolve();
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await withLocaleProbe(async ({ container, harness, mounted }) => {
    const settingsRevision = mounted.captureHydration();
    mounted.hydrate('en', settingsRevision);
    await mounted.selectLanguage('zh');
    await harness.flushLocaleEffects();

    providerRead.resolve({ language: 'en' });
    await harness.flushLocaleEffects();

    const output = container.querySelector('[data-testid="language"]');
    assert.equal(output.textContent, 'zh');
    assert.equal(JSON.parse(localStorage.getItem('ccem-settings')).language, 'zh');
  });
});

test('a successful Settings snapshot hydrates after the Provider read fails', async () => {
  globalThis.__ccemLocaleInvoke = async (command) => {
    assert.equal(command, 'get_settings');
    throw new Error('transient provider read failure');
  };

  await withLocaleProbe(async ({ container, harness, mounted }) => {
    const settingsRevision = mounted.captureHydration();
    await harness.flushLocaleEffects();
    const output = container.querySelector('[data-testid="language"]');
    assert.equal(output.dataset.hydrated, 'false');

    mounted.hydrate('en', settingsRevision);

    assert.equal(output.textContent, 'en');
    assert.equal(output.dataset.hydrated, 'true');
    assert.equal(JSON.parse(localStorage.getItem('ccem-settings')).language, 'en');
  });
});

test('rapid zh to en changes are saved serially with en as the final backend value', async () => {
  const saves = [];
  let backendLanguage = 'en';
  globalThis.__ccemLocaleInvoke = (command, args) => {
    if (command === 'get_settings') return Promise.resolve({ language: 'en' });
    if (command === 'save_language') {
      const save = deferred();
      saves.push({ language: args.language, ...save });
      return save.promise.then(() => {
        backendLanguage = args.language;
      });
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await withLocaleProbe(async ({ container, harness, mounted }) => {
    await harness.flushLocaleEffects();
    const zhSave = mounted.selectLanguage('zh');
    await harness.flushLocaleEffects();
    const enSave = mounted.selectLanguage('en');
    await harness.flushLocaleEffects();

    assert.deepEqual(saves.map(({ language }) => language), ['zh']);
    saves[0].resolve();
    await zhSave;
    await harness.flushLocaleEffects();
    assert.deepEqual(saves.map(({ language }) => language), ['zh', 'en']);

    saves[1].resolve();
    await enSave;
    await harness.flushLocaleEffects();

    assert.equal(backendLanguage, 'en');
    assert.equal(container.querySelector('[data-testid="language"]').textContent, 'en');
    assert.equal(JSON.parse(localStorage.getItem('ccem-settings')).language, 'en');
  });
});

test('a failed language save rolls back to the last confirmed language', async () => {
  globalThis.__ccemLocaleInvoke = (command) => {
    if (command === 'get_settings') return Promise.resolve({ language: 'en' });
    if (command === 'save_language') return Promise.reject(new Error('disk full'));
    throw new Error(`Unexpected command: ${command}`);
  };

  await withLocaleProbe(async ({ container, harness, mounted }) => {
    await harness.flushLocaleEffects();
    await assert.rejects(mounted.selectLanguageAndWait('zh'), /disk full/);
    await harness.flushLocaleEffects();

    assert.equal(container.querySelector('[data-testid="language"]').textContent, 'en');
    assert.equal(JSON.parse(localStorage.getItem('ccem-settings')).language, 'en');
  });
});

test('a missing backend field migrates legacy language once and only clears it after success', async () => {
  const migrationSave = deferred();
  globalThis.__ccemLocaleInvoke = (command, args) => {
    if (command === 'get_settings') return Promise.resolve({});
    if (command === 'save_language') {
      assert.deepEqual(args, { language: 'en' });
      return migrationSave.promise;
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await withLocaleProbe(async ({ container, harness }) => {
    localStorage.setItem('ccem-locale', 'en');
    await harness.flushLocaleEffects();
    assert.equal(container.querySelector('[data-testid="language"]').textContent, 'en');
    assert.equal(localStorage.getItem('ccem-locale'), 'en');

    migrationSave.resolve();
    await harness.flushLocaleEffects();

    assert.equal(localStorage.getItem('ccem-locale'), null);
    assert.equal(JSON.parse(localStorage.getItem('ccem-settings')).language, 'en');
  });
});

test('a failed legacy migration keeps the compatibility key for the next retry', async () => {
  globalThis.__ccemLocaleInvoke = (command) => {
    if (command === 'get_settings') return Promise.resolve({});
    if (command === 'save_language') return Promise.reject(new Error('read-only settings file'));
    throw new Error(`Unexpected command: ${command}`);
  };

  await withLocaleProbe(async ({ container, harness }) => {
    localStorage.setItem('ccem-locale', 'en');
    await harness.flushLocaleEffects();

    assert.equal(container.querySelector('[data-testid="language"]').textContent, 'zh');
    assert.equal(localStorage.getItem('ccem-locale'), 'en');
    assert.equal(localStorage.getItem('ccem-settings'), null);
  });
});
