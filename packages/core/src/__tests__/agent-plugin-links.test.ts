import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importClaudePlugins } from '../agent-plugins';
import { CLAUDE_PLUGIN_LINK_LEDGER, claudePluginLinksPending, claudePluginRevision, linkClaudePlugins } from '../agent-plugin-links';

describe.skipIf(process.platform === 'win32')('shared plugin code with private CCEM state', () => {
  let home: string;
  let source: string;
  let target: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-plugin-links-')));
    source = path.join(home, '.claude');
    target = path.join(home, '.ccem/agents/claude');
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
  function write(root: string, relative: string, value: unknown) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  }
  function read(root: string, relative: string) { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
  function seed(name = 'sample', version = '1.0.0', local = false) {
    const id = `${name}@market`;
    const installPath = path.join(source, `plugins/cache/market/${name}/${version}`);
    write(installPath, '.claude-plugin/plugin.json', { name, version });
    write(installPath, 'commands/check.md', `${name}-${version}`);
    const registry = fs.existsSync(path.join(source, 'plugins/installed_plugins.json')) ? read(source, 'plugins/installed_plugins.json') : { version: 2, plugins: {} };
    registry.plugins[id] = [{ scope: 'user', version, installPath }];
    write(source, 'plugins/installed_plugins.json', registry);
    const location = path.join(source, 'plugins/marketplaces/market');
    write(source, 'plugins/known_marketplaces.json', { market: { source: { source: 'github', repo: 'fixture/market' }, installLocation: location } });
    const file = '.claude-plugin/marketplace.json';
    const catalogue = fs.existsSync(path.join(location, file)) ? read(location, file) : { name: 'market', plugins: [] };
    catalogue.plugins = catalogue.plugins.filter((entry: { name: string }) => entry.name !== name);
    catalogue.plugins.push({ name, source: local ? `./plugins/${name}` : { source: 'url', url: `https://example.invalid/${name}.git` }, version });
    write(location, file, catalogue);
    if (local) fs.cpSync(installPath, path.join(location, 'plugins', name), { recursive: true });
    const settings = fs.existsSync(path.join(source, 'settings.json')) ? read(source, 'settings.json') : {};
    (settings.enabledPlugins ??= {})[id] = true;
    write(source, 'settings.json', settings);
    return { id, installPath, code: local ? path.join(location, 'plugins', name) : installPath };
  }
  function prepare() { importClaudePlugins(source, target); linkClaudePlugins(source, target); }
  function installed(id = 'sample@market') { return read(target, 'plugins/installed_plugins.json').plugins[id]?.[0]; }

  function seedRoot(name = 'root', version = '1.0.0') {
    const id = `${name}@${name}-market`;
    const code = path.join(source, `plugins/marketplaces/${name}-market`);
    const cache = path.join(source, `plugins/cache/${name}-market/${name}/${version}`);
    for (const directory of [code, cache]) {
      write(directory, '.claude-plugin/plugin.json', { name, version });
      write(directory, 'commands/check.md', `${name}-${version}`);
    }
    write(code, '.claude-plugin/marketplace.json', { name: `${name}-market`, plugins: [{ name, source: './', version }] });
    const registrations = fs.existsSync(path.join(source, 'plugins/installed_plugins.json')) ? read(source, 'plugins/installed_plugins.json') : { version: 2, plugins: {} };
    registrations.plugins[id] = [{ scope: 'user', version, installPath: cache }];
    write(source, 'plugins/installed_plugins.json', registrations);
    const markets = fs.existsSync(path.join(source, 'plugins/known_marketplaces.json')) ? read(source, 'plugins/known_marketplaces.json') : {};
    markets[`${name}-market`] = { source: { source: 'github', repo: `fixture/${name}` }, installLocation: code };
    write(source, 'plugins/known_marketplaces.json', markets);
    const settings = fs.existsSync(path.join(source, 'settings.json')) ? read(source, 'settings.json') : {};
    (settings.enabledPlugins ??= {})[id] = true;
    write(source, 'settings.json', settings);
    return { id, code, cache };
  }

  it('links root-marketplace code with private metadata and preserves existing session paths', () => {
    const plugin = seedRoot();
    write(plugin.code, '.in_use/official', 'official marker');
    write(source, 'plugins/data/root-market/private.txt', 'official data');
    write(target, 'projects/existing.jsonl', 'existing session');
    importClaudePlugins(source, target);
    const old = installed(plugin.id);
    const official = fs.readFileSync(path.join(plugin.code, '.claude-plugin/marketplace.json'), 'utf8');
    linkClaudePlugins(source, target);
    const linked = installed(plugin.id);
    expect(fs.lstatSync(path.join(linked.installPath, '.claude-plugin')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(linked.installPath, '.claude-plugin/plugin.json')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(linked.installPath, '.claude-plugin/marketplace.json'))).toBe(false);
    expect(fs.lstatSync(path.join(linked.installPath, 'commands')).isSymbolicLink()).toBe(true);
    write(linked.installPath, '.in_use/ccem', 'ccem marker');
    expect(fs.existsSync(path.join(plugin.code, '.in_use/ccem'))).toBe(false);
    expect(fs.readFileSync(path.join(plugin.code, '.claude-plugin/marketplace.json'), 'utf8')).toBe(official);
    expect(fs.readFileSync(path.join(old.installPath, 'commands/check.md'), 'utf8')).toBe('root-1.0.0');
    expect(fs.readFileSync(path.join(target, 'projects/existing.jsonl'), 'utf8')).toBe('existing session');
    expect(fs.existsSync(path.join(target, 'plugins/data'))).toBe(false);
    expect(claudePluginLinksPending(source, target)).toBe(false);
    write(linked.installPath, '.claude-plugin/marketplace.json', { private: true });
    seedRoot('root', '2.0.0'); linkClaudePlugins(source, target);
    expect(installed(plugin.id)).toEqual(linked);
    expect(read(linked.installPath, '.claude-plugin/marketplace.json')).toEqual({ private: true });
  });

  it('imports newly installed root marketplaces and keeps disable/uninstall choices on later updates', () => {
    seed(); prepare();
    const plugin = seedRoot('later'); prepare();
    expect(installed(plugin.id).version).toContain('.ccem-layout-v2.ccem-linked-');
    const old = installed(plugin.id);
    const settings = read(target, 'settings.json'); settings.enabledPlugins[plugin.id] = false;
    write(target, 'settings.json', settings);
    seedRoot('later', '2.0.0'); prepare();
    expect(installed(plugin.id).version).toContain('2.0.0.ccem-layout-v2.ccem-linked-');
    expect(read(target, 'settings.json').enabledPlugins[plugin.id]).toBe(false);
    expect(fs.existsSync(old.installPath)).toBe(true);
    const registry = read(target, 'plugins/installed_plugins.json'); delete registry.plugins[plugin.id];
    write(target, 'plugins/installed_plugins.json', registry);
    seedRoot('later', '3.0.0'); prepare();
    expect(installed(plugin.id)).toBeUndefined();
    const next = seedRoot('next'); prepare();
    expect(installed(next.id).version).toContain('.ccem-layout-v2.ccem-linked-');
    expect(installed(plugin.id)).toBeUndefined();
  });

  it('upgrades legacy linked wrappers without rewriting paths used by running sessions', () => {
    const plugin = seed(); importClaudePlugins(source, target);
    const suffix = createHash('sha256').update(plugin.code).digest('hex').slice(0, 8);
    const version = `1.0.0.ccem-linked-${suffix}`;
    const legacy = path.join(target, 'plugins/cache/market/sample', version);
    write(legacy, '.ccem-plugin-link-v1.json', { version: 1, source: plugin.code });
    for (const name of fs.readdirSync(plugin.code)) fs.symlinkSync(path.join(plugin.code, name), path.join(legacy, name));
    const registry = read(target, 'plugins/installed_plugins.json');
    Object.assign(registry.plugins[plugin.id][0], { installPath: legacy, version });
    write(target, 'plugins/installed_plugins.json', registry);
    write(target, CLAUDE_PLUGIN_LINK_LEDGER, { version: 1, plugins: { [plugin.id]: [{ scope: 'user', projectPath: null, sourcePath: plugin.code, installPath: legacy, version }] } });
    linkClaudePlugins(source, target);
    expect(installed().installPath).not.toBe(legacy);
    expect(fs.lstatSync(path.join(legacy, '.claude-plugin')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'commands/check.md'), 'utf8')).toBe('sample-1.0.0');
    expect(fs.lstatSync(path.join(installed().installPath, '.claude-plugin')).isSymbolicLink()).toBe(false);
    expect(claudePluginLinksPending(source, target)).toBe(false);
  });

  it('preserves a locally replaced plugin manifest when an official update arrives', () => {
    const plugin = seedRoot(); prepare();
    const old = installed(plugin.id);
    const manifest = path.join(old.installPath, '.claude-plugin/plugin.json');
    fs.unlinkSync(manifest); write(old.installPath, '.claude-plugin/plugin.json', { name: 'local' });
    seedRoot('root', '2.0.0'); linkClaudePlugins(source, target);
    expect(installed(plugin.id)).toEqual(old);
    expect(read(old.installPath, '.claude-plugin/plugin.json')).toEqual({ name: 'local' });
  });

  it('preserves local edits to a wrapper published before an interrupted catalogue update', () => {
    const plugin = seedRoot(); prepare();
    const old = installed(plugin.id);
    seedRoot('root', '2.0.0');
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('marketplace.json')) throw new Error('interrupted catalogue publication');
    });
    expect(() => linkClaudePlugins(source, target)).toThrow(/interrupted catalogue publication/);
    vi.restoreAllMocks();
    const published = read(target, 'plugins/marketplaces/root-market/.claude-plugin/marketplace.json').plugins[0].source;
    write(published, '.claude-plugin/marketplace.json', { private: 'local override' });
    seedRoot('root', '3.0.0'); linkClaudePlugins(source, target);
    expect(installed(plugin.id)).toEqual(old);
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins[plugin.id][0].local).toBe(true);
    expect(read(published, '.claude-plugin/marketplace.json')).toEqual({ private: 'local override' });
  });

  it('rejects runtime marker aliases even when their target looks like ordinary code', () => {
    const plugin = seedRoot(); importClaudePlugins(source, target);
    const before = installed(plugin.id);
    fs.symlinkSync(path.join(plugin.code, 'commands'), path.join(plugin.code, '.claude-plugin/.in_use'));
    expect(() => linkClaudePlugins(source, target)).toThrow(/metadata or runtime markers/);
    expect(installed(plugin.id)).toEqual(before);
  });

  it('refreshes manifest code children and preserves a replaced private metadata directory', () => {
    const plugin = seedRoot(); prepare();
    const linked = installed(plugin.id);
    write(plugin.code, '.claude-plugin/extra.json', { code: 1 });
    linkClaudePlugins(source, target);
    expect(fs.lstatSync(path.join(linked.installPath, '.claude-plugin/extra.json')).isSymbolicLink()).toBe(true);
    fs.unlinkSync(path.join(plugin.code, '.claude-plugin/extra.json')); linkClaudePlugins(source, target);
    expect(fs.existsSync(path.join(linked.installPath, '.claude-plugin/extra.json'))).toBe(false);
    fs.rmSync(path.join(linked.installPath, '.claude-plugin'), { recursive: true });
    fs.symlinkSync(path.join(plugin.code, '.claude-plugin'), path.join(linked.installPath, '.claude-plugin'));
    seedRoot('root', '2.0.0'); linkClaudePlugins(source, target);
    expect(installed(plugin.id)).toEqual(linked);
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins[plugin.id][0].local).toBe(true);
  });

  it('upgrades copies without moving old paths, while bookkeeping and account data stay private', () => {
    const plugin = seed();
    write(source, 'plugins/data/sample/account.json', 'official account');
    write(source, 'settings.json', { enabledPlugins: { [plugin.id]: true }, secret: 'official' });
    write(target, 'projects/existing.jsonl', 'existing-session');
    write(target, '.claude.json', 'ccem-login');
    importClaudePlugins(source, target);
    const original = installed();
    const sourceRegistry = fs.readFileSync(path.join(source, 'plugins/installed_plugins.json'), 'utf8');
    write(original.installPath, '.in_use/old-query', 'old-marker');
    linkClaudePlugins(source, target);
    const linked = installed();
    expect(linked.version).toBe(path.basename(linked.installPath));
    expect(linked.version).toMatch(/^1\.0\.0\.ccem-layout-v2\.ccem-linked-[a-f0-9]{8}$/);
    expect(fs.lstatSync(linked.installPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(linked.installPath, 'commands')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(original.installPath, 'commands/check.md'), 'utf8')).toBe('sample-1.0.0');
    write(linked.installPath, '.orphaned_at', 'local-uninstall');
    write(linked.installPath, '.in_use/new-query', 'local-marker');
    expect(fs.existsSync(path.join(plugin.code, '.orphaned_at'))).toBe(false);
    expect(fs.existsSync(path.join(plugin.code, '.in_use'))).toBe(false);
    expect(read(target, 'settings.json')).toEqual({ enabledPlugins: { [plugin.id]: true } });
    expect(fs.readFileSync(path.join(target, 'projects/existing.jsonl'), 'utf8')).toBe('existing-session');
    expect(fs.readFileSync(path.join(target, '.claude.json'), 'utf8')).toBe('ccem-login');
    expect(fs.existsSync(path.join(target, 'plugins/data'))).toBe(false);
    expect(fs.readFileSync(path.join(source, 'plugins/installed_plugins.json'), 'utf8')).toBe(sourceRegistry);
  });

  it('shares in-place edits and discovers new code children, with a stable no-op revision', () => {
    const plugin = seed(); prepare();
    const initial = claudePluginRevision(target);
    write(plugin.code, 'commands/check.md', 'updated command with new contents');
    expect(fs.readFileSync(path.join(installed().installPath, 'commands/check.md'), 'utf8')).toContain('updated command');
    expect(claudePluginRevision(target)).not.toBe(initial);
    write(plugin.code, 'skills/ping/SKILL.md', 'new top-level dir');
    expect(claudePluginLinksPending(source, target)).toBe(true);
    linkClaudePlugins(source, target);
    expect(fs.readFileSync(path.join(installed().installPath, 'skills/ping/SKILL.md'), 'utf8')).toBe('new top-level dir');
    const revision = claudePluginRevision(target);
    write(installed().installPath, '.in_use/current', 'runtime-only');
    write(installed().installPath, '.orphaned_at', 'runtime-only');
    expect(claudePluginRevision(target)).toBe(revision);
    expect(claudePluginLinksPending(source, target)).toBe(false);
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const writeFile = vi.spyOn(fs, 'writeFileSync');
    linkClaudePlugins(source, target);
    expect(mkdir).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled();
  });

  it('follows source versions without restoring a CCEM disable or deleting old wrappers', () => {
    const first = seed(); prepare();
    const previous = installed();
    write(target, 'settings.json', { enabledPlugins: { [first.id]: false }, private: 'unchanged' });
    seed('sample', '2.0.0');
    expect(claudePluginLinksPending(source, target)).toBe(true);
    linkClaudePlugins(source, target);
    expect(installed().version).toMatch(/^2\.0\.0\.ccem-layout-v2\.ccem-linked-/);
    expect(fs.readFileSync(path.join(installed().installPath, 'commands/check.md'), 'utf8')).toBe('sample-2.0.0');
    expect(fs.readFileSync(path.join(previous.installPath, 'commands/check.md'), 'utf8')).toBe('sample-1.0.0');
    expect(read(target, 'settings.json')).toEqual({ enabledPlugins: { [first.id]: false }, private: 'unchanged' });
  });

  it('never resurrects a locally removed plugin, even after an official update or reinstall', () => {
    seed(); prepare();
    write(target, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    linkClaudePlugins(source, target);
    seed('sample', '2.0.0'); prepare();
    expect(installed()).toBeUndefined();
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins['sample@market']).toEqual([{ scope: 'user', projectPath: null, local: true }]);
    const next = seed('next'); prepare();
    expect(installed(next.id).version).toContain('.ccem-linked-');
    expect(installed()).toBeUndefined();
  });

  it('retains user-modified copies and separately installed updates', () => {
    seed(); importClaudePlugins(source, target);
    const copy = installed();
    write(copy.installPath, 'commands/check.md', 'local edit');
    linkClaudePlugins(source, target);
    expect(installed()).toEqual(copy);
    seed('second'); prepare();
    const registry = read(target, 'plugins/installed_plugins.json');
    registry.plugins['second@market'][0].version = 'local-update';
    write(target, 'plugins/installed_plugins.json', registry);
    seed('second', '3.0.0'); prepare();
    expect(installed('second@market').version).toBe('local-update');
    expect(fs.readFileSync(path.join(copy.installPath, 'commands/check.md'), 'utf8')).toBe('local edit');
  });

  it('shares local marketplace code through the private catalogue without linking marketplace metadata', () => {
    const plugin = seed('sample', '1.0.0', true); prepare();
    const file = 'plugins/marketplaces/market/.claude-plugin/marketplace.json';
    const original = fs.readFileSync(path.join(source, file), 'utf8');
    expect(read(target, file).plugins[0].source).toBe(installed().installPath);
    expect(fs.lstatSync(path.join(target, file)).isSymbolicLink()).toBe(false);
    write(plugin.code, 'commands/check.md', 'local catalogue update');
    expect(fs.readFileSync(path.join(installed().installPath, 'commands/check.md'), 'utf8')).toBe('local catalogue update');
    expect(fs.readFileSync(path.join(source, file), 'utf8')).toBe(original);
    expect(claudePluginLinksPending(source, target)).toBe(false);
  });

  it('lets official cache removal affect code without rewriting private choices or deleting sessions', () => {
    const plugin = seed(); prepare();
    const before = read(target, 'plugins/installed_plugins.json');
    const revision = claudePluginRevision(target);
    write(source, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    linkClaudePlugins(source, target);
    expect(fs.existsSync(path.join(installed().installPath, 'commands/check.md'))).toBe(true);
    fs.rmSync(plugin.code, { recursive: true });
    linkClaudePlugins(source, target);
    expect(claudePluginRevision(target)).not.toBe(revision);
    expect(read(target, 'plugins/installed_plugins.json')).toEqual(before);
    expect(fs.existsSync(path.join(installed().installPath, 'commands/check.md'))).toBe(false);
    seed('sample', '1.1.0'); linkClaudePlugins(source, target);
    expect(installed().version).toMatch(/^1\.1\.0\.ccem-layout-v2\.ccem-linked-/);
  });

  it('rejects escaped and private-data links without modifying target registrations', () => {
    const plugin = seed(); importClaudePlugins(source, target);
    const before = installed();
    const secret = write(source, 'plugins/data/sample/private.txt', 'private');
    fs.symlinkSync(secret, path.join(plugin.code, 'private'));
    expect(() => linkClaudePlugins(source, target)).toThrow(/private plugin data/);
    expect(installed()).toEqual(before);
    fs.unlinkSync(path.join(plugin.code, 'private'));
    const outside = write(home, 'outside.txt', 'outside');
    fs.symlinkSync(outside, path.join(plugin.code, 'outside'));
    expect(() => linkClaudePlugins(source, target)).toThrow(/escapes/);
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_LINK_LEDGER))).toBe(false);
  });

  it('retains the registry if source metadata changes while staging a new wrapper', () => {
    seed(); importClaudePlugins(source, target);
    const original = installed();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).includes('.ccem-linked-')) write(source, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    });
    expect(() => linkClaudePlugins(source, target)).toThrow(/changed during import/);
    expect(installed()).toEqual(original);
  });

  it.each(['catalogue', 'registry'])('recovers a managed version update interrupted after its %s publication', (phase) => {
    seed('sample', '1.0.0', true); prepare();
    seed('sample', '2.0.0', true);
    const rename = fs.renameSync.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      const file = phase === 'catalogue' ? 'marketplace.json' : 'installed_plugins.json';
      if (!failed && String(to).endsWith(file)) { failed = true; throw new Error('simulated interruption'); }
    });
    expect(() => linkClaudePlugins(source, target)).toThrow(/simulated interruption/);
    vi.restoreAllMocks();
    linkClaudePlugins(source, target);
    expect(installed().version).toMatch(/^2\.0\.0\.ccem-layout-v2\.ccem-linked-/);
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins['sample@market'][0].local).toBeUndefined();
    seed('sample', '3.0.0', true); linkClaudePlugins(source, target);
    expect(installed().version).toMatch(/^3\.0\.0\.ccem-layout-v2\.ccem-linked-/);
  });

  it('recovers published ownership even when the official version advances again before retry', () => {
    seed(); prepare(); seed('sample', '2.0.0');
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('installed_plugins.json')) throw new Error('interrupted before ledger');
    });
    expect(() => linkClaudePlugins(source, target)).toThrow(/interrupted before ledger/);
    vi.restoreAllMocks();
    seed('sample', '3.0.0'); linkClaudePlugins(source, target);
    expect(installed().version).toMatch(/^3\.0\.0\.ccem-layout-v2\.ccem-linked-/);
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins['sample@market'][0].local).toBeUndefined();
  });

  it.each(['installed_plugins.json', 'known_marketplaces.json', 'marketplaces/market/.claude-plugin/marketplace.json', 'cache/market/other/1/.in_use/pid'])('rejects shared code links into official metadata %s', (relative) => {
    const plugin = seed(); importClaudePlugins(source, target);
    if (relative.includes('.in_use')) write(source, `plugins/${relative}`, 'official runtime marker');
    fs.symlinkSync(path.join(source, 'plugins', relative), path.join(plugin.code, 'metadata'));
    expect(() => linkClaudePlugins(source, target)).toThrow(/metadata or runtime markers/);
    expect(installed().version).toBe('1.0.0');
  });

  it('preserves a local replacement of linked code when the official version changes', () => {
    seed(); prepare();
    const old = installed();
    fs.unlinkSync(path.join(old.installPath, 'commands'));
    write(old.installPath, 'commands/check.md', 'local replacement');
    seed('sample', '2.0.0'); linkClaudePlugins(source, target);
    expect(installed()).toEqual(old);
    expect(read(target, CLAUDE_PLUGIN_LINK_LEDGER).plugins['sample@market'][0].local).toBe(true);
    expect(fs.readFileSync(path.join(old.installPath, 'commands/check.md'), 'utf8')).toBe('local replacement');
  });
});
