import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudePluginImportPending, CLAUDE_PLUGIN_IMPORT_LEDGER, importClaudePlugins } from '../agent-plugins';
import { buildIsolatedAgentEnv, ensureCcemAgentHome } from '../agent-home';

describe('incremental isolated Claude plugins', () => {
  let home: string;
  let source: string;
  let target: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-plugin-import-')));
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
  function seed(name = 'sample', scope = 'user', projectPath: string | null = null) {
    const id = `${name}@market`;
    const installPath = path.join(source, `plugins/cache/market/${name}/1.0.0`);
    write(installPath, '.claude-plugin/plugin.json', { name, version: '1.0.0' });
    write(installPath, 'skills/ping/SKILL.md', `---\nname: ping\n---\n${name} fixture`);
    const script = write(installPath, 'bin/ping', '#!/bin/sh\nprintf fixture');
    fs.chmodSync(script, 0o755);
    const existing = fs.existsSync(path.join(source, 'plugins/installed_plugins.json'))
      ? read(source, 'plugins/installed_plugins.json') : { version: 2, plugins: {} };
    existing.plugins[id] = [{ scope, ...(projectPath ? { projectPath } : {}), installPath, version: '1.0.0' }];
    write(source, 'plugins/installed_plugins.json', existing);
    write(source, 'plugins/known_marketplaces.json', { market: { source: { source: 'github', repo: 'fixture/market' }, installLocation: path.join(source, 'plugins/marketplaces/market') } });
    const catalogueFile = 'plugins/marketplaces/market/.claude-plugin/marketplace.json';
    const catalogue = fs.existsSync(path.join(source, catalogueFile)) ? read(source, catalogueFile) : { name: 'market', plugins: [] };
    catalogue.plugins.push({ name, source: `./plugins/${name}`, version: '1.0.0' });
    write(source, catalogueFile, catalogue);
    fs.cpSync(installPath, path.join(source, 'plugins/marketplaces/market/plugins', name), { recursive: true });
    const settings = fs.existsSync(path.join(source, 'settings.json')) ? read(source, 'settings.json') : {};
    if (scope === 'user') (settings.enabledPlugins ??= {})[id] = true;
    settings.env = { ANTHROPIC_AUTH_TOKEN: 'must-not-copy' };
    settings.hooks = { SessionStart: ['must-not-copy'] };
    write(source, 'settings.json', settings);
    write(source, '.credentials.json', 'must-not-copy');
    return { id, installPath };
  }

  it('upgrades an initialized profile and preserves the existing session, login and history bytes', () => {
    const plugin = seed();
    write(target, '.ccem-migration-v1.json', { version: 1 });
    const history = write(target, 'projects/project/old.jsonl', 'existing-session-id');
    write(target, '.claude.json', { login: 'ccem-login' });
    const registry = write(target, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    const originalRegistry = fs.readFileSync(registry, 'utf8');
    const sourceSettings = fs.readFileSync(path.join(source, 'settings.json'), 'utf8');
    expect(ensureCcemAgentHome('claude', { HOME: home })).toBe(target);
    const record = read(target, 'plugins/installed_plugins.json').plugins[plugin.id][0];
    expect(record.installPath).toBe(path.join(target, 'plugins/cache/market/sample', record.version));
    expect(record.version).toMatch(/^1\.0\.0\.ccem-layout-v2\.ccem-linked-/);
    expect(fs.lstatSync(record.installPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(record.installPath, 'bin')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(record.installPath, 'skills/ping/SKILL.md'), 'utf8')).toContain('sample fixture');
    expect(read(target, 'settings.json')).toEqual({ enabledPlugins: { [plugin.id]: true } });
    expect(fs.readFileSync(history, 'utf8')).toBe('existing-session-id');
    expect(read(target, '.claude.json')).toEqual({ login: 'ccem-login' });
    expect(fs.existsSync(path.join(target, '.credentials.json'))).toBe(false);
    expect(fs.readFileSync(path.join(source, 'settings.json'), 'utf8')).toBe(sourceSettings);
    expect(fs.readFileSync(path.join(target, '.ccem-plugins-backup-v1/plugins/installed_plugins.json'), 'utf8')).toBe(originalRegistry);
    expect(fs.statSync(path.join(record.installPath, 'bin/ping')).ino).toBe(fs.statSync(path.join(source, 'plugins/marketplaces/market/plugins/sample/bin/ping')).ino);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(record.installPath, 'bin/ping')).mode & 0o100).toBeTruthy();
  });

  it('imports later new installations while retaining local disables and uninstalls across source updates', () => {
    const first = seed('first');
    importClaudePlugins(source, target);
    write(target, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    write(target, 'settings.json', { enabledPlugins: { [first.id]: false }, theme: 'existing' });
    const registry = read(source, 'plugins/installed_plugins.json');
    registry.plugins[first.id][0].version = '2.0.0';
    write(source, 'plugins/installed_plugins.json', registry);
    const second = seed('second');
    expect(claudePluginImportPending(source, target)).toBe(true);
    expect(importClaudePlugins(source, target)).toEqual({ imported: 1, observed: 1 });
    expect(read(target, 'plugins/marketplaces/market/.claude-plugin/marketplace.json').plugins.map((entry: { name: string }) => entry.name)).toEqual(['first', 'second']);
    expect(fs.readFileSync(path.join(target, 'plugins/marketplaces/market/plugins/second/skills/ping/SKILL.md'), 'utf8')).toContain('second fixture');
    expect(read(target, 'plugins/installed_plugins.json').plugins).not.toHaveProperty(first.id);
    expect(read(target, 'settings.json')).toEqual({ theme: 'existing', enabledPlugins: { [first.id]: false, [second.id]: true } });
    const before = fs.statSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER)).mtimeMs;
    expect(claudePluginImportPending(source, target)).toBe(false);
    expect(importClaudePlugins(source, target)).toEqual({ imported: 0, observed: 0 });
    expect(fs.statSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER)).mtimeMs).toBe(before);
    // Changing or deleting the original installation no longer affects CCEM's files.
    const localPath = read(target, 'plugins/installed_plugins.json').plugins[second.id][0].installPath;
    fs.rmSync(second.installPath, { recursive: true });
    expect(fs.readFileSync(path.join(localPath, 'skills/ping/SKILL.md'), 'utf8')).toContain('second fixture');
    registry.plugins[first.id].push({ scope: 'project', projectPath: path.join(home, 'another-project'), installPath: first.installPath, version: '3.0.0' });
    write(source, 'plugins/installed_plugins.json', registry);
    expect(claudePluginImportPending(source, target)).toBe(false);
  });

  it('adopts an existing destination identity without replacing its code or false enablement', () => {
    const plugin = seed();
    const local = path.join(target, 'plugins/cache/local/sample/9');
    write(local, 'skills/ping/SKILL.md', 'local-version');
    write(target, 'plugins/installed_plugins.json', { version: 2, plugins: { [plugin.id]: [{ scope: 'user', installPath: local, version: '9' }] } });
    write(target, 'settings.json', { enabledPlugins: { [plugin.id]: false }, env: { PRIVATE: 'local' } });
    importClaudePlugins(source, target);
    expect(read(target, 'plugins/installed_plugins.json').plugins[plugin.id][0].version).toBe('9');
    expect(read(target, 'settings.json')).toEqual({ enabledPlugins: { [plugin.id]: false }, env: { PRIVATE: 'local' } });
    write(target, 'plugins/installed_plugins.json', { version: 2, plugins: {} });
    importClaudePlugins(source, target);
    expect(read(target, 'plugins/installed_plugins.json').plugins).toEqual({});
  });

  it('keeps project installations scoped and does not globally enable them', () => {
    const project = path.join(home, 'work');
    const plugin = seed('scoped', 'project', project);
    importClaudePlugins(source, target);
    expect(read(target, 'plugins/installed_plugins.json').plugins[plugin.id][0]).toMatchObject({ scope: 'project', projectPath: project });
    expect(fs.existsSync(path.join(target, 'settings.json'))).toBe(false);
  });

  it('rebases absolute local catalogue sources but retains repository-relative git-subdir paths', () => {
    const plugin = seed();
    const file = 'plugins/marketplaces/market/.claude-plugin/marketplace.json';
    const catalogue = read(source, file);
    catalogue.plugins[0].source = plugin.installPath;
    catalogue.plugins.push({ name: 'remote', source: { source: 'git-subdir', url: 'https://example.invalid/repo.git', path: 'plugins/remote' } });
    write(source, file, catalogue);
    importClaudePlugins(source, target);
    const copied = read(target, file);
    expect(copied.plugins[0].source).toBe(path.join(target, 'plugins/cache/market/sample/1.0.0'));
    expect(copied.plugins[1].source.path).toBe('plugins/remote');
    expect(read(source, file).plugins[0].source).toBe(plugin.installPath);
  });

  it('does not write or chmod an already prepared profile without new plugins', () => {
    seed();
    write(target, '.ccem-migration-v1.json', { version: 1 });
    ensureCcemAgentHome('claude', { HOME: home });
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const chmod = vi.spyOn(fs, 'chmodSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');
    ensureCcemAgentHome('claude', { HOME: home });
    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects malformed identities before copying or marking them imported', () => {
    const plugin = seed();
    const registry = read(source, 'plugins/installed_plugins.json');
    registry.plugins[plugin.id][0].scope = ['project'];
    registry.plugins[plugin.id][0].projectPath = path.join(home, 'project');
    write(source, 'plugins/installed_plugins.json', registry);
    expect(() => importClaudePlugins(source, target)).toThrow(/scope/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('materializes legitimate plugin links into independent files', () => {
    const plugin = seed();
    const shared = write(source, 'plugins/marketplaces/market/shared/script.sh', '#!/bin/sh\necho fixture');
    fs.symlinkSync(path.dirname(shared), path.join(plugin.installPath, 'scripts'));
    importClaudePlugins(source, target);
    const local = path.join(target, 'plugins/cache/market/sample/1.0.0/scripts/script.sh');
    expect(fs.lstatSync(path.dirname(local)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(local, 'utf8')).toContain('fixture');
    fs.writeFileSync(shared, 'official-updated');
    expect(fs.readFileSync(local, 'utf8')).not.toBe('official-updated');
  });

  it.skipIf(process.platform === 'win32')('rejects escaping source links before publishing metadata and permits later safe retry', () => {
    const plugin = seed();
    const outside = write(home, 'private/secret.txt', 'secret');
    const link = path.join(plugin.installPath, 'escape');
    fs.symlinkSync(outside, link);
    expect(() => importClaudePlugins(source, target)).toThrow(/escapes/);
    expect(fs.existsSync(path.join(target, 'plugins/installed_plugins.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER))).toBe(false);
    fs.unlinkSync(link);
    expect(importClaudePlugins(source, target).imported).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('never follows a destination registry symlink', () => {
    seed();
    const outside = write(home, 'existing.json', 'untouched');
    fs.mkdirSync(path.join(target, 'plugins'), { recursive: true });
    fs.symlinkSync(outside, path.join(target, 'plugins/installed_plugins.json'));
    expect(() => importClaudePlugins(source, target)).toThrow(/symlink/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });

  it.skipIf(process.platform === 'win32')('never imports official plugin private data through a confined link', () => {
    const plugin = seed();
    const privateData = write(source, 'plugins/data/sample/private.json', 'private-plugin-account');
    fs.symlinkSync(path.dirname(privateData), path.join(plugin.installPath, 'account'));
    expect(() => importClaudePlugins(source, target)).toThrow(/private plugin data/);
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER))).toBe(false);
    expect(fs.existsSync(path.join(target, 'plugins/installed_plugins.json'))).toBe(false);
    expect(fs.readFileSync(privateData, 'utf8')).toBe('private-plugin-account');
  });

  it('does not block a resumed conversation when source plugin metadata is corrupt', () => {
    write(target, '.ccem-migration-v1.json', { version: 1 });
    write(target, 'projects/old.jsonl', 'existing');
    write(source, 'plugins/installed_plugins.json', 'invalid');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ensureCcemAgentHome('claude', { HOME: home })).toBe(target);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('deferred'));
    expect(fs.readFileSync(path.join(target, 'projects/old.jsonl'), 'utf8')).toBe('existing');
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER))).toBe(false);
  });

  it('defers if any observed destination metadata changes, including unchanged settings', () => {
    const plugin = seed();
    const settings = write(target, 'settings.json', { enabledPlugins: { [plugin.id]: false } });
    const rename = fs.renameSync.bind(fs);
    let edited = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (!edited && String(to).endsWith('known_marketplaces.json')) {
        edited = true;
        fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { [plugin.id]: false }, theme: 'user-edit' }));
      }
    });
    expect(() => importClaudePlugins(source, target)).toThrow(/changed during import/);
    expect(read(target, 'settings.json').theme).toBe('user-edit');
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER))).toBe(false);
    vi.restoreAllMocks();
    expect(importClaudePlugins(source, target).imported).toBe(1);
    expect(read(target, 'settings.json')).toEqual({ enabledPlugins: { [plugin.id]: false }, theme: 'user-edit' });
  });

  it('keeps differing local cache files and defers instead of mixing plugin versions', () => {
    seed();
    const local = write(target, 'plugins/cache/market/sample/1.0.0/skills/ping/SKILL.md', 'ccem-local-edit');
    expect(() => importClaudePlugins(source, target)).toThrow(/differ/);
    expect(fs.readFileSync(local, 'utf8')).toBe('ccem-local-edit');
    expect(fs.existsSync(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER))).toBe(false);
    expect(fs.existsSync(path.join(target, 'plugins/installed_plugins.json'))).toBe(false);
  });

  it('pins the plugin store even when shell or model settings try to redirect it', () => {
    const env = buildIsolatedAgentEnv({ HOME: home, CLAUDE_CODE_PLUGIN_CACHE_DIR: '/official/plugins', CLAUDE_CODE_PLUGIN_SEED_DIR: '/official/seed' }, { CLAUDE_CODE_PLUGIN_CACHE_DIR: '/model/plugins', CLAUDE_CODE_PLUGIN_SEED_DIR: '/model/seed', CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '1' });
    expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(path.join(target, 'plugins'));
    expect(env.CLAUDE_CODE_PLUGIN_SEED_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE).toBeUndefined();
  });
});
