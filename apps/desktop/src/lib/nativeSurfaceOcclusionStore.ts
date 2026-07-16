export interface NativeSurfaceOcclusionParticipant {
  /**
   * Synchronously marks future native-surface creation as hidden. This closes
   * the gap before the acknowledgement-bearing hide transition is scheduled.
   */
  prepareHide?: () => void;
  hide: () => Promise<void> | void;
  restore: () => Promise<void> | void;
}

export interface NativeSurfaceOcclusionLease {
  /** Resolves only after every registered native surface has acknowledged hide. */
  ready: Promise<void>;
  /** Releases this overlay. The last release restores registered surfaces. */
  release: () => Promise<void>;
}

export interface NativeSurfaceOcclusionStore {
  acquire: () => NativeSurfaceOcclusionLease;
  registerParticipant: (participant: NativeSurfaceOcclusionParticipant) => () => void;
  isOccluded: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

interface ParticipantRecord {
  active: boolean;
  participant: NativeSurfaceOcclusionParticipant;
}

export interface NativeSurfaceOcclusionStoreOptions {
  /** Defers restore until React has committed removal of the closing overlay. */
  deferRestore?: () => Promise<void>;
}

function defaultDeferRestore(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    queueMicrotask(resolve);
  });
}

function transitionError(action: 'hide' | 'restore', failures: unknown[]): Error {
  const error = new Error(
    `Failed to ${action} ${failures.length} native surface participant${failures.length === 1 ? '' : 's'}`,
  );
  (error as Error & { causes?: unknown[] }).causes = failures;
  return error;
}

export function createNativeSurfaceOcclusionStore(
  options: NativeSurfaceOcclusionStoreOptions = {},
): NativeSurfaceOcclusionStore {
  const activeSources = new Set<symbol>();
  const participants = new Set<ParticipantRecord>();
  const listeners = new Set<() => void>();
  const deferRestore = options.deferRestore ?? defaultDeferRestore;

  // Native mutations are serialized so a slow restore can never race a newer
  // hide. A failed transition does not poison later transitions.
  let transitionTail: Promise<void> = Promise.resolve();
  let hiddenBarrier: Promise<void> | null = null;
  let occluded = false;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = transitionTail.then(operation, operation);
    transitionTail = result.catch(() => {});
    return result;
  };

  const runParticipantTransition = async (
    records: ParticipantRecord[],
    action: 'hide' | 'restore',
  ): Promise<void> => {
    const failures: unknown[] = [];
    await Promise.all(records.map(async (record) => {
      if (!record.active) return;
      try {
        await record.participant[action]();
      } catch (error) {
        // An unmounted BrowserPanel no longer owns a native surface, so a
        // concurrent unregister makes its stale IPC result irrelevant.
        if (record.active) failures.push(error);
      }
    }));
    if (failures.length > 0) throw transitionError(action, failures);
  };

  const prepareParticipantHides = (records: ParticipantRecord[]) => {
    for (const record of records) {
      if (!record.active) continue;
      record.participant.prepareHide?.();
    }
  };

  const beginHideBarrier = (): Promise<void> => {
    const initialParticipants = [...participants];
    try {
      // This must run before enqueue(): a participant may still be creating its
      // native child while an already-open overlay owns the occlusion lease.
      prepareParticipantHides(initialParticipants);
    } catch (error) {
      return Promise.reject(transitionError('hide', [error]));
    }

    return enqueue(async () => {
      if (activeSources.size === 0) return;

      // Registration happens in layout effects. Drain until stable so a panel
      // registered in the same commit is included before any overlay can open.
      const hiddenParticipants = new Set<ParticipantRecord>();
      while (activeSources.size > 0) {
        const pending = [...participants].filter(
          (record) => record.active && !hiddenParticipants.has(record),
        );
        if (pending.length === 0) return;
        await runParticipantTransition(pending, 'hide');
        for (const record of pending) {
          if (record.active) hiddenParticipants.add(record);
        }
      }
    });
  };

  return {
    acquire() {
      const source = Symbol('native-surface-occlusion');
      const wasOccluded = activeSources.size > 0;
      activeSources.add(source);

      if (!wasOccluded) {
        // Keep this synchronous as the defensive surfaceOccluded fallback.
        if (!occluded) {
          occluded = true;
          notify();
        }
        hiddenBarrier = beginHideBarrier();
      }

      const ready = hiddenBarrier ?? beginHideBarrier();
      let released = false;

      return {
        ready,
        async release() {
          if (released) return;
          released = true;
          if (!activeSources.delete(source) || activeSources.size > 0) return;

          hiddenBarrier = null;

          await enqueue(async () => {
            // The overlay renders closed before its layout-effect cleanup calls
            // release. Keep the fallback occluded through one deferred turn so
            // BrowserPanel cannot restore during that closing commit.
            await deferRestore();
            if (activeSources.size > 0) return;

            if (occluded) {
              occluded = false;
              notify();
            }

            // Let subscribers commit their non-modal visibility constraints
            // before asking each participant to restore.
            await deferRestore();
            if (activeSources.size > 0) return;
            await runParticipantTransition([...participants], 'restore');
          });
        },
      };
    },
    registerParticipant(participant) {
      const record: ParticipantRecord = { active: true, participant };
      participants.add(record);

      // BrowserPanel normally registers before an overlay request. If it mounts
      // while already occluded, hide it immediately; its own visibility fallback
      // also keeps a not-yet-created native surface hidden.
      if (activeSources.size > 0) {
        try {
          // Do not defer this behind transitionTail: delayed native creation
          // must consume the hidden intent before it can produce a first frame.
          participant.prepareHide?.();
        } catch (error) {
          console.error('Failed to prepare a late native surface participant for hide:', error);
        }
        void enqueue(async () => {
          if (activeSources.size === 0 || !record.active) return;
          await runParticipantTransition([record], 'hide');
        }).catch((error) => {
          console.error('Failed to hide a late native surface participant:', error);
        });
      }

      return () => {
        record.active = false;
        participants.delete(record);
      };
    },
    isOccluded() {
      return occluded;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const nativeSurfaceOcclusionStore = createNativeSurfaceOcclusionStore();
