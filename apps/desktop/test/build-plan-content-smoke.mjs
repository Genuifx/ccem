import path from 'node:path';
import { build } from 'esbuild';

const desktop = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(desktop, 'test/fixtures/plan-content.tsx')],
  outfile: path.join(desktop, 'test/.artifacts/build/plan-content-smoke.js'),
  bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', target: 'safari15',
  alias: { '@': path.join(desktop, 'src') },
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [{ name: 'plan-content-ipc', setup(builder) {
    // Tauri's injected invoke is readonly. Replace the import only, preserving
    // the native bridge and every production UI hook/response handler.
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'plan-ipc' }));
    builder.onLoad({ filter: /.*/, namespace: 'plan-ipc' }, () => ({
      loader: 'js', resolveDir: desktop, contents: `
        export * from ${JSON.stringify(path.join(desktop, 'node_modules/@tauri-apps/api/core.js'))};
        export function invoke(...args) { return globalThis.__planContentInvoke(...args); }
      `,
    }));
  } }], logLevel: 'warning',
});
