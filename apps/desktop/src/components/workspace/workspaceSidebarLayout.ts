export const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = 'ccem-workspace-sidebar-width';
export const WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY = 'ccem-workspace-sidebar-collapsed';
export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 280;
export const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 220;
export const WORKSPACE_SIDEBAR_MAX_WIDTH_PX = 420;

/** Screens narrower than this default to a collapsed sidebar. */
export const WORKSPACE_SIDEBAR_SMALL_SCREEN_PX = 1024;

export function clampWorkspaceSidebarWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(width)) {
    return WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX;
  }
  return Math.min(
    WORKSPACE_SIDEBAR_MAX_WIDTH_PX,
    Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, width),
  );
}

export function calculateWorkspaceSidebarWidth({
  layoutLeft,
  pointerClientX,
}: {
  layoutLeft: number;
  pointerClientX: number;
}): number {
  return clampWorkspaceSidebarWidth(pointerClientX - layoutLeft);
}

/**
 * Read persisted sidebar collapsed state.
 * Returns true (collapsed) on small screens when no explicit preference was stored.
 */
export function readStoredWorkspaceSidebarCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    // No stored preference — default based on screen width
    return window.innerWidth < WORKSPACE_SIDEBAR_SMALL_SCREEN_PX;
  } catch {
    return window.innerWidth < WORKSPACE_SIDEBAR_SMALL_SCREEN_PX;
  }
}
