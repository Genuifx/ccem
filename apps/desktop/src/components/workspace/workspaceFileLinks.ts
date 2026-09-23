/** Local links are handled inside the owning workspace, never by the OS. */
export function workspaceFileLinkPath(href: string): string | null {
  try {
    if (/^ccem-file:/i.test(href)) {
      const url = new URL(href);
      if (url.hostname !== 'preview' || (url.pathname && url.pathname !== '/') || url.username || url.password) return null;
      const path = url.searchParams.get('path');
      return path && !/[\x00-\x1f]/.test(path) ? path : null;
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
