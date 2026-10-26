export type WorkspaceOpenAppKind = 'editor' | 'browser' | 'viewer' | 'markdown';

export interface WorkspaceOpenApp {
  id: string;
  name: string;
  kind: WorkspaceOpenAppKind;
  /** PNG data URL of the app's own icon, when the backend could read it. */
  icon?: string | null;
}

export type WorkspaceFileOpenCategory = 'web' | 'image' | 'pdf' | 'markdown' | 'code';

const WEB_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'ico', 'avif']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

/** Which app kinds suit each file category, best first. */
const KIND_ORDER: Record<WorkspaceFileOpenCategory, WorkspaceOpenAppKind[]> = {
  web: ['browser', 'editor'],
  image: ['viewer', 'browser'],
  pdf: ['viewer', 'browser'],
  markdown: ['markdown', 'editor'],
  code: ['editor'],
};

const MAX_SUGGESTED = 4;

export function openCategoryForPath(path: string): WorkspaceFileOpenCategory {
  const name = path.split('/').pop() ?? path;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (WEB_EXTENSIONS.has(extension)) return 'web';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  return 'code';
}

export interface RankedOpenApps {
  /** App the main button uses; null falls back to the system default. */
  primary: WorkspaceOpenApp | null;
  suggested: WorkspaceOpenApp[];
  others: WorkspaceOpenApp[];
}

export function rankOpenApps(path: string, apps: WorkspaceOpenApp[], rememberedId?: string | null): RankedOpenApps {
  const kinds = KIND_ORDER[openCategoryForPath(path)];
  // Keep the suggestion list short; the rest stays one level down under "other apps".
  const suggested = kinds.flatMap((kind) => apps.filter((app) => app.kind === kind)).slice(0, MAX_SUGGESTED);
  const others = apps.filter((app) => !suggested.includes(app));
  const remembered = rememberedId ? apps.find((app) => app.id === rememberedId) ?? null : null;
  return { primary: remembered ?? suggested[0] ?? null, suggested, others };
}

const STORAGE_PREFIX = 'ccem.workspace.openWith.';

export function readRememberedOpenApp(path: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + openCategoryForPath(path));
  } catch {
    return null;
  }
}

export function rememberOpenApp(path: string, appId: string) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + openCategoryForPath(path), appId);
  } catch {
    // Storage is a convenience; opening still works without it.
  }
}
