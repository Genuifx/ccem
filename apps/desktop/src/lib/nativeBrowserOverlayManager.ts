export interface NativeBrowserOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserOverlaySnapshot {
  revision: number;
  modal: boolean;
  regions: NativeBrowserOverlayRect[];
}

interface ManagerOptions {
  document: Document;
  readZoom: () => number;
  isModal: () => boolean;
  send: (snapshot: NativeBrowserOverlaySnapshot) => Promise<void>;
  onError?: (error: unknown) => void;
}

type ElementKind = 'overlay' | 'viewport' | 'backdrop';
type Registry = Map<HTMLElement, Set<symbol>>;
const AUTOMATIC_OVERLAYS = '[data-sonner-toast], [data-ccem-native-overlay]';
const MAX_REGIONS = 256;

function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/** Cut only decorative background layers, never an ancestor of React content. */
export function browserBackdropClip(background: DOMRect, holes: DOMRect[]): string {
  const points = ['0 0', '100% 0', '100% 100%', '0 100%', '0 0'];
  let count = 0;
  for (const hole of holes) {
    const left = Math.max(0, hole.left - background.left);
    const top = Math.max(0, hole.top - background.top);
    const right = Math.min(background.width, hole.right - background.left);
    const bottom = Math.min(background.height, hole.bottom - background.top);
    if (right <= left || bottom <= top) continue;
    const point = (x: number, y: number) => `${Number(x.toFixed(3))}px ${Number(y.toFixed(3))}px`;
    // The doubled bridge has zero area; evenodd removes the inner rectangle.
    points.push(point(left, top), point(left, bottom), point(right, bottom), point(right, top), point(left, top), '0 0');
    count += 1;
  }
  return count ? `polygon(evenodd, ${points.join(', ')})` : 'none';
}

/** DOM registry and geometry transport. Native code owns hit testing and focus. */
export function createNativeBrowserOverlayManager(options: ManagerOptions) {
  const document = options.document;
  const view = document.defaultView as Window & typeof globalThis;
  const registries: Record<ElementKind, Registry> = {
    overlay: new Map(), viewport: new Map(), backdrop: new Map(),
  };
  const automatic = new Map<HTMLElement, () => void>();
  let disposed = false;
  let frame: number | null = null;
  let trackUntil = 0;
  let revision = 0;
  let lastSnapshot = '';
  let latestSend: { modal: boolean; promise: Promise<void> } | null = null;
  let retryTimer: number | null = null;
  let failedSends = 0;
  let microtaskPending = false;

  const visibleRect = (element: HTMLElement): DOMRect | null => {
    if (!element.isConnected) return null;
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const isModal = () => options.isModal()
    || view.getComputedStyle(document.body).pointerEvents === 'none';

  const flush = () => {
    if (disposed) return;
    const holes = [...registries.viewport.keys()].map(visibleRect).filter((rect): rect is DOMRect => !!rect);
    const hasHole = holes.length > 0;
    if (document.documentElement.dataset.nativeBrowserHole !== String(hasHole)) {
      document.documentElement.dataset.nativeBrowserHole = String(hasHole);
    }
    for (const element of registries.backdrop.keys()) {
      const clip = browserBackdropClip(element.getBoundingClientRect(), holes);
      if (element.style.getPropertyValue('--ccem-browser-backdrop-clip') !== clip) {
        element.style.setProperty('--ccem-browser-backdrop-clip', clip);
      }
    }

    const zoom = options.readZoom();
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const regions: NativeBrowserOverlayRect[] = [];
    for (const element of registries.overlay.keys()) {
      const rect = visibleRect(element);
      if (!rect) continue;
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(view.innerWidth, rect.right);
      const bottom = Math.min(view.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      regions.push({ x: left * scale, y: top * scale, width: (right - left) * scale, height: (bottom - top) * scale });
    }
    // Never leave an unreported overlay clickable through to CEF when bounded.
    const modal = isModal() || regions.length > MAX_REGIONS;
    const state = { modal, regions: regions.length > MAX_REGIONS ? [] : regions };
    const fingerprint = JSON.stringify(state);
    if (fingerprint === lastSnapshot) return;
    lastSnapshot = fingerprint;
    const currentRevision = ++revision;
    let promise: Promise<void>;
    try { promise = options.send({ revision: currentRevision, ...state }); }
    catch (error) { promise = Promise.reject(error); }
    latestSend = { modal, promise };
    // flush stays fire-and-forget. A participant can separately await the same
    // transport promise without creating an unhandled rejection for observers.
    void promise.then(() => {
      if (currentRevision === revision) {
        failedSends = 0;
        if (retryTimer !== null) view.clearTimeout(retryTimer);
        retryTimer = null;
      }
    }).catch((error) => {
      if (disposed || currentRevision !== revision) return;
      lastSnapshot = '';
      options.onError?.(error);
      failedSends += 1;
      // Retry only a failed transport while a native viewport still exists. The
      // delay is capped, so an unchanged snapshot can recover after a bridge gap.
      if (registries.viewport.size > 0) {
        if (retryTimer !== null) view.clearTimeout(retryTimer);
        retryTimer = view.setTimeout(() => {
          retryTimer = null;
          if (registries.viewport.size > 0) flush();
        }, Math.min(2000, 100 * (2 ** Math.min(failedSends - 1, 5))));
      }
    });
  };

  const publishAfterCommit = () => {
    if (disposed || microtaskPending) return;
    microtaskPending = true;
    view.queueMicrotask(() => { microtaskPending = false; flush(); });
  };

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      flush();
      if (view.performance.now() < trackUntil) schedule();
    });
  };
  const trackMotion = () => {
    // Entry/exit transforms do not trigger ResizeObserver. Sample a bounded
    // transition window, never scan the DOM on every animation frame.
    trackUntil = view.performance.now() + 450;
    schedule();
  };
  const resizeObserver = typeof view.ResizeObserver === 'function'
    ? new view.ResizeObserver(schedule) : null;

  const register = (element: HTMLElement, kind: ElementKind = 'overlay'): (() => void) => {
    if (disposed) return () => {};
    const registry = registries[kind];
    let owners = registry.get(element);
    if (!owners) {
      owners = new Set();
      registry.set(element, owners);
      resizeObserver?.observe(element);
    }
    const owner = Symbol(kind);
    owners.add(owner);
    publishAfterCommit();
    trackMotion();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = registry.get(element);
      current?.delete(owner);
      if (current?.size === 0) {
        registry.delete(element);
        if (kind === 'backdrop') element.style.removeProperty('--ccem-browser-backdrop-clip');
        if (!Object.values(registries).some((entries) => entries.has(element))) resizeObserver?.unobserve(element);
      }
      publishAfterCommit();
      schedule();
    };
  };

  const discover = (node: Node) => {
    if (!(node instanceof view.HTMLElement)) return;
    const add = (element: HTMLElement) => {
      if (!automatic.has(element)) automatic.set(element, register(element));
    };
    if (node.matches(AUTOMATIC_OVERLAYS)) add(node);
    node.querySelectorAll<HTMLElement>(AUTOMATIC_OVERLAYS).forEach(add);
  };
  const mutations = new view.MutationObserver((records) => {
    let modalChanged = false;
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(discover);
      if (record.target === document.body && record.attributeName === 'style') modalChanged = true;
      if (record.type === 'attributes' && record.target instanceof view.HTMLElement
        && (record.attributeName === 'data-ccem-native-overlay' || record.attributeName === 'data-sonner-toast')) {
        discover(record.target);
      }
    }
    for (const [element, release] of automatic) {
      if (!element.isConnected || !element.matches(AUTOMATIC_OVERLAYS)) {
        release();
        automatic.delete(element);
      }
    }
    // A modal body's input block is safety-critical; do not wait for RAF.
    if (modalChanged) flush();
    schedule();
  });
  mutations.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'data-state', 'data-sonner-toast', 'data-ccem-native-overlay'],
  });
  discover(document.body);

  const motionListener = (event: Event) => {
    const target = event.target;
    if (!(target instanceof view.HTMLElement)) return;
    if ([...registries.overlay.keys(), ...registries.viewport.keys()].some((element) => (
      element === target || target.contains(element) || element.contains(target)
    ))) trackMotion();
  };
  document.addEventListener('animationstart', motionListener, true);
  document.addEventListener('transitionrun', motionListener, true);
  document.addEventListener('scroll', schedule, true);
  view.addEventListener('resize', trackMotion);
  view.addEventListener('ccem-zoom-change', trackMotion);

  return {
    register,
    flush,
    schedule,
    async waitForModalSync(): Promise<void> {
      if (disposed) throw new Error('Native browser overlay manager is disposed');
      flush();
      if (!latestSend?.modal) throw new Error('Native browser modal barrier requires an active modal');
      // This ACK precedes the surface occlude transaction. Consequently any old
      // modal=false IPC is fenced by a newer native revision before React opens.
      await latestSend.promise;
    },
    /** CEF clicks need a DOM outside event for non-modal Radix dismiss layers. */
    pointerDown({ x, y, button }: { x: number; y: number; button: number }): void {
      if (disposed || isModal() || !Number.isFinite(x) || !Number.isFinite(y)
        || ![0, 1, 2].includes(button)) return;
      const zoom = options.readZoom();
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      const clientX = x / zoom;
      const clientY = y / zoom;
      const target = [...registries.viewport.keys()].find((element) => {
        const rect = visibleRect(element);
        return rect && contains(rect, clientX, clientY);
      });
      if (!target) return;
      // A delayed native event must not dismiss a newly-opened layer at the point.
      if ([...registries.overlay.keys()].some((element) => {
        const rect = visibleRect(element);
        return rect && contains(rect, clientX, clientY);
      })) return;
      const init = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button,
        buttons: button === 0 ? 1 : button === 1 ? 4 : 2 };
      const PointerEvent = view.PointerEvent ?? view.MouseEvent;
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new view.MouseEvent('mousedown', init));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      if (retryTimer !== null) view.clearTimeout(retryTimer);
      mutations.disconnect();
      resizeObserver?.disconnect();
      for (const element of registries.backdrop.keys()) element.style.removeProperty('--ccem-browser-backdrop-clip');
      for (const registry of Object.values(registries)) registry.clear();
      automatic.clear();
      delete document.documentElement.dataset.nativeBrowserHole;
      document.removeEventListener('animationstart', motionListener, true);
      document.removeEventListener('transitionrun', motionListener, true);
      document.removeEventListener('scroll', schedule, true);
      view.removeEventListener('resize', trackMotion);
      view.removeEventListener('ccem-zoom-change', trackMotion);
    },
  };
}
