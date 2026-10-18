import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Seen plugin IDs are never imported again: local uninstalls and scope changes stay local. */
export const CLAUDE_PLUGIN_IMPORT_LEDGER = '.ccem-plugins-import-v1.json';
type ObjectValue = Record<string, unknown>;
type Identity = { scope: string; projectPath: string | null };
type Ledger = { version: 1; seen: Record<string, Identity[]> };
type Document = { file: string; before?: string; value: ObjectValue };
type Copy = { source: string; target: string; directory: boolean; mode: number };

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as ObjectValue;
}

function stat(file: string) {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function noLinks(file: string): void {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (stat(current)?.isSymbolicLink()) throw new Error(`Plugin import cannot use a destination symlink: ${current}`);
  }
}

function readDocument(file: string, fallback: ObjectValue = {}): Document {
  noLinks(file);
  const info = stat(file);
  if (!info) return { file, value: structuredClone(fallback) };
  if (!info.isFile()) throw new Error(`Plugin metadata is not a file: ${file}`);
  const before = fs.readFileSync(file, 'utf8');
  return { file, before, value: object(JSON.parse(before), `plugin metadata: ${file}`) };
}

function pluginId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error('Invalid plugin identity');
  }
}

function identity(value: unknown): Identity {
  const row = object(value, 'plugin install');
  if (typeof row.scope !== 'string' || !['user', 'project', 'local'].includes(row.scope)) throw new Error('Invalid plugin scope');
  const projectPath = row.projectPath ?? null;
  if (row.scope === 'user' ? projectPath !== null
    : typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || projectPath.split(/[\\/]/).includes('..')) {
    throw new Error('Invalid plugin project scope');
  }
  return { scope: row.scope as string, projectPath: projectPath as string | null };
}

function same(a: Identity, b: Identity): boolean {
  return a.scope === b.scope && a.projectPath === b.projectPath;
}

function registry(document: Document): Record<string, ObjectValue[]> {
  if (document.value.version !== 2) throw new Error('Unsupported Claude plugin registry version');
  const plugins = object(document.value.plugins, 'Claude plugin registry');
  for (const [id, rows] of Object.entries(plugins)) {
    pluginId(id);
    if (!Array.isArray(rows)) throw new Error('Invalid plugin installations');
    const seen: Identity[] = [];
    for (const row of rows) {
      const key = identity(row);
      if (seen.some((old) => same(old, key))) throw new Error('Duplicate plugin installation identity');
      seen.push(key);
    }
  }
  return plugins as Record<string, ObjectValue[]>;
}

function readLedger(target: string): Document & { value: Ledger } {
  const document = readDocument(path.join(target, CLAUDE_PLUGIN_IMPORT_LEDGER), { version: 1, seen: {} });
  if (document.value.version !== 1 || Object.keys(document.value).some((key) => !['version', 'seen'].includes(key))) {
    throw new Error('Unsupported Claude plugin import ledger');
  }
  for (const [id, rows] of Object.entries(object(document.value.seen, 'plugin import ledger'))) {
    pluginId(id);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Invalid plugin import ledger');
    const parsed: Identity[] = [];
    for (const row of rows) {
      if (!Object.hasOwn(object(row, 'plugin import identity'), 'projectPath')
        || Object.keys(row).some((key) => !['scope', 'projectPath'].includes(key))) {
        throw new Error('Invalid plugin import identity');
      }
      const item = identity(row);
      if (parsed.some((old) => same(old, item))) throw new Error('Duplicate plugin import identity');
      parsed.push(item);
    }
  }
  return document as Document & { value: Ledger };
}

function readSource(source: string): Document {
  return readDocument(path.join(source, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {} });
}

export function claudePluginImportPending(source: string, target: string): boolean {
  const installed = registry(readSource(source));
  const ledger = readLedger(target).value;
  return Object.entries(installed).some(([id, rows]) => rows.length > 0 && !Object.hasOwn(ledger.seen, id));
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function rejectPrivateData(root: string, file: string): void {
  if (path.relative(root, file).split(path.sep)[0] === 'data') {
    throw new Error('Plugin import cannot copy private plugin data');
  }
}

function relocated(value: unknown, source: string, target: string): { source: string; target: string } {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Plugin installation path must be absolute');
  const resolved = path.resolve(value);
  if (!contained(source, resolved)) throw new Error('Plugin path escapes the official plugin store');
  rejectPrivateData(source, resolved);
  return { source: resolved, target: path.join(target, path.relative(source, resolved)) };
}

/** Materialize confined links (including cache -> marketplace links), never share mutable files. */
function planCopy(source: string, target: string, sourceRoot: string, copies: Copy[], excluded = new Set<string>(), ancestors = new Set<string>()): void {
  if (excluded.has(target)) return;
  const resolved = fs.realpathSync(source);
  if (resolved !== sourceRoot && !contained(sourceRoot, resolved)) throw new Error('Plugin symlink escapes the official plugin store');
  rejectPrivateData(sourceRoot, resolved);
  if (ancestors.has(resolved)) throw new Error('Plugin symlink cycle');
  noLinks(target);
  const info = fs.statSync(resolved);
  const existing = stat(target);
  if (info.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new Error('Plugin destination directory conflicts with a file');
    copies.push({ source: resolved, target, directory: true, mode: 0o700 });
    const next = new Set(ancestors).add(resolved);
    for (const name of fs.readdirSync(resolved).sort()) planCopy(path.join(resolved, name), path.join(target, name), sourceRoot, copies, excluded, next);
  } else if (info.isFile()) {
    if (existing) {
      if (!existing.isFile() || !fs.readFileSync(target).equals(fs.readFileSync(resolved))) {
        throw new Error('Existing CCEM plugin files differ; keeping the CCEM copy');
      }
      return;
    }
    copies.push({ source: resolved, target, directory: false, mode: 0o600 | (info.mode & 0o111) });
  } else {
    throw new Error('Plugin asset is not a regular file or directory');
  }
}

function privateDirectory(directory: string): void {
  noLinks(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function publishCopy(copy: Copy): void {
  noLinks(copy.target);
  if (copy.directory) { privateDirectory(copy.target); return; }
  privateDirectory(path.dirname(copy.target));
  const temporary = `${copy.target}.ccem-${randomUUID()}.tmp`;
  let input: number | undefined;
  let output: number | undefined;
  try {
    input = fs.openSync(copy.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(input);
    if (!before.isFile()) throw new Error('Plugin source changed during import');
    output = fs.openSync(temporary, 'wx', copy.mode);
    const buffer = Buffer.alloc(1024 * 1024);
    let remaining = before.size;
    while (remaining > 0) {
      const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) throw new Error('Plugin source changed during import');
      let offset = 0;
      while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
      remaining -= count;
    }
    const after = fs.fstatSync(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Plugin source changed during import');
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = undefined;
    noLinks(copy.target);
    try { fs.linkSync(temporary, copy.target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || !stat(copy.target)?.isFile() || !fs.readFileSync(copy.target).equals(fs.readFileSync(temporary))) throw error;
    }
  } finally {
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    fs.rmSync(temporary, { force: true });
  }
}

function unchanged(document: Document): void {
  noLinks(document.file);
  const current = stat(document.file) ? fs.readFileSync(document.file, 'utf8') : undefined;
  if (current !== document.before) throw new Error('Plugin metadata changed during import; retry later');
}

function publishDocument(document: Document, target: string): void {
  const contents = `${JSON.stringify(document.value, null, 2)}\n`;
  if (document.before !== undefined && JSON.stringify(JSON.parse(document.before)) === JSON.stringify(document.value)) return;
  unchanged(document);
  privateDirectory(path.dirname(document.file));
  if (document.before !== undefined) {
    const backup = path.join(target, '.ccem-plugins-backup-v1', path.relative(target, document.file));
    privateDirectory(path.dirname(backup));
    noLinks(backup);
    const existing = stat(backup);
    if (existing && !existing.isFile()) throw new Error('Plugin metadata backup is not a file');
    if (!existing) fs.writeFileSync(backup, document.before, { flag: 'wx', mode: 0o600 });
  }
  const temporary = `${document.file}.ccem-${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    unchanged(document);
    fs.renameSync(temporary, document.file);
    document.before = contents;
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Caller holds the shared agent migration lock. Import only previously unseen installations. */
export function importClaudePlugins(sourceHome: string, targetHome: string): { imported: number; observed: number } {
  const sourceRegistry = readSource(sourceHome);
  const sourcePlugins = registry(sourceRegistry);
  const ledger = readLedger(targetHome);
  const pending = Object.entries(sourcePlugins).flatMap(([id, installs]) => installs
    .filter(() => !Object.hasOwn(ledger.value.seen, id))
    .map((install) => ({ id, install, identity: identity(install) })));
  if (!pending.length) return { imported: 0, observed: 0 };
  noLinks(path.join(sourceHome, 'plugins'));
  const sourceRoot = fs.realpathSync(path.join(sourceHome, 'plugins'));
  const targetRoot = path.join(targetHome, 'plugins');
  if (sourceRoot === path.resolve(targetRoot) || contained(sourceRoot, path.resolve(targetRoot))
    || contained(path.resolve(targetRoot), sourceRoot)) throw new Error('Plugin stores must not overlap');
  noLinks(targetRoot);
  const sourceSettings = readDocument(path.join(sourceHome, 'settings.json'));
  const sourceMarkets = readDocument(path.join(sourceRoot, 'known_marketplaces.json'));
  const targetRegistry = readDocument(path.join(targetRoot, 'installed_plugins.json'), { version: 2, plugins: {} });
  const targetPlugins = registry(targetRegistry);
  const targetSettings = readDocument(path.join(targetHome, 'settings.json'));
  const targetMarkets = readDocument(path.join(targetRoot, 'known_marketplaces.json'));
  const existingMarketplaces = new Set(Object.keys(targetMarkets.value));
  const sourceCatalogues = new Map<string, Document>();
  const targetCatalogues = new Map<string, Document>();
  const catalogueFiles = new Set<string>();
  const copies: Copy[] = [];
  function sourceCatalogue(location: string): Document {
    const file = fs.realpathSync(path.join(location, '.claude-plugin/marketplace.json'));
    if (!contained(sourceRoot, file)) throw new Error('Marketplace manifest escapes the official plugin store');
    rejectPrivateData(sourceRoot, file);
    const document = sourceCatalogues.get(file) ?? readDocument(file);
    if (!Array.isArray(document.value.plugins)) throw new Error('Invalid plugin marketplace catalogue');
    sourceCatalogues.set(file, document);
    return document;
  }
  function localCatalogueEntry(entry: ObjectValue, from: string, to: string): void {
    const local = typeof entry.source === 'string' ? entry.source
      : entry.source && typeof entry.source === 'object' && ['directory', 'file'].includes(String((entry.source as ObjectValue).source))
        ? (entry.source as ObjectValue).path : undefined;
    if (local === undefined) return; // URL and git-subdir sources keep their repository-relative metadata.
    if (typeof local !== 'string') throw new Error('Invalid local marketplace plugin source');
    const original = path.resolve(from, local);
    const destination = path.isAbsolute(local) ? relocated(local, sourceRoot, targetRoot).target : path.resolve(to, local);
    if (!contained(sourceRoot, original) || !contained(targetRoot, destination)) throw new Error('Local marketplace source escapes its plugin store');
    rejectPrivateData(targetRoot, destination);
    planCopy(original, destination, sourceRoot, copies, catalogueFiles);
    if (path.isAbsolute(local)) {
      if (typeof entry.source === 'string') entry.source = destination;
      else (entry.source as ObjectValue).path = destination;
    }
  }
  let imported = 0;
  const visitedIds = new Set<string>();
  for (const { id, install, identity: key } of pending) {
    if (!targetPlugins[id]?.some((existing) => same(identity(existing), key))) {
      const location = relocated(install.installPath, sourceRoot, targetRoot);
      planCopy(location.source, location.target, sourceRoot, copies);
      (targetPlugins[id] ??= []).push({ ...install, installPath: location.target });
      imported += 1;
    }
    if (!visitedIds.has(id)) {
      visitedIds.add(id);
      const marketplace = id.split('@')[1];
      if (!Object.hasOwn(sourceMarkets.value, marketplace) && !Object.hasOwn(targetMarkets.value, marketplace)) {
        throw new Error(`Plugin is missing its marketplace registration: ${id}`);
      }
      if (Object.hasOwn(sourceMarkets.value, marketplace) && !Object.hasOwn(targetMarkets.value, marketplace)) {
        const entry = structuredClone(object(sourceMarkets.value[marketplace], 'marketplace'));
        const location = relocated(entry.installLocation, sourceRoot, targetRoot);
        const catalogue = sourceCatalogue(location.source);
        const file = path.join(location.target, '.claude-plugin/marketplace.json');
        const destination = readDocument(file);
        const existingCatalogue = destination.value;
        destination.value = structuredClone(catalogue.value);
        targetCatalogues.set(file, destination);
        catalogueFiles.add(file);
        for (const item of destination.value.plugins as unknown[]) {
          const plugin = object(item, 'catalogue plugin');
          localCatalogueEntry(plugin, location.source, location.target);
        }
        if (destination.before !== undefined && JSON.stringify(existingCatalogue) !== JSON.stringify(destination.value)) {
          throw new Error('Existing CCEM marketplace catalogue differs; keeping the CCEM copy');
        }
        for (const newId of pending.filter((item) => item.id.split('@')[1] === marketplace).map((item) => item.id)) {
          if (!(destination.value.plugins as ObjectValue[]).some((item) => item.name === newId.split('@')[0])) {
            throw new Error(`Plugin is missing from its marketplace catalogue: ${newId}`);
          }
        }
        planCopy(location.source, location.target, sourceRoot, copies, catalogueFiles);
        entry.installLocation = location.target;
        if (entry.source && typeof entry.source === 'object' && ['directory', 'file'].includes(String((entry.source as ObjectValue).source)) && 'path' in entry.source) {
          const local = relocated((entry.source as ObjectValue).path, sourceRoot, targetRoot);
          planCopy(local.source, local.target, sourceRoot, copies, catalogueFiles);
          (entry.source as ObjectValue).path = local.target;
        }
        targetMarkets.value[marketplace] = entry;
      }
      // A later install from a previously copied marketplace needs its catalogue entry too.
      if (existingMarketplaces.has(marketplace) && Object.hasOwn(sourceMarkets.value, marketplace)) {
        const from = relocated(object(sourceMarkets.value[marketplace], 'marketplace').installLocation, sourceRoot, targetRoot);
        const to = relocated(object(targetMarkets.value[marketplace], 'marketplace').installLocation, targetRoot, targetRoot);
        const targetFile = path.join(to.target, '.claude-plugin/marketplace.json');
        const officialCatalogue = sourceCatalogue(from.source);
        const targetCatalogue = targetCatalogues.get(targetFile) ?? readDocument(targetFile);
        targetCatalogues.set(targetFile, targetCatalogue);
        catalogueFiles.add(targetFile);
        if (!Array.isArray(officialCatalogue.value.plugins) || !Array.isArray(targetCatalogue.value.plugins)) {
          throw new Error('Invalid plugin marketplace catalogue');
        }
        const name = id.split('@')[0];
        if (!targetCatalogue.value.plugins.some((entry) => object(entry, 'catalogue plugin').name === name)) {
          const entry = officialCatalogue.value.plugins.find((entry) => object(entry, 'catalogue plugin').name === name);
          if (!entry) throw new Error(`Plugin is missing from its marketplace catalogue: ${id}`);
          const importedEntry = structuredClone(object(entry, 'catalogue plugin'));
          localCatalogueEntry(importedEntry, from.source, to.target);
          targetCatalogue.value.plugins.push(importedEntry);
        }
      }
      for (const [field, entryKey] of [['enabledPlugins', id], ['extraKnownMarketplaces', marketplace]]) {
        if (field === 'enabledPlugins' && !pending.some((item) => item.id === id && item.identity.scope === 'user')) continue;
        const from = sourceSettings.value[field] === undefined ? {} : object(sourceSettings.value[field], field);
        const to = targetSettings.value[field] === undefined ? {} : object(targetSettings.value[field], field);
        if (Object.hasOwn(from, entryKey) && !Object.hasOwn(to, entryKey)) {
          const value = structuredClone(from[entryKey]);
          if (field === 'enabledPlugins' && typeof value !== 'boolean') throw new Error('Invalid plugin enablement');
          if (field === 'extraKnownMarketplaces') {
            const extra = object(value, field);
            if (extra.source && typeof extra.source === 'object' && ['directory', 'file'].includes(String((extra.source as ObjectValue).source)) && 'path' in extra.source) {
              const local = relocated((extra.source as ObjectValue).path, sourceRoot, targetRoot);
              planCopy(local.source, local.target, sourceRoot, copies, catalogueFiles);
              (extra.source as ObjectValue).path = local.target;
            }
          }
          to[entryKey] = value;
          targetSettings.value[field] = to;
        }
      }
    }
    (ledger.value.seen[id] ??= []).push(key);
  }
  const sources = [sourceRegistry, sourceSettings, sourceMarkets, ...sourceCatalogues.values()];
  // Publish catalogues before registering them so an interrupted import can be retried.
  const targets = [...targetCatalogues.values(), targetMarkets, targetRegistry, targetSettings, ledger];
  for (const document of [...sources, ...targets]) unchanged(document);
  for (const copy of copies) if (!catalogueFiles.has(copy.target)) publishCopy(copy);
  for (const document of [...sources, ...targets]) unchanged(document);
  for (const document of targets) {
    for (const observed of [...sources, ...targets]) unchanged(observed);
    // Do not create meaningless empty settings/marketplace files.
    if (document.before === undefined && Object.keys(document.value).length === 0) continue;
    publishDocument(document, targetHome);
  }
  return { imported, observed: pending.length };
}
