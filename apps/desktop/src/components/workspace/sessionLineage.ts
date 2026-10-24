export interface SessionParentLink {
  childKey: string;
  parentKey: string;
  /** Id of the suggestion the child was started from, when any. */
  proposalId: string | null;
}

/** suggestion id -> every key recorded for its child (runtime key, then provider key). */
export function childKeysByProposalId(links: SessionParentLink[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const link of links) {
    if (!link.proposalId) continue;
    const keys = map.get(link.proposalId) ?? [];
    keys.push(link.childKey);
    map.set(link.proposalId, keys);
  }
  return map;
}

/**
 * Reorders a session list so each child directly follows its parent.
 * Grandchildren flatten to one indent level; children whose parent is not in
 * the list keep their place.
 */
export function nestSessionsByParent<T>(
  sessions: T[],
  keyOf: (session: T) => string,
  parentKeyOf: (session: T) => string | null,
): Array<{ session: T; depth: 0 | 1 }> {
  const present = new Set(sessions.map(keyOf));
  const childrenByParent = new Map<string, T[]>();
  const nested = new Set<T>();
  for (const session of sessions) {
    const parentKey = parentKeyOf(session);
    if (!parentKey || parentKey === keyOf(session) || !present.has(parentKey)) continue;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(session);
    childrenByParent.set(parentKey, siblings);
    nested.add(session);
  }
  const result: Array<{ session: T; depth: 0 | 1 }> = [];
  const emitted = new Set<T>();
  const emit = (session: T, depth: 0 | 1) => {
    if (emitted.has(session)) return;
    emitted.add(session);
    result.push({ session, depth });
    for (const child of childrenByParent.get(keyOf(session)) ?? []) emit(child, 1);
  };
  for (const session of sessions) {
    if (!nested.has(session)) emit(session, 0);
  }
  // A parent cycle leaves rows unreachable from any root; keep them visible.
  for (const session of sessions) emit(session, 0);
  return result;
}
