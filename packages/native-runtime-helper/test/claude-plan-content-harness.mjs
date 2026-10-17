import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export { PLAN } from './fixtures/plan-content-sdk.mjs';
export { spawnTrackedHelper, send, waitForOutput } from './claude-command-lifecycle-harness.mjs';

export async function buildPlanContentHelper() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-plan-content-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  await build({
    entryPoints: [path.resolve(import.meta.dirname, '../src/index.ts')], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
    plugins: [{ name: 'plan-content-sdk-fixture', setup(plugin) {
      plugin.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
        path: path.join(import.meta.dirname, 'fixtures/plan-content-sdk.mjs'),
      }));
      plugin.onResolve({ filter: /^@openai\/codex-sdk$/ }, () => ({ path: 'unused-codex', namespace: 'plan-fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'plan-fixture' }, () => ({ contents: 'export class Codex {}', loader: 'js' }));
    } }],
  });
  return { outfile, tempDir };
}
