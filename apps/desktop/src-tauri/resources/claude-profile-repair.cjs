// Runs in a bounded child process: a protected/cloud-backed skill must not
// strand a Desktop worker while the OS waits for file access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function noLinks(file) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (stat(p)?.isSymbolicLink()) throw new Error(`Symlinked storage path: ${p}`);
    if (p === path.dirname(p)) break;
  }
}
function document(file) {
  const info = stat(file);
  if (!info) return { raw: undefined, value: {} };
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error(`Invalid configuration file: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`Invalid JSON configuration: ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid configuration: ${file}`);
  return { raw, value };
}
function names(dir) {
  try { return fs.readdirSync(dir).filter(n => !n.startsWith('.')).sort(); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
function validName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name);
}
function inspect({ home, profile, workingDir, preflight = false }) {
  noLinks(profile);
  const project = fs.realpathSync(workingDir);
  if (!fs.statSync(project).isDirectory()) throw new Error('Working directory is not a directory');
  const config = document(path.join(profile, '.claude.json')).value;
  let source = {};
  const sourceWarnings = [];
  if (!preflight) {
    try { source = document(path.join(home, '.claude.json')).value; }
    catch (error) { sourceWarnings.push(error.message); }
  }
  const skillsDir = path.join(profile, 'skills');
  noLinks(skillsDir);
  const sourceDir = path.join(home, '.claude', 'skills');
  let sourceNames = [];
  if (!preflight) {
    try { sourceNames = names(sourceDir); }
    catch (error) { sourceWarnings.push(`Cannot list source skills: ${error.message}`); }
  }
  const candidates = new Set([...names(skillsDir), ...sourceNames]);
  const skills = [...candidates].filter(validName).sort().map(name => {
    const destination = path.join(skillsDir, name);
    const target = stat(destination);
    // Never follow a target link during inspection. The recovery is explicit.
    const source = target ? destination : path.join(sourceDir, name);
    const sourceInfo = target || stat(source);
    const sourcePath = sourceInfo?.isSymbolicLink() ? path.resolve(path.dirname(source), fs.readlinkSync(source)) : source;
    return { name, sourcePath, state: target?.isSymbolicLink() ? 'linked' : target ? 'installed' : 'available' };
  });
  return {
    workingDir: project,
    trusted: config.projects?.[project]?.hasTrustDialogAccepted === true,
    previouslyTrusted: source.projects?.[project]?.hasTrustDialogAccepted === true,
    skills,
    sourceWarnings,
  };
}
function copyTree(source, target, budget) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Nested skill symlink requires manual review: ${source}`);
  if (++budget.files > 5000) throw new Error('Skill contains too many files');
  if (info.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name), budget);
  } else if (info.isFile()) {
    budget.bytes += info.size;
    if (budget.bytes > 64 * 1024 * 1024) throw new Error('Skill exceeds the 64 MiB import limit');
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, info.mode & 0o111 ? 0o700 : 0o600);
  } else throw new Error(`Unsupported skill file: ${source}`);
}
function repair(input) {
  const { home, profile, trustProject = false, skillNames = [] } = input;
  if (!Array.isArray(skillNames) || skillNames.some(n => !validName(n))) throw new Error('Invalid skill selection');
  noLinks(profile);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const lock = path.join(profile, '.profile-repair.lock');
  if (stat(lock)) {
    const owner = document(lock).value;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1) throw new Error('Invalid profile repair lock');
    try { process.kill(owner.pid, 0); throw new Error('Another profile repair is running'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      // Only recover the dead worker's own lock, never a Claude/profile lock.
      fs.unlinkSync(lock);
    }
  }
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  const stages = [];
  try {
    const status = inspect(input);
    const root = path.join(profile, 'skills');
    noLinks(root);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Stage every selection before publishing any; never overwrite real local skills.
    for (const name of new Set(skillNames)) {
      const target = path.join(root, name);
      const old = stat(target);
      if (old && !old.isSymbolicLink()) throw new Error(`Keeping existing local skill: ${name}`);
      const source = fs.realpathSync(old ? target : path.join(home, '.claude', 'skills', name));
      if (source === profile || source.startsWith(profile + path.sep)) throw new Error('Skill source overlaps the isolated profile');
      if (!fs.statSync(source).isDirectory()) throw new Error(`Invalid skill directory: ${name}`);
      const skill = documentSizeCheck(path.join(source, 'SKILL.md'));
      if (!skill) throw new Error(`Missing SKILL.md: ${name}`);
      const stage = path.join(root, `.import-${crypto.randomUUID()}`);
      stages.push({ target, stage, oldLink: old ? fs.readlinkSync(target) : undefined });
      copyTree(source, stage, { files: 0, bytes: 0 });
    }
    const configPath = path.join(profile, '.claude.json');
    const before = document(configPath);
    if (trustProject && before.value.projects != null &&
        (typeof before.value.projects !== 'object' || Array.isArray(before.value.projects))) throw new Error('Invalid project trust data');
    const backup = path.join(profile, '.profile-repair-backups', crypto.randomUUID());
    noLinks(path.dirname(backup));
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const item of stages) {
      const current = stat(item.target);
      if (item.oldLink === undefined ? current : !current?.isSymbolicLink() || fs.readlinkSync(item.target) !== item.oldLink) {
        throw new Error('Skill changed during import; retry after other sessions finish');
      }
      const saved = path.join(backup, path.basename(item.target));
      if (item.oldLink !== undefined) fs.renameSync(item.target, saved);
      try { fs.renameSync(item.stage, item.target); } catch (error) {
        if (item.oldLink !== undefined) fs.renameSync(saved, item.target);
        throw error;
      }
    }
    if (trustProject) {
      const current = document(configPath);
      if (current.raw !== before.raw) throw new Error('Claude configuration changed; skills were imported, retry project trust separately');
      const value = before.value;
      value.projects ??= {};
      const entry = value.projects[status.workingDir];
      if (entry != null && (typeof entry !== 'object' || Array.isArray(entry))) throw new Error('Invalid project trust entry');
      value.projects[status.workingDir] = { ...entry, hasTrustDialogAccepted: true };
      if (before.raw !== undefined) fs.writeFileSync(path.join(backup, 'claude.json.before'), before.raw, { mode: 0o600, flag: 'wx' });
      const temp = path.join(profile, `.trust-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        // Recheck immediately before atomic replacement; never replace with the source config.
        if (document(configPath).raw !== before.raw) throw new Error('Claude configuration changed; retry project trust');
        fs.renameSync(temp, configPath);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return inspect(input);
  } finally {
    for (const { stage } of stages) fs.rmSync(stage, { recursive: true, force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function documentSizeCheck(file) {
  const info = fs.lstatSync(file);
  return info.isFile() && info.size > 0 && info.size <= 1024 * 1024;
}
module.exports = { inspect, repair };
if (require.main === module || process.argv[1] === undefined) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > 65536) process.exit(2);
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const result = input.action === 'repair' ? repair(input) : inspect(input);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message })); }
  });
}
