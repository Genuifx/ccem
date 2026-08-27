/**
 * Small dependency-injected coordinator for environment deletion.
 *
 * `useTauriCommands.deleteEnvironment` calls this with the real store mutations
 * + invokes; tests inject fakes. This makes the remote delete COMMIT BOUNDARY
 * and the post-commit outcome handling directly testable without a DOM/invoke
 * harness.
 *
 * Contract:
 *  - ONLY `deleteRemote` may throw outward → the caller rejects (keeps the
 *    dialog open for retry). The delete is irreversible once it resolves.
 *  - `removeLocal`, `persistEnabled`, and `refresh` are ALL post-commit: any
 *    failure is CAPTURED as a partialErrors entry and the coordinator continues
 *    to the next step + resolves (the delete already committed → caller must
 *    resolve). Production setters normally don't throw, but the coordinator's
 *    contract must hold regardless.
 *  - The caller clears its global error only when partialErrors is empty, so a
 *    post-commit error is never erased.
 */
export interface EnvDeleteDeps {
  deleteRemote: () => Promise<unknown>;
  removeLocal: () => void;
  persistEnabled: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
}

/**
 * Returns the post-commit partial-error messages (empty on full success).
 * Order: deleteRemote → removeLocal → persistEnabled → refresh.
 */
export async function coordinateEnvDelete(deps: EnvDeleteDeps): Promise<string[]> {
  await deps.deleteRemote(); // commit boundary — only this may throw outward

  const partialErrors: string[] = [];
  try {
    deps.removeLocal(); // synchronous local removal (post-commit; captured)
  } catch {
    partialErrors.push('could not apply local removal');
  }
  try {
    await deps.persistEnabled();
  } catch {
    partialErrors.push('could not persist enabled environments');
  }
  try {
    await deps.refresh();
  } catch {
    partialErrors.push('environment list refresh failed; showing locally-removed state');
  }
  return partialErrors;
}
