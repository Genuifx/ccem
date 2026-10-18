import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  object, stat, noLinks, readDocument, pluginId, identity, same, registry, readLedger,
  readSource, contained, rejectPrivateData, relocated, privateDirectory, unchanged, publishDocument,
  type ObjectValue, type Identity, type Document,
} from './agent-plugins';

export const CLAUDE_PLUGIN_LINK_LEDGER = '.ccem-plugin-links-v1.json';
const MARKER = '.ccem-plugin-link-v1.json';
const BACKUP = '.ccem-plugin-links-backup-v1';
const METADATA = '.claude-plugin';
const LAYOUT = '.ccem-layout-v2';
const IGNORED = new Set(['.git', '.in_use', '.orphaned_at', MARKER]);
type Managed = Identity & { sourcePath: string; installPath: string; version: string };
type Choice = Managed | (Identity & { local: true });
type LinkLedger = { version: 1; plugins: Record<string, Choice[]> };
type LinkRoot = { source: string; target: string; changed: boolean };
type Plan = { documents: Document[]; targets: Document[]; roots: LinkRoot[]; changed: boolean; store?: string; protectedCatalogues?: Set<string> };

function absolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
}

function readLinks(target: string): Document & { value: LinkLedger } {
  const document = readDocument(path.join(target, CLAUDE_PLUGIN_LINK_LEDGER), { version: 1, plugins: {} });
  if (document.value.version !== 1 || Object.keys(document.value).some((key) => !['version', 'plugins'].includes(key))) {
    throw new Error('Unsupported plugin links ledger');
  }
  for (const [id, rows] of Object.entries(object(document.value.plugins, 'plugin links ledger'))) {
    pluginId(id);
    if (!Array.isArray(rows) || !rows.length) throw new Error('Invalid plugin link identities');
    const seen: Identity[] = [];
    for (const entry of rows) {
      const row = object(entry, 'plugin link identity');
      const key = identity(row);
      const fields = row.local === true ? ['scope', 'projectPath', 'local']
        : ['scope', 'projectPath', 'sourcePath', 'installPath', 'version'];
      if (!Object.hasOwn(row, 'projectPath') || Object.keys(row).some((field) => !fields.includes(field))
        || seen.some((old) => same(old, key))) throw new Error('Invalid plugin link identity');
      if (row.local !== true && (!absolute(row.sourcePath) || !absolute(row.installPath)
        || typeof row.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(row.version))) {
        throw new Error('Invalid managed plugin link');
      }
      if (row.local !== true) {
        const [name, market] = id.split('@');
        const suffix = `.ccem-linked-${createHash('sha256').update(row.sourcePath as string).digest('hex').slice(0, 8)}`;
        if (!(row.version as string).endsWith(suffix) || row.installPath !== path.resolve(target, 'plugins/cache', market, name, row.version as string)) {
          throw new Error('Managed plugin link escapes its CCEM cache');
        }
      }
      seen.push(key);
    }
  }
  return document as Document & { value: LinkLedger };
}

function children(root: string): string[] {
  return fs.readdirSync(root).filter((name) => !IGNORED.has(name)).sort();
}

function metadataChildren(root: string): string[] {
  return fs.readdirSync(root).filter((name) => name !== 'marketplace.json').sort();
}

/** The manifest directory is private; only its code entries are linked. */
function linkChildren(root: string, legacy = false): string[] {
  return children(root).flatMap((name) => {
    if (name !== METADATA || (legacy && stat(path.join(root, name))?.isSymbolicLink())) return [name];
    return metadataChildren(path.join(root, name)).map((child) => path.join(name, child));
  });
}

/** Validate the entire code tree, including nested source links, before sharing any part of it. */
function validateCode(file: string, store: string, protectedCatalogues: Set<string>, ancestors = new Set<string>(), metadata = false): void {
  const resolved = fs.realpathSync(file);
  for (const candidate of [path.resolve(file), resolved]) {
    if (!contained(store, candidate)) throw new Error('Linked plugin code escapes the official plugin store');
    rejectPrivateData(store, candidate);
    const parts = path.relative(store, candidate).split(path.sep);
    if (parts.length < 2 || protectedCatalogues.has(candidate) || parts.some((part) => ['.in_use', '.orphaned_at', MARKER].includes(part))) {
      throw new Error('Linked plugin code cannot expose official plugin metadata or runtime markers');
    }
  }
  if (ancestors.has(resolved)) throw new Error('Linked plugin code has a symlink cycle');
  const info = fs.statSync(resolved);
  if (info.isDirectory()) {
    const next = new Set(ancestors).add(resolved);
    const names = metadata ? metadataChildren(resolved) : ancestors.size === 0 ? children(resolved) : fs.readdirSync(resolved).sort();
    for (const name of names) validateCode(path.join(resolved, name), store, protectedCatalogues, next, ancestors.size === 0 && name === METADATA);
  } else if (!info.isFile()) throw new Error('Linked plugin code is not a regular file or directory');
}

/** Legacy independent copies are adopted only if the user's copy is still identical. */
function equalCopy(source: string, target: string, top = true, metadata = false): boolean {
  noLinks(target);
  const from = fs.statSync(source);
  const to = stat(target);
  if (!to || from.isDirectory() !== to.isDirectory() || from.isFile() !== to.isFile()) return false;
  if (from.isFile()) return fs.readFileSync(source).equals(fs.readFileSync(target)) && (from.mode & 0o111) === (to.mode & 0o111);
  const names = metadata ? metadataChildren(source) : children(source);
  const local = metadata ? metadataChildren(target) : children(target);
  return JSON.stringify(names) === JSON.stringify(local) && names.every((name) => equalCopy(path.join(source, name), path.join(target, name), false, top && name === METADATA));
}

function rootMarker(target: string, source: string): Document {
  noLinks(target);
  const marker = readDocument(path.join(target, MARKER));
  if (stat(target) && (!stat(target)?.isDirectory() || marker.value.version !== 1 || marker.value.source !== source
    || Object.keys(marker.value).some((key) => !['version', 'source'].includes(key)))) {
    throw new Error('Existing plugin link root is not managed by CCEM');
  }
  return marker;
}

function recoverPublished(row: ObjectValue, key: Identity, id: string, sourceRoot: string, targetRoot: string): Managed | undefined {
  const [name, market] = id.split('@');
  if (typeof row.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(row.version)
    || row.installPath !== path.join(targetRoot, 'cache', market, name, row.version) || !stat(row.installPath as string)) return;
  const marker = readDocument(path.join(row.installPath as string, MARKER));
  if (marker.value.version !== 1 || !absolute(marker.value.source) || !contained(sourceRoot, marker.value.source)) return;
  rejectPrivateData(sourceRoot, marker.value.source);
  const suffix = `.ccem-linked-${createHash('sha256').update(marker.value.source).digest('hex').slice(0, 8)}`;
  if (!row.version.endsWith(suffix) || row.version.length === suffix.length) return;
  rootMarker(row.installPath as string, marker.value.source);
  if (!ownedChildren(row.installPath as string, marker.value.source)) return;
  return { ...key, sourcePath: marker.value.source, installPath: row.installPath as string, version: row.version };
}

function planRoot(source: string, target: string): LinkRoot {
  const marker = rootMarker(target, source);
  let changed = marker.before === undefined;
  noLinks(path.join(target, METADATA));
  const wanted = new Set(linkChildren(source));
  if (stat(target)) for (const name of linkChildren(target)) {
    const child = path.join(target, name);
    if (!stat(child)?.isSymbolicLink() || fs.readlinkSync(child) !== path.join(source, name)) {
      throw new Error('CCEM plugin code was changed locally; keeping it');
    }
    if (!wanted.has(name)) changed = true;
  }
  if (!stat(path.join(target, METADATA))) changed = true;
  for (const name of wanted) if (!stat(path.join(target, name))) changed = true;
  return { source, target, changed };
}

function ownedChildren(target: string, source: string): boolean {
  if (!stat(target)) return false;
  const legacy = !path.basename(target).includes(`${LAYOUT}.ccem-linked-`);
  const metadata = stat(path.join(target, METADATA));
  if (metadata && !(legacy ? metadata.isSymbolicLink() : metadata.isDirectory())) return false;
  if (!legacy && stat(path.join(target, METADATA, 'marketplace.json'))) return false;
  return linkChildren(target, legacy).every((name) => {
    const child = path.join(target, name);
    return stat(child)?.isSymbolicLink() && fs.readlinkSync(child) === path.join(source, name);
  });
}

function publishRoot(root: LinkRoot): void {
  if (!root.changed) return;
  // Re-check ownership immediately before modifying links. Never write through them.
  planRoot(root.source, root.target);
  const fresh = !stat(root.target);
  const directory = fresh ? `${root.target}.ccem-${randomUUID()}.tmp` : root.target;
  privateDirectory(directory);
  try {
    if (fresh) fs.writeFileSync(path.join(directory, MARKER), `${JSON.stringify({ version: 1, source: root.source })}\n`, { flag: 'wx', mode: 0o600 });
    const wanted = new Set(linkChildren(root.source));
    privateDirectory(path.join(directory, METADATA));
    for (const name of linkChildren(directory)) if (!wanted.has(name)) {
      const child = path.join(directory, name);
      if (!stat(child)?.isSymbolicLink() || fs.readlinkSync(child) !== path.join(root.source, name)) throw new Error('Plugin link changed during preparation');
      fs.unlinkSync(child);
    }
    for (const name of wanted) {
      const child = path.join(directory, name);
      if (stat(child)) continue;
      const original = path.join(root.source, name);
      fs.symlinkSync(original, child, fs.statSync(original).isDirectory() ? 'dir' : 'file');
    }
    if (fresh) {
      noLinks(root.target);
      if (stat(root.target)) throw new Error('Plugin link root changed during preparation');
      fs.renameSync(directory, root.target);
    }
  } finally {
    if (fresh) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function changed(document: Document): boolean {
  return document.before === undefined ? Object.keys(document.value).length > 0
    : JSON.stringify(JSON.parse(document.before)) !== JSON.stringify(document.value);
}

function planLinks(sourceHome: string, targetHome: string): Plan {
  const imports = readLedger(targetHome);
  if (!Object.keys(imports.value.seen).length) return { documents: [], targets: [], roots: [], changed: false };
  const sourceRegistry = readSource(sourceHome);
  const sourcePlugins = registry(sourceRegistry);
  const targetRegistry = readSource(targetHome);
  const targetPlugins = registry(targetRegistry);
  const ledger = readLinks(targetHome);
  const sourceRoot = fs.realpathSync(path.join(sourceHome, 'plugins'));
  noLinks(path.join(sourceHome, 'plugins'));
  const targetRoot = path.resolve(targetHome, 'plugins');
  noLinks(targetRoot);
  if (sourceRoot === targetRoot || contained(sourceRoot, targetRoot) || contained(targetRoot, sourceRoot)) throw new Error('Plugin stores must not overlap');
  for (const choices of Object.values(ledger.value.plugins)) for (const choice of choices) if (!('local' in choice)) {
    if (!contained(sourceRoot, choice.sourcePath)) throw new Error('Managed plugin source escapes the official store');
    rejectPrivateData(sourceRoot, choice.sourcePath);
  }
  const sourceMarkets = readDocument(path.join(sourceRoot, 'known_marketplaces.json'));
  const targetMarkets = readDocument(path.join(targetRoot, 'known_marketplaces.json'));
  const protectedCatalogues = new Set<string>();
  for (const market of Object.values(sourceMarkets.value)) {
    const location = market && typeof market === 'object' ? (market as ObjectValue).installLocation : undefined;
    if (absolute(location) && contained(sourceRoot, location)) {
      const file = path.join(location, '.claude-plugin/marketplace.json');
      if (fs.existsSync(file)) protectedCatalogues.add(fs.realpathSync(file));
    }
  }
  const documents: Document[] = [imports, sourceRegistry, targetRegistry, ledger, sourceMarkets, targetMarkets];
  const catalogues = new Map<string, Document>();
  const roots = new Map<string, LinkRoot>();

  function catalogue(markets: Document, market: string, store: string, mutable: boolean): { document: Document; location: string } | undefined {
    if (!Object.hasOwn(markets.value, market)) return undefined;
    const location = relocated(object(markets.value[market], 'marketplace').installLocation, store, store).source;
    const file = path.join(location, '.claude-plugin/marketplace.json');
    const document = catalogues.get(file) ?? readDocument(file);
    if (!Array.isArray(document.value.plugins)) throw new Error('Invalid marketplace catalogue');
    if (!catalogues.has(file)) { documents.push(document); if (mutable) catalogues.set(file, document); }
    return { document, location };
  }

  for (const [id, identities] of Object.entries(imports.value.seen)) {
    const choices = ledger.value.plugins[id] ??= [];
    for (const key of identities) {
      let index = choices.findIndex((choice) => same(choice, key));
      let old = index < 0 ? undefined : choices[index];
      if (old && 'local' in old) continue;
      const local = targetPlugins[id]?.find((row) => same(identity(row), key));
      const detach = () => {
        if (index < 0) { index = choices.length; choices.push({ ...key, local: true }); }
        else choices[index] = { ...key, local: true };
      };
      if (!local) { detach(); continue; }
      // The registry may be one publication ahead of the ledger, even if the
      // official installation has moved to another version since interruption.
      if (!old || local.installPath !== old.installPath || local.version !== old.version) {
        const recovered = recoverPublished(local, key, id, sourceRoot, targetRoot);
        if (recovered) {
          old = recovered;
          if (index < 0) { index = choices.length; choices.push(recovered); }
          else choices[index] = recovered;
        }
      }
      const registryMoved = old && (local.installPath !== old.installPath || local.version !== old.version);
      const official = sourcePlugins[id]?.find((row) => same(identity(row), key));
      if (!official) {
        if (registryMoved) detach();
        continue; // Source uninstall can retain cached code; normal symlink lifetime applies.
      }
      const original = relocated(official.installPath, sourceRoot, targetRoot);
      const [name, market] = id.split('@');
      const fromCatalogue = catalogue(sourceMarkets, market, sourceRoot, false);
      const toCatalogue = catalogue(targetMarkets, market, targetRoot, true);
      const fromEntry = (fromCatalogue?.document.value.plugins as ObjectValue[] | undefined)?.find((entry) => entry.name === name);
      const toEntry = (toCatalogue?.document.value.plugins as ObjectValue[] | undefined)?.find((entry) => entry.name === name);
      const entrySource = fromEntry?.source;
      const localSource = typeof entrySource === 'string' ? entrySource
        : entrySource && typeof entrySource === 'object' && ['directory', 'file'].includes(String((entrySource as ObjectValue).source))
          ? (entrySource as ObjectValue).path : undefined;
      let code = original.source;
      let legacyCode = original.target;
      let expectedCatalogueSource: unknown;
      let actualCatalogueSource: unknown;
      if (localSource !== undefined) {
        if (typeof localSource !== 'string' || !fromCatalogue || !toCatalogue || !toEntry) throw new Error('Invalid local plugin catalogue source');
        code = path.resolve(fromCatalogue.location, localSource);
        if (!contained(sourceRoot, code)) throw new Error('Local plugin source escapes the official store');
        legacyCode = path.isAbsolute(localSource) ? relocated(localSource, sourceRoot, targetRoot).target : path.resolve(toCatalogue.location, localSource);
        if (!contained(targetRoot, legacyCode)) throw new Error('Local plugin destination escapes its store');
        expectedCatalogueSource = old ? old.installPath : path.isAbsolute(localSource) ? legacyCode : localSource;
        actualCatalogueSource = typeof toEntry.source === 'string' ? toEntry.source : object(toEntry.source, 'local catalogue source').path;
      }
      if (!fs.existsSync(code)) {
        if (registryMoved) detach();
        continue; // A missing official cache must not block a saved conversation.
      }
      code = fs.realpathSync(code);
      validateCode(code, sourceRoot, protectedCatalogues);
      const sourceVersion = typeof official.version === 'string' ? official.version : path.basename(original.source);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(sourceVersion)) throw new Error('Invalid plugin version');
      const version = `${sourceVersion}${LAYOUT}.ccem-linked-${createHash('sha256').update(code).digest('hex').slice(0, 8)}`;
      const destination = path.join(targetRoot, 'cache', market, name, version);
      if (registryMoved) {
        if (local.installPath === destination && local.version === version && stat(destination)) rootMarker(destination, code);
        else { detach(); continue; }
      }
      if (old && !registryMoved) {
        rootMarker(old.installPath, old.sourcePath);
        if (!ownedChildren(old.installPath, old.sourcePath)) { detach(); continue; }
      }
      if (localSource !== undefined && actualCatalogueSource !== expectedCatalogueSource) {
        // A previous attempt may have published the catalogue but not its registry/ledger yet.
        const recovered = typeof actualCatalogueSource === 'string' ? recoverPublished({ installPath: actualCatalogueSource,
          version: path.basename(actualCatalogueSource) }, key, id, sourceRoot, targetRoot) : undefined;
        if (!recovered) { detach(); continue; }
      }
      if (!old) {
        const recovering = local.installPath === destination && local.version === version && stat(destination);
        if (recovering) rootMarker(destination, code);
        else {
          validateCode(original.source, sourceRoot, protectedCatalogues);
          if (local.installPath !== original.target || local.version !== official.version
            || !equalCopy(original.source, original.target) || !equalCopy(code, legacyCode)) { detach(); continue; }
        }
      }
      roots.set(destination, planRoot(code, destination));
      if (localSource !== undefined && toEntry) toEntry.source = destination;
      local.installPath = destination;
      local.version = version;
      const next: Managed = { ...key, sourcePath: code, installPath: destination, version };
      if (index < 0) choices.push(next); else choices[index] = next;
    }
    if (!choices.length) delete ledger.value.plugins[id];
  }
  const targets = [...catalogues.values(), targetRegistry, ledger];
  return { documents, targets, roots: [...roots.values()], changed: targets.some(changed) || [...roots.values()].some((root) => root.changed), store: sourceRoot, protectedCatalogues };
}

export function claudePluginLinksPending(sourceHome: string, targetHome: string): boolean {
  return planLinks(sourceHome, targetHome).changed;
}

/** Caller holds the existing shared migration lock. Old copies/wrappers are never removed. */
export function linkClaudePlugins(sourceHome: string, targetHome: string): void {
  const plan = planLinks(sourceHome, targetHome);
  if (!plan.changed) return;
  for (const document of plan.documents) unchanged(document);
  for (const root of plan.roots) {
    validateCode(root.source, plan.store!, plan.protectedCatalogues!);
    publishRoot(root);
  }
  for (const document of plan.targets) {
    for (const observed of plan.documents) unchanged(observed);
    publishDocument(document, targetHome, BACKUP);
  }
}

/** Changes to shared code need a reload even when installation metadata did not change. */
export function claudePluginRevision(home: string): string {
  const hash = createHash('sha256');
  const links = readLinks(home);
  for (const file of [path.join(home, '.ccem-plugins-import-v1.json'), links.file,
    path.join(home, 'plugins/installed_plugins.json'), path.join(home, 'settings.json')]) {
    const document = readDocument(file);
    hash.update(file).update(document.before ?? 'missing');
  }
  const visited = new Set<string>();
  function fingerprint(file: string) {
    hash.update(file);
    let resolved: string;
    try { resolved = fs.realpathSync(file); } catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) { hash.update('missing'); return; }
      throw error;
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const info = fs.statSync(resolved);
    if (info.isFile()) hash.update(`${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.mode}`);
    else if (info.isDirectory()) for (const name of children(resolved)) fingerprint(path.join(resolved, name));
  }
  for (const choices of Object.values(links.value.plugins)) for (const choice of choices) {
    if (!('local' in choice)) fingerprint(choice.installPath);
  }
  return hash.digest('hex');
}
