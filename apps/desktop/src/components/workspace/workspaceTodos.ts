import type { ConversationContentBlock, ConversationMessageData } from '@/features/conversations/types';
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
  source: 'structured' | 'legacy' | 'history' | 'unavailable';
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

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  const direct = readRecord(value);
  if (direct) {
    if (direct.type === 'tool_result' && direct.content !== undefined) {
      return resultRecord(direct.content);
    }
    return direct;
  }
  if (typeof value === 'string') {
    const parsed = safeJson(value);
    return readRecord(parsed);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = readRecord(entry);
      const parsed = record?.type === 'text'
        ? resultRecord(record.text)
        : resultRecord(entry);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function resultText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  const record = readRecord(value);
  if (record) {
    if (record.type === 'tool_result' && record.content !== undefined) {
      return resultText(record.content);
    }
    if (record.type === 'text' && typeof record.text === 'string') {
      return resultText(record.text);
    }
    return null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => resultText(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

function normalizeTodoStatus(
  value: unknown,
  fallback: TodoSnapshotStatusV1 = 'pending',
): TodoSnapshotStatusV1 {
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
  return fallback;
}

function todoTextFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') {
    return compactText(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return getString(value as Record<string, unknown>, [
    'subject',
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

function todoStatusFromUnknown(
  value: unknown,
  fallback: TodoSnapshotStatusV1 = 'pending',
): TodoSnapshotStatusV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.completed === 'boolean') {
    return record.completed ? 'completed' : 'pending';
  }
  return normalizeTodoStatus(record.status ?? record.state ?? record.phase, fallback);
}

function todoActiveTextFromUnknown(value: unknown): string | null {
  const record = readRecord(value);
  return record ? getString(record, ['activeForm', 'active_text']) : null;
}

function todoArrayFromRecord(input: Record<string, unknown>): unknown[] | null {
  for (const key of ['todos', 'tasks', 'items', 'todo_list']) {
    const value = input[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function taskIdFromResult(value: unknown): string | null {
  const text = resultText(value);
  if (!text) {
    return null;
  }
  const created = text.match(/\btask\s*#\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+created\b/i)
    ?? text.match(/\btask\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+created\b/i);
  return created?.[1] ?? null;
}

function taskListItemsFromResult(value: unknown): unknown[] | null {
  const text = resultText(value);
  if (!text) {
    return null;
  }
  const items: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:[-*]\s*)?#([^\s[\]:]+):?\s+\[([^\]]+)\]\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const subject = compactText(match[3].split(/\s+—\s+/, 1)[0]);
    if (!subject) {
      continue;
    }
    items.push({ id: match[1], subject, status: match[2] });
  }
  if (items.length > 0) {
    return items;
  }
  return /^(?:no tasks(?: found)?|no active tasks|task list is empty|there are no tasks)\.?$/i.test(text)
    ? []
    : null;
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

function legacyTodoKey(
  map: Map<string, WorkspaceTodoItem>,
  stableId: string | null,
  text: string | null,
): string | null {
  if (stableId) {
    return `id:${stableId}`;
  }
  if (!text) {
    return null;
  }
  const existing = Array.from(map.entries()).find(([, item]) => item.text === text);
  return existing?.[0] ?? `text:${text}`;
}

function applyLegacyTodo(
  map: Map<string, WorkspaceTodoItem>,
  value: unknown,
  source: { seq: number; label: string; toolUseId?: string },
): boolean {
  const text = todoTextFromUnknown(value);
  const stableId = todoStableIdFromUnknown(value);
  const id = legacyTodoKey(map, stableId, text);
  if (!id) {
    return false;
  }
  const current = map.get(id);
  if (!text && !current) {
    return false;
  }
  const activeText = todoActiveTextFromUnknown(value) ?? current?.activeText;
  map.set(id, {
    id,
    text: text ?? current!.text,
    status: todoStatusFromUnknown(value, current?.status ?? 'pending'),
    ...(activeText ? { activeText } : {}),
    sourceLabel: source.label,
    sourceSeq: source.seq,
    ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
  });
  return true;
}

function legacyReplacement(
  values: unknown[],
  source: { seq: number; label: string; toolUseId?: string },
): Map<string, WorkspaceTodoItem> {
  const replacement = new Map<string, WorkspaceTodoItem>();
  values.forEach((value, index) => {
    const text = todoTextFromUnknown(value);
    if (!text) {
      return;
    }
    const stableId = todoStableIdFromUnknown(value);
    const activeText = todoActiveTextFromUnknown(value);
    const id = stableId ? `id:${stableId}` : `legacy:${source.seq}:${index}`;
    replacement.set(id, {
      id,
      text,
      status: todoStatusFromUnknown(value),
      ...(activeText ? { activeText } : {}),
      sourceLabel: source.label,
      sourceSeq: source.seq,
      ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
    });
  });
  return replacement;
}

function applyLegacyValues(
  map: Map<string, WorkspaceTodoItem>,
  values: unknown[],
  source: { seq: number; label: string; toolUseId?: string },
): boolean {
  return values.reduce<boolean>(
    (changed, value) => applyLegacyTodo(map, value, source) || changed,
    false,
  );
}

function taskCreateTodo(
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  resultValue: unknown,
  source: { seq: number; label: string; toolUseId?: string },
): WorkspaceTodoItem | null {
  const task = readRecord(result?.task);
  const id = (task && todoStableIdFromUnknown(task))
    ?? todoStableIdFromUnknown(input)
    ?? todoStableIdFromUnknown(result)
    ?? taskIdFromResult(resultValue);
  const text = todoTextFromUnknown(input) ?? (task && todoTextFromUnknown(task));
  if (!id || !text) {
    return null;
  }
  const activeText = todoActiveTextFromUnknown(input) ?? (task && todoActiveTextFromUnknown(task));
  return {
    id: `id:${id}`,
    text,
    status: todoStatusFromUnknown(input, task ? todoStatusFromUnknown(task) : 'pending'),
    ...(activeText ? { activeText } : {}),
    sourceLabel: source.label,
    sourceSeq: source.seq,
    ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
  };
}

function applyTaskUpdate(
  map: Map<string, WorkspaceTodoItem>,
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  resultValue: unknown,
  source: { seq: number; label: string; toolUseId?: string },
): boolean {
  const resultTask = readRecord(result?.task);
  const id = todoStableIdFromUnknown(input)
    ?? (resultTask && todoStableIdFromUnknown(resultTask))
    ?? todoStableIdFromUnknown(result)
    ?? taskIdFromResult(resultValue);
  if (!id) {
    return false;
  }
  const key = `id:${id}`;
  if (typeof input.status === 'string' && input.status.toLowerCase() === 'deleted') {
    return map.delete(key);
  }

  const current = map.get(key);
  const text = todoTextFromUnknown(input)
    ?? (resultTask && todoTextFromUnknown(resultTask))
    ?? current?.text;
  if (!text) {
    return false;
  }
  const activeText = todoActiveTextFromUnknown(input)
    ?? (resultTask && todoActiveTextFromUnknown(resultTask))
    ?? current?.activeText;
  map.set(key, {
    id: key,
    text,
    status: todoStatusFromUnknown(
      input,
      resultTask
        ? todoStatusFromUnknown(resultTask, current?.status ?? 'pending')
        : current?.status ?? 'pending',
    ),
    ...(activeText ? { activeText } : {}),
    sourceLabel: source.label,
    sourceSeq: source.seq,
    ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
  });
  return true;
}

function completedLegacyToolUseIds(events: SessionEventRecord[]): Set<string> {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.payload.type === 'tool_use_completed') {
      completed.add(event.payload.tool_use_id);
    }
  }
  return completed;
}

function legacyStartedInputs(events: SessionEventRecord[]): Map<string, Record<string, unknown>> {
  const inputs = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.payload.type !== 'tool_use_started') {
      continue;
    }
    const input = readRecord(safeJson(event.payload.input_summary));
    if (input) {
      inputs.set(event.payload.tool_use_id, input);
    }
  }
  return inputs;
}

function buildLegacyTodos(
  events: SessionEventRecord[],
  baselineItems: WorkspaceTodoItem[],
): { items: WorkspaceTodoItem[]; observed: boolean } {
  let todos = new Map(baselineItems.map((item) => [item.id, item]));
  let observed = false;
  const rawClaudeTools = extractClaudeRawToolUses(events);
  const completedToolUseIds = completedLegacyToolUseIds(events);
  const startedInputs = legacyStartedInputs(events);

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.payload.type !== 'tool_use_started' && event.payload.type !== 'tool_use_completed') {
      continue;
    }
    if (
      event.payload.type === 'tool_use_started'
      && completedToolUseIds.has(event.payload.tool_use_id)
    ) {
      continue;
    }
    if (event.payload.type === 'tool_use_completed' && !event.payload.success) {
      continue;
    }
    const rawName = event.payload.raw_name;
    if (!TODO_SOURCES.has(rawName)) {
      continue;
    }

    const rawTool = rawClaudeTools.get(event.payload.tool_use_id);
    const input = rawTool?.input
      ?? startedInputs.get(event.payload.tool_use_id)
      ?? (event.payload.type === 'tool_use_started'
        ? readRecord(safeJson(event.payload.input_summary))
        : null);
    const resultValue = event.payload.type === 'tool_use_completed'
      ? event.payload.result_content?.trim() || event.payload.result_summary
      : null;
    const result = resultRecord(resultValue);
    const source = {
      seq: event.seq,
      label: rawName,
      toolUseId: event.payload.tool_use_id,
    };
    const isConfirmed = event.payload.type === 'tool_use_completed';

    if (rawName === 'TodoWrite') {
      const values = input && Array.isArray(input.todos) ? input.todos : null;
      if (!values) {
        continue;
      }
      if (isConfirmed) {
        todos = legacyReplacement(values, source);
        observed = true;
      } else if (values.length > 0) {
        observed = applyLegacyValues(todos, values, source) || observed;
      }
      continue;
    }

    if (rawName === 'TaskList') {
      const values = Array.isArray(result?.tasks)
        ? result.tasks
        : taskListItemsFromResult(resultValue) ?? (input ? todoArrayFromRecord(input) : null);
      if (!values) {
        continue;
      }
      if (isConfirmed) {
        todos = legacyReplacement(values, source);
        observed = true;
      } else if (values.length > 0) {
        observed = applyLegacyValues(todos, values, source) || observed;
      }
      continue;
    }

    if (rawName === 'TaskCreate') {
      if (!input) {
        continue;
      }
      const item = taskCreateTodo(input, result, resultValue, source);
      if (item) {
        todos.set(item.id, item);
        observed = true;
      }
      continue;
    }

    if (rawName === 'TaskUpdate') {
      if (!input) {
        continue;
      }
      observed = applyTaskUpdate(todos, input, result, resultValue, source) || observed;
      continue;
    }

    const values = todoArrayFromRecord(result ?? {})
      ?? (input ? todoArrayFromRecord(input) : null);
    if (!values) {
      continue;
    }
    if (isConfirmed) {
      todos = legacyReplacement(values, source);
      observed = true;
    } else if (values.length > 0) {
      observed = applyLegacyValues(todos, values, source) || observed;
    }
  }

  return { items: Array.from(todos.values()), observed };
}

function messageContentBlocks(message: ConversationMessageData): ConversationContentBlock[] {
  if (Array.isArray(message.content)) {
    return message.content;
  }
  if (message.content && typeof message.content === 'object') {
    return [message.content as ConversationContentBlock];
  }
  return [];
}

function hasSuccessfulHistoryResult(block: ConversationContentBlock): boolean {
  if (!Object.prototype.hasOwnProperty.call(block, '_result') || block._resultError === true) {
    return false;
  }
  return resultRecord(block._result)?.success !== false;
}

function historyTodoItem(
  value: unknown,
  source: { seq: number; label: string; toolUseId?: string },
  fallbackId: string,
): WorkspaceTodoItem | null {
  const text = todoTextFromUnknown(value);
  if (!text) {
    return null;
  }
  const stableId = todoStableIdFromUnknown(value);
  const activeText = todoActiveTextFromUnknown(value);
  return {
    id: stableId ? `id:${stableId}` : `history:${fallbackId}`,
    text,
    status: todoStatusFromUnknown(value),
    ...(activeText ? { activeText } : {}),
    sourceLabel: source.label,
    sourceSeq: source.seq,
    ...(source.toolUseId ? { toolUseId: source.toolUseId } : {}),
  };
}

function buildHistoryTodos(messages: ConversationMessageData[]): {
  items: WorkspaceTodoItem[];
  observed: boolean;
} {
  let todos = new Map<string, WorkspaceTodoItem>();
  let observed = false;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (
      !message
      || (message.msgType !== 'assistant' && message.msgType !== 'ai')
      || message.isCompactBoundary
      || message.planContent
    ) {
      continue;
    }

    const blocks = messageContentBlocks(message);
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (block.type !== 'tool_use' || typeof block.name !== 'string' || !TODO_SOURCES.has(block.name)) {
        continue;
      }
      if (!hasSuccessfulHistoryResult(block)) {
        continue;
      }

      const input = readRecord(block.input) ?? {};
      const result = resultRecord(block._result);
      const source = {
        seq: messageIndex + 1,
        label: `History · ${block.name}`,
        ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}),
      };

      if (block.name === 'TodoWrite') {
        if (!Array.isArray(input.todos)) {
          continue;
        }
        const replacement = new Map<string, WorkspaceTodoItem>();
        input.todos.forEach((value, itemIndex) => {
          const item = historyTodoItem(value, source, `todo:${messageIndex}:${blockIndex}:${itemIndex}`);
          if (item) {
            replacement.set(item.id, item);
          }
        });
        todos = replacement;
        observed = true;
        continue;
      }

      if (block.name === 'TaskList') {
        const values = Array.isArray(result?.tasks)
          ? result.tasks
          : taskListItemsFromResult(block._result);
        if (!values) {
          continue;
        }
        const replacement = new Map<string, WorkspaceTodoItem>();
        values.forEach((value, itemIndex) => {
          const item = historyTodoItem(value, source, `task:${messageIndex}:${blockIndex}:${itemIndex}`);
          if (item) {
            replacement.set(item.id, item);
          }
        });
        todos = replacement;
        observed = true;
        continue;
      }

      if (block.name === 'TaskCreate') {
        const item = taskCreateTodo(input, result, block._result, source);
        if (item) {
          todos.set(item.id, item);
          observed = true;
        }
        continue;
      }

      if (block.name === 'TaskUpdate') {
        observed = applyTaskUpdate(todos, input, result, block._result, source) || observed;
        continue;
      }

      const values = todoArrayFromRecord(result ?? {}) ?? todoArrayFromRecord(input);
      if (!values) {
        continue;
      }
      const replacement = new Map<string, WorkspaceTodoItem>();
      values.forEach((value, itemIndex) => {
        const item = historyTodoItem(value, source, `codex:${messageIndex}:${blockIndex}:${itemIndex}`);
        if (item) {
          replacement.set(item.id, item);
        }
      });
      todos = replacement;
      observed = true;
    }
  }

  return { items: Array.from(todos.values()), observed };
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

export function buildWorkspaceTodos(
  events: SessionEventRecord[],
  messages: ConversationMessageData[] = [],
): WorkspaceTodos {
  const structured = latestStructuredSnapshot(events);
  if (structured) {
    return buildResult(
      structured.snapshot.items.map((item) => workspaceItemFromSnapshot(item, structured)),
      'structured',
      structured.snapshot.revision,
    );
  }

  const history = buildHistoryTodos(messages);
  const legacy = buildLegacyTodos(events, history.items);
  if (legacy.observed) {
    return buildResult(
      legacy.items,
      'legacy',
      null,
    );
  }
  return buildResult(
    history.items,
    history.observed ? 'history' : 'unavailable',
    null,
  );
}

/**
 * The live view's events array is already seq-ascending except transiently
 * after a gap merge; walking the tail window only (O(tail)) detects that
 * cheaply so the common path avoids the copy + full sort.
 */
function tailWindowIsSeqOrdered(events: SessionEventRecord[], windowSize: number): boolean {
  const start = Math.max(0, events.length - windowSize);
  for (let index = Math.max(1, start); index < events.length; index += 1) {
    if (events[index]!.seq <= events[index - 1]!.seq) {
      return false;
    }
  }
  return true;
}

export function selectCachedWorkspaceEvents(
  events: SessionEventRecord[],
  tailLimit: number,
): SessionEventRecord[] {
  const limit = Math.max(0, Math.floor(tailLimit));
  if (limit === 0 || events.length === 0) {
    return [];
  }

  const ordered = tailWindowIsSeqOrdered(events, limit + 1)
    ? events
    : [...events].sort((left, right) => left.seq - right.seq);
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
