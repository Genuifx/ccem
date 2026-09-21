// pnpm exec node test/build-transcript-read-recovery-smoke.mjs
// Then open /test/fixtures/transcript-read-recovery.html in your own Tauri dev
// WebView. This uses real 8s deadlines; the DOM test alone accelerates time.
import path from 'node:path';
import { build } from 'esbuild';
import { recoveryIpcPlugin } from './helpers/transcript-recovery-ipc.mjs';

const desktop = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(desktop, 'test/fixtures/transcript-read-recovery-entry.tsx')],
  outfile: path.join(desktop, 'test/.artifacts/build/transcript-read-recovery-smoke.js'),
  bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
  target: 'safari15', alias: { '@': path.join(desktop, 'src') },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [recoveryIpcPlugin(desktop)], logLevel: 'warning',
});
