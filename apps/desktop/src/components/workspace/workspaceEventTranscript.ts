import type {
  ConversationContentBlock,
  ConversationMessageData,
} from '@/features/conversations/types';
import type {
  ReplayBatch,
  SessionEventRecord,
  SessionPromptAnnotation,
  SessionPromptImage,
} from '@/lib/tauri-ipc';
import {
  normalizePromptConfirmationText,
  normalizePromptIdentityText,
  parsePromptTimestamp,
  promptIdentityMatches,
  promptTimestampsAreCompatible,
  stripRenderedImageMarkers,
} from './transcriptIdentity';

export const COMPACTING_SUMMARY_TOKEN = '__ccem_context_compacting__';
export const COMPACT_FAILED_SUMMARY_TOKEN = '__ccem_context_compact_failed__';
export const TRANSCRIPT_GAP_SUMMARY_TOKEN = '__ccem_transcript_gap__';

export interface LocalUserPrompt {
  id: string;
  text: string;
  images?: SessionPromptImage[];
  annotations?: SessionPromptAnnotation[];
  timestamp?: number;
  afterEventSeq?: number;
}

interface PendingAssistantTurn {
  id: string;
  timestamp?: number;
  contentBlocks: ConversationContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

function parseOccurredAt(occurredAt: string): number | undefined {
  return parsePromptTimestamp(occurredAt);
}

function cloneContent(content: ConversationMessageData['content']): ConversationMessageData['content'] {
  if (Array.isArray(content)) {
    return content.map((block) => ({ ...block }));
  }

  if (content && typeof content === 'object') {
    return { ...(content as ConversationContentBlock) };
  }

  return content;
}

function cloneMessages(messages: ConversationMessageData[]): ConversationMessageData[] {
  return messages.map((message) => ({
    ...message,
    content: cloneContent(message.content),
  }));
}

function createUserMessage(prompt: LocalUserPrompt): ConversationMessageData {
  const imageBlocks = createPromptImageBlocks(prompt.images);
  if (imageBlocks.length > 0) {
    const displayText = stripRenderedImageMarkers(prompt.text, imageBlocks);
    const content: ConversationContentBlock[] = [];
    if (displayText) {
      content.push({ type: 'text', text: displayText });
    }
    content.push(...imageBlocks);

    return {
      msgType: 'user',
      uuid: prompt.id,
      content,
      timestamp: prompt.timestamp,
      segmentIndex: 0,
      isCompactBoundary: false,
      ...(prompt.annotations?.length ? { annotations: prompt.annotations } : {}),
    };
  }

  return {
    msgType: 'user',
    uuid: prompt.id,
    content: prompt.text,
    timestamp: prompt.timestamp,
    segmentIndex: 0,
    isCompactBoundary: false,
    ...(prompt.annotations?.length ? { annotations: prompt.annotations } : {}),
  };
}

export function createInitialLocalUserPrompts(
  initialPrompt?: string | null,
  initialImages?: SessionPromptImage[] | null,
  initialAnnotations?: SessionPromptAnnotation[] | null,
): LocalUserPrompt[] {
  if (!initialPrompt) {
    return [];
  }

  return [{
    id: 'initial-user',
    text: initialPrompt,
    images: initialImages ?? undefined,
    annotations: initialAnnotations ?? undefined,
  }];
}

function createPromptImageBlocks(images?: SessionPromptImage[] | null): ConversationContentBlock[] {
  if (!images?.length) {
    return [];
  }

  return images
    .map((image, index) => {
      const hasInlineData = typeof image.base64Data === 'string' && image.base64Data.length > 0;
      const hasStoredData = typeof image.storagePath === 'string' && image.storagePath.length > 0;
      if (
        typeof image.mediaType !== 'string'
        || !image.mediaType.startsWith('image/')
        || (!hasInlineData && !hasStoredData)
      ) {
        return null;
      }

      const block: ConversationContentBlock = {
        type: 'image',
        mediaType: image.mediaType,
        placeholder: image.placeholder || `[Image #${index + 1}]`,
      };
      if (hasInlineData) {
        block.base64Data = image.base64Data;
      }
      if (hasStoredData) {
        block.storagePath = image.storagePath;
      }
      if (image.sha256) {
        block.sha256 = image.sha256;
      }
      if (image.byteSize) {
        block.byteSize = image.byteSize;
      }
      return block;
    })
    .filter((block): block is ConversationContentBlock => block != null);
}

function messageContentText(content: ConversationMessageData['content']): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  const blockText = (block: ConversationContentBlock): string => {
    if (typeof block.text === 'string') {
      return block.text;
    }
    if (block.type === 'image' && typeof block.placeholder === 'string') {
      return block.placeholder;
    }
    if (typeof block.thinking === 'string') {
      return block.thinking;
    }
    if (typeof block.content === 'string') {
      return block.content;
    }
    return '';
  };

  if (Array.isArray(content)) {
    return content.map(blockText).filter(Boolean).join('\n').trim();
  }

  if (content && typeof content === 'object') {
    return blockText(content as ConversationContentBlock).trim();
  }

  return '';
}

function messageImageBlocks(content: ConversationMessageData['content']): ConversationContentBlock[] {
  if (Array.isArray(content)) {
    return content.filter((block) => block.type === 'image');
  }

  if (content && typeof content === 'object') {
    const block = content as ConversationContentBlock;
    return block.type === 'image' ? [block] : [];
  }

  return [];
}

export function filterConfirmedLocalUserPrompts(
  prompts: LocalUserPrompt[],
  events: SessionEventRecord[],
): LocalUserPrompt[] {
  if (prompts.length === 0 || events.length === 0) {
    return prompts;
  }

  const confirmedPrompts: Array<{ key: string; seq: number }> = [];
  for (const event of events) {
    if (event.payload.type !== 'user_prompt') {
      continue;
    }
    const key = normalizePromptConfirmationText(event.payload.text, event.payload.images ?? null);
    if (!key) {
      continue;
    }
    confirmedPrompts.push({ key, seq: event.seq });
  }

  if (confirmedPrompts.length === 0) {
    return prompts;
  }

  return prompts.filter((prompt) => {
    const key = normalizePromptConfirmationText(prompt.text, prompt.images ?? null);
    const confirmedIndex = confirmedPrompts.findIndex((confirmed) =>
      confirmed.key === key
      && (prompt.afterEventSeq == null || confirmed.seq > prompt.afterEventSeq),
    );
    if (confirmedIndex === -1) {
      return true;
    }
    confirmedPrompts.splice(confirmedIndex, 1);
    return false;
  });
}

export function splitLocalUserPromptsForReplay(
  prompts: LocalUserPrompt[],
): {
  initialPrompt: LocalUserPrompt | undefined;
  remainingPrompts: LocalUserPrompt[];
} {
  const [firstPrompt, ...restPrompts] = prompts;
  if (firstPrompt?.id === 'initial-user') {
    return {
      initialPrompt: firstPrompt,
      remainingPrompts: restPrompts,
    };
  }

  return {
    initialPrompt: undefined,
    remainingPrompts: prompts,
  };
}

export function trimSeedMessagesBeforeFirstUserPrompt(
  seedMessages: ConversationMessageData[],
  events: SessionEventRecord[],
  options: { seedBoundaryMessageCount?: number | null } = {},
): ConversationMessageData[] {
  if (seedMessages.length === 0 || events.length === 0) {
    return seedMessages;
  }

  if (options.seedBoundaryMessageCount != null && Number.isFinite(options.seedBoundaryMessageCount)) {
    const boundaryCount = Math.max(0, Math.min(seedMessages.length, Math.floor(options.seedBoundaryMessageCount)));
    return seedMessages.slice(0, boundaryCount);
  }

  const firstPersistedPrompt = events.find((event) =>
    event.payload.type === 'user_prompt'
    && normalizePromptIdentityText(event.payload.text, event.payload.images ?? null),
  );
  if (!firstPersistedPrompt || firstPersistedPrompt.payload.type !== 'user_prompt') {
    return seedMessages;
  }

  const promptText = firstPersistedPrompt.payload.text;
  const promptImages = firstPersistedPrompt.payload.images ?? null;
  const promptTimestamp = parseOccurredAt(firstPersistedPrompt.occurred_at);
  let boundaryIndex = -1;
  let boundaryIsExact = false;

  seedMessages.forEach((message, index) => {
    if (message.msgType !== 'user' && message.msgType !== 'human') {
      return;
    }
    const messageTimestamp = parsePromptTimestamp(message.timestamp);
    if (!promptTimestampsAreCompatible(promptTimestamp, messageTimestamp)) {
      return;
    }
    const match = promptIdentityMatches(
      promptText,
      messageContentText(message.content),
      promptImages,
      messageImageBlocks(message.content),
    );
    if (!match.matched) {
      return;
    }
    if (!match.exact && boundaryIsExact) {
      return;
    }
    boundaryIndex = index;
    boundaryIsExact = match.exact;
  });

  return boundaryIndex >= 0 ? seedMessages.slice(0, boundaryIndex) : seedMessages;
}

export function replayBatchCoversAvailableSequenceRange(replayBatch: ReplayBatch): boolean {
  if (replayBatch.truncated || replayBatch.gap_detected) {
    return false;
  }

  const oldestSeq = replayBatch.oldest_available_seq;
  const newestSeq = replayBatch.newest_available_seq;
  if (oldestSeq == null || newestSeq == null) {
    return replayBatch.events.length === 0;
  }

  if (!Number.isFinite(oldestSeq) || !Number.isFinite(newestSeq) || newestSeq < oldestSeq) {
    return false;
  }

  const firstEvent = replayBatch.events[0];
  const lastEvent = replayBatch.events[replayBatch.events.length - 1];
  if (!firstEvent || !lastEvent) {
    return false;
  }

  if (firstEvent.seq !== oldestSeq || lastEvent.seq !== newestSeq) {
    return false;
  }

  const expectedEventCount = newestSeq - oldestSeq + 1;
  if (replayBatch.events.length !== expectedEventCount) {
    return false;
  }

  return replayBatch.events.every((event, index, events) => {
    if (index === 0) {
      return true;
    }
    return event.seq === events[index - 1]!.seq + 1;
  });
}

export function nativeReplayCoversRuntimeStart(replayBatch: ReplayBatch): boolean {
  if (replayBatch.oldest_available_seq !== 1 || !replayBatchCoversAvailableSequenceRange(replayBatch)) {
    return false;
  }

  const firstEvent = replayBatch.events.find((event) => event.seq === 1);
  if (!firstEvent) {
    return false;
  }

  if (firstEvent.payload.type === 'user_prompt') {
    return true;
  }

  return firstEvent.payload.type === 'lifecycle'
    && (firstEvent.payload.stage === 'runtime_boot' || firstEvent.payload.stage === 'initializing');
}

export function selectSeedMessagesForNativeReplay(
  seedMessages: ConversationMessageData[],
  replayBatch: ReplayBatch | null | undefined,
  seedBoundaryMessageCount?: number | null,
): ConversationMessageData[] {
  if (seedMessages.length === 0) {
    return seedMessages;
  }

  if (seedBoundaryMessageCount != null && Number.isFinite(seedBoundaryMessageCount)) {
    return seedMessages.slice(0, Math.max(0, Math.min(seedMessages.length, Math.floor(seedBoundaryMessageCount))));
  }

  if (!replayBatch) {
    return seedMessages;
  }

  if (nativeReplayCoversRuntimeStart(replayBatch)) {
    return [];
  }

  return trimSeedMessagesBeforeFirstUserPrompt(seedMessages, replayBatch.events);
}

export function shouldSkipProviderSeedHydration(
  replayBatch: ReplayBatch | null | undefined,
  seedBoundaryMessageCount?: number | null,
): boolean {
  if (!replayBatch) {
    return false;
  }

  if (seedBoundaryMessageCount === 0) {
    return true;
  }

  return seedBoundaryMessageCount == null && nativeReplayCoversRuntimeStart(replayBatch);
}

function createAssistantTextMessage(
  id: string,
  text: string,
  occurredAt?: number,
  metadata: Partial<Pick<
    ConversationMessageData,
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheCreationTokens'
    | 'cacheReadTokens'
  >> = {},
): ConversationMessageData {
  return {
    msgType: 'assistant',
    uuid: id,
    content: text,
    timestamp: occurredAt,
    segmentIndex: 0,
    isCompactBoundary: false,
    ...metadata,
  };
}

function createSummaryMessage(
  id: string,
  summary: string,
  occurredAt?: number,
): ConversationMessageData {
  return {
    msgType: 'summary',
    uuid: id,
    content: null,
    summary,
    timestamp: occurredAt,
    segmentIndex: 0,
    isCompactBoundary: false,
  };
}

function createCompactBoundaryMessage(
  id: string,
  occurredAt?: number,
): ConversationMessageData {
  return {
    msgType: 'compact_boundary',
    uuid: id,
    content: 'Conversation compacted',
    timestamp: occurredAt,
    segmentIndex: 0,
    isCompactBoundary: true,
  };
}

function createToolResultMessage(
  id: string,
  toolUseId: string,
  resultContent: string,
  success: boolean,
  occurredAt?: number,
): ConversationMessageData {
  return {
    msgType: 'user',
    uuid: id,
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: resultContent,
      is_error: !success,
    }],
    timestamp: occurredAt,
    segmentIndex: 0,
    isCompactBoundary: false,
  };
}

export function buildBaseMessages(
  seedMessages: ConversationMessageData[],
  firstPrompt: LocalUserPrompt | undefined,
): ConversationMessageData[] {
  const base = cloneMessages(seedMessages);
  if (firstPrompt) {
    base.push(createUserMessage(firstPrompt));
  }
  return base;
}

function createAssistantTurnMessage(
  pendingTurn: PendingAssistantTurn,
): ConversationMessageData | null {
  const contentBlocks = pendingTurn.contentBlocks.filter((block) => {
    if (block.type === 'text') {
      return Boolean(block.text?.trim());
    }
    if (block.type === 'thinking') {
      return Boolean((block.thinking || block.text || '').trim());
    }
    return true;
  });

  if (contentBlocks.length === 0) {
    return null;
  }

  if (contentBlocks.length === 1 && contentBlocks[0]?.type === 'text') {
    return createAssistantTextMessage(
      pendingTurn.id,
      contentBlocks[0].text || '',
      pendingTurn.timestamp,
      {
        inputTokens: pendingTurn.inputTokens,
        outputTokens: pendingTurn.outputTokens,
        cacheCreationTokens: pendingTurn.cacheCreationTokens,
        cacheReadTokens: pendingTurn.cacheReadTokens,
      },
    );
  }

  return {
    msgType: 'assistant',
    uuid: pendingTurn.id,
    content: contentBlocks,
    timestamp: pendingTurn.timestamp,
    segmentIndex: 0,
    isCompactBoundary: false,
    inputTokens: pendingTurn.inputTokens,
    outputTokens: pendingTurn.outputTokens,
    cacheCreationTokens: pendingTurn.cacheCreationTokens,
    cacheReadTokens: pendingTurn.cacheReadTokens,
  };
}

export function dedupeEvents(events: SessionEventRecord[]) {
  const seen = new Set<string>();
  const deduped: SessionEventRecord[] = [];

  for (const event of events) {
    const key = `${event.runtime_id}:${event.seq}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

export function appendSessionEvents(
  previous: SessionEventRecord[],
  incoming: SessionEventRecord[],
  reset = false,
) {
  if (!incoming.length) {
    return reset ? [] : previous;
  }

  if (reset || previous.length === 0) {
    return dedupeEvents(incoming);
  }

  const lastPrevious = previous[previous.length - 1];
  let lastSeq = lastPrevious?.seq ?? 0;
  const isMonotonicAppend = Boolean(lastPrevious) && incoming.every((event) => {
    if (event.runtime_id !== lastPrevious!.runtime_id || event.seq <= lastSeq) {
      return false;
    }
    lastSeq = event.seq;
    return true;
  });

  if (isMonotonicAppend) {
    return [...previous, ...incoming];
  }

  const seen = new Set(previous.map((event) => `${event.runtime_id}:${event.seq}`));
  const nextEvents: SessionEventRecord[] = [];
  for (const event of incoming) {
    const key = `${event.runtime_id}:${event.seq}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    nextEvents.push(event);
  }

  if (!nextEvents.length) {
    return previous;
  }

  return [...previous, ...nextEvents];
}

export function sessionEventsNeedSummaryRefresh(events: SessionEventRecord[]) {
  return events.some((event) => {
    switch (event.payload.type) {
      case 'session_completed':
      case 'stderr_line':
      case 'permission_required':
      case 'permission_responded':
      case 'terminal_prompt_required':
      case 'terminal_prompt_resolved':
      case 'runtime_settings_changed':
      case 'background_tasks_changed':
      case 'background_task_updated':
        return true;
      case 'tool_use_completed':
        return event.payload.success === false;
      case 'lifecycle':
        return [
          'compacting',
          'compact_completed',
          'compact_failed',
          'closed_idle',
          'handoff_failed',
          'idle_stop',
          'error',
          'interrupted',
          'interrupt_timeout',
          'ready',
          'runtime_resume',
          'stop_force_killed',
          'turn_completed',
          'turn_interrupted',
        ].includes(event.payload.stage);
      default:
        return false;
    }
  });
}

const ACTIVE_TURN_LIFECYCLE_STAGES = new Set([
  'compacting',
  'initializing',
  'prompt_send_requested',
  'prompt_send_written',
  'processing',
  'interrupt_requested',
  'stop_requested',
  'stop_written',
  'turn_started',
]);

const CLOSED_TURN_LIFECYCLE_STAGES = new Set([
  'error',
  'closed_idle',
  'handoff',
  'handoff_failed',
  'idle',
  'idle_stop',
  'interrupted',
  'interrupt_timeout',
  'ready',
  'stopped',
  'stop_force_killed',
  'turn_completed',
  'turn_interrupted',
]);

const STALE_PROCESSING_EVENT_MS = 10 * 60 * 1000;

function latestEventTime(events: SessionEventRecord[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const occurredAt = parseOccurredAt(events[index]!.occurred_at);
    if (occurredAt != null) {
      return occurredAt;
    }
  }
  return null;
}

function inferProcessingFromLifecycleEvents(events: SessionEventRecord[]): boolean | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]!.payload;
    if (payload.type !== 'lifecycle') {
      continue;
    }

    if (CLOSED_TURN_LIFECYCLE_STAGES.has(payload.stage)) {
      return false;
    }
    if (ACTIVE_TURN_LIFECYCLE_STAGES.has(payload.stage)) {
      return true;
    }
  }

  return null;
}

export function shouldTreatNativeSessionAsProcessing(
  status: string,
  events: SessionEventRecord[],
  nowMs = Date.now(),
) {
  if (status === 'initializing') {
    return true;
  }
  if (status !== 'processing') {
    return false;
  }

  const inferred = inferProcessingFromLifecycleEvents(events);
  if (inferred === false) {
    return false;
  }

  if (inferred === true) {
    const latestTime = latestEventTime(events);
    if (latestTime != null && nowMs - latestTime > STALE_PROCESSING_EVENT_MS) {
      return false;
    }
    return true;
  }

  return true;
}

function stableUnknownEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function shallowEqualContentBlock(
  block: ConversationContentBlock,
  next: ConversationContentBlock,
): boolean {
  if (block.type !== next.type) return false;

  switch (block.type) {
    case 'text':
      return block.text === next.text;
    case 'thinking':
      return (block.thinking || block.text) === (next.thinking || next.text)
        && block._startedAt === next._startedAt
        && block._completedAt === next._completedAt;
    case 'tool_use':
      return block.id === next.id
        && block.name === next.name
        && stableUnknownEqual(block.input, next.input)
        && block._startedAt === next._startedAt
        && block._completedAt === next._completedAt
        && stableUnknownEqual(block._result, next._result)
        && block._resultError === next._resultError;
    case 'tool_result':
      return block.tool_use_id === next.tool_use_id
        && stableUnknownEqual(block.content, next.content)
        && block.is_error === next.is_error;
    default:
      return stableUnknownEqual(block, next);
  }
}

function shallowEqualContent(
  a: ConversationMessageData['content'],
  b: ConversationMessageData['content'],
): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a == null || b == null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((block, index) => shallowEqualContentBlock(block, b[index]!));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    return shallowEqualContentBlock(
      a as ConversationContentBlock,
      b as ConversationContentBlock,
    );
  }

  return false;
}

function shallowEqualMessages(
  previous: ConversationMessageData,
  next: ConversationMessageData,
): boolean {
  return previous.uuid === next.uuid
    && previous.msgType === next.msgType
    && previous.timestamp === next.timestamp
    && previous.segmentIndex === next.segmentIndex
    && previous.isCompactBoundary === next.isCompactBoundary
    && previous.planContent === next.planContent
    && previous.summary === next.summary
    && previous.model === next.model
    && previous.inputTokens === next.inputTokens
    && previous.outputTokens === next.outputTokens
    && previous.cacheCreationTokens === next.cacheCreationTokens
    && previous.cacheReadTokens === next.cacheReadTokens
    && previous.annotations === next.annotations
    && shallowEqualContent(previous.content, next.content);
}

export function stabilizeMessageRefs(
  messages: ConversationMessageData[],
  previousMessages: ConversationMessageData[] | undefined,
): ConversationMessageData[] {
  if (!previousMessages?.length) {
    return messages;
  }

  const previousByUuid = new Map<string, ConversationMessageData>();
  for (const message of previousMessages) {
    if (message.uuid) {
      previousByUuid.set(message.uuid, message);
    }
  }

  let reusedAny = false;
  const stabilized = messages.map((message) => {
    if (!message.uuid) {
      return message;
    }
    const previous = previousByUuid.get(message.uuid);
    if (!previous || previous === message || !shallowEqualMessages(previous, message)) {
      return message;
    }
    reusedAny = true;
    return previous;
  });

  return reusedAny ? stabilized : messages;
}

function appendTextBlock(blocks: ConversationContentBlock[], text: string) {
  if (!text) {
    return;
  }

  const last = blocks[blocks.length - 1];
  if (last?.type === 'text') {
    blocks[blocks.length - 1] = {
      ...last,
      text: `${last.text || ''}${text}`,
    };
    return;
  }

  blocks.push({
    type: 'text',
    text,
  });
}

function appendThinkingBlock(
  blocks: ConversationContentBlock[],
  text: string,
  occurredAt?: number,
) {
  if (!text) {
    return;
  }

  const last = blocks[blocks.length - 1];
  if (last?.type === 'thinking') {
    blocks[blocks.length - 1] = {
      ...last,
      thinking: `${last.thinking || last.text || ''}${text}`,
      ...(occurredAt != null ? { _completedAt: occurredAt } : {}),
    };
    return;
  }

  blocks.push({
    type: 'thinking',
    thinking: text,
    ...(occurredAt != null ? { _startedAt: occurredAt, _completedAt: occurredAt } : {}),
  });
}

function attachToolResultToBlocks(
  blocks: ConversationContentBlock[],
  toolUseId: string,
  resultContent: string,
  success: boolean,
  occurredAt?: number,
) {
  let attached = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== 'tool_use' || block.id !== toolUseId) {
      continue;
    }
    blocks[index] = {
      ...block,
      _result: resultContent,
      _resultError: !success,
      ...(occurredAt != null ? { _completedAt: occurredAt } : {}),
    };
    attached = true;
    break;
  }
  return attached;
}

/**
 * Incremental transcript derivation state (plan 022).
 *
 * `deriveTranscriptReset` folds a full event list once; `deriveTranscriptAppend`
 * folds only newly appended events into an existing state, so a streaming poll
 * costs O(new events) instead of O(all events). `finalizeTranscriptMessages`
 * renders a pure display view of the state WITHOUT mutating it — the pending
 * assistant turn must stay pending across appends (flushing it per append would
 * re-key the streaming message every batch).
 */
export interface TranscriptDerivationState {
  /** Runtime whose events were folded; mismatch forces a reset. */
  runtimeId: string | null;
  /** Committed messages. The open pendingTurn is NOT part of this list. */
  messages: ConversationMessageData[];
  /** Leading messages that came from base/seed inputs (rebuildable). */
  headLength: number;
  pendingTurn: PendingAssistantTurn | null;
  hiddenInteractiveToolUseIds: Set<string>;
  /** Tool uses owned by background tasks: their completions never render as
   *  standalone result/error rows (v2.70.0 background-task lifecycle). */
  backgroundToolUseIds: Set<string>;
  emittedErrorTexts: Set<string>;
  promptQueue: LocalUserPrompt[];
  /** Last event seq folded in; doubles as the gap-detection junction. */
  consumedSeq: number | null;
  /** Number of events folded so far (drives merge-vs-prune detection). */
  consumedCount: number;
  /** Identity token: seedMessages prop captured at reset/rebase time. */
  seedMessages: ConversationMessageData[] | null;
  /** Identity token: replay prompts captured at reset/rebase time. */
  prompts: unknown;
  /** Terminal error text, applied during finalize only (never baked in). */
  terminalError: string | null;
}

export interface TranscriptDerivationTokens {
  seedMessages?: ConversationMessageData[];
  prompts?: unknown;
}

function foldFlushPendingTurn(state: TranscriptDerivationState): boolean {
  if (!state.pendingTurn) {
    return false;
  }

  const assistantMessage = createAssistantTurnMessage(state.pendingTurn);
  if (assistantMessage) {
    state.messages.push(assistantMessage);
  }
  state.pendingTurn = null;
  return Boolean(assistantMessage);
}

function foldAppendErrorMessage(
  state: TranscriptDerivationState,
  id: string,
  text?: string | null,
  occurredAt?: number,
) {
  const trimmedText = text?.trim();
  if (!trimmedText || state.emittedErrorTexts.has(trimmedText)) {
    return;
  }
  state.emittedErrorTexts.add(trimmedText);
  foldFlushPendingTurn(state);
  state.messages.push(createAssistantTextMessage(id, trimmedText, occurredAt));
}

function foldRemoveTrailingCompactingSummary(state: TranscriptDerivationState) {
  const last = state.messages[state.messages.length - 1];
  if (last?.msgType === 'summary' && last.summary === COMPACTING_SUMMARY_TOKEN) {
    state.messages.pop();
  }
}

function foldAppendCompactingSummary(
  state: TranscriptDerivationState,
  event: SessionEventRecord,
  occurredAt?: number,
) {
  const last = state.messages[state.messages.length - 1];
  if (last?.msgType === 'summary' && last.summary === COMPACTING_SUMMARY_TOKEN) {
    return;
  }
  state.messages.push(createSummaryMessage(
    `compact-status-${event.seq}`,
    COMPACTING_SUMMARY_TOKEN,
    occurredAt,
  ));
}

function foldAppendCompactBoundary(
  state: TranscriptDerivationState,
  event: SessionEventRecord,
  occurredAt?: number,
) {
  foldRemoveTrailingCompactingSummary(state);
  const last = state.messages[state.messages.length - 1];
  if (last?.isCompactBoundary) {
    return;
  }
  state.messages.push(createCompactBoundaryMessage(`compact-boundary-${event.seq}`, occurredAt));
}

function foldAppendTranscriptGapSummary(
  state: TranscriptDerivationState,
  previousSeq: number,
  event: SessionEventRecord,
  occurredAt?: number,
) {
  foldFlushPendingTurn(state);
  const last = state.messages[state.messages.length - 1];
  if (last?.msgType === 'summary' && last.summary === TRANSCRIPT_GAP_SUMMARY_TOKEN) {
    return;
  }
  state.messages.push(createSummaryMessage(
    `transcript-gap-${previousSeq}-${event.seq}`,
    TRANSCRIPT_GAP_SUMMARY_TOKEN,
    occurredAt,
  ));
}

function foldConsumeMatchingPrompt(
  state: TranscriptDerivationState,
  event: SessionEventRecord,
  text: string,
  images: Array<unknown>,
) {
  const key = normalizePromptConfirmationText(text, images);
  if (!key || state.promptQueue.length === 0) {
    return;
  }
  const index = state.promptQueue.findIndex((prompt) =>
    normalizePromptConfirmationText(prompt.text, prompt.images ?? null) === key
    && (prompt.afterEventSeq == null || event.seq > prompt.afterEventSeq),
  );
  if (index === -1) {
    return;
  }
  state.promptQueue = [
    ...state.promptQueue.slice(0, index),
    ...state.promptQueue.slice(index + 1),
  ];
}

function foldFlushAnchoredPromptsBeforeEvent(
  state: TranscriptDerivationState,
  event: SessionEventRecord,
) {
  if (state.promptQueue.length === 0) {
    return;
  }

  const remaining: LocalUserPrompt[] = [];
  for (const prompt of state.promptQueue) {
    if (prompt.afterEventSeq != null && event.seq > prompt.afterEventSeq) {
      foldFlushPendingTurn(state);
      state.messages.push(createUserMessage(prompt));
    } else {
      remaining.push(prompt);
    }
  }
  state.promptQueue = remaining;
}

function foldFlushFirstUnanchoredPrompt(state: TranscriptDerivationState) {
  const index = state.promptQueue.findIndex((prompt) => prompt.afterEventSeq == null);
  if (index === -1) {
    return false;
  }
  foldFlushPendingTurn(state);
  state.messages.push(createUserMessage(state.promptQueue[index]!));
  state.promptQueue = [
    ...state.promptQueue.slice(0, index),
    ...state.promptQueue.slice(index + 1),
  ];
  return true;
}

function foldAttachToolResultToExistingMessages(
  state: TranscriptDerivationState,
  toolUseId: string,
  resultContent: string,
  success: boolean,
  occurredAt?: number,
) {
  const next = state.messages;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message.msgType !== 'assistant' && message.msgType !== 'ai') {
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    const blocks = [...message.content];
    if (!attachToolResultToBlocks(blocks, toolUseId, resultContent, success, occurredAt)) {
      continue;
    }
    next[index] = {
      ...message,
      content: blocks,
      timestamp: occurredAt ?? message.timestamp,
    };
    return true;
  }
  return false;
}

function foldApplyTokenUsageToLatestAssistant(
  state: TranscriptDerivationState,
  payload: Extract<SessionEventRecord['payload'], { type: 'token_usage' }>,
) {
  const pendingTurn = state.pendingTurn;
  if (pendingTurn) {
    pendingTurn.inputTokens = payload.input_tokens;
    pendingTurn.outputTokens = payload.output_tokens;
    pendingTurn.cacheReadTokens = payload.cache_read_tokens;
    pendingTurn.cacheCreationTokens = payload.cache_creation_tokens;
    return;
  }

  const next = state.messages;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message.msgType !== 'assistant' && message.msgType !== 'ai') {
      continue;
    }
    next[index] = {
      ...message,
      inputTokens: payload.input_tokens,
      outputTokens: payload.output_tokens,
      cacheReadTokens: payload.cache_read_tokens,
      cacheCreationTokens: payload.cache_creation_tokens,
    };
    return;
  }
}

function foldEnsurePendingTurn(
  state: TranscriptDerivationState,
  event: SessionEventRecord,
  occurredAt?: number,
): PendingAssistantTurn {
  if (!state.pendingTurn) {
    state.pendingTurn = {
      id: `assistant-turn-${event.seq}`,
      timestamp: occurredAt,
      contentBlocks: [],
    };
    return state.pendingTurn;
  }

  if (occurredAt != null) {
    state.pendingTurn.timestamp = occurredAt;
  }
  return state.pendingTurn;
}

function foldTranscriptEvents(
  state: TranscriptDerivationState,
  events: SessionEventRecord[],
  suppressGapBeforeSeqs?: ReadonlySet<number>,
): TranscriptDerivationState {
  let previousEventSeq = state.consumedSeq;
  for (const event of events) {
    const occurredAt = parseOccurredAt(event.occurred_at);
    if (
      previousEventSeq != null
      && event.seq > previousEventSeq + 1
      && !suppressGapBeforeSeqs?.has(event.seq)
    ) {
      foldAppendTranscriptGapSummary(state, previousEventSeq, event, occurredAt);
    }
    previousEventSeq = event.seq;

    foldFlushAnchoredPromptsBeforeEvent(state, event);

    switch (event.payload.type) {
      case 'user_prompt': {
        const images = event.payload.images?.filter(Boolean) ?? [];
        const text = event.payload.text?.trim()
          || (event.payload.image_count > 0 && images.length === 0
            ? `Images attached: ${event.payload.image_count}`
            : '');
        if (!text && images.length === 0) {
          break;
        }
        foldFlushPendingTurn(state);
        state.messages.push(createUserMessage({
          id: `user-prompt-${event.seq}`,
          text,
          images,
          annotations: event.payload.annotations ?? undefined,
          timestamp: occurredAt,
        }));
        if (text) {
          foldConsumeMatchingPrompt(state, event, text, images);
        }
        break;
      }
      case 'system_message': {
        appendThinkingBlock(
          foldEnsurePendingTurn(state, event, occurredAt).contentBlocks,
          event.payload.message,
          occurredAt,
        );
        break;
      }
      case 'assistant_chunk': {
        appendTextBlock(
          foldEnsurePendingTurn(state, event, occurredAt).contentBlocks,
          event.payload.text,
        );
        break;
      }
      case 'tool_use_started': {
        if (event.payload.needs_response) {
          state.hiddenInteractiveToolUseIds.add(event.payload.tool_use_id);
          break;
        }
        foldEnsurePendingTurn(state, event, occurredAt).contentBlocks.push({
          type: 'tool_use',
          id: event.payload.tool_use_id,
          name: event.payload.raw_name,
          input: event.payload.input_summary
            ? { summary: event.payload.input_summary }
            : {},
          ...(occurredAt != null ? { _startedAt: occurredAt } : {}),
        });
        break;
      }
      case 'background_tasks_changed': {
        event.payload.tasks.forEach((task) => {
          if (task.tool_use_id) state.backgroundToolUseIds.add(task.tool_use_id);
        });
        break;
      }
      case 'background_task_updated': {
        if (event.payload.task.tool_use_id) {
          state.backgroundToolUseIds.add(event.payload.task.tool_use_id);
        }
        break;
      }
      case 'tool_use_completed': {
        if (state.hiddenInteractiveToolUseIds.has(event.payload.tool_use_id)) {
          state.hiddenInteractiveToolUseIds.delete(event.payload.tool_use_id);
          break;
        }
        const resultContent = event.payload.result_content?.trim()
          ? event.payload.result_content
          : event.payload.result_summary;
        let attachedToPendingTurn = false;
        const currentPendingTurn = state.pendingTurn;
        if (currentPendingTurn) {
          attachedToPendingTurn = attachToolResultToBlocks(
            currentPendingTurn.contentBlocks,
            event.payload.tool_use_id,
            resultContent,
            event.payload.success,
            occurredAt,
          );
        }
        if (
          attachedToPendingTurn
          || foldAttachToolResultToExistingMessages(
            state,
            event.payload.tool_use_id,
            resultContent,
            event.payload.success,
            occurredAt,
          )
        ) {
          break;
        }
        if (state.backgroundToolUseIds.has(event.payload.tool_use_id)) {
          break;
        }
        if (!event.payload.success) {
          const fallbackName = event.payload.raw_name?.trim() || 'Tool';
          foldAppendErrorMessage(
            state,
            `tool-result-error-${event.seq}`,
            event.payload.result_summary || `${fallbackName} failed.`,
            occurredAt,
          );
          break;
        }
        const resultBlock = {
          type: 'tool_result',
          tool_use_id: event.payload.tool_use_id,
          content: resultContent,
          is_error: !event.payload.success,
        };
        const last = state.messages[state.messages.length - 1];
        if (
          last
          && (last.msgType === 'user' || last.msgType === 'human')
          && Array.isArray(last.content)
          && last.content.every((block) => block.type === 'tool_result')
        ) {
          state.messages[state.messages.length - 1] = {
            ...last,
            content: [...last.content, resultBlock],
            timestamp: occurredAt ?? last.timestamp,
          };
        } else {
          state.messages.push(
            createToolResultMessage(
              `tool-result-${event.seq}`,
              event.payload.tool_use_id,
              resultContent,
              event.payload.success,
              occurredAt,
            ),
          );
        }
        break;
      }
      case 'token_usage': {
        foldApplyTokenUsageToLatestAssistant(state, event.payload);
        break;
      }
      case 'stderr_line': {
        foldAppendErrorMessage(state, `runtime-error-${event.seq}`, event.payload.line, occurredAt);
        break;
      }
      case 'lifecycle': {
        if (event.payload.stage === 'error') {
          foldAppendErrorMessage(
            state,
            `runtime-error-${event.seq}`,
            event.payload.detail,
            occurredAt,
          );
          break;
        }
        if (event.payload.stage === 'compacting') {
          foldFlushPendingTurn(state);
          foldAppendCompactingSummary(state, event, occurredAt);
          break;
        }
        if (event.payload.stage === 'compact_completed') {
          foldFlushPendingTurn(state);
          foldAppendCompactBoundary(state, event, occurredAt);
          break;
        }
        if (event.payload.stage === 'compact_failed') {
          foldFlushPendingTurn(state);
          foldRemoveTrailingCompactingSummary(state);
          const compactFailureDetail = event.payload.detail?.trim();
          state.messages.push(createSummaryMessage(
            `compact-failed-${event.seq}`,
            compactFailureDetail && compactFailureDetail !== 'Claude failed to compact the context.'
              ? compactFailureDetail
              : COMPACT_FAILED_SUMMARY_TOKEN,
            occurredAt,
          ));
          break;
        }
        if (
          event.payload.stage === 'turn_started'
          || event.payload.stage === 'turn_completed'
          || event.payload.stage === 'turn_interrupted'
        ) {
          const flushedTurn = foldFlushPendingTurn(state);
          if (
            !flushedTurn
            && (
              event.payload.stage === 'turn_completed'
              || event.payload.stage === 'turn_interrupted'
            )
          ) {
            const detail = event.payload.detail?.trim();
            if (detail) {
              foldAppendErrorMessage(state, `turn-detail-${event.seq}`, detail, occurredAt);
            }
          }
        }
        if (
          (event.payload.stage === 'turn_completed' || event.payload.stage === 'turn_interrupted')
          && state.promptQueue.length > 0
        ) {
          foldFlushFirstUnanchoredPrompt(state);
        }
        break;
      }
      case 'session_completed': {
        foldFlushPendingTurn(state);
        if (!event.payload.reason.includes('Stopped from desktop workspace')) {
          foldAppendErrorMessage(
            state,
            `runtime-completed-${event.seq}`,
            event.payload.reason,
            occurredAt,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  state.consumedSeq = previousEventSeq;
  state.consumedCount += events.length;
  return state;
}

/**
 * Full-pass derivation over `events` (current pre-plan-022 behavior minus the
 * display finalization). Used on mount, runtime switch, and whenever the event
 * list changes in a way that is not a pure suffix extension of what the state
 * already consumed.
 */
export function deriveTranscriptReset(
  baseMessages: ConversationMessageData[],
  remainingPrompts: LocalUserPrompt[],
  events: SessionEventRecord[],
  terminalError?: string | null,
  options?: {
    tokens?: TranscriptDerivationTokens;
    /** Seqs where a seq jump is a known prune seam, not a real event gap. */
    suppressGapBeforeSeqs?: ReadonlySet<number>;
  },
): TranscriptDerivationState {
  const head = trimSeedMessagesBeforeFirstUserPrompt(baseMessages, events);
  const runtimeId = events.length
    ? events[events.length - 1]!.runtime_id
    : null;
  const state: TranscriptDerivationState = {
    runtimeId,
    messages: [...head],
    headLength: head.length,
    pendingTurn: null,
    hiddenInteractiveToolUseIds: new Set(),
    backgroundToolUseIds: new Set(),
    emittedErrorTexts: new Set(),
    promptQueue: [...remainingPrompts],
    consumedSeq: null,
    consumedCount: 0,
    seedMessages: options?.tokens?.seedMessages ?? null,
    prompts: options?.tokens?.prompts ?? null,
    terminalError: terminalError ?? null,
  };
  return foldTranscriptEvents(state, events, options?.suppressGapBeforeSeqs);
}

/**
 * Fold only newly appended events into an existing derivation state.
 * `appendedEvents` must be a validated suffix (see selectTranscriptAppendEvents).
 */
export function deriveTranscriptAppend(
  state: TranscriptDerivationState,
  appendedEvents: SessionEventRecord[],
): TranscriptDerivationState {
  if (!appendedEvents.length) {
    return state;
  }
  return foldTranscriptEvents({ ...state }, appendedEvents);
}

/**
 * Seed/prompt inputs changed but the folded event history is still valid:
 * rebuild only the head (base messages) and refresh the prompt queue, keeping
 * every event-derived message object identity intact.
 */
export function rebaseTranscriptHead(
  state: TranscriptDerivationState,
  baseMessages: ConversationMessageData[],
  events: SessionEventRecord[],
  remainingPrompts: LocalUserPrompt[],
  tokens?: TranscriptDerivationTokens,
): TranscriptDerivationState {
  const head = trimSeedMessagesBeforeFirstUserPrompt(baseMessages, events);
  return {
    ...state,
    messages: [...head, ...state.messages.slice(state.headLength)],
    headLength: head.length,
    promptQueue: [...remainingPrompts],
    seedMessages: tokens?.seedMessages ?? state.seedMessages,
    prompts: tokens?.prompts ?? state.prompts,
  };
}

/**
 * Pure display view of a derivation state: flushes the open pending turn,
 * appends the terminal error (once), then any queued local prompts. Never
 * mutates the state, so calling it twice or after further appends is safe.
 */
export function finalizeTranscriptMessages(
  state: TranscriptDerivationState,
): ConversationMessageData[] {
  const final = [...state.messages];
  if (state.pendingTurn) {
    const assistantMessage = createAssistantTurnMessage(state.pendingTurn);
    if (assistantMessage) {
      final.push(assistantMessage);
    }
  }
  const terminalErrorText = state.terminalError?.trim();
  if (terminalErrorText && !state.emittedErrorTexts.has(terminalErrorText)) {
    final.push(createAssistantTextMessage('runtime-error-terminal', terminalErrorText));
  }
  for (const prompt of state.promptQueue) {
    final.push(createUserMessage(prompt));
  }
  return final;
}

export type TranscriptAppendSelection =
  | { mode: 'idle' }
  | { mode: 'append'; appended: SessionEventRecord[] }
  | { mode: 'reset' };

/**
 * Generic append-vs-reset detection shared by every event fold (transcript,
 * usage, review). Decides how `events` relates to a fold that consumed
 * `consumedSeq` over `consumedCount` events of `runtimeId`:
 * - `append`: events is the consumed prefix (possibly pruned from the head, as
 *   long as no NEW pre-consumed events appeared) plus a strictly-ascending
 *   same-runtime suffix.
 * - `reset`: consumed marker missing (replacement), old events inserted
 *   (replay merge/backfill refilled the pruned head), or the suffix is not a
 *   valid ascending same-runtime run.
 * - `idle`: nothing new to fold.
 */
export function selectEventAppendRange(
  events: SessionEventRecord[],
  consumedSeq: number | null,
  consumedCount: number,
  runtimeId: string | null,
): TranscriptAppendSelection {
  if (consumedSeq == null) {
    if (!events.length) {
      return { mode: 'idle' };
    }
    if (runtimeId != null && events[0]!.runtime_id !== runtimeId) {
      return { mode: 'reset' };
    }
    return validateAppendRun(events, 0, consumedSeq, runtimeId)
      ? { mode: 'append', appended: events }
      : { mode: 'reset' };
  }

  // Binary search for the consumed marker (events are seq-ascending).
  let low = 0;
  let high = events.length - 1;
  let markerIndex = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const seq = events[mid]!.seq;
    if (seq === consumedSeq) {
      markerIndex = mid;
      low = mid + 1;
    } else if (seq < consumedSeq) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (markerIndex < 0) {
    return { mode: 'reset' };
  }
  // More pre-consumed events than we folded => the pruned head was refilled
  // (initial replay merge / backfill). Fold the complete list from scratch.
  if (markerIndex + 1 > consumedCount) {
    return { mode: 'reset' };
  }
  const appended = events.slice(markerIndex + 1);
  if (!appended.length) {
    return { mode: 'idle' };
  }
  if (!validateAppendRun(events, markerIndex + 1, consumedSeq, runtimeId)) {
    return { mode: 'reset' };
  }
  return { mode: 'append', appended };
}

/** Transcript-flavored wrapper over selectEventAppendRange. */
export function selectTranscriptAppendEvents(
  events: SessionEventRecord[],
  state: TranscriptDerivationState,
): TranscriptAppendSelection {
  return selectEventAppendRange(events, state.consumedSeq, state.consumedCount, state.runtimeId);
}

function validateAppendRun(
  events: SessionEventRecord[],
  startIndex: number,
  consumedSeq: number | null,
  runtimeId: string | null,
): boolean {
  const expectedRuntimeId = runtimeId ?? events[startIndex]?.runtime_id ?? null;
  if (expectedRuntimeId == null) {
    return false;
  }
  let expectedSeq = consumedSeq;
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.runtime_id !== expectedRuntimeId) {
      return false;
    }
    if (expectedSeq != null && event.seq <= expectedSeq) {
      return false;
    }
    expectedSeq = event.seq;
  }
  return true;
}

/**
 * One-shot transcript derivation over a full event list. Kept for callers that
 * do not keep derivation state (history page seeding); the live view uses the
 * incremental API above. Output is identical to finalize(reset(events)).
 */
export function buildMessagesFromEvents(
  baseMessages: ConversationMessageData[],
  remainingPrompts: LocalUserPrompt[],
  events: SessionEventRecord[],
  terminalError?: string | null,
): ConversationMessageData[] {
  return finalizeTranscriptMessages(
    deriveTranscriptReset(baseMessages, remainingPrompts, events, terminalError),
  );
}

/**
 * Raw event tail bounding (plan 022, step 3).
 *
 * The live `events` array keeps the newest RAW_TAIL_LIMIT events plus an anchor
 * set of semantically load-bearing older events, so the array's resident memory
 * stays bounded for the view's lifetime. Anchors cover every consumer that
 * re-scans the array: prompt confirmation and seed trimming (user_prompt),
 * file checkpoints (checkpoint_created / files_rewound / file_rewind_failed),
 * todo snapshots (newest snapshot carrier below the tail), terminal completion,
 * and attention state (unresolved permission / terminal prompts — resolved
 * pairs are dropped together so the attention fold never sees a stale raise).
 */
export const RAW_TAIL_LIMIT = 5000;

export interface RawEventTailPruneResult {
  events: SessionEventRecord[];
  /**
   * Seqs of the first retained event after each pruned run. A seq jump onto
   * one of these is a prune seam, not a real event gap; derivation resets pass
   * them as `suppressGapBeforeSeqs` so no spurious transcript-gap chip appears.
   */
  seams: number[];
  prunedCount: number;
}

function isTodoSnapshotCarrier(event: SessionEventRecord): boolean {
  const payload = event.payload;
  if (payload.type !== 'tool_use_started' && payload.type !== 'tool_use_completed') {
    return false;
  }
  const snapshot = payload.todo_snapshot as { version?: unknown } | undefined;
  return Boolean(snapshot) && typeof snapshot === 'object' && snapshot.version === 1;
}

/**
 * Prune `events` to the newest `tailLimit` events plus retained anchors.
 * Assumes a single runtime and seq-ascending order (both hold for the live
 * view's arrays); mixed runtimes disable pruning as a safety net.
 */
export function pruneRawEventTail(
  events: SessionEventRecord[],
  tailLimit = RAW_TAIL_LIMIT,
): RawEventTailPruneResult {
  const limit = Math.max(0, Math.floor(tailLimit));
  if (events.length <= limit || limit === 0) {
    return { events, seams: [], prunedCount: 0 };
  }

  const runtimeId = events[0]!.runtime_id;
  const dropEnd = events.length - limit;

  const respondedRequestIds = new Set<string>();
  const terminalResolvedSeqs: number[] = [];
  let newestSnapshotIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.runtime_id !== runtimeId) {
      return { events, seams: [], prunedCount: 0 };
    }
    const payload = event.payload;
    if (payload.type === 'permission_responded') {
      respondedRequestIds.add(payload.request_id);
    } else if (payload.type === 'terminal_prompt_resolved') {
      terminalResolvedSeqs.push(event.seq);
    }
    if (index < dropEnd && isTodoSnapshotCarrier(event)) {
      newestSnapshotIndex = index;
    }
  }

  const retained: SessionEventRecord[] = [];
  const seams: number[] = [];
  let skippedSinceKeep = false;
  let previousKeptSeq: number | null = null;

  const keepAnchor = (event: SessionEventRecord, index: number): boolean => {
    const payload = event.payload;
    switch (payload.type) {
      case 'user_prompt':
      case 'files_rewound':
      case 'file_rewind_failed':
      case 'session_completed':
        return true;
      case 'checkpoint_created':
        return payload.provider === 'claude' && payload.source === 'claude-file-checkpoint';
      case 'permission_required':
        return !respondedRequestIds.has(payload.request_id);
      case 'terminal_prompt_required':
        return !terminalResolvedSeqs.some((resolvedSeq) => resolvedSeq > event.seq);
      default:
        return index === newestSnapshotIndex;
    }
  };

  for (let index = 0; index < dropEnd; index += 1) {
    const event = events[index]!;
    if (!keepAnchor(event, index)) {
      skippedSinceKeep = true;
      continue;
    }
    if (skippedSinceKeep) {
      seams.push(event.seq);
      skippedSinceKeep = false;
    }
    previousKeptSeq = event.seq;
    retained.push(event);
  }

  // Seam at the tail boundary when events were dropped between the last
  // retained anchor (or array head) and the tail window.
  if (skippedSinceKeep) {
    const tailHead = events[dropEnd]!;
    if (tailHead.seq !== (previousKeptSeq ?? tailHead.seq - 1) + 1) {
      seams.push(tailHead.seq);
    }
  }

  const pruned = events.length - retained.length - limit;
  return {
    events: [...retained, ...events.slice(dropEnd)],
    seams,
    prunedCount: pruned,
  };
}
