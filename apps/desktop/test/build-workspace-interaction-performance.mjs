// node test/build-workspace-interaction-performance.mjs [--baseline] [--revision <git-ref>]
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import tailwindConfig from '../tailwind.config.js';
import { interactionPerformancePlugin } from './helpers/workspace-interaction-performance-build.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(desktop, '../..');
const baseline = process.argv.includes('--baseline');
const revisionArg = process.argv.indexOf('--revision');
const revision = execFileSync('git', ['rev-parse', revisionArg < 0 ? 'HEAD' : process.argv[revisionArg + 1]],
  { cwd: repository, encoding: 'utf8' }).trim();
const variant = baseline ? 'baseline' : 'current';
const outdir = path.join(desktop, 'test/.artifacts/workspace-interaction-performance', variant);
await fs.mkdir(outdir, { recursive: true });
const manifest = {
  variant, revision, mode: 'production', provider: 'synthetic IPC only',
  visuals: 'full production CSS and GSAP; no reduced-motion override',
  builtAt: new Date().toISOString(), components: [], productionModules: [],
};
await build({
  entryPoints: [path.join(desktop, 'test/fixtures/workspace-interaction-performance-entry.tsx')],
  outfile: path.join(outdir, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm',
  jsx: 'automatic', target: 'safari15', minify: true, sourcemap: true,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
  alias: { '@': path.join(desktop, 'src') },
  define: {
    'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}',
    '__PERFORMANCE_VARIANT__': JSON.stringify(variant),
    '__PERFORMANCE_REVISION__': JSON.stringify(revision),
  },
  plugins: [interactionPerformancePlugin({ desktop, repository, baseline, revision, manifest })],
  logLevel: 'warning',
});
const cssSource = baseline
  ? execFileSync('git', ['show', `${revision}:apps/desktop/src/index.css`], { cwd: repository, encoding: 'utf8' })
  : await fs.readFile(path.join(desktop, 'src/index.css'), 'utf8');
const css = await postcss([
  tailwindcss({ ...tailwindConfig, content: [
    path.join(desktop, 'index.html'), path.join(desktop, 'src/**/*.{js,ts,jsx,tsx}'),
    path.join(desktop, 'test/fixtures/workspace-interaction-performance.tsx'),
  ] }), autoprefixer(),
]).process(cssSource, { from: path.join(desktop, 'src/index.css'), to: path.join(outdir, 'fixture.css') });
await fs.writeFile(path.join(outdir, 'fixture.css'), css.css);
await fs.writeFile(path.join(outdir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workspace interaction performance: ${variant}</title><link rel="stylesheet" href="./fixture.css"></head>
<body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>\n`);
manifest.components = [...new Set(manifest.components)].sort();
manifest.productionModules.sort();
for (const name of ['WorkspaceToolDigestComponent', 'WorkspaceTranscriptList', 'WorkspaceSessionComposer', 'PromptArea']) {
  if (!manifest.components.includes(name)) throw new Error(`Missing render probe: ${name}`);
}
if (!manifest.components.some((name) => name.startsWith('WorkspaceNativeSessionView'))) {
  throw new Error('Missing native session render probe');
}
await fs.writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ variant, revision, url: `/test/.artifacts/workspace-interaction-performance/${variant}/index.html`,
  components: manifest.components, productionModules: manifest.productionModules.length }));
