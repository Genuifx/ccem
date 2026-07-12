import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

test('Settings exposes the bundled CCEM agent skill installer', async () => {
  const settingsSource = await fs.readFile(path.join(desktopDir, 'src/pages/Settings.tsx'), 'utf8');
  const enLocale = JSON.parse(await fs.readFile(path.join(desktopDir, 'src/locales/en.json'), 'utf8'));
  const zhLocale = JSON.parse(await fs.readFile(path.join(desktopDir, 'src/locales/zh.json'), 'utf8'));

  assert.match(settingsSource, /get_ccem_agent_skill_status/);
  assert.match(settingsSource, /install_ccem_agent_skill/);
  assert.match(settingsSource, /agentSkill/);
  assert.equal(enLocale.settings.agentSkill, 'Agent Skill');
  assert.equal(zhLocale.settings.agentSkill, 'Agent Skill');
});

test('bundled CCEM agent skill teaches agents to use the JSON desktop CLI wrapper', async () => {
  const skillSource = await fs.readFile(
    path.join(repoRoot, 'packages/agent-skills/ccem/SKILL.md'),
    'utf8',
  );

  assert.match(skillSource, /^---\nname: ccem\n/ms);
  assert.match(skillSource, /ccem desktop health --json/);
  assert.match(skillSource, /ccem desktop create/);
  assert.match(skillSource, /--json/);
  assert.match(skillSource, /Do not read or write ~\/\.ccem\/control\.json directly/);
});

test('bundled CCEM agent skill matches the supported cron CLI contract', async () => {
  const [skillSource, cliSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'packages/agent-skills/ccem/SKILL.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'apps/cli/src/index.ts'), 'utf8'),
  ]);
  const cronStart = cliSource.indexOf('const cronCmd = program');
  const cronEnd = cliSource.indexOf('const setupCmd = program');
  assert.notEqual(cronStart, -1);
  assert.notEqual(cronEnd, -1);

  const cronCliSource = cliSource.slice(cronStart, cronEnd);
  const cronCommands = [...cronCliSource.matchAll(/cronCmd\s*\n\s*\.command\('([^']+)'\)/g)]
    .map((match) => match[1].split(' ')[0]);

  assert.deepEqual(cronCommands, ['list', 'create', 'delete']);
  assert.match(skillSource, /supports `list`, `create`, and `delete`/);
  assert.match(skillSource, /ccem cron list --json/);
  assert.match(skillSource, /ccem cron create --from-json/);
  assert.match(skillSource, /ccem cron delete "<taskId>" --json/);
  assert.match(skillSource, /does not expose an `update`, `edit`, or `runs` command/);
  assert.match(skillSource, /use CCEM Desktop's Cron page to edit the exact task in place/);
  assert.doesNotMatch(skillSource, /ccem cron runs <taskId> --json/);
});
