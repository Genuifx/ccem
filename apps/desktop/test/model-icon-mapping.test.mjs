import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function transpilePureSource(source, fileName) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-model-icon-test-'));
  const outputPath = path.join(tempDir, fileName);
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

async function importResolveIcon() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'history', 'ModelIcon.tsx');
  const source = await fs.readFile(sourcePath, 'utf8');
  const pureSource = `
    const Grok = { title: 'Grok' };
    const Claude = {};
    const Codex = {};
    const OpenAI = {};
    const DeepSeek = {};
    const Minimax = {};
    const Moonshot = {};
    const Zhipu = {};
    const Gemini = {};
    const Ollama = {};
    const OpenRouterIcon = {};
    const Qwen = {};
    const XiaomiMiMo = {};

    export type IconEntry = {
      icon: any;
      color?: string;
      variant?: 'color' | 'avatar';
      needsContrastBg?: boolean;
    };

    ${source.slice(source.indexOf('/** Map a model ID string'), source.indexOf('export const ModelIcon'))}
  `;
  return transpilePureSource(pureSource, 'resolveIcon.mjs');
}

async function importResolveEnvironmentIconHint() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'sessionTreeIcons.tsx',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const start = source.indexOf('const TIER_MODEL_ALIASES');
  const end = source.indexOf('export function resolveSessionClient');
  const pureSource = `
    type Environment = {
      name?: string;
      baseUrl?: string;
      runtimeModel?: string;
      defaultOpusModel?: string;
      defaultSonnetModel?: string;
      defaultHaikuModel?: string;
    };

    ${source.slice(start, end)}
  `;
  return transpilePureSource(pureSource, 'resolveEnvironmentIconHint.mjs');
}

test('resolveIcon maps grok and xai model ids', async () => {
  const { resolveIcon } = await importResolveIcon();

  const grok = resolveIcon('grok-4');
  assert.ok(grok);
  assert.equal(grok.icon.title, 'Grok');
  assert.equal(grok.needsContrastBg, true);

  const xai = resolveIcon('xai/grok-code-fast-1');
  assert.ok(xai);
  assert.equal(xai.icon.title, 'Grok');

  // Keep Claude tier aliases working and not swallowed by xai/grok checks.
  const claude = resolveIcon('claude-opus-4');
  assert.ok(claude);
  assert.notEqual(claude.icon.title, 'Grok');

  assert.equal(resolveIcon('unknown-model-xyz'), null);
});

test('resolveIcon maps kimi and k3 model ids', async () => {
  const { resolveIcon } = await importResolveIcon();

  const kimi = resolveIcon('kimi-latest');
  assert.ok(kimi);
  assert.equal(kimi.needsContrastBg, true);

  const k3 = resolveIcon('k3');
  assert.ok(k3);
  assert.equal(k3.needsContrastBg, true);

  const k3_256k = resolveIcon('k3-256k');
  assert.ok(k3_256k);
  assert.equal(k3_256k.needsContrastBg, true);

  const moonshot = resolveIcon('moonshot-v1-8k');
  assert.ok(moonshot);
  assert.equal(moonshot.needsContrastBg, true);
});

test('resolveEnvironmentIconHint prefers concrete grok model over tier alias', async () => {
  const { resolveEnvironmentIconHint } = await importResolveEnvironmentIconHint();

  assert.equal(
    resolveEnvironmentIconHint({
      name: 'grok-proxy',
      baseUrl: 'https://api.x.ai',
      runtimeModel: 'opus',
      defaultOpusModel: 'grok-4',
    }),
    'grok-4',
  );

  assert.equal(
    resolveEnvironmentIconHint({
      name: 'xai-env',
      baseUrl: 'https://api.x.ai/v1',
      runtimeModel: 'opus',
      defaultOpusModel: 'opus',
    }),
    'grok',
  );

  assert.equal(
    resolveEnvironmentIconHint({
      name: 'named-grok',
      baseUrl: 'https://proxy.example.com',
      runtimeModel: 'opus',
    }),
    'named-grok',
  );
});
