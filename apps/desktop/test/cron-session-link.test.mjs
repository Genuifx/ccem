import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importCronSessionLink() {
  const sessionLinksPath = path.join(desktopDir, 'src', 'components', 'workspace', 'sessionLinks.ts');
  const cronLinkPath = path.join(desktopDir, 'src', 'components', 'cron', 'cronSessionLink.ts');
  const sessionLinksSource = await fs.readFile(sessionLinksPath, 'utf8');
  const cronLinkSource = await fs.readFile(cronLinkPath, 'utf8');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cron-session-link-test-'));
  const sessionLinksOut = path.join(tempDir, 'sessionLinks.mjs');
  const cronLinkOut = path.join(tempDir, 'cronSessionLink.mjs');

  const transpile = (source) => ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;

  await fs.writeFile(sessionLinksOut, transpile(sessionLinksSource), 'utf8');
  // Rewrite relative import so the compiled cron helper can load the transpiled sessionLinks module.
  let rewritten = transpile(cronLinkSource);
  rewritten = rewritten
    .replace(/from ['"]@\/components\/workspace\/sessionLinks['"];?/g, "from './sessionLinks.mjs';")
    .replace(/from ['"]\.\.\/workspace\/sessionLinks(?:\.ts)?['"];?/g, "from './sessionLinks.mjs';")
    .replace(/from ['"]\.\/sessionLinks(?:\.ts)?['"];?/g, "from './sessionLinks.mjs';");
  await fs.writeFile(cronLinkOut, rewritten, 'utf8');
  return import(pathToFileURL(cronLinkOut).href);
}

test('cron run session link prefers runtime live deep-link', async () => {
  const { buildCronRunSessionLink, getCronRunSessionAvailability } = await importCronSessionLink();
  const link = buildCronRunSessionLink({
    id: 'run-1',
    runtimeId: 'rt-1',
    providerSessionId: 'prov-1',
    workingDir: '/tmp/project',
    status: 'running',
  });

  assert.match(link, /^ccem:\/\/workspace\/session\?/);
  assert.match(link, /idKind=runtime/);
  assert.match(link, /id=rt-1/);
  assert.match(link, /runtimeId=rt-1/);
  assert.match(link, /providerSessionId=prov-1/);
  assert.match(link, /focus=live/);

  const availability = getCronRunSessionAvailability({
    id: 'run-1',
    runtimeId: 'rt-1',
    providerSessionId: 'prov-1',
    status: 'running',
  });
  assert.equal(availability.canOpen, true);
  assert.equal(availability.reason, 'live');
});

test('cron run session link falls back to provider history deep-link', async () => {
  const { buildCronRunSessionLink, getCronRunSessionAvailability } = await importCronSessionLink();
  const link = buildCronRunSessionLink({
    id: 'run-2',
    providerSessionId: 'prov-2',
    workingDir: '/tmp/project',
    status: 'success',
  });

  assert.match(link, /idKind=provider/);
  assert.match(link, /id=prov-2/);
  assert.match(link, /providerSessionId=prov-2/);
  assert.match(link, /focus=live/);

  const availability = getCronRunSessionAvailability({
    id: 'run-2',
    providerSessionId: 'prov-2',
    status: 'success',
  });
  assert.equal(availability.canOpen, true);
  assert.equal(availability.reason, 'history');
});

test('cron run session link is unavailable without session ids', async () => {
  const { buildCronRunSessionLink, getCronRunSessionAvailability } = await importCronSessionLink();
  assert.equal(buildCronRunSessionLink({ id: 'run-3', status: 'failed' }), null);
  const availability = getCronRunSessionAvailability({ id: 'run-3', status: 'failed' });
  assert.equal(availability.canOpen, false);
  assert.equal(availability.reason, 'unavailable');
  assert.equal(availability.link, null);
});
