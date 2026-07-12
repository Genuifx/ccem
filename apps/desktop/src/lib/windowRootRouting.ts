export type DesktopWindowRoot =
  | 'main'
  | 'desktop-pet'
  | 'tray-cockpit'
  | 'login-browser-control';

const DEDICATED_WINDOW_ROOTS: ReadonlySet<string> = new Set([
  'desktop-pet',
  'tray-cockpit',
  'login-browser-control',
]);

function dedicatedWindowRoot(value: string | null | undefined): DesktopWindowRoot | null {
  return value && DEDICATED_WINDOW_ROOTS.has(value)
    ? value as DesktopWindowRoot
    : null;
}

export function resolveDesktopWindowRoot(
  requestedWindow: string | null | undefined,
  nativeWindowLabel: string | null | undefined,
): DesktopWindowRoot {
  return dedicatedWindowRoot(requestedWindow)
    ?? dedicatedWindowRoot(nativeWindowLabel)
    ?? 'main';
}
