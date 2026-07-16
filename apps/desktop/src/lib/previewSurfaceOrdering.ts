export interface PreviewSurfaceOwner {
  readonly scope: string;
  readonly token: symbol;
}

export type PreviewSurfaceOperationResult<T> =
  | { applied: true; value: T }
  | { applied: false };

export interface PreviewSurfaceOrdering {
  claim(scope: string): PreviewSurfaceOwner;
  enqueue<T>(
    owner: PreviewSurfaceOwner,
    operation: () => Promise<T>,
  ): Promise<PreviewSurfaceOperationResult<T>>;
  release(owner: PreviewSurfaceOwner): void;
  isCurrent(owner: PreviewSurfaceOwner): boolean;
}

export const PREVIEW_ACTIVE_SESSION_SCOPE = 'workspace:active-preview-session';

export function previewPanelScope(sessionId: string): string {
  return `panel:${sessionId}`;
}

export function createPreviewSurfaceOrdering(): PreviewSurfaceOrdering {
  const currentOwners = new Map<string, symbol>();
  // Panel and Workspace scopes share a tail so their native mutations cannot overtake each other.
  let tail: Promise<void> = Promise.resolve();

  const isCurrent = (owner: PreviewSurfaceOwner) => (
    currentOwners.get(owner.scope) === owner.token
  );

  return {
    claim(scope) {
      if (!scope.trim()) throw new Error('Preview surface owner scope is required.');
      const owner = { scope, token: Symbol(scope) };
      currentOwners.set(scope, owner.token);
      return owner;
    },
    enqueue<T>(owner: PreviewSurfaceOwner, operation: () => Promise<T>) {
      if (!isCurrent(owner)) return Promise.resolve({ applied: false });
      const result: Promise<PreviewSurfaceOperationResult<T>> = tail.then(async () => {
        if (!isCurrent(owner)) return { applied: false };
        try {
          const value = await operation();
          return isCurrent(owner) ? { applied: true, value } : { applied: false };
        } catch (error) {
          if (!isCurrent(owner)) return { applied: false };
          throw error;
        }
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    release(owner) {
      if (isCurrent(owner)) currentOwners.delete(owner.scope);
    },
    isCurrent,
  };
}

export const previewSurfaceOrdering = createPreviewSurfaceOrdering();
