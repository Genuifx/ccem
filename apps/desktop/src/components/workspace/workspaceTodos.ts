import type {
  SessionEventRecord,
  TodoSnapshotItemV1,
  TodoSnapshotStatusV1,
  TodoSnapshotV1,
} from '@/lib/tauri-ipc';

export interface WorkspaceTodoItem {
  id: string;
  text: string;
  status: TodoSnapshotStatusV1;
  activeText?: string;
  sourceLabel: string;
  sourceSeq: number;
  toolUseId?: string;
}

export interface WorkspaceTodos {
  items: WorkspaceTodoItem[];
  completed: number;
  total: number;
  source: 'structured' | 'legacy' | 'unavailable';
  revision: number | null;
}

interface ClaudeRawToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface StructuredSnapshotEvent {
  event: SessionEventRecord;
  snapshot: TodoSnapshotV1;
}

const TODO_STATUSES = new Set<TodoSnapshotStatusV1>([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);
const TODO_PROVIDERS = new Set(['claude', 'codex']);
const TODO_SOURCES = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'todo_list',
]);

function compactText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
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

function normalizeTodoStatus(value: unknown): TodoSnapshotStatusV1 {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (status.includes('done') || status.includes('complete')) {
    return 'completed';
  }
  if (status.includes('progress') || status.includes('active') || status.includes('doing')) {
    return 'in_progress';
  }
  if (status.includes('fail') || status.includes('error') || status.includes('blocked')) {
    return 'failed';
  }
  return 'pending';
}

function todoTextFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') {
    return compactText(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return getString(value as Record<string, unknown>, [
    'content',
    'text',
    'title',
    'task',
    'description',
    'name',
  ]);
}

function todoStableIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return getString(value as Record<string, unknown>, [
    'id',
    'task_id',
    'taskId',
    'todo_id',
    'todoId',
    'uuid',
  ]);
}

function todoStatusFromUnknown(value: unknown): TodoSnapshotStatusV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'pending';
  }
  const record = value as Record<string, unknown>;
  if (typeof record.completed === 'boolean') {
    return record.completed ? 'completed' : 'pending';
  }
  return normalizeTodoStatus(record.status ?? record.state ?? record.phase);
}

function readTodoArray(input: Record<string, unknown>): unknown[] {
  for (const key of ['todos', 'tasks', 'items', 'todo_list']) {
    const value = input[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function isValidSnapshotItem(value: unknown): value is TodoSnapshotItemV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && item.id.trim().length > 0
    && typeof item.text === 'string'
    && item.text.trim().length > 0
    && TODO_STATUSES.has(item.status as TodoSnapshotStatusV1)
    && (item.active_text === undefined || typeof item.active_text === 'string');
}

function validSnapshotFromEvent(event: SessionEventRecord): TodoSnapshotV1 | null {
  if (event.payload.type !== 'tool_use_started' && event.payload.type !== 'tool_use_completed') {
    return null;
  }
  const value: unknown = event.payload.todo_snapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1
    || !TODO_PROVIDERS.has(String(snapshot.provider))
    || !TODO_SOURCES.has(String(snapshot.source))
    || !Number.isSafeInteger(snapshot.revision)
    || Number(snapshot.revision) < 0
    || !Array.isArray(snapshot.items)
    || !snapshot.items.every(isValidSnapshotItem)
  ) {
    return null;
  }
  return value as TodoSnapshotV1;
}

function latestStructuredSnapshot(events: SessionEventRecord[]): StructuredSnapshotEvent | null {
  let latest: StructuredSnapshotEvent | null = null;
  for (const event of events) {
    const snapshot = validSnapshotFromEvent(event);
    if (!snapshot) {
      continue;
    }
    if (
      !latest
      || event.seq > latest.event.seq
      || (event.seq === latest.event.seq && snapshot.revision > latest.snapshot.revision)
    ) {
      latest = { event, snapshot };
    }
  }
  return latest;
}

function snapshotToolUseId(event: SessionEventRecord): string | undefined {
  if (event.payload.type !== 'tool_use_started' && event.payload.type !== 'tool_use_completed') {
    return undefined;
  }
  return event.payload.tool_use_id;
}

function workspaceItemFromSnapshot(
  item: TodoSnapshotItemV1,
  snapshotEvent: StructuredSnapshotEvent,
): WorkspaceTodoItem {
  const { event, snapshot } = snapshotEvent;
  const toolUseId = snapshotToolUseId(event);
  return {
    id: item.id,
    text: item.text,
    status: item.status,
    ...(item.active_text !== undefined ? { activeText: item.active_text } : {}),
    sourceLabel: snapshot.source,
    sourceSeq: event.seq,
    ...(toolUseId ? { toolUseId } : {}),
  };
}

function extractClaudeRawToolUses(events: SessionEventRecord[]): Map<string, ClaudeRawToolUse> {
  const tools = new Map<string, ClaudeRawToolUse>();
  for (const event of events) {
    if (event.payload.type !== 'claude_json') {
      continue;
    }
    const parsed = safeJson(event.payload.raw_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const message = (parsed as { message?: { content?: unknown } }).message;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        continue;
      }
      const record = block as Record<string, unknown>;
      if (record.type !== 'tool_use' || typeof record.id !== 'string' || typeof record.name !== 'string') {
        continue;
      }
      tools.set(record.id, {
        id: record.id,
        name: record.name,
        input: record.input && typeof record.input === 'object' && !Array.isArray(record.input)
          ? record.input as Record<string, unknown>
          : {},
      });
    }
  }
  return tools;
}

function pushLegacyTodo(
  map: Map<string, WorkspaceTodoItem>,
  value: unknown,
  source: { seq: number; label: string; toolUseId?: string },
) {
  const text = todoTextFromUnknown(value);
  const stableId = todoStableIdFromUnknown(value);
  if (!text && !stableId) {
    return;
  }
  const id = stableId ? `id:${stableId}` : `text:${text}`;
  const current = map.get(id);
  map.set(id, {
    id,
    text: text ?? current?.text ?? `Task ${stableId}`,
    status: todoStatusFromUnknown(value),
    sourceLabel: source.label,
    sourceSeq: source.seq,
    ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
  });
}

function buildLegacyTodos(events: SessionEventRecord[]): WorkspaceTodoItem[] {
  const todos = new Map<string, WorkspaceTodoItem>();
  const rawClaudeTools = extractClaudeRawToolUses(events);

  for (const event of events) {
    if (event.payload.type !== 'tool_use_started' && event.payload.type !== 'tool_use_completed') {
      continue;
    }
    const rawName = event.payload.raw_name;
    if (!rawName.includes('Task') && !rawName.includes('Todo') && rawName !== 'todo_list') {
      continue;
    }

    const rawTool = rawClaudeTools.get(event.payload.tool_use_id);
    const input = rawTool?.input;
    const parsedSummary = event.payload.type === 'tool_use_completed'
      ? safeJson(event.payload.result_summary)
      : safeJson(event.payload.input_summary);
    const parsedInput = parsedSummary && typeof parsedSummary === 'object' && !Array.isArray(parsedSummary)
      ? parsedSummary as Record<string, unknown>
      : null;
    const todoValues = input ? readTodoArray(input) : parsedInput ? readTodoArray(parsedInput) : [];

    if (todoValues.length > 0) {
      for (const todo of todoValues) {
        pushLegacyTodo(todos, todo, {
          seq: event.seq,
          label: rawName,
          toolUseId: event.payload.tool_use_id,
        });
      }
      continue;
    }

    if (input && (rawName === 'TaskCreate' || rawName === 'TaskUpdate')) {
      const text = getString(input, ['content', 'text', 'title', 'task', 'description']);
      pushLegacyTodo(todos, text ? { ...input, text } : input, {
        seq: event.seq,
        label: rawName,
        toolUseId: event.payload.tool_use_id,
      });
    }
  }

  return Array.from(todos.values());
}

function buildResult(
  items: WorkspaceTodoItem[],
  source: WorkspaceTodos['source'],
  revision: number | null,
): WorkspaceTodos {
  return {
    items,
    completed: items.reduce((count, item) => count + (item.status === 'completed' ? 1 : 0), 0),
    total: items.length,
    source,
    revision,
  };
}

export function buildWorkspaceTodos(events: SessionEventRecord[]): WorkspaceTodos {
  const structured = latestStructuredSnapshot(events);
  if (structured) {
    return buildResult(
      structured.snapshot.items.map((item) => workspaceItemFromSnapshot(item, structured)),
      'structured',
      structured.snapshot.revision,
    );
  }

  const legacyItems = buildLegacyTodos(events);
  return buildResult(
    legacyItems,
    legacyItems.length > 0 ? 'legacy' : 'unavailable',
    null,
  );
}

export function selectCachedWorkspaceEvents(
  events: SessionEventRecord[],
  tailLimit: number,
): SessionEventRecord[] {
  const limit = Math.max(0, Math.floor(tailLimit));
  if (limit === 0 || events.length === 0) {
    return [];
  }

  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const tail = ordered.slice(-limit);
  const snapshotEvent = latestStructuredSnapshot(ordered)?.event;
  if (!snapshotEvent) {
    return tail;
  }
  const snapshotKey = `${snapshotEvent.runtime_id}:${snapshotEvent.seq}`;
  if (tail.some((event) => `${event.runtime_id}:${event.seq}` === snapshotKey)) {
    return tail;
  }
  return [snapshotEvent, ...tail];
}

export function mergeWorkspaceReplayEvents(
  cachedEvents: SessionEventRecord[],
  replayedEvents: SessionEventRecord[],
): SessionEventRecord[] {
  const eventsBySequence = new Map<string, SessionEventRecord>();
  for (const event of cachedEvents) {
    eventsBySequence.set(`${event.runtime_id}:${event.seq}`, event);
  }
  for (const event of replayedEvents) {
    eventsBySequence.set(`${event.runtime_id}:${event.seq}`, event);
  }
  return Array.from(eventsBySequence.values()).sort((left, right) => {
    if (left.runtime_id !== right.runtime_id) {
      return left.runtime_id.localeCompare(right.runtime_id);
    }
    return left.seq - right.seq;
  });
}
