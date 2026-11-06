const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect, repair } = require('./claude-profile-repair.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ccem-profile-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, '.ccem/agents/claude');
  const workingDir = path.join(home, 'project');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workingDir);
  const config = path.join(profile, '.claude.json');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { secret: 'must-not-import' }, projects: { [workingDir]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(config, JSON.stringify({ isolatedOnly: 42, projects: { [workingDir]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] }, '/another': { hasTrustDialogAccepted: false } } }));
  return { home, profile, workingDir, config };
}
function skill(root, name) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\nTest skill`);
  fs.mkdirSync(path.join(dir, 'references')); fs.writeFileSync(path.join(dir, 'references/a.md'), 'reference');
  return dir;
}
test('inspection and skill-only repair never adopt legacy trust or credentials', t => {
  const f = fixture(t); const before = fs.readFileSync(f.config, 'utf8');
  const state = inspect(f);
  assert.equal(state.previouslyTrusted, true); assert.equal(state.trusted, false);
  repair({ ...f, trustProject: false });
  assert.equal(fs.readFileSync(f.config, 'utf8'), before);
});
test('explicit trust changes only the selected project and keeps a private backup', t => {
  const f = fixture(t); const before = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  assert.equal(repair({ ...f, trustProject: true }).trusted, true);
  const after = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  before.projects[f.workingDir].hasTrustDialogAccepted = true;
  assert.deepEqual(after, before); assert.equal(after.oauthAccount, undefined);
  const backup = fs.readdirSync(path.join(f.profile, '.profile-repair-backups'))[0];
  assert.ok(fs.existsSync(path.join(f.profile, '.profile-repair-backups', backup, 'claude.json.before')));
});
test('imports selected source skills and materializes external links with references', t => {
  const f = fixture(t);
  skill(path.join(f.home, '.claude/skills'), 'source');
  const external = skill(path.join(f.home, 'Documents'), 'linked');
  fs.mkdirSync(path.join(f.profile, 'skills'), { recursive: true });
  fs.symlinkSync(external, path.join(f.profile, 'skills/linked'), 'dir');
  assert.equal(inspect(f).skills.find(s => s.name === 'linked').state, 'linked');
  repair({ ...f, skillNames: ['source', 'linked'] });
  assert.equal(fs.lstatSync(path.join(f.profile, 'skills/linked')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(f.profile, 'skills/linked/references/a.md'), 'utf8'), 'reference');
  fs.writeFileSync(path.join(external, 'SKILL.md'), 'source changed');
  assert.notEqual(fs.readFileSync(path.join(f.profile, 'skills/linked/SKILL.md'), 'utf8'), 'source changed');
  assert.equal(inspect(f).trusted, false);
});
test('keeps local skills, rejects traversal and nested symlinks without granting trust', t => {
  const f = fixture(t);
  const local = skill(path.join(f.profile, 'skills'), 'local');
  assert.throws(() => repair({ ...f, skillNames: ['local'], trustProject: true }), /Keeping existing/);
  assert.throws(() => repair({ ...f, skillNames: ['../escape'] }), /Invalid skill/);
  const source = skill(path.join(f.home, '.claude/skills'), 'nested');
  fs.symlinkSync(local, path.join(source, 'outside'), 'dir');
  assert.throws(() => repair({ ...f, skillNames: ['nested'], trustProject: true }), /Nested skill symlink/);
  assert.equal(inspect(f).trusted, false);
  assert.equal(fs.existsSync(path.join(f.profile, 'skills/nested')), false);
});
test('rejects configuration links and a live worker lock', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.profile, '.profile-repair.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => repair({ ...f, trustProject: true }), /Another profile repair/);
  fs.unlinkSync(path.join(f.profile, '.profile-repair.lock'));
  fs.unlinkSync(f.config); fs.symlinkSync(path.join(f.home, '.claude.json'), f.config);
  assert.throws(() => repair({ ...f, trustProject: true }), /Invalid configuration file/);
});

test('optional broken legacy sources do not block isolated project trust', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude.json'), 'broken JSON');
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude/skills'), 'not a directory');
  const state = inspect(f);
  assert.equal(state.previouslyTrusted, false);
  assert.equal(state.sourceWarnings.length, 2);
  assert.equal(repair({ ...f, trustProject: true }).trusted, true);
});
