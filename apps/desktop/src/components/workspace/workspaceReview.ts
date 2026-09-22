import type { ConversationContentBlock, ConversationMessageData } from '@/features/conversations/types';
import type { NativeSessionSummary, SessionEventRecord, WorkspaceGitSnapshot } from '@/lib/tauri-ipc';
import {
  buildWorkspaceTodos,
  type WorkspaceTodoItem,
  type WorkspaceTodos,
} from './workspaceTodos';

export type ReviewSource = 'sdk' | 'git' | 'matched';

export interface ReviewToolEvidence {
  id: string;
  seq: number;
  toolUseId: string;
  rawName: string;
  category: string;
  inputSummary: string;
  resultSummary?: string;
  success?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export type ReviewTodoItem = WorkspaceTodoItem;

export interface ReviewChangedFile {
  path: string;
  status: string;
  source: ReviewSource;
  additions?: number | null;
  deletions?: number | null;
  toolUseIds: string[];
  sourceSeqs: number[];
}

export interface ReviewArtifact {
  id: string;
  path: string;
  kind: 'html' | 'image' | 'report' | 'patch' | 'log' | 'json' | 'file';
  openable: boolean;
  source: ReviewSource;
  sourceSeqs: number[];
  toolUseIds: string[];
}

export interface WorkspaceReviewModel {
  finalReply: string;
  artifacts: ReviewArtifact[];
  todos: ReviewTodoItem[];
  changedFiles: ReviewChangedFile[];
  tools: ReviewToolEvidence[];
  failedTools: ReviewToolEvidence[];
  todoCompleted: number;
  todoTotal: number;
  todoSource: WorkspaceTodos['source'];
  todoRevision: number | null;
}

export interface WorkspaceReviewSummary {
  failedTools: number;
  changedFiles: number;
  artifacts: number;
}

const ARTIFACT_EXTENSIONS = new Map<string, ReviewArtifact['kind']>([
  ['html', 'html'],
  ['htm', 'html'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['webp', 'image'],
  ['gif', 'image'],
  ['svg', 'image'],
  ['pdf', 'report'],
  ['md', 'report'],
  ['markdown', 'report'],
  ['txt', 'report'],
  ['patch', 'patch'],
  ['diff', 'patch'],
  ['log', 'log'],
  ['json', 'json'],
  ['jsonl', 'json'],
]);

function compactText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function categoryName(category: unknown): string {
  if (!category || typeof category !== 'object') {
    return 'unknown';
  }
  const value = (category as { category?: unknown }).category;
  return typeof value === 'string' ? value : 'unknown';
}

function contentBlockText(block: ConversationContentBlock): string {
  if (typeof block.text === 'string') {
    return block.text;
  }
  if (typeof block.thinking === 'string') {
    return block.thinking;
  }
  if (typeof block.content === 'string') {
    return block.content;
  }
  return '';
}

function messageText(message: ConversationMessageData): string {
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(contentBlockText).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    return contentBlockText(content as ConversationContentBlock);
  }
  return '';
}

function latestAssistantReply(messages: ConversationMessageData[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.msgType !== 'assistant') {
      continue;
    }
    const text = compactText(messageText(message));
    if (text) {
      return text;
    }
  }
  return '';
}

function safeJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed) || trimmed.endsWith('…')) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function toolPathFromSummary(summary: string): string | null {
  const trimmed = summary.trim();
  if (!trimmed || trimmed.startsWith('{') || /[\r\n]/.test(trimmed) || trimmed.endsWith('…')) {
    return null;
  }
  if (!/[/.\\]/.test(trimmed) && !/\.[a-z0-9]{1,8}$/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^["']|["']$/g, '');
}

function structuredFileChanges(summary: string): Array<{ path: string; status: string }> {
  const parsed = safeJson(summary);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  const changes = Array.isArray(record.changes)
    ? record.changes
    : Array.isArray(record.files)
      ? record.files
      : [];

  return changes
    .map((change): { path: string; status: string } | null => {
      if (typeof change === 'string') {
        return { path: change, status: 'sdk' };
      }
      if (!change || typeof change !== 'object') {
        return null;
      }
      const changeRecord = change as Record<string, unknown>;
      const path = getString(changeRecord, ['path', 'file_path', 'filePath', 'target_file']);
      if (!path) {
        return null;
      }
      const status = getString(changeRecord, ['kind', 'status', 'type']) ?? 'sdk';
      return { path, status };
    })
    .filter((change): change is { path: string; status: string } => Boolean(change));
}

function gitStatusLabel(status: string) {
  const value = status.trim();
  if (value === 'A' || value.includes('A')) return 'added';
  if (value === 'D' || value.includes('D')) return 'deleted';
  if (value === 'R' || value.includes('R')) return 'renamed';
  if (value === '??') return 'untracked';
  if (value === 'M' || value.includes('M')) return 'modified';
  return value || 'changed';
}

function artifactKind(path: string): ReviewArtifact['kind'] | null {
  const lower = path.toLowerCase();
  const ext = lower.split('.').pop() ?? '';
  const byExtension = ARTIFACT_EXTENSIONS.get(ext);
  if (byExtension) {
    return byExtension;
  }
  if (/(report|summary|result|artifact)/.test(lower)) {
    return 'report';
  }
  return null;
}

function buildArtifacts(files: ReviewChangedFile[]): ReviewArtifact[] {
  return files
    .map((file): ReviewArtifact | null => {
      const kind = artifactKind(file.path);
      if (!kind) {
        return null;
      }
      return {
        id: file.path,
        path: file.path,
        kind,
        openable: true,
        source: file.source,
        sourceSeqs: file.sourceSeqs,
        toolUseIds: file.toolUseIds,
      };
    })
    .filter((artifact): artifact is ReviewArtifact => Boolean(artifact));
}

/**
 * Incremental review fold (plan 022). The status-strip summary needs full
 * session history (changed-file and tool evidence totals), but the live view's
 * raw event array is bounded — so events fold into this accumulator and the
 * summary assembles from (fold, gitSnapshot) without rescanning events.
 */
export interface WorkspaceReviewEventFold {
  /** SDK/file-op-derived file mentions, insertion order = first mention. */
  sdkFiles: Map<string, {
    status: string;
    toolUseIds: string[];
    sourceSeqs: number[];
  }>;
  /** Tool evidence keyed by tool_use_id (starts updated by completions). */
  tools: Map<string, ReviewToolEvidence>;
}

function isWritingTool(name: string) {
  return /^(?:write|edit|multiedit|notebookedit|apply_patch|file_change)$/i.test(name);
}

function normalizeReviewPath(path: string, workingDir?: string | null): string {
  const normalize = (value: string) => {
    const absolute = value.startsWith('/');
    const parts: string[] = [];
    for (const part of value.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
    }
    return (absolute ? '/' : '') + parts.join('/');
  };
  const normalized = normalize(path);
  const root = workingDir ? normalize(workingDir).replace(/\/$/, '') : '';
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/** Fold `events` into `previous` (or a fresh accumulator when null). */
export function foldWorkspaceReviewEvents(
  previous: WorkspaceReviewEventFold | null,
  events: SessionEventRecord[],
): WorkspaceReviewEventFold {
  const fold: WorkspaceReviewEventFold = previous
    ? {
      sdkFiles: new Map([...previous.sdkFiles].map(([path, file]) => [path, { ...file, toolUseIds: [...file.toolUseIds], sourceSeqs: [...file.sourceSeqs] }])),
      tools: new Map([...previous.tools].map(([id, tool]) => [id, { ...tool }])),
    }
    : { sdkFiles: new Map(), tools: new Map() };

  const addSdkFile = (
    path: string,
    status: string,
    toolUseId: string,
    sourceSeq: number,
  ) => {
    const current = fold.sdkFiles.get(path);
    if (current) {
      if (!current.toolUseIds.includes(toolUseId)) {
        current.toolUseIds.push(toolUseId);
      }
      if (!current.sourceSeqs.includes(sourceSeq)) {
        current.sourceSeqs.push(sourceSeq);
      }
      return;
    }
    fold.sdkFiles.set(path, {
      status,
      toolUseIds: [toolUseId],
      sourceSeqs: [sourceSeq],
    });
  };

  for (const event of events) {
    const { payload } = event;

    if (payload.type === 'tool_use_started' || payload.type === 'tool_use_completed') {
      const isFileEvent = isWritingTool(payload.raw_name);
      if (isFileEvent) {
        const summary = payload.type === 'tool_use_started'
          ? payload.input_summary
          : payload.result_summary;
        const structuredChanges = structuredFileChanges(summary);
        if (structuredChanges.length > 0) {
          for (const change of structuredChanges) {
            addSdkFile(change.path, change.status, payload.tool_use_id, event.seq);
          }
        } else {
          const parsed = safeJson(summary);
          const path = parsed && typeof parsed === 'object'
            ? getString(parsed as Record<string, unknown>, ['file_path', 'filePath', 'path', 'target_file', 'notebook_path'])
            : payload.type === 'tool_use_started' ? toolPathFromSummary(summary) : null;
          if (path) {
            addSdkFile(path, 'sdk', payload.tool_use_id, event.seq);
          }
        }
      }
    }

    if (payload.type === 'tool_use_started') {
      fold.tools.set(payload.tool_use_id, {
        id: payload.tool_use_id,
        seq: event.seq,
        toolUseId: payload.tool_use_id,
        rawName: payload.raw_name,
        category: categoryName(payload.category),
        inputSummary: payload.input_summary,
        startedAt: event.occurred_at,
      });
      continue;
    }
    if (payload.type === 'tool_use_completed') {
      const current = fold.tools.get(payload.tool_use_id);
      if (current) {
        current.resultSummary = payload.result_summary;
        current.success = payload.success;
        current.completedAt = event.occurred_at;
      } else {
        fold.tools.set(payload.tool_use_id, {
          id: payload.tool_use_id,
          seq: event.seq,
          toolUseId: payload.tool_use_id,
          rawName: payload.raw_name,
          category: 'unknown',
          inputSummary: '',
          resultSummary: payload.result_summary,
          success: payload.success,
          completedAt: event.occurred_at,
        });
      }
    }
  }

  return fold;
}

/** One source of truth for the compact summary and the full file list. */
function reviewFilesFromFold(
  fold: WorkspaceReviewEventFold | null,
  gitSnapshot?: WorkspaceGitSnapshot | null,
  workingDir?: string | null,
): ReviewChangedFile[] {
  const files = new Map<string, ReviewChangedFile>();
  for (const file of gitSnapshot?.files ?? []) {
    files.set(file.path, {
      path: file.path,
      status: gitStatusLabel(file.status),
      source: 'git',
      additions: file.additions,
      deletions: file.deletions,
      toolUseIds: [],
      sourceSeqs: [],
    });
  }

  for (const [rawPath, sdkFile] of fold?.sdkFiles ?? []) {
    const toolUseIds = sdkFile.toolUseIds.filter((id) => fold?.tools.get(id)?.success !== false);
    if (toolUseIds.length === 0) continue;
    const path = normalizeReviewPath(rawPath, workingDir ?? gitSnapshot?.root);
    const current = files.get(path);
    if (current) {
      current.source = current.source === 'git' ? 'matched' : current.source;
      for (const toolUseId of toolUseIds) {
        if (!current.toolUseIds.includes(toolUseId)) {
          current.toolUseIds.push(toolUseId);
        }
      }
      for (const sourceSeq of sdkFile.sourceSeqs) {
        if (!current.sourceSeqs.includes(sourceSeq)) {
          current.sourceSeqs.push(sourceSeq);
        }
      }
      continue;
    }
    files.set(path, {
      path,
      status: sdkFile.status,
      source: 'sdk',
      additions: null,
      deletions: null,
      toolUseIds: [...toolUseIds],
      sourceSeqs: [...sdkFile.sourceSeqs],
    });
  }

  return Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export function buildWorkspaceReviewSummaryFromFold(
  fold: WorkspaceReviewEventFold | null,
  gitSnapshot?: WorkspaceGitSnapshot | null,
  workingDir?: string | null,
): WorkspaceReviewSummary {
  const changedFiles = reviewFilesFromFold(fold, gitSnapshot, workingDir);
  return {
    failedTools: Array.from(fold?.tools.values() ?? []).filter((tool) => tool.success === false).length,
    changedFiles: changedFiles.length,
    artifacts: buildArtifacts(changedFiles).length,
  };
}

export function buildWorkspaceReviewSummary({
  events,
  gitSnapshot,
  workingDir,
}: {
  events: SessionEventRecord[];
  gitSnapshot?: WorkspaceGitSnapshot | null;
  workingDir?: string | null;
}): WorkspaceReviewSummary {
  return buildWorkspaceReviewSummaryFromFold(
    foldWorkspaceReviewEvents(null, events),
    gitSnapshot,
    workingDir,
  );
}

export function buildWorkspaceReviewModel({
  session,
  events,
  messages,
  gitSnapshot,
  eventFold,
}: {
  session: NativeSessionSummary;
  events: SessionEventRecord[];
  messages: ConversationMessageData[];
  gitSnapshot?: WorkspaceGitSnapshot | null;
  eventFold?: WorkspaceReviewEventFold | null;
}): WorkspaceReviewModel {
  const todoState = buildWorkspaceTodos(events, messages);
  const todos = todoState.items;
  const fold = eventFold ?? foldWorkspaceReviewEvents(null, events);
  const changedFiles = reviewFilesFromFold(fold, gitSnapshot, session.project_dir);
  const tools = Array.from(fold.tools.values()).sort((left, right) => left.seq - right.seq);
  const failedTools = tools.filter((tool) => tool.success === false);

  return {
    finalReply: latestAssistantReply(messages),
    artifacts: buildArtifacts(changedFiles),
    todos,
    changedFiles,
    tools,
    failedTools,
    todoCompleted: todoState.completed,
    todoTotal: todoState.total,
    todoSource: todoState.source,
    todoRevision: todoState.revision,
  };
}
