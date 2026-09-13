export const COMPOSER_ESC_INTERRUPT_ARM_TIMEOUT_MS = 2000;

export interface ComposerEscInterruptInput {
  key: string;
  /** Whether the confirm-interrupt state is already armed. */
  isArmed: boolean;
  /** Whether the owning session is running so Esc may arm an interrupt. */
  available: boolean;
  /** Whether a trigger suggestion panel is open and owns the first Escape. */
  triggerPanelOpen: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

export type ComposerEscInterruptDecision =
  | { kind: 'skip' }
  | { kind: 'arm' }
  | { kind: 'confirm' }
  | { kind: 'disarm' };

/**
 * Escape inside a running session's composer is a two-step interrupt: the
 * first press only switches the primary action button to a confirm state,
 * the second press actually interrupts the session. Trigger dropdowns, IME
 * composition, and key auto-repeat keep their existing ownership of the key,
 * and any other keystroke cancels a stale armed state.
 */
export function decideComposerEscInterrupt(input: ComposerEscInterruptInput): ComposerEscInterruptDecision {
  if (!input.available || input.defaultPrevented) {
    return { kind: 'skip' };
  }
  if (input.key === 'Escape') {
    if (input.isComposing || input.keyCode === 229 || input.repeat || input.triggerPanelOpen) {
      return { kind: 'skip' };
    }
    return input.isArmed ? { kind: 'confirm' } : { kind: 'arm' };
  }
  return input.isArmed ? { kind: 'disarm' } : { kind: 'skip' };
}
