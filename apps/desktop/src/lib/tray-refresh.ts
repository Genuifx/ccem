export interface TrayRefreshGateOptions {
  minIntervalMs: number;
  now?: () => number;
}

export interface TrayRefreshRunOptions {
  force?: boolean;
}

export interface TrayRefreshGate {
  run: (
    task: () => Promise<void>,
    options?: TrayRefreshRunOptions,
  ) => Promise<boolean>;
}

export function createTrayRefreshGate({
  minIntervalMs,
  now = Date.now,
}: TrayRefreshGateOptions): TrayRefreshGate {
  let inFlight: Promise<boolean> | null = null;
  let inFlightIsForced = false;
  let queuedForce: Promise<boolean> | null = null;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;

  const run: TrayRefreshGate['run'] = (task, { force = false } = {}) => {
    if (inFlight) {
      if (!force || inFlightIsForced) {
        return inFlight;
      }

      if (!queuedForce) {
        queuedForce = inFlight
          .catch(() => false)
          .then(() => run(task, { force: true }))
          .finally(() => {
            queuedForce = null;
          });
      }
      return queuedForce;
    }

    if (!force && now() - lastCompletedAt < minIntervalMs) {
      return Promise.resolve(false);
    }

    inFlightIsForced = force;
    inFlight = task()
      .then(() => {
        lastCompletedAt = now();
        return true;
      })
      .finally(() => {
        inFlight = null;
        inFlightIsForced = false;
      });

    return inFlight;
  };

  return { run };
}
