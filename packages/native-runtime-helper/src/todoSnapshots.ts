export type TodoSnapshotStatusV1 = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TodoSnapshotItemV1 {
  id: string;
  text: string;
  status: TodoSnapshotStatusV1;
  active_text?: string;
}

export interface TodoSnapshotV1 {
  version: 1;
  provider: 'claude' | 'codex';
  source: 'TodoWrite' | 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'todo_list';
  revision: number;
  items: TodoSnapshotItemV1[];
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readText(record: Record<string, unknown> | null) {
  return readString(record, ['subject', 'content', 'text', 'description']);
}

function readActiveText(record: Record<string, unknown> | null) {
  return readString(record, ['activeForm', 'active_text']);
}

function readId(record: Record<string, unknown> | null) {
  return readString(record, ['id', 'taskId', 'task_id']);
}

function normalizeStatus(value: unknown, fallback: TodoSnapshotStatusV1 = 'pending') {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed') {
    return value;
  }
  return fallback;
}

function parseResultObject(value: unknown): Record<string, unknown> | null {
  const direct = readObject(value);
  if (direct) {
    if (direct.type === 'tool_result' && direct.content !== undefined) {
      return parseResultObject(direct.content);
    }
    return direct;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return readObject(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = readObject(entry);
      const parsed = record?.type === 'text'
        ? parseResultObject(record.text)
        : parseResultObject(entry);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function cloneItem(item: TodoSnapshotItemV1): TodoSnapshotItemV1 {
  return { ...item };
}

function isTodoSnapshotItemV1(value: unknown): value is TodoSnapshotItemV1 {
  const record = readObject(value);
  return Boolean(
    record
    && typeof record.id === 'string'
    && record.id.trim()
    && typeof record.text === 'string'
    && record.text.trim()
    && ['pending', 'in_progress', 'completed', 'failed'].includes(String(record.status))
    && (record.active_text === undefined || typeof record.active_text === 'string'),
  );
}

function isTodoSnapshotV1(value: unknown): value is TodoSnapshotV1 {
  const record = readObject(value);
  if (
    !record
    || record.version !== 1
    || (record.provider !== 'claude' && record.provider !== 'codex')
    || typeof record.revision !== 'number'
    || !Number.isSafeInteger(record.revision)
    || record.revision < 0
    || !Array.isArray(record.items)
    || !record.items.every(isTodoSnapshotItemV1)
  ) {
    return false;
  }

  return record.provider === 'claude'
    ? ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'].includes(String(record.source))
    : record.source === 'todo_list';
}

function itemFromRecord(
  value: unknown,
  fallbackId: string,
): TodoSnapshotItemV1 | null {
  const record = readObject(value);
  const text = readText(record);
  if (!record || !text) {
    return null;
  }

  const activeText = readActiveText(record);
  return {
    id: readId(record) ?? fallbackId,
    text,
    status: typeof record.completed === 'boolean'
      ? record.completed ? 'completed' : 'pending'
      : normalizeStatus(record.status),
    ...(activeText ? { active_text: activeText } : {}),
  };
}

export function snapshotFromCodexTodoList(
  item: unknown,
  revision = 1,
): TodoSnapshotV1 | undefined {
  const record = readObject(item);
  if (record?.type !== 'todo_list' || !Array.isArray(record.items)) {
    return undefined;
  }

  const listId = readId(record) ?? 'todo-list';
  const items = record.items
    .map((value, index) => itemFromRecord(value, `${listId}:${index}`))
    .filter((value): value is TodoSnapshotItemV1 => Boolean(value));

  return {
    version: 1,
    provider: 'codex',
    source: 'todo_list',
    revision,
    items,
  };
}

export class TodoSnapshotTracker {
  private revision = 0;
  private claudeItems = new Map<string, TodoSnapshotItemV1>();
  private claudeBaselineKnown = true;

  reset(seed?: TodoSnapshotV1 | null, claudeBaselineKnown = true) {
    this.revision = 0;
    this.claudeItems = new Map();
    this.claudeBaselineKnown = seed ? false : claudeBaselineKnown;

    if (!isTodoSnapshotV1(seed)) {
      return;
    }

    this.revision = seed.revision;
    if (seed.provider !== 'claude') {
      return;
    }

    this.claudeBaselineKnown = true;
    this.claudeItems = new Map(
      seed.items.map((item) => [item.id, cloneItem(item)]),
    );
  }

  fromClaudeToolStarted(_rawName: string, _input: unknown): TodoSnapshotV1 | undefined {
    // TodoWrite is persisted only after a successful tool result. This keeps a
    // rejected write from becoming the canonical snapshot across replay/restart.
    return undefined;
  }

  fromClaudeToolCompleted(
    rawName: string,
    input: unknown,
    result: unknown,
  ): TodoSnapshotV1 | undefined {
    const inputRecord = readObject(input);
    const resultRecord = parseResultObject(result);

    if (resultRecord?.success === false) {
      return undefined;
    }

    if (rawName === 'TodoWrite') {
      if (!Array.isArray(inputRecord?.todos)) {
        return undefined;
      }

      this.claudeItems = new Map(
        inputRecord.todos
          .map((value, index) => itemFromRecord(value, `todo-${index}`))
          .filter((value): value is TodoSnapshotItemV1 => Boolean(value))
          .map((item) => [item.id, item]),
      );
      this.claudeBaselineKnown = true;
      return this.emitClaudeSnapshot('TodoWrite');
    }

    if (rawName === 'TaskCreate') {
      if (!this.claudeBaselineKnown) {
        return undefined;
      }

      const task = readObject(resultRecord?.task);
      const id = readId(task) ?? readId(inputRecord);
      const text = readText(inputRecord) ?? readText(task);
      if (!id || !text) {
        return undefined;
      }

      const activeText = readActiveText(inputRecord) ?? readActiveText(task);
      this.claudeItems.set(id, {
        id,
        text,
        status: normalizeStatus(inputRecord?.status),
        ...(activeText ? { active_text: activeText } : {}),
      });
      return this.emitClaudeSnapshot('TaskCreate');
    }

    if (rawName === 'TaskUpdate') {
      if (!this.claudeBaselineKnown || !inputRecord) {
        return undefined;
      }

      const id = readId(inputRecord) ?? readId(resultRecord);
      if (!id) {
        return undefined;
      }

      if (inputRecord.status === 'deleted') {
        this.claudeItems.delete(id);
        return this.emitClaudeSnapshot('TaskUpdate');
      }

      const current = this.claudeItems.get(id);
      const text = readText(inputRecord) ?? current?.text ?? `Task ${id}`;
      const activeText = readActiveText(inputRecord) ?? current?.active_text;
      this.claudeItems.set(id, {
        id,
        text,
        status: normalizeStatus(inputRecord.status, current?.status),
        ...(activeText ? { active_text: activeText } : {}),
      });
      return this.emitClaudeSnapshot('TaskUpdate');
    }

    if (rawName === 'TaskList') {
      if (!Array.isArray(resultRecord?.tasks)) {
        return undefined;
      }

      this.claudeItems = new Map(
        resultRecord.tasks
          .map((value, index) => itemFromRecord(value, `task-${index}`))
          .filter((value): value is TodoSnapshotItemV1 => Boolean(value))
          .map((item) => [item.id, item]),
      );
      this.claudeBaselineKnown = true;
      return this.emitClaudeSnapshot('TaskList');
    }

    return undefined;
  }

  fromCodexTodoList(item: unknown): TodoSnapshotV1 | undefined {
    const snapshot = snapshotFromCodexTodoList(item, this.revision + 1);
    if (!snapshot) {
      return undefined;
    }
    this.revision = snapshot.revision;
    return snapshot;
  }

  private emitClaudeSnapshot(
    source: Extract<TodoSnapshotV1['source'], 'TodoWrite' | 'TaskCreate' | 'TaskUpdate' | 'TaskList'>,
  ): TodoSnapshotV1 {
    this.revision += 1;
    return {
      version: 1,
      provider: 'claude',
      source,
      revision: this.revision,
      items: Array.from(this.claudeItems.values(), cloneItem),
    };
  }
}
