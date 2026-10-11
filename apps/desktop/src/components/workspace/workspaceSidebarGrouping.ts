import type { HistorySessionItem } from '@/features/conversations/types';
import {
  normalizeProjectPath,
  type ProjectNode,
  type SidebarGroupId,
} from './workspaceProjectTreeModel';

/*
 * Sidebar origin classifier.
 *
 * A session is placed by how it was launched first (cron, external agent
 * control), then by where it ran: worktrees and tool folders fold into their
 * repository, while agent scratch directories, projectless chats and temporary
 * folders collapse into a few fixed groups below the project list.
 */

export type ProjectClassificationOverride = 'main' | 'temporary';
export type ProjectClassificationOverrides = Readonly<
  Record<string, ProjectClassificationOverride | undefined>
>;

export type SessionOriginKind = 'project' | 'worktree' | 'nested' | 'group';

export interface SessionOrigin {
  kind: SessionOriginKind;
  /** Key of the sidebar node the session is listed under. */
  nodeKey: string;
  /** Display name of the owning project; empty for groups. */
  projectName: string;
  /** Directory for "new session in this project"; absent for groups and virtual repos. */
  createPath?: string;
  groupId?: SidebarGroupId;
  /** Where a grouped session ran: agent, folder or project name. */
  context?: string;
  /** Worktree name or sub-path inside the owning project. */
  detail?: string;
  /** Override entry that produced this placement, so it can be reset. */
  overrideKey?: string;
  /** Grouped by launcher (cron, external control) instead of by directory. */
  byLauncher?: boolean;
}

export const SIDEBAR_GROUP_ORDER: readonly SidebarGroupId[] = ['chat', 'agent', 'scheduled', 'temporary'];

export const SIDEBAR_GROUP_LABEL_KEYS: Readonly<Record<SidebarGroupId, string>> = {
  chat: 'workspace.groupChat',
  agent: 'workspace.groupAgent',
  scheduled: 'workspace.groupScheduled',
  temporary: 'workspace.temporaryProjects',
};

const GROUP_NODE_KEY_PREFIX = 'ccem-group:';
const VIRTUAL_REPO_NODE_KEY_PREFIX = 'ccem-repo:';
const MAX_ROOT_DEPTH = 8;

/** Directories owned by background agents, matched as a whole path segment. */
const AGENT_PATH_MARKERS: ReadonlyArray<{ segment: string; label: string }> = [
  { segment: '.hermes', label: 'Hermes' },
];

const SYSTEM_TEMP_ROOTS = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
];
const WINDOWS_TEMP_PATTERN = /\/appdata\/local\/temp(?:\/|$)/;

/** Worktrees that tools create under a shared root, named after the repository. */
const SHARED_WORKTREE_PATTERNS: ReadonlyArray<{ pattern: RegExp; repo: number; variant: number }> = [
  { pattern: /\/\.codex\/worktrees\/([^/]+)\/([^/]+)/i, repo: 2, variant: 1 },
  { pattern: /\/copilot-worktrees\/([^/]+)\/([^/]+)/i, repo: 1, variant: 2 },
  { pattern: /\/conductor\/workspaces\/([^/]+)\/([^/]+)/i, repo: 1, variant: 2 },
];
const SHARED_WORKTREE_MARKERS = ['/copilot-worktrees/', '/conductor/workspaces/'];
/** Worktrees nested inside the repository they belong to. */
const LOCAL_WORKTREE_PATTERN = /^(.*?)\/(?:\.worktrees|\.claude\/worktrees)\/([^/]+)/i;

const CHAT_HOME_FOLDERS = new Set(['desktop', 'downloads', 'documents']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPORARY_NAME_PATTERNS = [
  /^ui(?:-|$)/i,
  /^e2e(?:-|$)/i,
  /^handoff(?:-|$)/i,
  /^improve-\d{8}(?:-|$)/i,
  /(?:^|-)mainflow-\d+/i,
  /(?:^|-)smoke(?:-|$)/i,
  /(?:^|-)checkpoint(?:-|$)/i,
  /^[0-9a-f]{16,}$/i,
  UUID_PATTERN,
];
/** Generated names that say nothing about where a session ran. */
const OPAQUE_NAME_PATTERNS = [/^[0-9a-f]{8,}$/i, UUID_PATTERN, /^tmp[._-]?[a-z0-9]{6,}$/i];

function pathKey(path: string): string {
  return normalizeProjectPath(path).toLowerCase();
}

function pathSegments(normalized: string): string[] {
  return normalized.split('/').filter(Boolean);
}

function basenameOf(normalized: string): string {
  const segments = pathSegments(normalized);
  return segments[segments.length - 1] ?? '';
}

function readableName(name: string): string | undefined {
  return name && !OPAQUE_NAME_PATTERNS.some((pattern) => pattern.test(name)) ? name : undefined;
}

function isTemporaryName(name: string): boolean {
  return TEMPORARY_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function isSystemTempPath(lowerPath: string): boolean {
  return SYSTEM_TEMP_ROOTS.some((root) => lowerPath === root || lowerPath.startsWith(`${root}/`))
    || WINDOWS_TEMP_PATTERN.test(lowerPath);
}

function agentMarkerOf(segments: readonly string[]) {
  return AGENT_PATH_MARKERS.find((marker) => (
    segments.some((segment) => segment.toLowerCase() === marker.segment)
  ));
}

/** Number of leading segments that make up the user's home directory, or 0. */
function homeDepthOf(segments: readonly string[]): number {
  const first = segments[0]?.toLowerCase();
  if (first === 'users' || first === 'home') return 2;
  if (first === 'root') return 1;
  if (first && /^[a-z]:$/.test(first) && segments[1]?.toLowerCase() === 'users') return 3;
  return 0;
}

/** Home, its well-known document folders and filesystem roots carry no project. */
function isChatPath(segments: readonly string[], homeDepth: number): boolean {
  if (segments.length === 0) return true;
  if (homeDepth === 0) return segments.length <= 1;
  if (segments.length <= homeDepth) return true;
  const top = segments[homeDepth].toLowerCase();
  if (segments.length === homeDepth + 1 && CHAT_HOME_FOLDERS.has(top)) return true;
  return top === 'documents' && segments[homeDepth + 1]?.toLowerCase() === 'codex';
}

function isRepoRootCandidate(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  const segments = pathSegments(normalized);
  if (isSystemTempPath(lower) || agentMarkerOf(segments)) return false;
  if (SHARED_WORKTREE_MARKERS.some((marker) => lower.includes(marker))) return false;
  if (SHARED_WORKTREE_PATTERNS.some(({ pattern }) => pattern.test(normalized))) return false;
  const homeDepth = homeDepthOf(segments);
  if (isChatPath(segments, homeDepth)) return false;
  return !segments.some((segment, index) => index >= homeDepth && segment.startsWith('.'));
}

function groupNodeKey(groupId: SidebarGroupId): string {
  return `${GROUP_NODE_KEY_PREFIX}${groupId}`;
}

function compactOrigin(origin: SessionOrigin): SessionOrigin {
  for (const key of Object.keys(origin) as Array<keyof SessionOrigin>) {
    if (origin[key] === undefined) {
      delete origin[key];
    }
  }
  return origin;
}

function groupOrigin(
  groupId: SidebarGroupId,
  extra: Pick<SessionOrigin, 'context' | 'detail' | 'overrideKey'> = {},
): SessionOrigin {
  return compactOrigin({
    kind: 'group',
    groupId,
    nodeKey: groupNodeKey(groupId),
    projectName: '',
    ...extra,
  });
}

function projectOrigin(path: string, name: string, overrideKey?: string): SessionOrigin {
  return compactOrigin({
    kind: 'project',
    nodeKey: path,
    projectName: name || path,
    createPath: path,
    overrideKey,
  });
}

function attachToRoot(root: SessionOrigin, kind: 'worktree' | 'nested', detail: string): SessionOrigin {
  if (root.kind === 'group') {
    return compactOrigin({
      kind: 'group',
      groupId: root.groupId,
      nodeKey: root.nodeKey,
      projectName: '',
      context: root.context,
      detail,
      overrideKey: root.overrideKey,
    });
  }
  return compactOrigin({
    kind,
    nodeKey: root.nodeKey,
    projectName: root.projectName,
    createPath: root.createPath,
    detail,
  });
}

function pickRepoRoot(candidates: readonly string[] | undefined): string | undefined {
  if (!candidates?.length) return undefined;
  return [...candidates].sort((left, right) => (
    left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
  ))[0];
}

function collectRepoRoots(paths: readonly string[]): Map<string, string[]> {
  const rootsByName = new Map<string, string[]>();
  const add = (root: string) => {
    const name = basenameOf(normalizeProjectPath(root)).toLowerCase();
    if (!name) return;
    const roots = rootsByName.get(name) ?? [];
    if (!roots.some((existing) => pathKey(existing) === pathKey(root))) {
      roots.push(root);
    }
    rootsByName.set(name, roots);
  };
  for (const path of paths) {
    const normalized = normalizeProjectPath(path);
    const local = LOCAL_WORKTREE_PATTERN.exec(normalized);
    if (local?.[1]) {
      add(local[1]);
    } else if (isRepoRootCandidate(normalized)) {
      add(path);
    }
  }
  return rootsByName;
}

/**
 * Resolve where each directory belongs in the sidebar. The result only
 * depends on the set of known paths and the user's overrides; known paths
 * are needed to find the repository a shared worktree belongs to.
 */
export function resolveProjectPathOrigins(
  paths: Iterable<string>,
  overrides: ProjectClassificationOverrides = {},
): Map<string, SessionOrigin> {
  const uniquePaths = Array.from(new Set(paths)).sort();
  const canonicalByKey = new Map<string, string>();
  for (const path of uniquePaths) {
    const key = pathKey(path);
    if (!canonicalByKey.has(key)) {
      canonicalByKey.set(key, path);
    }
  }

  const overrideByKey = new Map<string, { key: string; value: ProjectClassificationOverride }>();
  for (const key of Object.keys(overrides).sort()) {
    const value = overrides[key];
    const lookupKey = pathKey(key);
    if ((value === 'main' || value === 'temporary') && !overrideByKey.has(lookupKey)) {
      overrideByKey.set(lookupKey, { key, value });
    }
  }

  const repoRootsByName = collectRepoRoots(uniquePaths);
  const memo = new Map<string, SessionOrigin>();

  const resolveWorktree = (normalized: string, depth: number): SessionOrigin | null => {
    for (const { pattern, repo, variant } of SHARED_WORKTREE_PATTERNS) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      const repoName = match[repo];
      const variantName = match[variant];
      const root = pickRepoRoot(repoRootsByName.get(repoName.toLowerCase()));
      if (root) {
        return attachToRoot(classify(root, depth + 1), 'worktree', variantName);
      }
      // The main checkout never hosted a session: list the worktrees under
      // the repository name without offering a directory to create in.
      const virtualKey = `${VIRTUAL_REPO_NODE_KEY_PREFIX}${repoName.toLowerCase()}`;
      const override = overrideByKey.get(virtualKey);
      if (override?.value === 'temporary') {
        return groupOrigin('temporary', { context: repoName, detail: variantName, overrideKey: override.key });
      }
      return { kind: 'worktree', nodeKey: virtualKey, projectName: repoName, detail: variantName };
    }
    const local = LOCAL_WORKTREE_PATTERN.exec(normalized);
    if (local?.[1]) {
      return attachToRoot(classify(local[1], depth + 1), 'worktree', local[2]);
    }
    return null;
  };

  const resolveNested = (
    normalized: string,
    segments: readonly string[],
    homeDepth: number,
    depth: number,
  ): SessionOrigin | null => {
    // Tool folders such as `.artifacts/` belong to the project that holds
    // them, but `~/.claude` style home folders are not inside any project.
    const floor = homeDepth > 0 ? homeDepth + 1 : 2;
    const dotIndex = segments.findIndex((segment, index) => index >= floor && segment.startsWith('.'));
    if (dotIndex < 0) return null;
    const prefix = `${normalized.startsWith('/') ? '/' : ''}${segments.slice(0, dotIndex).join('/')}`;
    const knownPrefix = canonicalByKey.get(prefix.toLowerCase());
    if (!knownPrefix) return null;
    return attachToRoot(classify(knownPrefix, depth + 1), 'nested', segments.slice(dotIndex).join('/'));
  };

  const classifyUncached = (path: string, normalized: string, key: string, depth: number): SessionOrigin => {
    const canonical = canonicalByKey.get(key) ?? path;
    const segments = pathSegments(normalized);
    const name = segments[segments.length - 1] ?? '';

    const override = overrideByKey.get(key);
    if (override?.value === 'main') {
      return projectOrigin(canonical, name, override.key);
    }
    if (override?.value === 'temporary') {
      return groupOrigin('temporary', { context: readableName(name), overrideKey: override.key });
    }

    const agent = agentMarkerOf(segments);
    if (agent) {
      return groupOrigin('agent', { context: agent.label });
    }
    if (isSystemTempPath(key)) {
      return groupOrigin('temporary', { context: readableName(name) });
    }

    const worktree = resolveWorktree(normalized, depth);
    if (worktree) return worktree;

    const homeDepth = homeDepthOf(segments);
    if (isChatPath(segments, homeDepth)) {
      return groupOrigin('chat', { context: segments.length > homeDepth && name ? name : undefined });
    }

    const nested = resolveNested(normalized, segments, homeDepth, depth);
    if (nested) return nested;

    if (isTemporaryName(name)) {
      return groupOrigin('temporary', { context: readableName(name) });
    }
    return projectOrigin(canonical, name);
  };

  function classify(path: string, depth: number): SessionOrigin {
    const normalized = normalizeProjectPath(path);
    const key = normalized.toLowerCase();
    const cached = memo.get(key);
    if (cached) return cached;
    if (depth > MAX_ROOT_DEPTH) {
      return projectOrigin(canonicalByKey.get(key) ?? path, basenameOf(normalized));
    }
    const origin = classifyUncached(path, normalized, key, depth);
    memo.set(key, origin);
    return origin;
  }

  const origins = new Map<string, SessionOrigin>();
  for (const path of uniquePaths) {
    origins.set(path, classify(path, 0));
  }
  return origins;
}

export function resolveProjectPathOrigin(
  path: string,
  overrides: ProjectClassificationOverrides = {},
): SessionOrigin {
  return resolveProjectPathOrigins([path], overrides).get(path) ?? projectOrigin(path, basenameOf(path));
}

function launcherGroupOf(launchMode: string | undefined): SidebarGroupId | null {
  switch (launchMode) {
    case 'cron':
    case 'automation':
      return 'scheduled';
    case 'external_control':
    case 'subagent':
      return 'agent';
    default:
      return null;
  }
}

/** Automated launches are grouped by launcher no matter where they ran. */
export function resolveSessionOrigin(
  session: Pick<HistorySessionItem, 'launchMode'>,
  pathOrigin: SessionOrigin,
): SessionOrigin {
  const groupId = launcherGroupOf(session.launchMode);
  if (!groupId) return pathOrigin;
  return compactOrigin({
    kind: 'group',
    groupId,
    nodeKey: groupNodeKey(groupId),
    projectName: '',
    context: pathOrigin.kind === 'group' ? pathOrigin.context : pathOrigin.projectName,
    detail: pathOrigin.detail,
    byLauncher: true,
  });
}

export function isAutomatedSessionOrigin(origin: SessionOrigin): boolean {
  return origin.kind === 'group' && (origin.groupId === 'agent' || origin.groupId === 'scheduled');
}

/** Directory-derived placements can be overridden; launcher groups cannot. */
export function canPromoteSessionOrigin(origin: SessionOrigin): boolean {
  return !origin.byLauncher && origin.kind !== 'project';
}

export function describeSessionOrigin(
  origin: SessionOrigin,
  groupLabel: (groupId: SidebarGroupId) => string,
): string {
  if (origin.kind === 'group' && origin.groupId) {
    const label = groupLabel(origin.groupId);
    return origin.context ? `${label} · ${origin.context}` : label;
  }
  if (origin.kind !== 'project' && origin.detail) {
    return `${origin.projectName} · ${origin.detail}`;
  }
  return origin.projectName;
}

/** Where a session ran relative to the node it is listed under, if anywhere specific. */
export function describeSessionOriginInNode(origin: SessionOrigin): string | undefined {
  if (origin.kind === 'group') {
    const parts = [origin.context, origin.detail].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }
  return origin.kind === 'project' ? undefined : origin.detail;
}

/**
 * Projects first (most recent activity first), then the fixed groups in
 * `SIDEBAR_GROUP_ORDER`. Sessions inside every node are newest first.
 */
export function groupSidebarSessions(
  sessions: readonly HistorySessionItem[],
  originOf: (session: HistorySessionItem) => SessionOrigin,
): ProjectNode[] {
  const projects = new Map<string, ProjectNode>();
  const groups = new Map<SidebarGroupId, ProjectNode>();

  for (const session of sessions) {
    const origin = originOf(session);
    let node: ProjectNode | undefined;
    if (origin.kind === 'group' && origin.groupId) {
      node = groups.get(origin.groupId);
      if (!node) {
        node = {
          project: origin.nodeKey,
          projectName: '',
          sessions: [],
          latestTimestamp: 0,
          kind: 'group',
          groupId: origin.groupId,
        };
        groups.set(origin.groupId, node);
      }
    } else {
      node = projects.get(origin.nodeKey);
      if (!node) {
        node = {
          project: origin.nodeKey,
          projectName: origin.projectName,
          sessions: [],
          latestTimestamp: 0,
          kind: 'project',
          ...(origin.createPath ? { createPath: origin.createPath } : {}),
        };
        projects.set(origin.nodeKey, node);
      }
      if (session.project === origin.nodeKey && session.projectName) {
        node.projectName = session.projectName;
      }
    }
    node.sessions.push(session);
    if (session.timestamp > node.latestTimestamp) {
      node.latestTimestamp = session.timestamp;
    }
  }

  const projectNodes = Array.from(projects.values())
    .sort((left, right) => right.latestTimestamp - left.latestTimestamp);
  const groupNodes = SIDEBAR_GROUP_ORDER
    .map((groupId) => groups.get(groupId))
    .filter((node): node is ProjectNode => node !== undefined);
  const nodes = [...projectNodes, ...groupNodes];
  for (const node of nodes) {
    node.sessions.sort((left, right) => right.timestamp - left.timestamp);
  }
  return nodes;
}

/**
 * Split the flat recent list: finished automated runs leave the timeline for
 * their groups, while running ones (`timelineKeys`) stay visible on top.
 */
export function partitionRecentSessions(
  sessions: readonly HistorySessionItem[],
  originOf: (session: HistorySessionItem) => SessionOrigin,
  timelineKeys: ReadonlySet<string>,
  keyOf: (session: HistorySessionItem) => string,
): { timeline: HistorySessionItem[]; automated: HistorySessionItem[] } {
  const timeline: HistorySessionItem[] = [];
  const automated: HistorySessionItem[] = [];
  for (const session of sessions) {
    if (!timelineKeys.has(keyOf(session)) && isAutomatedSessionOrigin(originOf(session))) {
      automated.push(session);
    } else {
      timeline.push(session);
    }
  }
  return { timeline, automated };
}

export function findProjectClassificationOverrideKey(
  overrides: ProjectClassificationOverrides,
  path: string,
): string | undefined {
  const key = pathKey(path);
  return Object.keys(overrides)
    .sort()
    .find((candidate) => pathKey(candidate) === key && overrides[candidate] !== undefined);
}

/** Set or clear the override for a path, replacing case/slash variants of it. */
export function updateProjectClassificationOverride(
  overrides: Readonly<Record<string, ProjectClassificationOverride>>,
  path: string,
  value: ProjectClassificationOverride | null,
): Record<string, ProjectClassificationOverride> {
  const key = pathKey(path);
  const matchingKeys = Object.keys(overrides).filter((candidate) => pathKey(candidate) === key);
  if (value === null ? matchingKeys.length === 0 : (
    matchingKeys.length === 1 && matchingKeys[0] === path && overrides[path] === value
  )) {
    return overrides;
  }
  const next: Record<string, ProjectClassificationOverride> = {};
  for (const [candidate, candidateValue] of Object.entries(overrides)) {
    if (pathKey(candidate) !== key) {
      next[candidate] = candidateValue;
    }
  }
  if (value !== null) {
    next[path] = value;
  }
  return next;
}
