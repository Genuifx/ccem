import path from 'node:path';
import { build } from 'esbuild';

export async function buildProjectTreeCollapseFixture() {
  const desktop = path.resolve(import.meta.dirname, '../..');
  await build({
    absWorkingDir: desktop,
    entryPoints: ['test/fixtures/project-tree-collapse.tsx'],
    outfile: 'test/.artifacts/project-tree-collapse.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari18',
    jsx: 'automatic',
    alias: { '@': path.join(desktop, 'src') },
    loader: { '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'isolated-project-tree-ipc',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
          path: 'core', namespace: 'fixture-ipc',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-ipc' }, () => ({
          contents: `export async function invoke(command) {
            if (command === 'get_settings') return { language: 'zh' };
            throw new Error('Project tree fixture blocked IPC: ' + command);
          }`,
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
}
