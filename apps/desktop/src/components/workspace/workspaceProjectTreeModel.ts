import type { HistorySessionItem } from '@/features/conversations/types';

export type ProjectBucket = 'main' | 'temporary';
export type ProjectBucketOverride = ProjectBucket;
export type ProjectClassificationSource = 'manual' | 'worktree' | 'name' | 'regular';

export interface ProjectNode {
  project: string;
  projectName: string;
  sessions: HistorySessionItem[];
  latestTimestamp: number;
}

export interface ProjectClassification {
  project: string;
  bucket: ProjectBucket;
  source: ProjectClassificationSource;
  parentProject?: string;
  parentProjectName?: string;
}

export interface SidebarProjectSections {
  mainProjectNodes: ProjectNode[];
  temporaryProjectNodes: ProjectNode[];
  activeTemporaryProjectNodes: ProjectNode[];
}

const TEMPORARY_PROJECT_NAME_PATTERNS = [
  /^ui(?:-|$)/i,
  /^e2e(?:-|$)/i,
  /^handoff(?:-|$)/i,
  /^improve-\d{8}(?:-|$)/i,
  /(?:^|-)mainflow-\d+/i,
  /(?:^|-)smoke(?:-|$)/i,
  /(?:^|-)checkpoint(?:-|$)/i,
];

// Align overflow budget with the UI page size so auto-expansion for active
// sessions feels like one extra "Load more" click rather than an unbounded list.
const PRIORITY_OVERFLOW_BUDGET = 6;

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

export function projectBasename(path: string): string {
  const normalized = normalizeProjectPath(path);
  return normalized.split('/').filter(Boolean).pop() || 'unknown';
}

function pathKey(path: string): string {
  return normalizeProjectPath(path).toLowerCase();
}

function inferWorktreeParent(project: string): string | null {
  const normalized = normalizeProjectPath(project);
  const marker = '/.worktrees/';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }
  return normalized.slice(0, markerIndex);
}

function hasTemporaryName(projectName: string): boolean {
  return TEMPORARY_PROJECT_NAME_PATTERNS.some((pattern) => pattern.test(projectName));
}

export function classifyProject(
  project: string,
  allProjects: string[],
  overrides: Record<string, ProjectBucketOverride | undefined> = {},
): ProjectClassification {
  const override = overrides[project];
  if (override) {
    return {
      project,
      bucket: override,
      source: 'manual',
    };
  }

  const parentProject = inferWorktreeParent(project);
  if (parentProject) {
    const knownProjectByKey = new Map(allProjects.map((candidate) => [pathKey(candidate), candidate]));
    const canonicalParent = knownProjectByKey.get(pathKey(parentProject)) ?? parentProject;
    return {
      project,
      bucket: 'temporary',
      source: 'worktree',
      parentProject: canonicalParent,
      parentProjectName: projectBasename(canonicalParent),
    };
  }

  const projectName = projectBasename(project);
  if (hasTemporaryName(projectName)) {
    return {
      project,
      bucket: 'temporary',
      source: 'name',
    };
  }

  return {
    project,
    bucket: 'main',
    source: 'regular',
  };
}

export function buildProjectNodes(sessions: HistorySessionItem[]): ProjectNode[] {
  const map = new Map<string, ProjectNode>();
  for (const session of sessions) {
    let node = map.get(session.project);
    if (!node) {
      node = {
        project: session.project,
        projectName: session.projectName,
        sessions: [],
        latestTimestamp: 0,
      };
      map.set(session.project, node);
    }
    node.sessions.push(session);
    if (session.timestamp > node.latestTimestamp) {
      node.latestTimestamp = session.timestamp;
    }
  }

  const nodes = Array.from(map.values());
  nodes.sort((left, right) => right.latestTimestamp - left.latestTimestamp);
  for (const node of nodes) {
    node.sessions.sort((left, right) => right.timestamp - left.timestamp);
  }
  return nodes;
}

function projectSessionKey(session: Pick<HistorySessionItem, 'id' | 'source'>): string {
  return `${session.source}:${session.id}`;
}

export type ProjectSessionCanonicalKeyMap = Readonly<Record<string, string | undefined>>;

function canonicalProjectSessionKey(
  session: Pick<HistorySessionItem, 'id' | 'source'>,
  canonicalKeyBySessionKey: ProjectSessionCanonicalKeyMap,
): string {
  const key = projectSessionKey(session);
  return canonicalKeyBySessionKey[key] ?? key;
}

export interface StabilizeProjectNodeSessionOptions {
  canonicalKeyBySessionKey?: ProjectSessionCanonicalKeyMap;
}

export function stabilizeProjectNodeSessions(
  previousNodes: ProjectNode[],
  nextNodes: ProjectNode[],
  options: StabilizeProjectNodeSessionOptions = {},
): ProjectNode[] {
  if (previousNodes.length === 0 || nextNodes.length === 0) {
    return nextNodes;
  }

  const previousByProject = new Map(previousNodes.map((node) => [node.project, node]));
  const canonicalKeyBySessionKey = options.canonicalKeyBySessionKey ?? {};

  return nextNodes.map((node) => {
    const previousNode = previousByProject.get(node.project);
    if (!previousNode || previousNode.sessions.length === 0 || node.sessions.length <= 1) {
      return node;
    }

    const nextSessionByKey = new Map<string, HistorySessionItem>();
    for (const session of node.sessions) {
      const canonicalKey = canonicalProjectSessionKey(session, canonicalKeyBySessionKey);
      const existing = nextSessionByKey.get(canonicalKey);
      const currentKey = projectSessionKey(session);
      if (!existing || currentKey === canonicalKey) {
        nextSessionByKey.set(canonicalKey, session);
      }
    }
    const retainedSessions: HistorySessionItem[] = [];
    const retainedKeys = new Set<string>();

    for (const previousSession of previousNode.sessions) {
      const key = canonicalProjectSessionKey(previousSession, canonicalKeyBySessionKey);
      const nextSession = nextSessionByKey.get(key);
      if (!nextSession || retainedKeys.has(key)) {
        continue;
      }
      retainedSessions.push(nextSession);
      retainedKeys.add(key);
    }

    if (retainedSessions.length === 0) {
      return node;
    }

    const newSessions: HistorySessionItem[] = [];
    const seenNewKeys = new Set<string>();
    for (const session of node.sessions) {
      const key = canonicalProjectSessionKey(session, canonicalKeyBySessionKey);
      if (retainedKeys.has(key) || seenNewKeys.has(key)) {
        continue;
      }
      seenNewKeys.add(key);
      newSessions.push(nextSessionByKey.get(key) ?? session);
    }
    if (newSessions.length === 0) {
      const alreadyStable = retainedSessions.every((session, index) => session === node.sessions[index]);
      return alreadyStable ? node : { ...node, sessions: retainedSessions };
    }

    const newestRetainedTimestamp = retainedSessions.reduce(
      (newest, session) => Math.max(newest, session.timestamp),
      Number.NEGATIVE_INFINITY
    );
    const freshSessions: HistorySessionItem[] = [];
    const backfilledSessions: HistorySessionItem[] = [];
    for (const session of newSessions) {
      if (session.timestamp >= newestRetainedTimestamp) {
        freshSessions.push(session);
      } else {
        backfilledSessions.push(session);
      }
    }

    return {
      ...node,
      sessions: [...freshSessions, ...retainedSessions, ...backfilledSessions],
    };
  });
}

/**
 * Build the rendered page while preserving the canonical stable order.
 * Priority (active/selected) rows are guaranteed visible, but they stay in
 * their original position instead of jumping to the top. The first
 * `visibleCount` rows are shown as the base window; any priority row beyond
 * that window is appended without displacing earlier rows, up to one extra
 * page budget so the list cannot auto-expand without bound.
 */
export function selectVisibleProjectSessions(
  sessions: HistorySessionItem[],
  visibleCount: number,
  prioritySessionKeys: ReadonlySet<string>,
  canonicalKeyBySessionKey: ProjectSessionCanonicalKeyMap = {},
): HistorySessionItem[] {
  const canonicalPriorityKeys = new Set<string>();
  for (const key of prioritySessionKeys) {
    canonicalPriorityKeys.add(canonicalKeyBySessionKey[key] ?? key);
  }

  const pageBudget = Number.isFinite(visibleCount)
    ? Math.max(0, Math.floor(visibleCount))
    : 0;
  const maxVisible = pageBudget + PRIORITY_OVERFLOW_BUDGET;

  const visible: HistorySessionItem[] = [];
  const seenKeys = new Set<string>();
  let count = 0;

  for (const session of sessions) {
    const key = canonicalProjectSessionKey(session, canonicalKeyBySessionKey);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const isPriority = canonicalPriorityKeys.has(key);
    if (count < pageBudget || (isPriority && count < maxVisible)) {
      visible.push(session);
      count++;
    }
  }

  return visible;
}

/**
 * Local native entries and runtime decorations are sampled independently, so
 * visibility is the union of affirmative activity signals. An explicit
 * decoration `false` suppresses that decoration's visual fallback, but cannot
 * hide a live entry that may have reconnected after the decoration poll.
 */
export function buildProjectPrioritySessionKeys(
  activeSessionKeys: ReadonlySet<string>,
  decorationsBySessionKey: Readonly<Record<string, {
    visualState?: string;
    isActive?: boolean;
  } | undefined>>,
  canonicalKeyBySessionKey: ProjectSessionCanonicalKeyMap = {},
): Set<string> {
  const priorities = new Set<string>();
  for (const key of activeSessionKeys) {
    priorities.add(canonicalKeyBySessionKey[key] ?? key);
  }
  for (const [key, decoration] of Object.entries(decorationsBySessionKey)) {
    const canonicalKey = canonicalKeyBySessionKey[key] ?? key;
    if (decoration?.isActive === true) {
      priorities.add(canonicalKey);
      continue;
    }
    if (decoration?.isActive === false) {
      continue;
    }
    if (decoration?.visualState !== 'processing' && decoration?.visualState !== 'attention') {
      continue;
    }
    priorities.add(canonicalKey);
  }
  return priorities;
}

export function reconcileProjectOrder(
  previousOrder: string[],
  projectsByPreferredAppendOrder: string[],
): string[] {
  const projectSet = new Set(projectsByPreferredAppendOrder);
  const retained = previousOrder.filter((project) => projectSet.has(project));
  const retainedSet = new Set(retained);
  const appended = projectsByPreferredAppendOrder.filter((project) => !retainedSet.has(project));
  return [...retained, ...appended];
}

export function sortProjectNodesByOrder(nodes: ProjectNode[], projectOrder: string[]): ProjectNode[] {
  if (nodes.length <= 1) {
    return nodes;
  }

  const order = new Map(projectOrder.map((project, index) => [project, index]));
  return [...nodes].sort((left, right) => {
    const leftOrder = order.get(left.project);
    const rightOrder = order.get(right.project);
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== undefined) {
      return -1;
    }
    if (rightOrder !== undefined) {
      return 1;
    }
    return right.latestTimestamp - left.latestTimestamp;
  });
}

export function splitProjectNodesForSidebar(
  projectNodes: ProjectNode[],
  classificationsByProject: Record<string, ProjectClassification | undefined>,
  activeTemporaryProjects: Set<string>,
  dismissedActiveTemporaryProjects: Set<string>,
): SidebarProjectSections {
  const mainProjectNodes: ProjectNode[] = [];
  const temporaryProjectNodes: ProjectNode[] = [];
  const activeTemporaryProjectNodes: ProjectNode[] = [];

  for (const node of projectNodes) {
    const classification = classificationsByProject[node.project];
    if (classification?.bucket !== 'temporary') {
      mainProjectNodes.push(node);
      continue;
    }

    if (activeTemporaryProjects.has(node.project) && !dismissedActiveTemporaryProjects.has(node.project)) {
      activeTemporaryProjectNodes.push(node);
    } else {
      temporaryProjectNodes.push(node);
    }
  }

  return {
    mainProjectNodes,
    temporaryProjectNodes,
    activeTemporaryProjectNodes,
  };
}
