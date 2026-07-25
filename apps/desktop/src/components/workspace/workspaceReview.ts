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
  if (!trimmed || trimmed.startsWith('{') || /\s/.test(trimmed)) {
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

function buildChangedFiles(
  events: SessionEventRecord[],
  gitSnapshot: WorkspaceGitSnapshot | null | undefined,
): ReviewChangedFile[] {
  const files = new Map<string, ReviewChangedFile>();
  const mutatingToolCandidates = events
    .filter((event) =>
      event.payload.type === 'tool_use_started'
      && (
        event.payload.category.category === 'execution'
        || event.payload.category.category === 'file_op'
        || event.payload.raw_name === 'file_change'
      ))
    .map((event) => {
      if (event.payload.type !== 'tool_use_started') {
        throw new Error('unreachable');
      }
      return {
        toolUseId: event.payload.tool_use_id,
        seq: event.seq,
      };
    });

  const addSdkFile = (
    path: string,
    status: string,
    toolUseId: string,
    sourceSeq: number,
  ) => {
    const current = files.get(path);
    if (current) {
      current.source = current.source === 'git' ? 'matched' : current.source;
      if (!current.toolUseIds.includes(toolUseId)) {
        current.toolUseIds.push(toolUseId);
      }
      if (!current.sourceSeqs.includes(sourceSeq)) {
        current.sourceSeqs.push(sourceSeq);
      }
      return;
    }
    files.set(path, {
      path,
      status,
      source: 'sdk',
      additions: null,
      deletions: null,
      toolUseIds: [toolUseId],
      sourceSeqs: [sourceSeq],
    });
  };

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

  for (const event of events) {
    if (event.payload.type !== 'tool_use_started' && event.payload.type !== 'tool_use_completed') {
      continue;
    }
    const isFileEvent = event.payload.raw_name === 'file_change'
      || (
        event.payload.type === 'tool_use_started'
        && event.payload.category.category === 'file_op'
      );
    if (!isFileEvent) {
      continue;
    }
    const summary = event.payload.type === 'tool_use_started'
      ? event.payload.input_summary
      : event.payload.result_summary;
    const structuredChanges = structuredFileChanges(summary);
    if (structuredChanges.length > 0) {
      for (const change of structuredChanges) {
        addSdkFile(change.path, change.status, event.payload.tool_use_id, event.seq);
      }
      continue;
    }

    const path = toolPathFromSummary(summary);
    if (!path) {
      continue;
    }
    addSdkFile(path, 'sdk', event.payload.tool_use_id, event.seq);
  }

  const fallbackTool = mutatingToolCandidates[mutatingToolCandidates.length - 1];
  if (fallbackTool) {
    for (const file of files.values()) {
      if (file.source !== 'git' || file.toolUseIds.length > 0) {
        continue;
      }
      file.toolUseIds.push(fallbackTool.toolUseId);
      file.sourceSeqs.push(fallbackTool.seq);
    }
  }

  return Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path));
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

function buildToolEvidence(events: SessionEventRecord[]): ReviewToolEvidence[] {
  const tools = new Map<string, ReviewToolEvidence>();
  for (const event of events) {
    if (event.payload.type === 'tool_use_started') {
      tools.set(event.payload.tool_use_id, {
        id: event.payload.tool_use_id,
        seq: event.seq,
        toolUseId: event.payload.tool_use_id,
        rawName: event.payload.raw_name,
        category: categoryName(event.payload.category),
        inputSummary: event.payload.input_summary,
        startedAt: event.occurred_at,
      });
      continue;
    }
    if (event.payload.type === 'tool_use_completed') {
      const current = tools.get(event.payload.tool_use_id);
      if (current) {
        current.resultSummary = event.payload.result_summary;
        current.success = event.payload.success;
        current.completedAt = event.occurred_at;
      } else {
        tools.set(event.payload.tool_use_id, {
          id: event.payload.tool_use_id,
          seq: event.seq,
          toolUseId: event.payload.tool_use_id,
          rawName: event.payload.raw_name,
          category: 'unknown',
          inputSummary: '',
          resultSummary: event.payload.result_summary,
          success: event.payload.success,
          completedAt: event.occurred_at,
        });
      }
    }
  }
  return Array.from(tools.values()).sort((left, right) => left.seq - right.seq);
}

export function buildWorkspaceReviewSummary({
  events,
  gitSnapshot,
}: {
  events: SessionEventRecord[];
  gitSnapshot?: WorkspaceGitSnapshot | null;
}): WorkspaceReviewSummary {
  const changedFiles = buildChangedFiles(events, gitSnapshot);
  const tools = buildToolEvidence(events);

  return {
    failedTools: tools.reduce((count, tool) => count + (tool.success === false ? 1 : 0), 0),
    changedFiles: changedFiles.length,
    artifacts: buildArtifacts(changedFiles).length,
  };
}

export function buildWorkspaceReviewModel({
  events,
  messages,
  gitSnapshot,
}: {
  session: NativeSessionSummary;
  events: SessionEventRecord[];
  messages: ConversationMessageData[];
  gitSnapshot?: WorkspaceGitSnapshot | null;
}): WorkspaceReviewModel {
  const todoState = buildWorkspaceTodos(events);
  const todos = todoState.items;
  const changedFiles = buildChangedFiles(events, gitSnapshot);
  const tools = buildToolEvidence(events);
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
