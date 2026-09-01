export interface WorkspaceEscapeCommandIdentity {
  runtimeId: string;
  commandId: string;
}

export interface WorkspaceEscapeInput {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  isWorkspaceActive: boolean;
  isLiveSessionVisible: boolean;
  isSessionActive: boolean;
  runtimeId?: string | null;
  activeCommandId?: string | null;
  lastRequestedCommand?: WorkspaceEscapeCommandIdentity | null;
  hasOpenInteractionLayer?: boolean;
}

export type WorkspaceEscapeDecision =
  | { kind: 'ignore' }
  | ({ kind: 'stop' } & WorkspaceEscapeCommandIdentity);

const ESCAPE_INTERACTION_TARGET_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[data-command-palette]',
  '[data-cmdk-root]',
  '[cmdk-root]',
  '[data-state="open"][data-side]:not([role="tooltip"])',
].join(',');

const OPEN_ESCAPE_INTERACTION_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[aria-modal="true"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-command-palette][data-state="open"]',
  '[data-cmdk-root][data-state="open"]',
  '[cmdk-root][data-state="open"]',
  '[data-state="open"][data-side]:not([role="tooltip"])',
].join(',');

interface ClosestTarget {
  closest: (selector: string) => unknown;
}

function getClosestTarget(target: EventTarget | null | undefined): ClosestTarget | null {
  if (target && typeof (target as Partial<ClosestTarget>).closest === 'function') {
    return target as unknown as ClosestTarget;
  }

  const parentElement = (target as { parentElement?: unknown } | null | undefined)?.parentElement;
  if (parentElement && typeof (parentElement as Partial<ClosestTarget>).closest === 'function') {
    return parentElement as ClosestTarget;
  }

  return null;
}

/**
 * Interactive controls and layered UI own Escape before the workspace does.
 * This is intentionally based on semantic DOM state rather than component
 * names so Radix portals and native form controls follow the same contract.
 */
export function isWorkspaceEscapeOwnedByTarget(
  target: EventTarget | null | undefined,
): boolean {
  return getClosestTarget(target)?.closest(ESCAPE_INTERACTION_TARGET_SELECTOR) != null;
}

export function hasOpenWorkspaceEscapeLayer(
  root: Pick<Document, 'querySelector'>,
): boolean {
  return root.querySelector(OPEN_ESCAPE_INTERACTION_LAYER_SELECTOR) != null;
}

/**
 * Decide whether one physical Escape keydown may interrupt the foreground
 * native command. A coordinator command id is required: legacy status strings
 * are deliberately not accepted as ownership evidence.
 *
 * Auto-repeat keydowns are never a new stop request: a held Escape must not
 * cancel a queued prompt whose command was admitted right after the first
 * press released the previous turn.
 */
export function decideWorkspaceEscape(input: WorkspaceEscapeInput): WorkspaceEscapeDecision {
  if (
    input.key !== 'Escape'
    || input.repeat
    || input.defaultPrevented
    || input.isComposing
    || input.keyCode === 229
    || !input.isWorkspaceActive
    || !input.isLiveSessionVisible
    || !input.isSessionActive
    || input.hasOpenInteractionLayer
    || isWorkspaceEscapeOwnedByTarget(input.target)
  ) {
    return { kind: 'ignore' };
  }

  const runtimeId = input.runtimeId?.trim();
  const commandId = input.activeCommandId?.trim();
  if (!runtimeId || !commandId) {
    return { kind: 'ignore' };
  }

  if (
    input.lastRequestedCommand?.runtimeId === runtimeId
    && input.lastRequestedCommand.commandId === commandId
  ) {
    return { kind: 'ignore' };
  }

  return { kind: 'stop', runtimeId, commandId };
}
