/**
 * The reserved ccem-file scheme carries a single `path` query value. Agents
 * drift from the canonical form — capitalized host, empty authority, raw
 * '#', '&' or '+' in the value — and URLSearchParams would silently truncate
 * or mis-decode those. Recognize the preview action case-insensitively and
 * read the value verbatim from the raw href; the backend still enforces
 * working-dir containment after resolution.
 */
function ccemFilePreviewPath(href: string): string | null {
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  const isPreviewAction = (host === 'preview' && (!url.pathname || url.pathname === '/'))
    || (host === '' && url.pathname.replace(/^\//, '').toLowerCase() === 'preview');
  if (!isPreviewAction || url.username || url.password) return null;
  const rest = href.slice(href.indexOf(':') + 1);
  const start = rest.search(/[?&]path=/);
  if (start < 0) return null;
  const value = rest.slice(rest.indexOf('=', start) + 1);
  if (!value) return null;
  const path = value.replace(/(?:%[0-9a-fA-F]{2})+/g, decodeURIComponent);
  return /[\x00-\x1f]/.test(path) ? null : path;
}

/** Local links are handled inside the owning workspace, never by the OS. */
export function workspaceFileLinkPath(href: string): string | null {
  try {
    if (/^ccem-file:/i.test(href)) {
      return ccemFilePreviewPath(href);
    }
    if (/^file:/i.test(href)) {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return null;
      const path = decodeURIComponent(url.pathname);
      return /[\x00-\x1f]/.test(path) ? null : path;
    }
    const target = href.replace(/:\d+(?::\d+)?$/, '');
    if (!target || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
    const path = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
    if (/[\x00-\x1f]/.test(path)) return null;
    return /(?:^\/|^\.{1,2}\/|\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?)$/i.test(path) || path.includes('/') ? path.replace(/:\d+(?::\d+)?$/, '') : null;
  } catch {
    return null;
  }
}

export function resolveWorkspaceDocumentLink(path: string, documentPath?: string): string {
  if (!documentPath || path.startsWith('/') || /^[a-z]:[/\\]/i.test(path)) return path;
  const directory = documentPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return directory ? `${directory}/${path}` : path;
}
