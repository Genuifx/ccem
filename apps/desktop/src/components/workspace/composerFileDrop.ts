interface DropPosition {
  x: number;
  y: number;
}

interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface DropCoordinateSpace {
  platform: string;
  devicePixelRatio: number;
  appZoom: number;
}

export function composerFileDropPoint(
  position: DropPosition,
  { platform, devicePixelRatio, appZoom }: DropCoordinateSpace,
): DropPosition {
  // Wry 0.55.1's wkwebview/drag_drop.rs forwards AppKit logical points,
  // despite Tauri typing the payload as PhysicalPosition. Dividing those by
  // Retina DPR moves the pointer away from the composer. WKWebView page zoom
  // still needs to be undone to compare with getBoundingClientRect().
  // Keep the existing physical-pixel conversion on other platforms.
  const scale = /Mac/i.test(platform) ? appZoom : devicePixelRatio;
  const divisor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / divisor, y: position.y / divisor };
}

export function isComposerFileDropInside(
  rect: DropRect,
  position: DropPosition,
  coordinateSpace: DropCoordinateSpace,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const { x, y } = composerFileDropPoint(position, coordinateSpace);
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
