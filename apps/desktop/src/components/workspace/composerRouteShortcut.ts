/**
 * Composer Shift+~ shortcut for the Dynamic Routing opt-in.
 *
 * Local to the composer's PromptArea onKeyDown — deliberately NOT a global
 * shortcut hook, so it only ever applies while the routing-capable composer
 * is focused. Pure predicate + handler builder shared verbatim with the DOM
 * gesture tests (composer-route-shortcut-dom.test.mjs) so tests and the real
 * wiring cannot drift.
 */

export interface ComposerRouteShortcutEvent {
  key?: string | null;
  code?: string | null;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean } | null;
  preventDefault: () => void;
}

export interface ComposerRouteShortcutContext {
  /** Only Claude sessions can route. */
  provider: string;
  /** Draft availability: live-direct composers pass null → shortcut inert. */
  routeDraft: { optIn: boolean } | null | undefined;
  /** Called ONLY for the off → on transition (idempotent enable). */
  onRouteDraftEnable: (() => void) | undefined;
  disabled?: boolean;
  isSubmitting?: boolean;
}

/** Keycode reported by browsers while an IME composition is in flight. */
const IME_PROCESSING_KEYCODE = 229;

export function isComposerRouteShortcutGesture(event: ComposerRouteShortcutEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.code !== 'Backquote') return false;
  if (!event.shiftKey) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.repeat) return false;
  if (event.nativeEvent?.isComposing === true) return false;
  if (event.key === 'Process') return false;
  if (event.keyCode === IME_PROCESSING_KEYCODE) return false;
  return true;
}

export function buildComposerRouteShortcutHandler(context: ComposerRouteShortcutContext) {
  return (event: ComposerRouteShortcutEvent) => {
    if (!isComposerRouteShortcutGesture(event)) return;
    if (context.provider !== 'claude') return;
    if (context.disabled || context.isSubmitting) return;
    if (!context.routeDraft || !context.onRouteDraftEnable) return;

    // Consume the gesture only when the routing draft surface is actually
    // available; otherwise the `~` character must flow through untouched.
    event.preventDefault();
    // Idempotent enable — never toggles off and never resets a named profile.
    if (!context.routeDraft.optIn) {
      context.onRouteDraftEnable();
    }
  };
}
