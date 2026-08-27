export type ClaudeBackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export interface ClaudeBackgroundTaskUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export interface ClaudeBackgroundTask {
  task_id: string;
  tool_use_id?: string;
  task_type?: string;
  subagent_type?: string;
  workflow_name?: string;
  description: string;
  status: ClaudeBackgroundTaskStatus;
  started_at: string;
  updated_at: string;
  progress_summary?: string;
  last_tool_name?: string;
  usage?: ClaudeBackgroundTaskUsage;
  terminal_summary?: string;
  output_file?: string;
  error?: string;
  skip_transcript?: boolean;
  stop_request_id?: string;
  stop_failed?: boolean;
}

type TaskStartedMessage = {
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  task_type?: string;
  workflow_name?: string;
  skip_transcript?: boolean;
};

type TaskProgressMessage = {
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  usage: ClaudeBackgroundTaskUsage;
  last_tool_name?: string;
  summary?: string;
};

type TaskUpdatedMessage = {
  task_id: string;
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
    description?: string;
    error?: string;
    is_backgrounded?: boolean;
  };
};

type TaskNotificationMessage = {
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  usage?: ClaudeBackgroundTaskUsage;
  skip_transcript?: boolean;
};

type BackgroundTaskSnapshotEntry = {
  task_id: string;
  task_type: string;
  description: string;
};

const TERMINAL_STATUSES = new Set<ClaudeBackgroundTaskStatus>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

function isTerminalStatus(status: ClaudeBackgroundTaskStatus) {
  return TERMINAL_STATUSES.has(status);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cloneTask(task: ClaudeBackgroundTask): ClaudeBackgroundTask {
  return {
    ...task,
    ...(task.usage ? { usage: { ...task.usage } } : {}),
  };
}

function taskDescription(taskId: string, description?: string) {
  return optionalString(description) ?? `Background task ${taskId}`;
}

function guardedStatus(
  existing: ClaudeBackgroundTask | undefined,
  fallback: ClaudeBackgroundTaskStatus,
) {
  if (existing?.status === 'stopping'
    || existing?.status === 'settling'
    || existing?.status === 'paused') {
    return existing.status;
  }
  return fallback;
}

export function backgroundTaskIdFromLaunchResult(toolUseResult: unknown) {
  if (!toolUseResult || typeof toolUseResult !== 'object') {
    return undefined;
  }

  const result = toolUseResult as Record<string, unknown>;
  const bashTaskId = optionalString(result.backgroundTaskId);
  if (bashTaskId) {
    return bashTaskId;
  }
  if (result.status !== 'async_launched'
    && result.status !== 'remote_launched'
    && result.isAsync !== true) {
    return undefined;
  }
  return optionalString(result.taskId)
    ?? optionalString(result.task_id)
    ?? optionalString(result.agentId);
}

export function isBackgroundLaunchResult(
  _rawName: string,
  input: Record<string, unknown> | undefined,
  toolUseResult: unknown,
  success: boolean,
) {
  if (!success) {
    return false;
  }

  if (input?.run_in_background === true) {
    return true;
  }

  if (!toolUseResult || typeof toolUseResult !== 'object') {
    return false;
  }

  const result = toolUseResult as Record<string, unknown>;
  return result.status === 'async_launched'
    || result.status === 'remote_launched'
    || result.isAsync === true
    || backgroundTaskIdFromLaunchResult(result) !== undefined;
}

export function backgroundTaskSnapshotKey(tasks: ClaudeBackgroundTask[]) {
  return JSON.stringify(tasks.map((task) => [
    task.task_id,
    task.status,
    task.tool_use_id ?? null,
    task.task_type ?? null,
    task.subagent_type ?? null,
    task.workflow_name ?? null,
    task.description,
    task.started_at,
    task.skip_transcript ?? null,
  ]));
}

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, ClaudeBackgroundTask>();
  private readonly backgroundTaskIds = new Set<string>();
  private readonly liveSnapshotIds = new Set<string>();
  private readonly backgroundToolUseIds = new Set<string>();
  private readonly taskIdByToolUseId = new Map<string, string>();
  private readonly taskIdByOwnerId = new Map<string, string>();
  private readonly priorStoppingStatuses = new Map<
    string,
    { status: ClaudeBackgroundTaskStatus; requestId: string }
  >();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  markToolBackgroundCandidate(toolUseId: string) {
    if (toolUseId) {
      this.backgroundToolUseIds.add(toolUseId);
      const taskId = this.taskIdByToolUseId.get(toolUseId);
      if (taskId) {
        this.backgroundTaskIds.add(taskId);
      }
    }
  }

  applyLaunchReceipt(
    toolUseId: string,
    rawName: string,
    input: Record<string, unknown> | undefined,
    toolUseResult: unknown,
  ) {
    this.markToolBackgroundCandidate(toolUseId);
    const taskId = backgroundTaskIdFromLaunchResult(toolUseResult);
    if (!taskId) {
      return null;
    }

    this.backgroundTaskIds.add(taskId);
    this.taskIdByToolUseId.set(toolUseId, taskId);
    const existing = this.tasks.get(taskId);
    if (existing && isTerminalStatus(existing.status)) {
      const linked = existing.tool_use_id === toolUseId
        ? existing
        : { ...existing, tool_use_id: toolUseId };
      this.tasks.set(taskId, linked);
      return cloneTask(linked);
    }

    const result = toolUseResult && typeof toolUseResult === 'object'
      ? toolUseResult as Record<string, unknown>
      : {};
    const timestamp = this.now();
    const inferredDescription = optionalString(result.description)
      ?? optionalString(result.summary)
      ?? optionalString(input?.description)
      ?? optionalString(input?.prompt)
      ?? optionalString(input?.command);
    const inferredTaskType = optionalString(result.taskType)
      ?? optionalString(result.task_type)
      ?? optionalString(rawName)?.toLowerCase();
    const inferredSubagentType = optionalString(input?.subagent_type)
      ?? optionalString(input?.agent)
      ?? optionalString(input?.agent_type);
    const inferredWorkflowName = optionalString(result.workflowName)
      ?? optionalString(result.workflow_name);
    const inferredOutputFile = optionalString(result.outputFile)
      ?? optionalString(result.output_file)
      ?? optionalString(result.rawOutputPath);
    const task: ClaudeBackgroundTask = {
      ...(existing ?? {
        task_id: taskId,
        description: taskDescription(taskId, inferredDescription),
        status: 'running' as const,
        started_at: timestamp,
        updated_at: timestamp,
      }),
      tool_use_id: toolUseId,
      ...(inferredTaskType ? { task_type: inferredTaskType } : {}),
      ...(inferredSubagentType ? { subagent_type: inferredSubagentType } : {}),
      ...(inferredWorkflowName ? { workflow_name: inferredWorkflowName } : {}),
      ...(inferredOutputFile ? { output_file: inferredOutputFile } : {}),
      description: taskDescription(taskId, inferredDescription ?? existing?.description),
      status: guardedStatus(existing, 'running'),
      updated_at: timestamp,
    };
    this.tasks.set(taskId, task);
    return cloneTask(task);
  }

  isBackgroundToolUse(toolUseId: string) {
    if (this.backgroundToolUseIds.has(toolUseId)) {
      return true;
    }
    const taskId = this.taskIdByToolUseId.get(toolUseId);
    return Boolean(taskId && this.backgroundTaskIds.has(taskId));
  }

  isBackgroundTask(taskId: string) {
    return this.backgroundTaskIds.has(taskId);
  }

  backgroundTaskIdForOwner(ownerId: string | undefined | null) {
    const normalizedOwnerId = optionalString(ownerId);
    if (!normalizedOwnerId) {
      return null;
    }
    if (this.backgroundTaskIds.has(normalizedOwnerId)) {
      return normalizedOwnerId;
    }
    const taskId = this.taskIdByOwnerId.get(normalizedOwnerId)
      ?? this.taskIdByToolUseId.get(normalizedOwnerId);
    return taskId && this.backgroundTaskIds.has(taskId) ? taskId : null;
  }

  associateOwnerWithTask(ownerId: string | undefined | null, taskId: string | undefined | null) {
    const normalizedOwnerId = optionalString(ownerId);
    const normalizedTaskId = optionalString(taskId);
    if (!normalizedOwnerId
      || !normalizedTaskId
      || !this.backgroundTaskIds.has(normalizedTaskId)) {
      return null;
    }
    this.taskIdByOwnerId.set(normalizedOwnerId, normalizedTaskId);
    return normalizedTaskId;
  }

  associateChildToolWithParent(
    childToolUseId: string | undefined | null,
    parentOwnerId: string | undefined | null,
  ) {
    const normalizedChildId = optionalString(childToolUseId);
    const taskId = this.backgroundTaskIdForOwner(parentOwnerId);
    if (!normalizedChildId || !taskId) {
      return null;
    }
    this.backgroundToolUseIds.add(normalizedChildId);
    this.taskIdByToolUseId.set(normalizedChildId, taskId);
    this.taskIdByOwnerId.set(normalizedChildId, taskId);
    return taskId;
  }

  taskIdForToolUse(toolUseId: string) {
    return this.taskIdByToolUseId.get(toolUseId) ?? null;
  }

  toolUseIdForTask(taskId: string) {
    return this.tasks.get(taskId)?.tool_use_id ?? null;
  }

  getTask(taskId: string) {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
  }

  hasUnsettledTasks() {
    return this.activeTasks().length > 0;
  }

  canStop(taskId: string) {
    const task = this.tasks.get(taskId);
    return Boolean(task && this.backgroundTaskIds.has(taskId)
      && ['pending', 'running', 'paused'].includes(task.status));
  }

  activeTasks() {
    return [...this.tasks.values()]
      .filter((task) => this.backgroundTaskIds.has(task.task_id) && !isTerminalStatus(task.status))
      .sort((left, right) => left.started_at.localeCompare(right.started_at))
      .map(cloneTask);
  }

  applyStarted(message: TaskStartedMessage) {
    const existing = this.tasks.get(message.task_id);
    const toolUseId = optionalString(message.tool_use_id) ?? existing?.tool_use_id;
    if (toolUseId) {
      this.taskIdByToolUseId.set(toolUseId, message.task_id);
      if (this.backgroundToolUseIds.has(toolUseId)) {
        this.backgroundTaskIds.add(message.task_id);
      }
    }
    if (existing && isTerminalStatus(existing.status)) {
      const linked = toolUseId && existing.tool_use_id !== toolUseId
        ? { ...existing, tool_use_id: toolUseId }
        : existing;
      this.tasks.set(message.task_id, linked);
      return this.backgroundTaskIds.has(message.task_id) ? cloneTask(linked) : null;
    }

    const timestamp = this.now();

    const task: ClaudeBackgroundTask = {
      ...(existing ?? {
        task_id: message.task_id,
        description: taskDescription(message.task_id, message.description),
        status: 'running' as const,
        started_at: timestamp,
        updated_at: timestamp,
      }),
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...(optionalString(message.task_type) ? { task_type: message.task_type!.trim() } : {}),
      ...(optionalString(message.subagent_type) ? { subagent_type: message.subagent_type!.trim() } : {}),
      ...(optionalString(message.workflow_name) ? { workflow_name: message.workflow_name!.trim() } : {}),
      description: taskDescription(message.task_id, message.description),
      status: guardedStatus(existing, 'running'),
      updated_at: timestamp,
      ...(message.skip_transcript === true ? { skip_transcript: true } : {}),
    };
    this.tasks.set(message.task_id, task);
    return this.backgroundTaskIds.has(message.task_id) ? cloneTask(task) : null;
  }

  applyProgress(message: TaskProgressMessage) {
    const existing = this.tasks.get(message.task_id);
    const toolUseId = optionalString(message.tool_use_id) ?? existing?.tool_use_id;
    if (toolUseId) {
      this.taskIdByToolUseId.set(toolUseId, message.task_id);
      if (this.backgroundToolUseIds.has(toolUseId)) {
        this.backgroundTaskIds.add(message.task_id);
      }
    }
    if (existing && isTerminalStatus(existing.status)) {
      const linked = toolUseId && existing.tool_use_id !== toolUseId
        ? { ...existing, tool_use_id: toolUseId }
        : existing;
      this.tasks.set(message.task_id, linked);
      return this.backgroundTaskIds.has(message.task_id) ? cloneTask(linked) : null;
    }

    const timestamp = this.now();
    const task: ClaudeBackgroundTask = {
      ...(existing ?? {
        task_id: message.task_id,
        description: taskDescription(message.task_id, message.description),
        status: 'running' as const,
        started_at: timestamp,
        updated_at: timestamp,
      }),
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...(optionalString(message.subagent_type) ? { subagent_type: message.subagent_type!.trim() } : {}),
      description: taskDescription(message.task_id, message.description),
      status: guardedStatus(existing, 'running'),
      updated_at: timestamp,
      usage: { ...message.usage },
      ...(optionalString(message.last_tool_name) ? { last_tool_name: message.last_tool_name!.trim() } : {}),
      ...(optionalString(message.summary) ? { progress_summary: message.summary!.trim() } : {}),
    };
    this.tasks.set(message.task_id, task);
    return this.backgroundTaskIds.has(message.task_id) ? cloneTask(task) : null;
  }

  applyUpdated(message: TaskUpdatedMessage) {
    const existing = this.tasks.get(message.task_id);
    if (message.patch.is_backgrounded === true) {
      this.backgroundTaskIds.add(message.task_id);
    }
    if (existing && isTerminalStatus(existing.status)) {
      return this.backgroundTaskIds.has(message.task_id) ? cloneTask(existing) : null;
    }

    const timestamp = this.now();
    const nextStatus = (() => {
      if (existing?.status === 'stopping' || existing?.status === 'settling') {
        return existing.status;
      }
      if (message.patch.status === 'pending') return 'pending' as const;
      if (message.patch.status === 'paused') return 'paused' as const;
      if (message.patch.status === 'running') return 'running' as const;
      if (message.patch.status === 'completed'
        || message.patch.status === 'failed'
        || message.patch.status === 'killed') {
        return 'settling' as const;
      }
      return existing?.status ?? 'pending';
    })();
    const task: ClaudeBackgroundTask = {
      ...(existing ?? {
        task_id: message.task_id,
        description: taskDescription(message.task_id),
        status: nextStatus,
        started_at: timestamp,
        updated_at: timestamp,
      }),
      ...(optionalString(message.patch.description)
        ? { description: message.patch.description!.trim() }
        : {}),
      status: nextStatus,
      updated_at: timestamp,
      ...(optionalString(message.patch.error) ? { error: message.patch.error!.trim() } : {}),
    };
    this.tasks.set(message.task_id, task);
    return this.backgroundTaskIds.has(message.task_id) ? cloneTask(task) : null;
  }

  applySnapshot(entries: BackgroundTaskSnapshotEntry[]) {
    const nextLiveIds = new Set<string>();
    const changed: ClaudeBackgroundTask[] = [];

    for (const entry of entries) {
      if (!optionalString(entry.task_id)) {
        continue;
      }
      const taskId = entry.task_id.trim();
      nextLiveIds.add(taskId);
      const wasBackgroundTask = this.backgroundTaskIds.has(taskId);
      this.backgroundTaskIds.add(taskId);
      const existing = this.tasks.get(taskId);
      if (existing && isTerminalStatus(existing.status)) {
        if (!wasBackgroundTask) {
          changed.push(cloneTask(existing));
        }
        continue;
      }
      const timestamp = this.now();
      const task: ClaudeBackgroundTask = {
        ...(existing ?? {
          task_id: taskId,
          description: taskDescription(taskId, entry.description),
          status: 'running' as const,
          started_at: timestamp,
          updated_at: timestamp,
        }),
        ...(optionalString(entry.task_type) ? { task_type: entry.task_type.trim() } : {}),
        description: taskDescription(taskId, entry.description),
        status: guardedStatus(existing, 'running'),
        updated_at: timestamp,
      };
      this.tasks.set(taskId, task);
      changed.push(cloneTask(task));
    }

    for (const [taskId, existing] of this.tasks.entries()) {
      if (!this.backgroundTaskIds.has(taskId)) {
        continue;
      }
      if (nextLiveIds.has(taskId)) {
        continue;
      }
      if (isTerminalStatus(existing.status) || existing.status === 'settling') {
        continue;
      }
      const task: ClaudeBackgroundTask = {
        ...existing,
        status: 'settling',
        updated_at: this.now(),
      };
      delete task.stop_request_id;
      delete task.stop_failed;
      this.priorStoppingStatuses.delete(taskId);
      this.tasks.set(taskId, task);
      changed.push(cloneTask(task));
    }

    this.liveSnapshotIds.clear();
    for (const taskId of nextLiveIds) {
      this.liveSnapshotIds.add(taskId);
    }

    return {
      tasks: this.activeTasks(),
      changed,
    };
  }

  applyNotification(message: TaskNotificationMessage) {
    this.liveSnapshotIds.delete(message.task_id);
    const existing = this.tasks.get(message.task_id);
    const toolUseId = optionalString(message.tool_use_id) ?? existing?.tool_use_id;
    if (toolUseId) {
      this.taskIdByToolUseId.set(toolUseId, message.task_id);
      if (this.backgroundToolUseIds.has(toolUseId)) {
        this.backgroundTaskIds.add(message.task_id);
      }
    }
    if (existing && isTerminalStatus(existing.status)) {
      const linked = toolUseId && existing.tool_use_id !== toolUseId
        ? { ...existing, tool_use_id: toolUseId }
        : existing;
      this.tasks.set(message.task_id, linked);
      return this.backgroundTaskIds.has(message.task_id) ? cloneTask(linked) : null;
    }
    const timestamp = this.now();
    const task: ClaudeBackgroundTask = {
      ...(existing ?? {
        task_id: message.task_id,
        description: taskDescription(message.task_id, message.summary),
        status: message.status,
        started_at: timestamp,
        updated_at: timestamp,
      }),
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      status: message.status,
      updated_at: timestamp,
      ...(optionalString(message.summary) ? { terminal_summary: message.summary.trim() } : {}),
      ...(optionalString(message.output_file) ? { output_file: message.output_file.trim() } : {}),
      ...(message.usage ? { usage: { ...message.usage } } : {}),
      ...(message.skip_transcript === true ? { skip_transcript: true } : {}),
      ...(message.status === 'failed' && optionalString(message.summary)
        ? { error: message.summary.trim() }
        : {
            error: undefined,
            stop_request_id: undefined,
            stop_failed: undefined,
          }),
    };
    this.tasks.set(message.task_id, task);
    this.priorStoppingStatuses.delete(message.task_id);
    return this.backgroundTaskIds.has(message.task_id) ? cloneTask(task) : null;
  }

  markStopping(taskId: string, requestId: string) {
    const existing = this.tasks.get(taskId);
    const normalizedRequestId = optionalString(requestId);
    if (!existing || !this.canStop(taskId) || !normalizedRequestId) {
      return null;
    }
    this.priorStoppingStatuses.set(taskId, {
      status: existing.status,
      requestId: normalizedRequestId,
    });
    const task: ClaudeBackgroundTask = {
      ...existing,
      status: 'stopping',
      updated_at: this.now(),
      error: undefined,
      stop_request_id: normalizedRequestId,
      stop_failed: undefined,
    };
    this.tasks.set(taskId, task);
    return cloneTask(task);
  }

  restoreStopFailure(taskId: string, requestId: string, error: string) {
    const existing = this.tasks.get(taskId);
    if (!existing || isTerminalStatus(existing.status)) {
      return existing ? cloneTask(existing) : null;
    }
    const priorStop = this.priorStoppingStatuses.get(taskId);
    if (!priorStop
      || priorStop.requestId !== requestId
      || existing.stop_request_id !== requestId
      || existing.status !== 'stopping') {
      return cloneTask(existing);
    }
    this.priorStoppingStatuses.delete(taskId);
    const task: ClaudeBackgroundTask = {
      ...existing,
      status: !isTerminalStatus(priorStop.status) ? priorStop.status : 'running',
      updated_at: this.now(),
      error: error.trim() || 'Failed to stop background task.',
      stop_failed: true,
    };
    this.tasks.set(taskId, task);
    return cloneTask(task);
  }

  interruptAll(reason: string) {
    const interrupted = this.activeTasks().map((task) => {
      const next: ClaudeBackgroundTask = {
        ...task,
        status: 'interrupted',
        updated_at: this.now(),
        error: reason,
      };
      this.tasks.set(task.task_id, next);
      return cloneTask(next);
    });
    this.liveSnapshotIds.clear();
    this.priorStoppingStatuses.clear();
    return interrupted;
  }
}
