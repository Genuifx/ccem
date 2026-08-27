export interface BrowserPresentationIntent {
  ownerSessionId: string;
  surfaceSessionId: string;
  occluded: boolean;
}

function intentKey(intent: BrowserPresentationIntent): string {
  return [
    intent.ownerSessionId,
    intent.surfaceSessionId,
    intent.occluded ? 'occluded' : 'visible',
  ].join('\u0000');
}

/**
 * Allocates one monotonic presentation revision for each Workspace ownership
 * or occlusion intent. Every mounted BrowserPanel receives the same revision
 * for that render so the native coordinator can reject stale visibility work.
 */
export function createBrowserPresentationRevisionAllocator() {
  let lastIntentKey: string | null = null;
  let revision = 0;

  return {
    observe(intent: BrowserPresentationIntent): number {
      const nextIntentKey = intentKey(intent);
      if (nextIntentKey !== lastIntentKey) {
        lastIntentKey = nextIntentKey;
        revision += 1;
      }
      return revision;
    },
  };
}
