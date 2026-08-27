export type HistorySource = 'claude' | 'codex' | 'opencode' | 'dsh';

/** Sources that support session resume (DSH is read-only, never resumable). */
export type ResumableHistorySource = Exclude<HistorySource, 'dsh'>;

/** Type guard: returns true if the source supports resume. */
export function isResumableHistorySource(source: HistorySource): source is ResumableHistorySource {
  return source === 'claude' || source === 'codex' || source === 'opencode';
}

export type HistorySourceFilter = 'all' | HistorySource;

export type SessionTaskStage = 'ideation' | 'implementation' | 'validation' | 'release' | 'done';

export type SessionStickerId =
  | 'focused'
  | 'excited'
  | 'calm'
  | 'blocked'
  | 'confused'
  | 'waiting'
  | 'urgent'
  | 'reviewing'
  | 'shipping'
  | 'celebrating'
  | 'risky'
  | 'archived';

export interface HistorySessionItem {
  id: string;
  source: HistorySource;
  display: string;
  timestamp: number;
  project: string;
  projectName: string;
  envName?: string;
  configSource?: 'ccem' | 'native';
  taskStage?: SessionTaskStage;
  taskSticker?: SessionStickerId;
  taskLabel?: string;
}

export interface WorkspaceProjectNode {
  project: string;
  projectName: string;
  sessions: HistorySessionItem[];
  latestTimestamp: number;
}

export interface WorkspaceProjectNodePayload {
  project: string;
  projectName: string;
  sessionKeys?: string[];
  sessions?: HistorySessionItem[];
  latestTimestamp: number;
}

export interface WorkspaceOverviewSnapshot {
  sessions: HistorySessionItem[];
  projectNodes: WorkspaceProjectNode[];
  totalSessions: number;
  totalProjects: number;
}

export interface WorkspaceOverviewSnapshotPayload {
  sessions: HistorySessionItem[];
  projectNodes: WorkspaceProjectNodePayload[];
  totalSessions: number;
  totalProjects: number;
}

export interface ConversationContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
  _result?: unknown;
  _resultError?: boolean;
  [key: string]: unknown;
}

export interface ConversationMessageData {
  msgType: string;
  uuid?: string;
  content: ConversationContentBlock[] | ConversationContentBlock | string | null;
  model?: string;
  summary?: string;
  timestamp?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  segmentIndex: number;
  isCompactBoundary: boolean;
  planContent?: string;
  annotations?: Array<{ quote: string; note: string }>;
}

export type ConversationMessageList = ConversationMessageData[] & {
  toolResultsMerged?: boolean;
};

export interface ConversationDetailPayload {
  messages: ConversationMessageData[];
  segments: HistorySegment[];
  toolResultsMerged?: boolean;
}

export interface HistorySegment {
  segmentIndex: number;
  timestamp: number;
  trigger?: string;
  preTokens?: number;
  messageCount: number;
}

/** List entry for a Claude Code sub-agent (Task/Agent sidechain). */
export interface SubagentMeta {
  agentId: string;
  subagentType?: string;
  description?: string;
  /** `running` | `completed` | `failed` */
  status: string;
  messageCount: number;
  toolCount: number;
  startedAt: number;
  completedAt?: number;
  resultSummary?: string;
}

export interface SessionSubagentsPayload {
  subagents: SubagentMeta[];
  /** Full message transcript for the requested detail agent, if any. */
  detail?: ConversationMessageData[] | null;
}

export function toSessionKey(session: Pick<HistorySessionItem, 'id' | 'source'>): string {
  return `${session.source}:${session.id}`;
}
