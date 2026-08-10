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

/**
 * Contract + a11y + behavior tests for DeleteEnvConfirmDialog.
 *
 * Boundary (explicit): Radix Dialog cannot render under JSDOM (missing
 * pointer/focus APIs; no repo precedent). The dialog primitives are stubbed to
 * mirror Radix's contract: role=dialog, aria-modal, aria-labelledby↔DialogTitle,
 * and DismissableLayer dismissal interception (onEscapeKeyDown /
 * onPointerDownOutside / onInteractOutside honored with preventDefault) + a
 * controlled open/onOpenChange. This proves the COMPONENT wires the primitives,
 * exposes a screen-reader live region, and locks dismissal while confirming.
 * Radix's own focus trap/restore remain its tested contract. Pure pieces
 * (refQueryAllowsDelete, createDeleteGuard) are covered in their own test files.
 */

async function resolveSourcePath(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
    const candidate = `${base}${ext}`;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // try next extension
    }
  }
  return null;
}

const STUB_PATHS = new Set(['@/components/ui/dialog', '@/hooks/useTauriCommands', '@/locales']);

const DIALOG_STUB = `
  import React from 'react';
  const Ctx = React.createContext({ open: true, onOpenChange: () => {} });
  function preventable() {
    return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  }
  export function Dialog({ open = true, onOpenChange, children }) {
    return React.createElement(Ctx.Provider, { value: { open, onOpenChange } }, children);
  }
  export function DialogContent({
    children, showCloseButton = true, closeLabel,
    onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...rest
  }) {
    const ctx = React.useContext(Ctx);
    if (!ctx.open) return null;
    const overlay = React.createElement('div', {
      'data-overlay': true,
      onPointerDown: () => {
        const a = preventable();
        if (onPointerDownOutside) onPointerDownOutside(a);
        const b = preventable();
        if (onInteractOutside) onInteractOutside(b);
        if (!a.defaultPrevented && !b.defaultPrevented) ctx.onOpenChange(false);
      },
    });
    const content = React.createElement('div', {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title',
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          if (onEscapeKeyDown) onEscapeKeyDown(e);
          if (!e.defaultPrevented) ctx.onOpenChange(false);
        }
      },
      ...rest,
    },
      children,
      showCloseButton
        ? React.createElement('button', { 'data-close': true, onClick: () => ctx.onOpenChange(false) }, 'x')
        : null,
    );
    return React.createElement(React.Fragment, null, overlay, content);
  }
  export function DialogHeader({ children }) { return React.createElement('div', null, children); }
  export function DialogTitle({ children }) { return React.createElement('h2', { id: 'dlg-title' }, children); }
  export function DialogDescription({ children }) { return React.createElement('p', null, children); }
  export function DialogFooter({ children }) { return React.createElement('div', null, children); }
`;

const harnessPlugins = [
  {
    name: 'ccem-delete-env-alias',
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, async (args) => {
        if (STUB_PATHS.has(args.path)) return null;
        const resolved = await resolveSourcePath(args.path);
        return resolved ? { path: resolved } : { errors: [{ text: `Could not resolve ${args.path}` }] };
      });
    },
  },
  {
    name: 'ccem-delete-env-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^@\/components\/ui\/dialog$/ }, () => ({ path: 'dialog', namespace: 'delete-env-stub' }));
      builder.onResolve({ filter: /^@\/hooks\/useTauriCommands$/ }, () => ({ path: 'cmds', namespace: 'delete-env-stub' }));
      builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locales', namespace: 'delete-env-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'delete-env-stub' }, (args) => {
        if (args.path === 'dialog') return { loader: 'jsx', resolveDir: desktopDir, contents: DIALOG_STUB };
        if (args.path === 'cmds') {
          return {
            loader: 'js',
            resolveDir: desktopDir,
            // Module-level STABLE identities so the component effect doesn't loop.
            contents: `
              let __resolve;
              const __pending = new Promise((r) => { __resolve = r; });
              const getEnvironmentRouterReferences = async () => __pending;
              const __cmds = { getEnvironmentRouterReferences };
              export function useTauriCommands() { return __cmds; }
              export function resolveRefs(list) { __resolve(list); }
            `,
          };
        }
        if (args.path === 'locales') {
          return { loader: 'js', resolveDir: desktopDir, contents: `export function useLocale() { return { t: (k) => k }; }` };
        }
        return { loader: 'js', contents: '' };
      });
    },
  },
];

async function buildHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-delete-env-dialog-test-'));
  const outputPath = path.join(tempDir, 'delete-env-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act as reactAct, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { DeleteEnvConfirmDialog } from '@/components/DeleteEnvConfirmDialog';
        import { createDeleteGuard } from '@/lib/asyncGuard';
        import { resolveRefs } from '@/hooks/useTauriCommands';

        export function mountDialog(container, props) {
          const root = createRoot(container);
          reactAct(() => root.render(React.createElement(DeleteEnvConfirmDialog, props)));
          return { unmount() { reactAct(() => root.unmount()); } };
        }

        // Re-export the SAME React act the bundled component/scheduler uses, so
        // the test does not import a different React instance act.
        export const act = reactAct;

        // Mirrors App's ref-guarded confirming flow: synchronous re-entry guard,
        // confirming state drives the dialog, success closes, reject stays open.
        export function mountAppLike(container, { deleteImpl, onClose }) {
          const root = createRoot(container);
          function AppLike() {
            const guard = useRef(createDeleteGuard()).current;
            const [confirming, setConfirming] = useState(false);
            const [open, setOpen] = useState(true);
            const confirm = () => {
              if (!guard.begin()) return; // atomic re-entry guard
              setConfirming(true);
              Promise.resolve()
                .then(() => deleteImpl())
                .then(() => { setOpen(false); if (onClose) onClose('success'); })
                .catch(() => { /* reject: keep dialog open, do not close */ })
                .finally(() => { guard.end(); setConfirming(false); });
            };
            if (!open) return null;
            return React.createElement(DeleteEnvConfirmDialog, {
              envName: 'glm', confirming, onConfirm: confirm,
              onCancel: () => { setOpen(false); if (onClose) onClose('cancel'); },
            });
          }
          reactAct(() => root.render(React.createElement(AppLike)));
          return { unmount() { reactAct(() => root.unmount()); } };
        }

        export async function flush() {
          await reactAct(async () => { await new Promise((r) => setTimeout(r, 0)); });
        }
        export { resolveRefs };
      `,
      resolveDir: desktopDir,
      sourcefile: 'delete-env-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: harnessPlugins,
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  return { harness: await import(pathToFileURL(outputPath).href), tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => { queueMicrotask(() => this.port1.onmessage?.({ data })); } };
    }
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: window.MouseEvent });
  const names = {
    window, self: window, document: window.document, navigator: window.navigator,
    localStorage: window.localStorage, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, SVGElement: window.SVGElement, Event: window.Event,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    MessageChannel: TestMessageChannel, ResizeObserver, PointerEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(names)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    container: window.document.getElementById('root'),
    restore() {
      window.close();
      for (const [name, desc] of previous) {
        if (desc === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, desc);
      }
    },
  };
}

/** mount + assert + full teardown (unmount, JSDOM close, tempDir rm, esbuild stop). */
async function withHarness(mount, fn) {
  const { harness, tempDir } = await buildHarness();
  const dom = installDom();
  const mounted = mount(harness, dom.container);
  try {
    await fn({ act: harness.act, flush: harness.flush, resolveRefs: harness.resolveRefs, document: dom.container.ownerDocument });
  } finally {
    mounted.unmount();
    dom.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  }
}

function findButtonByText(doc, text) {
  return Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === text);
}

// ---- Contract / a11y tests (direct component render) ----

test('DeleteEnvConfirmDialog uses shadcn Dialog semantics + a live region (a11y)', async () => {
  await withHarness(
    (h, c) => h.mountDialog(c, { envName: 'glm', onConfirm: () => {}, onCancel: () => {} }),
    async ({ flush, document }) => {
      await flush();
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog, 'renders the Dialog primitive (role=dialog)');
      assert.equal(dialog.getAttribute('aria-modal'), 'true');
      assert.equal(dialog.getAttribute('aria-labelledby'), 'dlg-title');
      assert.ok(document.getElementById('dlg-title'));
      const live = document.querySelector('[role=status]');
      assert.ok(live, 'live region present');
      assert.equal(live.getAttribute('aria-live'), 'polite');
    },
  );
});

test('delete is disabled while loading; enabled when authoritative refs resolve empty', async () => {
  await withHarness(
    (h, c) => h.mountDialog(c, { envName: 'glm', onConfirm: () => {}, onCancel: () => {} }),
    async ({ flush, resolveRefs, document }) => {
      await flush();
      assert.equal(findButtonByText(document, 'common.delete').disabled, true);
      resolveRefs([]);
      await flush();
      assert.equal(findButtonByText(document, 'common.delete').disabled, false);
    },
  );
});

test('delete is disabled and references are listed when references exist', async () => {
  await withHarness(
    (h, c) => h.mountDialog(c, { envName: 'glm', onConfirm: () => {}, onCancel: () => {} }),
    async ({ flush, resolveRefs, document }) => {
      resolveRefs(['router.bindings.subagent:Explore', 'router.profile:budget', 'session:r-1']);
      await flush();
      assert.equal(findButtonByText(document, 'common.delete').disabled, true);
      const live = document.querySelector('[role=status]');
      assert.match(live.textContent, /router\.bindings\.subagent:Explore/);
      assert.match(live.textContent, /session:r-1/);
    },
  );
});

test('Escape routes through onOpenChange → onCancel when not confirming', async () => {
  let cancelled = false;
  await withHarness(
    (h, c) => h.mountDialog(c, { envName: 'glm', onConfirm: () => {}, onCancel: () => { cancelled = true; } }),
    async ({ flush, document }) => {
      await flush();
      document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush();
    },
  );
  assert.equal(cancelled, true, 'Escape → onCancel when not confirming');
});

// ---- Behavior tests (App-like ref-guarded confirming flow) ----

test('two rapid confirms trigger the backend delete only once (atomic re-entry guard)', async () => {
  let calls = 0;
  const deleteImpl = () => { calls += 1; return new Promise(() => {}); };
  await withHarness(
    (h, c) => h.mountAppLike(c, { deleteImpl, onClose: () => {} }),
    async ({ act, flush, resolveRefs, document }) => {
      await flush();
      await act(async () => { resolveRefs([]); }); // empty refs → delete enabled
      await flush();
      const del = findButtonByText(document, 'common.delete');
      assert.ok(del);
      assert.equal(del.disabled, false, 'delete enabled before submit');
      // Two synchronous submits in one act batch (no React re-render between).
      await act(async () => { del.click(); del.click(); });
      await flush();
    },
  );
  assert.equal(calls, 1, 'backend delete_environment invoked exactly once');
});

test('while confirming: Escape, overlay, top-right close, and Cancel cannot dismiss', async () => {
  const closed = [];
  const deleteImpl = () => new Promise(() => {}); // pending → confirming stays true
  await withHarness(
    (h, c) => h.mountAppLike(c, { deleteImpl, onClose: (reason) => closed.push(reason) }),
    async ({ act, flush, resolveRefs, document }) => {
      await flush();
      await act(async () => { resolveRefs([]); }); // delete enabled
      await flush();
      await act(async () => { findButtonByText(document, 'common.delete').click(); });
      await flush(); // confirming is now true

      assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true', 'aria-busy set');
      assert.equal(document.querySelector('[data-close]'), null, 'top-right close hidden (showCloseButton=false)');
      assert.equal(findButtonByText(document, 'common.cancel').disabled, true, 'Cancel disabled');

      // Escape blocked.
      await act(async () => {
        document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flush();
      // Overlay (interact-outside) blocked.
      await act(async () => {
        document.querySelector('[data-overlay]').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      await flush();
    },
  );
  assert.deepEqual(closed, [], 'no dismiss path closed the dialog while confirming');
});

test('after backend reject: operability restored and dialog stays open', async () => {
  const closed = [];
  let rejectDelete;
  const deleteImpl = () => new Promise((_, rej) => { rejectDelete = rej; });
  await withHarness(
    (h, c) => h.mountAppLike(c, { deleteImpl, onClose: (reason) => closed.push(reason) }),
    async ({ act, flush, resolveRefs, document }) => {
      await flush();
      await act(async () => { resolveRefs([]); }); // delete enabled
      await flush();
      await act(async () => { findButtonByText(document, 'common.delete').click(); });
      await flush();
      // Reject inside act and drain the catch/finally microtasks within the same
      // act scope so the setConfirming(false) update does not escape act.
      await act(async () => {
        rejectDelete(new Error('referenced')); // TOCTOU new reference
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      assert.ok(document.querySelector('[role="dialog"]'), 'dialog still open after reject');
      assert.equal(findButtonByText(document, 'common.delete').disabled, false, 'operability restored');
      assert.equal(findButtonByText(document, 'common.cancel').disabled, false, 'cancel re-enabled');
    },
  );
  assert.deepEqual(closed, [], 'reject did not close the dialog');
});
