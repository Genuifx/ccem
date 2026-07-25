import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Check,
  ClipboardList,
  History,
  Layers3,
  LoaderCircle,
  MessageSquareQuote,
  RotateCcw,
  Share2,
  ShieldAlert,
  Square,
  SquarePen,
  Terminal,
} from '@/lib/lucide-react';
import { Suspense, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import type {
  InteractivePromptAnnotation,
  InteractiveToolPrompt,
  NativePromptImageInput,
  NativeSessionSummary,
  SessionEventRecord,
  SessionPromptImage,
  WorkspaceCommand,
  WorkspaceGitSnapshot,
  ToolQuestionPrompt,
} from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import { useAppStore } from '@/store';
import type { InstalledSkill, LaunchClient } from '@/store';
import type { PermissionModeName } from '@ccem/core/browser';

function isNearBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= 48;
}

function scrollToLatest(container: HTMLDivElement) {
  container.scrollTo({ top: container.scrollHeight });
}
import type {
  ConversationMessageData,
} from '@/features/conversations/types';
import {
  buildComposerPromptPreview,
  buildComposerPromptText,
  extractComposerImagePayloads,
  type ComposerAttachment,
  type ComposerSubmitPayload,
} from './composerAttachments';
import { WorkspaceTranscriptList } from './WorkspaceTranscriptList';
import { WorkspaceSessionComposer } from './WorkspaceSessionComposer';
import {
  ComposerControls,
  normalizePermissionModeName,
  providerDisplayName,
} from './ComposerControls';
import type { EffortLevel } from './ComposerControls';
import {
  extractAttentionState,
  getPlanExitPrimaryReply,
  type NativeSessionAttentionState,
} from './workspaceNativeAttention';
import { normalizeEffortForProvider } from './workspaceSessionPreferences';
import { resolveWorkspaceRuntimePlanMode } from './workspaceRuntimePlanMode';
import {
  deriveNativeFileCheckpoints,
  type NativeFileCheckpoint,
} from './workspaceNativeCheckpoints';
import {
  buildWorkspaceCronAgentPrompt,
  isWorkspaceCronCommand,
} from './workspaceCronCommand';
import {
  appendSessionEvents,
  buildBaseMessages,
  buildMessagesFromEvents,
  filterConfirmedLocalUserPrompts,
  replayBatchCoversAvailableSequenceRange,
  sessionEventsNeedSummaryRefresh,
  shouldTreatNativeSessionAsProcessing,
  splitLocalUserPromptsForReplay,
  stabilizeMessageRefs,
  type LocalUserPrompt,
} from './workspaceEventTranscript';
import { ContextWindowIndicator } from './ContextWindowIndicator';
import { computeSessionUsage } from './workspaceUsage';
import { LazyWorkspaceReviewPopover } from './LazyWorkspaceReviewPopover';
import {
  buildWorkspaceReviewModel,
  buildWorkspaceReviewSummary,
} from './workspaceReview';
import {
  mergeWorkspaceReplayEvents,
  selectCachedWorkspaceEvents,
} from './workspaceTodos';
import { WorkspaceWecomBindDialog } from './WorkspaceWecomBindDialog';
import { WorkspaceTranscriptSelection } from './WorkspaceAnnotations';
import { useWorkspaceAnnotations } from './useWorkspaceAnnotations';

function ProcessingActionIcon({ stopping = false }: { stopping?: boolean }) {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      <LoaderCircle className="h-4 w-4 animate-spin opacity-80" />
      <Square
        className={cn(
          'absolute h-2.5 w-2.5',
          stopping ? 'opacity-0' : 'fill-current stroke-[2.5]'
        )}
      />
    </span>
  );
}

// Ant Design's WechatWorkFilled path, inlined to avoid adding another icon runtime.
function WeComMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="64 64 896 896"
      fill="currentColor"
      fillRule="evenodd"
      className={cn(
        'h-4 w-4 text-[#07c160]',
        className,
      )}
    >
      <path d="M805.33 112H218.67C159.76 112 112 159.76 112 218.67v586.66C112 864.24 159.76 912 218.67 912h586.66C864.24 912 912 864.24 912 805.33V218.67C912 159.76 864.24 112 805.33 112m-98.17 417.86a102.13 102.13 0 0028.1 52.46l2.13 2.06c.41.27.8.57 1.16.9l.55.64.2.02a7.96 7.96 0 01-.98 10.82 7.96 7.96 0 01-10.85-.18c-1.1-1.05-2.14-2.14-3.24-3.24a102.49 102.49 0 00-53.82-28.36l-2-.27c-.66-.12-1.34-.39-1.98-.39a33.27 33.27 0 1140.37-37.66c.17 1.09.36 2.16.36 3.2m-213.1 153.82a276.78 276.78 0 01-61.7.17 267.3 267.3 0 01-44.67-8.6l-68.44 34.4c-.33.24-.77.43-1.15.71h-.27a18.29 18.29 0 01-27.52-15.9c.03-.59.1-1.17.2-1.74.13-1.97.6-3.9 1.37-5.72l2.75-11.15 9.56-39.56a277.57 277.57 0 01-49.25-54.67A185.99 185.99 0 01223.1 478.1a182.42 182.42 0 0119.08-81.04 203.98 203.98 0 0137.19-52.32c38.91-39.94 93.26-65.52 153.1-72.03a278.25 278.25 0 0130.17-1.64c10.5.03 20.99.65 31.42 1.86 59.58 6.79 113.65 32.48 152.26 72.36a202.96 202.96 0 0137 52.48 182.3 182.3 0 0118.17 94.67c-.52-.57-1.02-1.2-1.57-1.76a33.26 33.26 0 00-40.84-4.8c.22-2.26.22-4.54.22-6.79a143.64 143.64 0 00-14.76-63.38 164.07 164.07 0 00-29.68-42.15c-31.78-32.76-76.47-53.95-125.89-59.55a234.37 234.37 0 00-51.67-.14c-49.61 5.41-94.6 26.45-126.57 59.26a163.63 163.63 0 00-29.82 41.95 143.44 143.44 0 00-15.12 63.93 147.16 147.16 0 0025.29 81.51 170.5 170.5 0 0024.93 29.4 172.31 172.31 0 0017.56 14.75 17.6 17.6 0 016.35 19.62l-6.49 24.67-1.86 7.14-1.62 6.45a2.85 2.85 0 002.77 2.88 3.99 3.99 0 001.93-.68l43.86-25.93 1.44-.78a23.2 23.2 0 0118.24-1.84 227.38 227.38 0 0033.87 7.12l5.22.69a227.26 227.26 0 0051.67-.14 226.58 226.58 0 0042.75-9.07 33.2 33.2 0 0022.72 34.76 269.27 269.27 0 01-60.37 14.12m89.07-24.87a33.33 33.33 0 01-33.76-18.75 33.32 33.32 0 016.64-38.03 33.16 33.16 0 0118.26-9.31c1.07-.14 2.19-.36 3.24-.36a102.37 102.37 0 0052.47-28.05l2.2-2.33a10.21 10.21 0 011.57-1.68v-.03a7.97 7.97 0 1110.64 11.81l-3.24 3.24a102.44 102.44 0 00-28.56 53.74c-.09.63-.28 1.35-.28 2l-.39 2.01a33.3 33.3 0 01-28.79 25.74m94.44 93.87a33.3 33.3 0 01-36.18-24.25 28 28 0 01-1.1-6.73 102.4 102.4 0 00-28.15-52.39l-2.3-2.25a7.2 7.2 0 01-1.11-.9l-.54-.6h-.03v.05a7.96 7.96 0 01.96-10.82 7.96 7.96 0 0110.85.18l3.22 3.24a102.29 102.29 0 0053.8 28.35l2 .28a33.27 33.27 0 11-1.42 65.84m113.67-103.34a32.84 32.84 0 01-18.28 9.31 26.36 26.36 0 01-3.24.36 102.32 102.32 0 00-52.44 28.1 49.57 49.57 0 00-3.14 3.41l-.68.56h.02l.09.05a7.94 7.94 0 11-10.6-11.81l3.23-3.24a102.05 102.05 0 0028.37-53.7 33.26 33.26 0 1162.4-12.1 33.21 33.21 0 01-5.73 39.06" />
    </svg>
  );
}

interface InteractivePromptAnswer {
  selectedOptions: string[];
  customSelected: boolean;
  customText: string;
}

interface InteractivePromptState {
  currentQuestionIndex: number;
  answers: Record<number, InteractivePromptAnswer>;
}

type InteractivePromptReplyPayload =
  | {
      kind: 'text';
      text: string;
      displayText?: string;
      attachments?: ComposerAttachment[];
    }
  | {
      kind: 'ask_user_question';
      toolUseId: string;
      text: string;
      answers: Record<string, string>;
      annotations?: Record<string, InteractivePromptAnnotation>;
    }
  | {
      kind: 'plan_exit';
      toolUseId: string;
      text: string;
      approved: boolean;
    };

type QueuedGuidanceMessage = {
  id: string;
  text: string;
  displayText?: string;
  planMode: boolean;
  attachments: ComposerAttachment[];
};

type QueuedGuidanceState = {
  runtimeId: string;
  messages: QueuedGuidanceMessage[];
};

type QueuedGuidanceMessagesUpdate =
  | QueuedGuidanceMessage[]
  | ((previous: QueuedGuidanceMessage[]) => QueuedGuidanceMessage[]);

interface WorkspaceNativeSessionViewProps {
  session: NativeSessionSummary;
  initialPrompt?: string | null;
  initialImages?: SessionPromptImage[] | null;
  seedMessages?: ConversationMessageData[];
  installedSkills?: InstalledSkill[];
  onRefreshSkills?: () => Promise<InstalledSkill[]>;
  workspaceCommands?: WorkspaceCommand[];
  isVisible?: boolean;
  onSessionUpdate: (session: NativeSessionSummary) => void;
  onStartNew: () => void;
  codexInstalled?: boolean;
  opencodeInstalled?: boolean;
  onLaunchNewSession?: (client: LaunchClient) => void;
}

const ACTIVE_POLL_INTERVAL_MS = 140;
const IDLE_POLL_INTERVAL_MS = 700;
const TERMINAL_POLL_INTERVAL_MS = 1100;
const SUMMARY_REFRESH_COOLDOWN_MS = 2000;
const CACHE_FLUSH_INTERVAL_MS = 1500;
const FILE_REWIND_TIMEOUT_MS = 30_000;
const INITIAL_EVENT_REPLAY_LIMIT = 1200;
const NATIVE_EVENT_CACHE_KEY_PREFIX = 'ccem-workspace-native-events:';
const NATIVE_EVENT_CACHE_LIMIT = 8000;
const GUIDANCE_QUEUE_STORAGE_PREFIX = 'ccem:workspace-native-guidance-queue:v1:';

function guidanceQueueStorageKey(runtimeId: string): string {
  return `${GUIDANCE_QUEUE_STORAGE_PREFIX}${runtimeId}`;
}

function makePersistableAttachment(attachment: ComposerAttachment): ComposerAttachment {
  if (attachment.kind !== 'image') {
    return attachment;
  }

  return {
    ...attachment,
    objectUrl: null,
  };
}

function makePersistableGuidanceMessage(message: QueuedGuidanceMessage): QueuedGuidanceMessage {
  return {
    ...message,
    attachments: message.attachments.map(makePersistableAttachment),
  };
}

function isStoredComposerAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const attachment = value as Record<string, unknown>;
  if (
    typeof attachment.id !== 'string'
    || typeof attachment.name !== 'string'
    || typeof attachment.source !== 'string'
  ) {
    return false;
  }

  if (attachment.kind === 'file') {
    return typeof attachment.absolutePath === 'string'
      && (typeof attachment.relativePath === 'string' || attachment.relativePath === null)
      && typeof attachment.displayPath === 'string'
      && typeof attachment.isOutsideWorkspace === 'boolean';
  }

  if (attachment.kind === 'text') {
    return typeof attachment.content === 'string'
      && typeof attachment.lineCount === 'number'
      && typeof attachment.charCount === 'number';
  }

  if (attachment.kind === 'image') {
    return typeof attachment.placeholder === 'string'
      && typeof attachment.mediaType === 'string'
      && typeof attachment.base64Data === 'string'
      && typeof attachment.byteSize === 'number';
  }

  return false;
}

function normalizeStoredGuidanceQueue(value: unknown): QueuedGuidanceMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Partial<QueuedGuidanceMessage>;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.text !== 'string'
      || typeof candidate.planMode !== 'boolean'
      || !Array.isArray(candidate.attachments)
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      text: candidate.text,
      displayText: typeof candidate.displayText === 'string' ? candidate.displayText : undefined,
      planMode: candidate.planMode,
      attachments: candidate.attachments
        .filter(isStoredComposerAttachment)
        .map(makePersistableAttachment),
    }];
  });
}

function readStoredGuidanceQueue(runtimeId: string): QueuedGuidanceMessage[] {
  try {
    const stored = window.sessionStorage.getItem(guidanceQueueStorageKey(runtimeId));
    if (!stored) {
      return [];
    }

    return normalizeStoredGuidanceQueue(JSON.parse(stored));
  } catch (error) {
    console.warn('Failed to read native guidance queue:', error);
    return [];
  }
}

function writeStoredGuidanceQueue(runtimeId: string, messages: QueuedGuidanceMessage[]) {
  try {
    const key = guidanceQueueStorageKey(runtimeId);
    if (messages.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }

    window.sessionStorage.setItem(
      key,
      JSON.stringify(messages.map(makePersistableGuidanceMessage)),
    );
  } catch (error) {
    console.warn('Failed to persist native guidance queue:', error);
  }
}

function resolveGuidanceMessagesUpdate(
  update: QueuedGuidanceMessagesUpdate,
  previous: QueuedGuidanceMessage[],
): QueuedGuidanceMessage[] {
  return typeof update === 'function' ? update(previous) : update;
}

function isTerminalStatus(status: string) {
  return status === 'stopped' || status === 'error' || status === 'handoff';
}

function formatCheckpointRelativeTime(
  createdAt: string,
  t: (key: string) => string,
) {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return t('workspace.nativeRestoreJustNow');
  }

  const elapsedMs = Math.max(0, Date.now() - created);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return t('workspace.nativeRestoreJustNow');
  }
  if (elapsedMinutes < 60) {
    return t('workspace.nativeRestoreMinutesAgo').replace('{count}', String(elapsedMinutes));
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return t('workspace.nativeRestoreHoursAgo').replace('{count}', String(elapsedHours));
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return t('workspace.nativeRestoreDaysAgo').replace('{count}', String(elapsedDays));
}

function nativeSessionRuntimePermMode(session: NativeSessionSummary) {
  return session.runtime_perm_mode || session.perm_mode;
}

function isNativeSessionPlanRuntime(session: NativeSessionSummary) {
  return nativeSessionRuntimePermMode(session) === 'plan';
}

function latestEventSeq(events: SessionEventRecord[]): number | null {
  return events[events.length - 1]?.seq ?? null;
}

function hasImmediateAttentionEvent(events: SessionEventRecord[]) {
  return events.some((event) => {
    switch (event.payload.type) {
      case 'permission_required':
      case 'permission_responded':
      case 'terminal_prompt_required':
      case 'terminal_prompt_resolved':
        return true;
      case 'tool_use_started':
        return event.payload.needs_response === true;
      case 'tool_use_completed':
        return true;
      default:
        return false;
    }
  });
}

function nativeEventCacheKey(runtimeId: string) {
  return `${NATIVE_EVENT_CACHE_KEY_PREFIX}${runtimeId}`;
}

function readCachedNativeEvents(runtimeId: string): SessionEventRecord[] {
  try {
    if (typeof sessionStorage === 'undefined') {
      return [];
    }

    const raw = sessionStorage.getItem(nativeEventCacheKey(runtimeId));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((event): event is SessionEventRecord =>
      event
      && typeof event === 'object'
      && event.runtime_id === runtimeId
      && typeof event.seq === 'number'
      && typeof event.occurred_at === 'string'
      && event.payload
      && typeof event.payload === 'object',
    );
  } catch {
    return [];
  }
}

function writeCachedNativeEvents(runtimeId: string, events: SessionEventRecord[]) {
  try {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    const key = nativeEventCacheKey(runtimeId);
    for (const limit of [NATIVE_EVENT_CACHE_LIMIT, 3000, 1000]) {
      try {
        sessionStorage.setItem(key, JSON.stringify(selectCachedWorkspaceEvents(events, limit)));
        return;
      } catch {
        // Try a smaller retained window before giving up.
      }
    }
  } catch {
    // Losing the UI-side cache should never break the live session itself.
  }
}

function promptPanelTitle(prompt: InteractiveToolPrompt, t: (key: string) => string) {
  switch (prompt.prompt_type) {
    case 'ask_user_question':
      return t('workspace.nativeInputNeeded');
    case 'plan_exit':
      return t('workspace.nativePlanReviewNeeded');
    case 'plan_entry':
      return t('workspace.nativePlanModeActive');
    default:
      return t('workspace.nativeInputNeeded');
  }
}

function promptPanelBody(prompt: InteractiveToolPrompt): string[] {
  switch (prompt.prompt_type) {
    case 'ask_user_question': {
      const firstQuestion = prompt.questions[0];
      if (!firstQuestion) {
        return [];
      }
      return [
        firstQuestion.header?.trim(),
        firstQuestion.question.trim(),
      ].filter((value): value is string => Boolean(value));
    }
    case 'plan_exit':
      return prompt.plan_summary?.trim()
        ? prompt.plan_summary
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
        : [];
    case 'plan_entry':
      return [];
    default:
      return [];
  }
}

function promptQuickReplies(prompt: InteractiveToolPrompt): string[] {
  switch (prompt.prompt_type) {
    case 'ask_user_question': {
      const firstQuestion = prompt.questions[0];
      if (!firstQuestion) {
        return [];
      }
      return firstQuestion.options
        .map((option) => option.preview?.trim() || option.label.trim())
        .filter(Boolean);
    }
    case 'plan_exit': {
      const reply = getPlanExitPrimaryReply(prompt);
      return reply ? [reply] : [];
    }
    default:
      return [];
  }
}

function isSyntheticPlanExitPrompt(prompt: InteractiveToolPrompt) {
  return prompt.prompt_type === 'plan_exit'
    && /^Claude is ready to run\b/.test((prompt.plan_summary ?? '').trim());
}

function isPlanExitApprovalText(text: string, quickReplies: string[]) {
  const normalizedText = text.trim().toLocaleLowerCase();
  if (!normalizedText) {
    return false;
  }

  if (quickReplies.some((reply) => reply.trim().toLocaleLowerCase() === normalizedText)) {
    return true;
  }

  return new Set([
    'ok',
    'okay',
    'yes',
    'y',
    'approve',
    'approved',
    'continue',
    'execute',
    'go',
    'proceed',
    '同意',
    '通过',
    '批准',
    '确认',
    '继续',
    '继续执行',
    '执行',
    '开始执行',
  ]).has(normalizedText);
}

function questionDisplayLabel(question: {
  header?: string | null;
  question: string;
}) {
  return question.header?.trim() || question.question.trim();
}

function createEmptyPromptAnswer(): InteractivePromptAnswer {
  return {
    selectedOptions: [],
    customSelected: false,
    customText: '',
  };
}

function getPromptAnswerState(
  question: ToolQuestionPrompt,
  answer?: InteractivePromptAnswer | null,
) {
  const selectedLabels = new Set(answer?.selectedOptions ?? []);
  const selectedOptions = question.options.filter((option) => selectedLabels.has(option.label));
  const trimmedCustomText = answer?.customText.trim() ?? '';

  return {
    selectedOptions,
    selectedLabels: selectedOptions.map((option) => option.label),
    selectedPreviews: selectedOptions
      .map((option) => option.preview?.trim())
      .filter((value): value is string => Boolean(value)),
    customSelected: Boolean(answer?.customSelected),
    customText: answer?.customText ?? '',
    trimmedCustomText,
  };
}

function questionHasPromptAnswer(
  question: ToolQuestionPrompt,
  answer?: InteractivePromptAnswer | null,
) {
  const answerState = getPromptAnswerState(question, answer);
  if (answerState.customSelected && !answerState.trimmedCustomText) {
    return false;
  }

  return answerState.selectedLabels.length > 0 || answerState.customSelected;
}

function buildAskUserQuestionResponse(
  questions: ToolQuestionPrompt[],
  answers: Record<number, InteractivePromptAnswer>,
) {
  const collectedAnswers: Record<string, string> = {};
  const annotations: Record<string, InteractivePromptAnnotation> = {};
  const summaryLines: string[] = [];

  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    const answerState = getPromptAnswerState(question, answer);
    if (!questionHasPromptAnswer(question, answer)) {
      return null;
    }

    const answerParts = [...answerState.selectedLabels];
    if (answerState.customSelected && answerState.trimmedCustomText) {
      answerParts.push(answerState.trimmedCustomText);
    }
    const answerValue = answerParts.join(', ');
    collectedAnswers[question.question] = answerValue;
    summaryLines.push(
      questions.length === 1
        ? answerValue
        : `${index + 1}. ${questionDisplayLabel(question)}: ${answerValue}`,
    );

    const preview = answerState.selectedPreviews.join('\n\n').trim();
    const notes = answerState.customSelected ? answerState.trimmedCustomText : undefined;

    if (preview || notes) {
      annotations[question.question] = {
        ...(preview ? { preview } : {}),
        ...(notes ? { notes } : {}),
      };
    }
  }

  return {
    text: summaryLines.join('\n'),
    answers: collectedAnswers,
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
  };
}

function WorkspaceAttentionPanel({
  provider,
  attentionState,
  respondingRequestId,
  isSubmittingPrompt,
  onPermission,
  onSubmitPromptReply,
}: {
  provider: string;
  attentionState: NativeSessionAttentionState;
  respondingRequestId: string | null;
  isSubmittingPrompt: boolean;
  onPermission: (requestId: string, approved: boolean) => void;
  onSubmitPromptReply: (payload: InteractivePromptReplyPayload) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [promptStates, setPromptStates] = useState<Record<string, InteractivePromptState>>({});
  const [collapsedPromptIds, setCollapsedPromptIds] = useState<Set<string>>(new Set());
  const attentionPanelRef = useRef<HTMLDivElement | null>(null);
  const attentionMotionKey = useMemo(() => [
    attentionState.permissions.map((request) => request.requestId).join('|'),
    attentionState.prompts.map((prompt) => prompt.toolUseId).join('|'),
    attentionState.terminalPrompt ? 'terminal' : 'no-terminal',
  ].join('::'), [attentionState.permissions, attentionState.prompts, attentionState.terminalPrompt]);

  useEffect(() => {
    const activePromptIds = new Set(attentionState.prompts.map((prompt) => prompt.toolUseId));
    setPromptStates((previous) => {
      const nextEntries = Object.entries(previous)
        .filter(([toolUseId]) => activePromptIds.has(toolUseId));

      if (
        nextEntries.length === Object.keys(previous).length
        && nextEntries.every(([toolUseId]) => toolUseId in previous)
      ) {
        return previous;
      }

      return Object.fromEntries(nextEntries);
    });
    setCollapsedPromptIds((previous) => {
      let changed = false;
      const next = new Set<string>();
      previous.forEach((toolUseId) => {
        if (activePromptIds.has(toolUseId)) {
          next.add(toolUseId);
        } else {
          changed = true;
        }
      });
      return changed || next.size !== previous.size ? next : previous;
    });
  }, [attentionState.prompts]);

  const togglePromptCollapsed = useCallback((toolUseId: string) => {
    setCollapsedPromptIds((previous) => {
      const next = new Set(previous);
      if (next.has(toolUseId)) {
        next.delete(toolUseId);
      } else {
        next.add(toolUseId);
      }
      return next;
    });
  }, []);

  useGSAP(() => {
    const panel = attentionPanelRef.current;
    if (!panel) {
      return;
    }

    const cards = gsap.utils.toArray<HTMLElement>('[data-native-attention-card]', panel);
    if (cards.length === 0) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(cards);
      return;
    }

    gsap.fromTo(
      cards,
      { autoAlpha: 0, y: 8, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        stagger: 0.035,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [attentionMotionKey], scope: attentionPanelRef });

  const updatePromptState = useCallback((
    toolUseId: string,
    updater: (current: InteractivePromptState) => InteractivePromptState,
  ) => {
    setPromptStates((previous) => {
      const current = previous[toolUseId] ?? {
        currentQuestionIndex: 0,
        answers: {},
      };

      return {
        ...previous,
        [toolUseId]: updater(current),
      };
    });
  }, []);

  if (
    attentionState.permissions.length === 0
    && attentionState.prompts.length === 0
    && !attentionState.terminalPrompt
  ) {
    return null;
  }

  return (
    <div ref={attentionPanelRef} className="space-y-2">
      {attentionState.permissions.map((request) => (
        <div
          key={request.requestId}
          data-native-attention-card
          className="flex items-center gap-2.5 rounded-xl bg-muted/35 px-3 py-2.5 transition-colors duration-300"
        >
          <div className="rounded-md bg-muted/60 p-1.5">
            <ShieldAlert className="h-4 w-4 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-snug text-foreground">
              {t('workspace.nativeApprovalNeeded')}
            </p>
            <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
              {request.toolName}
            </p>
            {request.inputSummary ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/80">
                {request.inputSummary}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-lg border-border/60 px-3 text-[12px] font-medium hover:bg-background/80"
              disabled={respondingRequestId === request.requestId}
              onClick={() => onPermission(request.requestId, false)}
            >
              {t('sessions.headlessDeny')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 rounded-lg px-3 text-[12px] font-medium shadow-sm"
              disabled={respondingRequestId === request.requestId}
              onClick={() => onPermission(request.requestId, true)}
            >
              {t('sessions.headlessApprove')}
            </Button>
          </div>
        </div>
      ))}

      {attentionState.prompts.map((entry) => {
        const bodyLines = promptPanelBody(entry.prompt);
        const quickReplies = promptQuickReplies(entry.prompt);
        const questionPrompt = entry.prompt.prompt_type === 'ask_user_question'
          ? entry.prompt
          : null;
        const isPlanExitPrompt = entry.prompt.prompt_type === 'plan_exit';
        const primaryPlanExitReply = getPlanExitPrimaryReply(entry.prompt);

        if (questionPrompt?.questions.length) {
          const providerName = providerDisplayName(provider);
          const customOptionLabel = t('workspace.nativePromptAdjust')
            .replace('{provider}', providerName);
          const promptState = promptStates[entry.toolUseId] ?? {
            currentQuestionIndex: 0,
            answers: {},
          };
          const questionIndex = Math.min(
            promptState.currentQuestionIndex,
            questionPrompt.questions.length - 1,
          );
          const currentQuestion = questionPrompt.questions[questionIndex]!;
          const currentAnswer = promptState.answers[questionIndex];
          const currentAnswerState = getPromptAnswerState(currentQuestion, currentAnswer);
          const questionOptions = [
            ...currentQuestion.options.map((option) => ({
              ...option,
              optionKind: 'option' as const,
            })),
            {
              label: customOptionLabel,
              description: t('workspace.nativePromptAdjustHint'),
              preview: undefined,
              optionKind: 'custom' as const,
            },
          ];
          const selectedPreview = currentAnswerState.selectedPreviews.join('\n\n').trim();
          const selectedSummary = [
            ...currentAnswerState.selectedLabels,
            ...(currentAnswerState.customSelected && currentAnswerState.trimmedCustomText
              ? [currentAnswerState.trimmedCustomText]
              : []),
          ].join(', ');
          const selectedCount = currentAnswerState.selectedLabels.length
            + (currentAnswerState.customSelected && currentAnswerState.trimmedCustomText ? 1 : 0);
          const isLastQuestion = questionIndex === questionPrompt.questions.length - 1;
          const canAdvance = isLastQuestion
            ? questionPrompt.questions.every((question, index) =>
              questionHasPromptAnswer(question, promptState.answers[index]))
            : questionHasPromptAnswer(currentQuestion, currentAnswer);
          const progressLabel = t('workspace.nativePromptProgress')
            .replace('{current}', String(questionIndex + 1))
            .replace('{total}', String(questionPrompt.questions.length));

          const isCollapsed = collapsedPromptIds.has(entry.toolUseId);
          const collapseToggleLabel = isCollapsed
            ? t('workspace.nativePromptExpand')
            : t('workspace.nativePromptCollapse');

          return (
            <div
              key={entry.toolUseId}
              data-native-attention-card
              data-collapsed={isCollapsed ? 'true' : 'false'}
              className={cn(
                'rounded-xl bg-muted/30 px-3.5 transition-[padding] duration-200',
                isCollapsed ? 'py-2' : 'py-3',
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md text-left outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring/30"
                  aria-expanded={!isCollapsed}
                  aria-controls={`ask-user-body-${entry.toolUseId}`}
                  onClick={() => togglePromptCollapsed(entry.toolUseId)}
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80">
                    <span>{progressLabel}</span>
                    {currentQuestion.header ? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                        <span className="truncate text-muted-foreground/85">
                          {currentQuestion.header}
                        </span>
                      </>
                    ) : null}
                    {isCollapsed && selectedCount > 0 ? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                        <span className="truncate text-muted-foreground/75">
                          {t('workspace.nativePromptSelectedCount').replace('{count}', String(selectedCount))}
                        </span>
                      </>
                    ) : null}
                  </div>
                  <h3 className={cn(
                    'mt-1 text-[14px] font-semibold leading-snug text-foreground',
                    isCollapsed && 'line-clamp-2',
                  )}>
                    {currentQuestion.question}
                  </h3>
                  {!isCollapsed && currentQuestion.multiSelect ? (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
                      {t('workspace.nativePromptMultiSelectHint')}
                    </p>
                  ) : null}
                  {!isCollapsed && currentQuestion.multiSelect && selectedCount > 0 ? (
                    <p className="mt-1 text-[11px] font-medium text-muted-foreground/75">
                      {t('workspace.nativePromptSelectedCount').replace('{count}', String(selectedCount))}
                    </p>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
                    {entry.rawName}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    aria-label={collapseToggleLabel}
                    title={collapseToggleLabel}
                    aria-expanded={!isCollapsed}
                    aria-controls={`ask-user-body-${entry.toolUseId}`}
                    onClick={() => togglePromptCollapsed(entry.toolUseId)}
                  >
                    {isCollapsed ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronUp className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {!isCollapsed ? (
                <div id={`ask-user-body-${entry.toolUseId}`}>
                  {selectedSummary || selectedPreview ? (
                    <div className="mt-2.5 rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {selectedSummary ? (
                        <p className="whitespace-pre-wrap text-foreground/90">
                          {selectedSummary}
                        </p>
                      ) : null}
                      {selectedPreview ? (
                        <p className={cn(
                          'whitespace-pre-wrap',
                          selectedSummary ? 'mt-1 text-muted-foreground' : 'text-muted-foreground',
                        )}>
                          {selectedPreview.split('\n').slice(0, 6).join('\n')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-2.5 space-y-1">
                    {questionOptions.map((option, index) => {
                      const isSelected = option.optionKind === 'custom'
                        ? currentAnswerState.customSelected
                        : currentAnswerState.selectedLabels.includes(option.label);
                      return (
                        <button
                          key={`${entry.toolUseId}-${option.label}`}
                          type="button"
                          className={cn(
                            'group relative w-full rounded-lg px-3 py-2 text-left transition-all',
                            isSelected
                              ? 'bg-muted/60'
                              : 'bg-muted/20 hover:bg-muted/40',
                          )}
                          onClick={() => {
                            const emptyAnswer = createEmptyPromptAnswer();
                            updatePromptState(entry.toolUseId, (current) => ({
                              ...current,
                              answers: {
                                ...current.answers,
                                [questionIndex]: (() => {
                                  const answerForQuestion = current.answers[questionIndex] ?? emptyAnswer;
                                  if (option.optionKind === 'custom') {
                                    return currentQuestion.multiSelect
                                      ? {
                                        ...answerForQuestion,
                                        customSelected: !answerForQuestion.customSelected,
                                      }
                                      : {
                                        ...answerForQuestion,
                                        selectedOptions: [],
                                        customSelected: true,
                                      };
                                  }

                                  if (!currentQuestion.multiSelect) {
                                    return {
                                      ...answerForQuestion,
                                      selectedOptions: [option.label],
                                      customSelected: false,
                                    };
                                  }

                                  const nextSelectedOptions = answerForQuestion.selectedOptions.includes(option.label)
                                    ? answerForQuestion.selectedOptions.filter((value) => value !== option.label)
                                    : [...answerForQuestion.selectedOptions, option.label];

                                  return {
                                    ...answerForQuestion,
                                    selectedOptions: nextSelectedOptions,
                                  };
                                })(),
                              },
                            }));
                          }}
                        >
                          <div className="flex items-start gap-2.5">
                            <span className={cn(
                              'mt-0.5 flex h-4 w-4 items-center justify-center rounded border text-[10px] transition-colors',
                              isSelected
                                ? 'border-foreground/60 bg-foreground/10 text-foreground'
                                : 'border-border/70 text-muted-foreground/60',
                            )}>
                              {isSelected ? <Check className="h-3 w-3" /> : index + 1}
                            </span>
                            <div className="flex-1">
                              <p className="text-[13px] leading-relaxed text-foreground">
                                {option.label}
                              </p>
                              {option.description ? (
                                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/75">
                                  {option.description}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {currentAnswerState.customSelected ? (
                    <div className="mt-2.5 space-y-1">
                      <label
                        htmlFor={`ask-user-custom-${entry.toolUseId}-${questionIndex}`}
                        className="text-[11px] font-medium text-muted-foreground/80"
                      >
                        {t('workspace.nativePromptCustomLabel')}
                      </label>
                      <textarea
                        id={`ask-user-custom-${entry.toolUseId}-${questionIndex}`}
                        value={currentAnswerState.customText}
                        onChange={(event) => {
                          const value = event.target.value;
                          updatePromptState(entry.toolUseId, (current) => ({
                            ...current,
                            answers: {
                              ...current.answers,
                              [questionIndex]: {
                                ...(current.answers[questionIndex] ?? createEmptyPromptAnswer()),
                                customSelected: true,
                                customText: value,
                              },
                            },
                          }));
                        }}
                        rows={3}
                        placeholder={t('workspace.nativePromptCustomPlaceholder')}
                        className="min-h-[80px] w-full resize-y rounded-lg border border-border/60 bg-background/70 px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                      />
                    </div>
                  ) : null}

                  <div className="mt-2.5 flex items-center justify-end gap-1.5">
                    {questionIndex > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 px-3 text-[12px]"
                        disabled={isSubmittingPrompt}
                        onClick={() => {
                          updatePromptState(entry.toolUseId, (current) => ({
                            ...current,
                            currentQuestionIndex: Math.max(0, current.currentQuestionIndex - 1),
                          }));
                        }}
                      >
                        {t('workspace.nativePromptBack')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      className="h-7 rounded-lg bg-foreground px-3.5 text-[12px] font-medium text-background hover:bg-foreground/90"
                      disabled={!canAdvance || isSubmittingPrompt}
                      onClick={async () => {
                        if (!canAdvance) {
                          return;
                        }

                        if (!isLastQuestion) {
                          updatePromptState(entry.toolUseId, (current) => ({
                            ...current,
                            currentQuestionIndex: Math.min(
                              questionPrompt.questions.length - 1,
                              current.currentQuestionIndex + 1,
                            ),
                          }));
                          return;
                        }

                        const reply = buildAskUserQuestionResponse(
                          questionPrompt.questions,
                          promptState.answers,
                        );
                        if (!reply) {
                          return;
                        }

                        await onSubmitPromptReply({
                          kind: 'ask_user_question',
                          toolUseId: entry.toolUseId,
                          text: reply.text,
                          answers: reply.answers,
                          annotations: reply.annotations,
                        });
                      }}
                    >
                      {isLastQuestion ? t('common.submit') : t('workspace.nativePromptContinue')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        }

        const Icon = isPlanExitPrompt ? ClipboardList : MessageSquareQuote;

        return (
          <div
            key={entry.toolUseId}
            data-native-attention-card
            className="rounded-xl bg-surface-raised/60 px-3 py-2.5 backdrop-blur-sm"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-muted/60 p-1">
                <Icon className="h-3 w-3 text-muted-foreground" />
              </div>
              <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                {promptPanelTitle(entry.prompt, t)}
              </p>
              {primaryPlanExitReply ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 shrink-0 rounded-lg px-3 text-[12px] font-medium shadow-sm"
                  disabled={isSubmittingPrompt}
                  onClick={() => {
                    void onSubmitPromptReply({
                      kind: 'plan_exit',
                      toolUseId: entry.toolUseId,
                      text: primaryPlanExitReply,
                      approved: true,
                    });
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{primaryPlanExitReply}</span>
                </Button>
              ) : null}
              <span className="shrink-0 rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
                {entry.rawName}
              </span>
            </div>
            {bodyLines.length > 0 ? (
              <div className="mt-1.5 space-y-1 text-[12px] leading-relaxed text-foreground/90">
                {bodyLines.map((line, index) => (
                  <p key={`${entry.toolUseId}-line-${index}`}>{line}</p>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-muted-foreground/75">
                {t('workspace.nativeReplyHint')}
              </p>
            )}
            {quickReplies.length > 0 && !primaryPlanExitReply ? (
              <div className={cn(
                'mt-2 flex flex-wrap gap-1.5',
                isPlanExitPrompt && 'justify-end'
              )}>
                {quickReplies.map((reply) => (
                  <Button
                    key={`${entry.toolUseId}-${reply}`}
                    type="button"
                    size="sm"
                    variant={isPlanExitPrompt ? 'default' : 'outline'}
                    className={cn(
                      'h-7 rounded-lg px-3 text-[12px]',
                      isPlanExitPrompt
                        ? 'min-w-24 gap-1.5 shadow-sm'
                        : 'border-border/60 hover:bg-muted/50'
                    )}
                    disabled={isSubmittingPrompt}
                    onClick={() => {
                      if (isPlanExitPrompt && !isSyntheticPlanExitPrompt(entry.prompt)) {
                        void onSubmitPromptReply({
                          kind: 'plan_exit',
                          toolUseId: entry.toolUseId,
                          text: reply,
                          approved: true,
                        });
                        return;
                      }

                      void onSubmitPromptReply({
                        kind: 'text',
                        text: reply,
                      });
                    }}
                  >
                    {isPlanExitPrompt ? <Check className="h-3.5 w-3.5" /> : null}
                    <span>{reply}</span>
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {attentionState.terminalPrompt ? (
        <div data-native-attention-card className="rounded-xl bg-surface-raised/60 px-3 py-2.5 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-muted/60 p-1">
              <Terminal className="h-3 w-3 text-muted-foreground" />
            </div>
            <p className="text-[12px] font-semibold text-foreground">
              {t('workspace.nativeTerminalPrompt')}
            </p>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">
            {attentionState.terminalPrompt.promptText}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceNativeSessionView({
  session,
  initialPrompt,
  initialImages,
  seedMessages = [],
  installedSkills = [],
  onRefreshSkills,
  workspaceCommands = [],
  isVisible = true,
  onSessionUpdate,
  onStartNew,
  codexInstalled = false,
  opencodeInstalled = false,
  onLaunchNewSession,
}: WorkspaceNativeSessionViewProps) {
  const { t } = useLocale();
  const environments = useAppStore((state) => state.environments);
  const enabledEnvironments = useAppStore((state) => state.enabledEnvironments);
  const defaultPermissionMode = useAppStore((state) => state.permissionMode);
  const {
    getNativeSessionEvents,
    sendNativeSessionInput,
    respondNativeSessionPermission,
    respondNativeSessionPrompt,
    rewindNativeSessionFiles,
    stopNativeSession,
    updateNativeSessionSettings,
    setNativeSessionRuntimePermMode,
    handoffNativeSessionToTerminal,
    getWorkspaceGitSnapshot,
    getWorkspaceFileDiff,
    getWorkspaceMediaPreview,
    getSessionSubagents,
    listNativeSessions,
    searchWorkspaceFiles,
  } = useTauriCommands();
  const [sessionEnv, setSessionEnv] = useState(session.env_name);
  const [sessionRuntimePermMode, setSessionRuntimePermMode] = useState(
    () => nativeSessionRuntimePermMode(session),
  );
  const [sessionDisplayPermMode, setSessionDisplayPermMode] = useState(
    () => normalizePermissionModeName(session.perm_mode, defaultPermissionMode),
  );
  const sessionPermMode = sessionDisplayPermMode;
  const [sessionEffort, setSessionEffort] = useState<EffortLevel>(
    () => normalizeEffortForProvider(session.effort, session.provider),
  );
  const composerTextRef = useRef('');
  const composerHasDraftRef = useRef(false);
  const pendingEnvironmentUpdateRef = useRef<Promise<boolean> | null>(null);
  const environmentUpdateRequestSeqRef = useRef(0);
  const [composerDraftRevision, setComposerDraftRevision] = useState(0);
  const [composerHasDraft, setComposerHasDraft] = useState(false);
  const sessionAnnotations = useWorkspaceAnnotations(`live:${session.runtime_id}`);
  const [composerPlanModeEnabled, setComposerPlanModeEnabled] = useState(
    () => isNativeSessionPlanRuntime(session),
  );
  const [events, setEvents] = useState<SessionEventRecord[]>(() =>
    readCachedNativeEvents(session.runtime_id),
  );
  const [localUserPrompts, setLocalUserPrompts] = useState<LocalUserPrompt[]>(() => {
    if (!initialPrompt) {
      return [];
    }

    return [{
      id: 'initial-user',
      text: initialPrompt,
      images: initialImages ?? undefined,
    }];
  });
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isHandingOff, setIsHandingOff] = useState(false);
  const [isWecomBindDialogOpen, setIsWecomBindDialogOpen] = useState(false);
  const [isExternalActionsOpen, setIsExternalActionsOpen] = useState(false);
  const [isFileRestoreMenuOpen, setIsFileRestoreMenuOpen] = useState(false);
  const [selectedFileCheckpoint, setSelectedFileCheckpoint] = useState<NativeFileCheckpoint | null>(null);
  const [isRestoreDialogOpen, setIsRestoreDialogOpen] = useState(false);
  const [isRewindingFiles, setIsRewindingFiles] = useState(false);
  const reviewPanelOpen = useAppStore((state) => state.reviewPanelOpen);
  const setReviewPanelOpen = useAppStore((state) => state.setReviewPanelOpen);
  const setReviewEntry = useAppStore((state) => state.setReviewEntry);
  const isReviewPopoverOpen = isVisible && reviewPanelOpen;
  const [gitSnapshot, setGitSnapshot] = useState<WorkspaceGitSnapshot | null>(null);
  const [isRefreshingGitSnapshot, setIsRefreshingGitSnapshot] = useState(false);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [locallyDismissedPromptIds, setLocallyDismissedPromptIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [queuedState, setQueuedState] = useState<QueuedGuidanceState>(() => ({
    runtimeId: session.runtime_id,
    messages: readStoredGuidanceQueue(session.runtime_id),
  }));
  const queuedMessages = queuedState.runtimeId === session.runtime_id ? queuedState.messages : [];
  const setQueuedMessages = useCallback((update: QueuedGuidanceMessagesUpdate) => {
    setQueuedState((previousState) => {
      const previousMessages = previousState.runtimeId === session.runtime_id
        ? previousState.messages
        : readStoredGuidanceQueue(session.runtime_id);

      return {
        runtimeId: session.runtime_id,
        messages: resolveGuidanceMessagesUpdate(update, previousMessages),
      };
    });
  }, [session.runtime_id]);
  const isHandoffPending = session.status === 'handoff_pending';
  const lastSeenSeqRef = useRef<number | null>(latestEventSeq(events));
  const latestEventsRef = useRef<SessionEventRecord[]>(events);
  const previousMessagesRef = useRef<ConversationMessageData[]>([]);
  const cacheFlushTimerRef = useRef<number | null>(null);
  const cacheFlushIdleCancelRef = useRef<(() => void) | null>(null);
  const cacheFlushPendingRef = useRef(false);
  const lastSummaryRefreshTimestampRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const autoScrollDetachedRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollSettleTimeoutRef = useRef<number | null>(null);
  const externalActionsCloseTimerRef = useRef<number | null>(null);
  const fileRestorePointerToggleRef = useRef(false);
  const fileRewindTimeoutRef = useRef<number | null>(null);
  const pendingRewindCheckpointIdRef = useRef<string | null>(null);
  const pendingRewindStartSeqRef = useRef(0);
  const prevEventCountRef = useRef(0);
  const tickInFlightRef = useRef(false);
  const initialReplayRuntimeRef = useRef<string | null>(null);
  const initialReplayBackfillRuntimeRef = useRef<string | null>(null);
  const gitSnapshotRequestSeqRef = useRef(0);

  const handleComposerTextChange = useCallback((value: string) => {
    composerTextRef.current = value;
    const hasDraft = value.trim().length > 0;
    if (composerHasDraftRef.current !== hasDraft) {
      composerHasDraftRef.current = hasDraft;
      setComposerHasDraft(hasDraft);
    }
  }, []);

  const clearComposerDraft = useCallback(() => {
    handleComposerTextChange('');
    setComposerDraftRevision((revision) => revision + 1);
  }, [handleComposerTextChange]);

  const sessionUsage = useMemo(() => computeSessionUsage(events), [events]);
  const fileCheckpoints = useMemo(() => deriveNativeFileCheckpoints(events), [events]);

  const clearFileRewindTimeout = useCallback(() => {
    if (fileRewindTimeoutRef.current !== null) {
      window.clearTimeout(fileRewindTimeoutRef.current);
      fileRewindTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearFileRewindTimeout, [clearFileRewindTimeout]);

  useEffect(() => {
    if (!selectedFileCheckpoint) {
      return;
    }

    const nextSelected = fileCheckpoints.find(
      (checkpoint) => checkpoint.checkpointId === selectedFileCheckpoint.checkpointId,
    );
    if (nextSelected) {
      setSelectedFileCheckpoint(nextSelected);
      return;
    }

    setSelectedFileCheckpoint(null);
    setIsRestoreDialogOpen(false);
  }, [fileCheckpoints, selectedFileCheckpoint]);

  const clearExternalActionsCloseTimer = useCallback(() => {
    if (externalActionsCloseTimerRef.current !== null) {
      window.clearTimeout(externalActionsCloseTimerRef.current);
      externalActionsCloseTimerRef.current = null;
    }
  }, []);

  const openExternalActionsMenu = useCallback(() => {
    clearExternalActionsCloseTimer();
    setIsExternalActionsOpen(true);
  }, [clearExternalActionsCloseTimer]);

  const closeExternalActionsMenu = useCallback(() => {
    clearExternalActionsCloseTimer();
    setIsExternalActionsOpen(false);
  }, [clearExternalActionsCloseTimer]);

  const scheduleExternalActionsClose = useCallback(() => {
    clearExternalActionsCloseTimer();
    externalActionsCloseTimerRef.current = window.setTimeout(() => {
      closeExternalActionsMenu();
    }, 180);
  }, [clearExternalActionsCloseTimer, closeExternalActionsMenu]);

  const handleExternalActionsOpenChange = useCallback((open: boolean) => {
    if (open) {
      openExternalActionsMenu();
      return;
    }

    closeExternalActionsMenu();
  }, [closeExternalActionsMenu, openExternalActionsMenu]);

  useEffect(() => {
    return () => {
      clearExternalActionsCloseTimer();
    };
  }, [clearExternalActionsCloseTimer]);

  const refreshGitSnapshot = useCallback(async () => {
    const requestSeq = gitSnapshotRequestSeqRef.current + 1;
    gitSnapshotRequestSeqRef.current = requestSeq;
    const projectDir = session.project_dir;

    if (!projectDir) {
      setGitSnapshot(null);
      return;
    }

    setIsRefreshingGitSnapshot(true);
    try {
      const snapshot = await getWorkspaceGitSnapshot(projectDir);
      if (gitSnapshotRequestSeqRef.current === requestSeq) {
        setGitSnapshot(snapshot);
      }
    } catch (error) {
      if (gitSnapshotRequestSeqRef.current === requestSeq) {
        setGitSnapshot({
          is_repo: false,
          root: null,
          branch: null,
          sha: null,
          upstream: null,
          dirty_count: 0,
          files: [],
          error: String(error),
        });
      }
    } finally {
      if (gitSnapshotRequestSeqRef.current === requestSeq) {
        setIsRefreshingGitSnapshot(false);
      }
    }
  }, [getWorkspaceGitSnapshot, session.project_dir]);

  useEffect(() => {
    const cachedEvents = readCachedNativeEvents(session.runtime_id);
    const initialPrompts = initialPrompt
      ? [{ id: 'initial-user', text: initialPrompt, images: initialImages ?? undefined }]
      : [];

    lastSeenSeqRef.current = latestEventSeq(cachedEvents);
    latestEventsRef.current = cachedEvents;
    previousMessagesRef.current = [];
    initialReplayBackfillRuntimeRef.current = null;
    autoScrollDetachedRef.current = false;
    prevEventCountRef.current = 0;
    setEvents(cachedEvents);
    clearComposerDraft();
    setComposerPlanModeEnabled(isNativeSessionPlanRuntime(session));
    setQueuedMessages([]);
    setLocalUserPrompts(initialPrompts);
    setLocallyDismissedPromptIds(new Set());
    setSelectedFileCheckpoint(null);
    setIsRestoreDialogOpen(false);
    setIsRewindingFiles(false);
    clearFileRewindTimeout();
    pendingRewindCheckpointIdRef.current = null;
    pendingRewindStartSeqRef.current = 0;
    setReviewPanelOpen(false);
    gitSnapshotRequestSeqRef.current += 1;
    setGitSnapshot(null);
    setIsRefreshingGitSnapshot(false);
  }, [clearComposerDraft, clearFileRewindTimeout, initialImages, initialPrompt, session.runtime_id]);

  useEffect(() => {
    environmentUpdateRequestSeqRef.current += 1;
    pendingEnvironmentUpdateRef.current = null;
    initialReplayRuntimeRef.current = null;
  }, [session.runtime_id]);

  useEffect(() => {
    gitSnapshotRequestSeqRef.current += 1;
    setGitSnapshot(null);
    setIsRefreshingGitSnapshot(false);
  }, [session.project_dir]);

  useEffect(() => {
    setSessionEnv(session.env_name);
    setSessionRuntimePermMode(nativeSessionRuntimePermMode(session));
    setSessionDisplayPermMode(normalizePermissionModeName(session.perm_mode, defaultPermissionMode));
    setSessionEffort(normalizeEffortForProvider(session.effort, session.provider));
  }, [
    defaultPermissionMode,
    session.effort,
    session.env_name,
    session.perm_mode,
    session.provider,
    session.runtime_id,
    session.runtime_perm_mode,
  ]);

  const unconfirmedLocalUserPrompts = useMemo(
    () => filterConfirmedLocalUserPrompts(localUserPrompts, events),
    [events, localUserPrompts],
  );

  const replayLocalPrompts = useMemo(
    () => splitLocalUserPromptsForReplay(unconfirmedLocalUserPrompts),
    [unconfirmedLocalUserPrompts],
  );

  const rawMessages = useMemo(
    () => buildMessagesFromEvents(
      buildBaseMessages(seedMessages, replayLocalPrompts.initialPrompt),
      replayLocalPrompts.remainingPrompts,
      events,
      session.status === 'error' ? session.last_error : null,
    ),
    [events, replayLocalPrompts, seedMessages, session.last_error, session.status],
  );

  const messages = useMemo(
    () => stabilizeMessageRefs(rawMessages, previousMessagesRef.current),
    [rawMessages],
  );

  const reviewSummary = useMemo(
    () => buildWorkspaceReviewSummary({
      events,
      gitSnapshot,
    }),
    [events, gitSnapshot],
  );
  const reviewModel = useMemo(
    () => {
      if (!isReviewPopoverOpen) {
        return null;
      }

      return buildWorkspaceReviewModel({
        session,
        events,
        messages,
        gitSnapshot,
      });
    },
    [events, gitSnapshot, isReviewPopoverOpen, messages, session],
  );

  // Publish review summary to the status-strip entry pill while this live session owns the view.
  useEffect(() => {
    if (!isVisible) {
      return;
    }
    setReviewEntry({
      envName: session.env_name,
      failedTools: reviewSummary.failedTools,
      changedFiles: reviewSummary.changedFiles,
      artifacts: reviewSummary.artifacts,
    });
  }, [
    isVisible,
    session.env_name,
    reviewSummary.failedTools,
    reviewSummary.changedFiles,
    reviewSummary.artifacts,
    setReviewEntry,
  ]);

  useEffect(() => {
    previousMessagesRef.current = messages;
  }, [messages]);

  const flushCachedEvents = useCallback((options: { immediate?: boolean } = {}) => {
    cacheFlushPendingRef.current = false;
    if (cacheFlushIdleCancelRef.current) {
      cacheFlushIdleCancelRef.current();
      cacheFlushIdleCancelRef.current = null;
    }

    const write = () => {
      writeCachedNativeEvents(session.runtime_id, latestEventsRef.current);
    };

    if (options.immediate) {
      write();
      return;
    }

    cacheFlushIdleCancelRef.current = scheduleAfterFirstPaint(() => {
      cacheFlushIdleCancelRef.current = null;
      write();
    }, { delayMs: 0, timeoutMs: 800 });
  }, [session.runtime_id]);

  const scheduleCacheFlush = useCallback(() => {
    cacheFlushPendingRef.current = true;
    if (cacheFlushTimerRef.current !== null) {
      return;
    }

    cacheFlushTimerRef.current = window.setTimeout(() => {
      cacheFlushTimerRef.current = null;
      if (cacheFlushPendingRef.current) {
        flushCachedEvents();
      }
    }, CACHE_FLUSH_INTERVAL_MS);
  }, [flushCachedEvents]);

  useEffect(() => {
    latestEventsRef.current = events;
    if (events.length > 0) {
      scheduleCacheFlush();
    }
  }, [events, scheduleCacheFlush]);

  useEffect(() => () => {
    if (cacheFlushTimerRef.current !== null) {
      window.clearTimeout(cacheFlushTimerRef.current);
      cacheFlushTimerRef.current = null;
    }
    if (cacheFlushIdleCancelRef.current) {
      cacheFlushIdleCancelRef.current();
      cacheFlushIdleCancelRef.current = null;
    }
    if (latestEventsRef.current.length > 0) {
      flushCachedEvents({ immediate: true });
    }
  }, [flushCachedEvents]);

  useEffect(() => {
    if (isTerminalStatus(session.status) && latestEventsRef.current.length > 0) {
      flushCachedEvents({ immediate: true });
    }
  }, [flushCachedEvents, session.status]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const delay = isReviewPopoverOpen ? 250 : 1200;
    const timeoutId = window.setTimeout(() => {
      void refreshGitSnapshot();
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    events.length,
    isReviewPopoverOpen,
    isVisible,
    refreshGitSnapshot,
    session.status,
  ]);

  const refreshSummary = useCallback(async (options: { force?: boolean } = {}) => {
    const now = Date.now();
    if (!options.force && now - lastSummaryRefreshTimestampRef.current < SUMMARY_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastSummaryRefreshTimestampRef.current = now;
    const sessions = await listNativeSessions();
    const next = sessions.find(
      (candidate) => candidate.runtime_id === session.runtime_id,
    );
    if (next) {
      onSessionUpdate(next);
    }
  }, [listNativeSessions, onSessionUpdate, session.runtime_id]);

  const backfillInitialReplay = useCallback(async () => {
    if (initialReplayBackfillRuntimeRef.current === session.runtime_id) {
      return;
    }
    initialReplayBackfillRuntimeRef.current = session.runtime_id;

    try {
      const fullBatch = await getNativeSessionEvents(session.runtime_id, null, null);
      if (!fullBatch.events.length) {
        return;
      }

      const fullBatchLatestSeq = latestEventSeq(fullBatch.events);
      if (fullBatchLatestSeq != null) {
        lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current ?? fullBatchLatestSeq, fullBatchLatestSeq);
      }

      startTransition(() => {
        setEvents((previous) => appendSessionEvents(fullBatch.events, previous));
      });

      if (sessionEventsNeedSummaryRefresh(fullBatch.events)) {
        await refreshSummary({ force: true });
      }
    } catch (error) {
      console.error('Failed to backfill native session transcript:', error);
    }
  }, [getNativeSessionEvents, refreshSummary, session.runtime_id]);

  const pollEvents = useCallback(async () => {
    const isInitialReplay = initialReplayRuntimeRef.current !== session.runtime_id;
    const sinceSeq = isInitialReplay ? null : lastSeenSeqRef.current;
    const batch = await getNativeSessionEvents(
      session.runtime_id,
      sinceSeq,
      isInitialReplay ? INITIAL_EVENT_REPLAY_LIMIT : null,
    );
    initialReplayRuntimeRef.current = session.runtime_id;
    if (!batch.events.length) {
      return false;
    }

    const batchLatestSeq = latestEventSeq(batch.events);
    if (batchLatestSeq != null) {
      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current ?? batchLatestSeq, batchLatestSeq);
    }
    const updateEvents = () => {
      setEvents((previous) => (
        isInitialReplay
          ? mergeWorkspaceReplayEvents(previous, batch.events)
          : appendSessionEvents(previous, batch.events, batch.gap_detected)
      ));
    };

    if (hasImmediateAttentionEvent(batch.events)) {
      updateEvents();
    } else {
      startTransition(updateEvents);
    }

    if (isInitialReplay && !replayBatchCoversAvailableSequenceRange(batch)) {
      void backfillInitialReplay();
    }

    return sessionEventsNeedSummaryRefresh(batch.events);
  }, [backfillInitialReplay, getNativeSessionEvents, session.runtime_id]);

  const rawAttentionState = useMemo(
    () => extractAttentionState(events),
    [events],
  );
  const attentionState = useMemo(() => {
    if (locallyDismissedPromptIds.size === 0) {
      return rawAttentionState;
    }

    const prompts = rawAttentionState.prompts.filter(
      (entry) => !locallyDismissedPromptIds.has(entry.toolUseId),
    );

    return {
      ...rawAttentionState,
      prompts,
    };
  }, [locallyDismissedPromptIds, rawAttentionState]);

  useEffect(() => {
    if (locallyDismissedPromptIds.size === 0) {
      return;
    }

    const activePromptIds = new Set(rawAttentionState.prompts.map((entry) => entry.toolUseId));
    setLocallyDismissedPromptIds((previous) => {
      const next = new Set(
        Array.from(previous).filter((toolUseId) => activePromptIds.has(toolUseId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [locallyDismissedPromptIds.size, rawAttentionState.prompts]);

  const pollIntervalMs = isSending
    || session.status === 'initializing'
    || session.status === 'processing'
    ? ACTIVE_POLL_INTERVAL_MS
    : isTerminalStatus(session.status)
      ? TERMINAL_POLL_INTERVAL_MS
      : IDLE_POLL_INTERVAL_MS;

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const scheduleNextTick = () => {
      if (cancelled) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        void tick();
      }, pollIntervalMs);
    };

    const tick = async () => {
      if (cancelled) {
        return;
      }

      if (tickInFlightRef.current) {
        scheduleNextTick();
        return;
      }

      tickInFlightRef.current = true;
      try {
        const forceSummary = await pollEvents();
        await refreshSummary({ force: forceSummary });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to poll native session:', error);
        }
      } finally {
        tickInFlightRef.current = false;
        scheduleNextTick();
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isVisible, pollEvents, pollIntervalMs, refreshSummary]);

  const cancelPendingAutoScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollSettleTimeoutRef.current);
      scrollSettleTimeoutRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  // Detect user scroll-away to suppress auto-scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      if (programmaticScrollRef.current) {
        return;
      }
      autoScrollDetachedRef.current = !isNearBottom(container);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        cancelPendingAutoScroll();
        autoScrollDetachedRef.current = true;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [cancelPendingAutoScroll, session.runtime_id]);

  // Clean up any pending scroll animation frame on unmount
  useEffect(() => () => {
    cancelPendingAutoScroll();
  }, [cancelPendingAutoScroll]);

  // Auto-scroll to bottom when new events arrive, unless the user has scrolled up.
  // We watch events.length (not messages.length) because streaming deltas grow
  // existing message content without increasing the message count.
  useLayoutEffect(() => {
    if (!isVisible || !containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const prevCount = prevEventCountRef.current;
    prevEventCountRef.current = events.length;

    // Nothing to scroll to
    if (messages.length === 0) {
      return;
    }

    // User scrolled up to read earlier content — don't yank the scrollbar
    if (autoScrollDetachedRef.current && prevCount > 0) {
      return;
    }

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollSettleTimeoutRef.current);
      scrollSettleTimeoutRef.current = null;
    }

    programmaticScrollRef.current = true;
    scrollToLatest(container);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollToLatest(container);
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollSettleTimeoutRef.current = window.setTimeout(() => {
          scrollToLatest(container);
          programmaticScrollRef.current = false;
          autoScrollDetachedRef.current = !isNearBottom(container);
          scrollSettleTimeoutRef.current = null;
        }, 120);
      });
    });
  }, [events.length, isVisible, messages.length]);

  const isProcessingTurn = shouldTreatNativeSessionAsProcessing(session.status, events);
  const isAwaitingResponse = isSending || isProcessingTurn;
  const hasAskUserQuestionPrompt = attentionState.prompts.some(
    (entry) => entry.prompt.prompt_type === 'ask_user_question',
  );
  const hasQuickReplyPrompt = attentionState.prompts.some(
    (entry) => entry.prompt.prompt_type !== 'ask_user_question',
  );
  const planExitPromptIds = useMemo(
    () => attentionState.prompts
      .filter((entry) => entry.prompt.prompt_type === 'plan_exit')
      .map((entry) => entry.toolUseId),
    [attentionState.prompts],
  );
  const planExitApprovalPrompt = useMemo(
    () => attentionState.prompts.find((entry) =>
      entry.prompt.prompt_type === 'plan_exit' && !isSyntheticPlanExitPrompt(entry.prompt)
    ) ?? null,
    [attentionState.prompts],
  );
  const hasPlanExitPrompt = planExitPromptIds.length > 0;
  const hasHardBlockingAttention = attentionState.permissions.length > 0
    || Boolean(attentionState.terminalPrompt)
    || hasAskUserQuestionPrompt;
  const hasBlockingAttention = hasHardBlockingAttention || hasQuickReplyPrompt;
  const hasAttentionPanel = hasBlockingAttention;
  const canSend = !isSending
    && !isTerminalStatus(session.status)
    && (composerHasDraft || sessionAnnotations.annotations.length > 0);
  const canShowFileRestorePoints = session.provider === 'claude'
    && fileCheckpoints.length > 0;
  const canUseFileRestorePoints = canShowFileRestorePoints
    && !isTerminalStatus(session.status)
    && !isProcessingTurn
    && !hasBlockingAttention
    && !isRewindingFiles;
  const fileRestoreDisabledReason = canUseFileRestorePoints
    ? null
    : isRewindingFiles
      ? t('common.loading')
      : hasBlockingAttention
        ? t('workspace.nativeRestoreBlocked')
        : isProcessingTurn
          ? t('workspace.nativeRestoreBusy')
          : isTerminalStatus(session.status)
            ? t('workspace.nativeRestoreUnavailable')
            : null;

  useEffect(() => {
    if (!canUseFileRestorePoints) {
      setIsFileRestoreMenuOpen(false);
    }
  }, [canUseFileRestorePoints]);

  const toggleFileRestoreMenu = useCallback(() => {
    if (!canUseFileRestorePoints) {
      return;
    }

    setIsFileRestoreMenuOpen((open) => !open);
  }, [canUseFileRestorePoints]);

  const buildDispatchText = useCallback((text: string, planModeEnabled: boolean) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return '';
    }

    if (!planModeEnabled) {
      return trimmedText;
    }

    if (session.provider === 'codex') {
      return trimmedText.startsWith('/plan')
        ? trimmedText
        : `/plan ${trimmedText}`;
    }

    if (sessionRuntimePermMode === 'plan') {
      return trimmedText;
    }

    return [
      'Stay in planning mode for this reply.',
      'Outline the plan only and wait for confirmation before executing changes.',
      '',
      trimmedText,
    ].join('\n');
  }, [session.provider, sessionRuntimePermMode]);

  const buildQueuedBatchText = useCallback((items: Array<{ text: string; planMode: boolean; attachments: ComposerAttachment[] }>) => {
    if (items.length === 1) {
      return buildDispatchText(
        buildComposerPromptText(items[0]!.text, items[0]!.attachments),
        items[0]!.planMode,
      );
    }

    const [firstItem, ...restItems] = items;
    const firstText = buildDispatchText(
      buildComposerPromptText(firstItem!.text, firstItem!.attachments),
      firstItem!.planMode,
    );
    const remainingText = restItems
      .map((item, index) => `${index + 2}. ${buildDispatchText(
        buildComposerPromptText(item.text, item.attachments),
        item.planMode,
      )}`)
      .join('\n\n');

    return [
      firstText,
      '',
      '另外还有这些后续消息，请按顺序继续处理：',
      remainingText,
    ].join('\n');
  }, [buildDispatchText]);

  const sendPromptBatch = useCallback(async (prompts: QueuedGuidanceMessage[]) => {
    const allAttachments = prompts.flatMap((p) => p.attachments);
    const images = extractComposerImagePayloads(allAttachments);
    const payload = buildQueuedBatchText(prompts.map((prompt) => ({
      text: prompt.text,
      planMode: prompt.planMode,
      attachments: prompt.attachments,
    })));
    if (!payload && images.length === 0) {
      return;
    }

    const previewText = prompts.length === 1
      ? buildComposerPromptPreview(prompts[0]!.displayText ?? prompts[0]!.text, prompts[0]!.attachments)
      : [
          buildComposerPromptPreview(prompts[0]!.displayText ?? prompts[0]!.text, prompts[0]!.attachments),
          '',
          '另外还有这些后续消息，请按顺序继续处理：',
          ...prompts.slice(1).map((prompt, index) =>
            `${index + 2}. ${buildComposerPromptPreview(prompt.displayText ?? prompt.text, prompt.attachments)}`,
          ),
        ].join('\n');

    const promptEntry: LocalUserPrompt = {
      id: prompts.length === 1
        ? prompts[0]!.id
        : `queue-batch-${Date.now()}`,
      text: previewText,
      images: images.length > 0 ? images : undefined,
      timestamp: Date.now(),
      afterEventSeq: latestEventSeq(latestEventsRef.current) ?? undefined,
    };

    setIsSending(true);
    setLocalUserPrompts((previous) => [...previous, promptEntry]);

    try {
      await sendNativeSessionInput(
        session.runtime_id,
        payload ?? '',
        images.length > 0 ? images : undefined,
        promptEntry.text,
      );
      await pollEvents();
      await refreshSummary({ force: true });
    } catch (error) {
      console.error('Failed to send native session input:', error);
      setLocalUserPrompts((previous) =>
        previous.filter((prompt) => prompt.id !== promptEntry.id),
      );
      throw error;
    } finally {
      setIsSending(false);
    }
  }, [buildQueuedBatchText, pollEvents, refreshSummary, sendNativeSessionInput, session.runtime_id]);

  const applyRuntimePlanModeChange = useCallback(async (
    enabled: boolean,
    options?: { refreshSummaryAfterChange?: boolean },
  ) => {
    if (session.provider !== 'claude') {
      setComposerPlanModeEnabled(enabled);
      return true;
    }

    const previousRuntimeMode = sessionRuntimePermMode;
    const previousPlanMode = composerPlanModeEnabled;
    const nextRuntimePermMode = resolveWorkspaceRuntimePlanMode(session.provider, enabled);
    const nextSessionRuntimeMode = nextRuntimePermMode ?? sessionDisplayPermMode;

    setComposerPlanModeEnabled(enabled);
    setSessionRuntimePermMode(nextSessionRuntimeMode);

    try {
      await setNativeSessionRuntimePermMode(session.runtime_id, nextRuntimePermMode);
      if (options?.refreshSummaryAfterChange ?? true) {
        await refreshSummary({ force: true });
      }
      return true;
    } catch (error) {
      console.error('Failed to update native session plan mode:', error);
      setComposerPlanModeEnabled(previousPlanMode);
      setSessionRuntimePermMode(previousRuntimeMode);
      toast.error(t('workspace.nativeSettingsFailed'));
      return false;
    }
  }, [
    composerPlanModeEnabled,
    refreshSummary,
    session.provider,
    session.runtime_id,
    sessionDisplayPermMode,
    sessionRuntimePermMode,
    setNativeSessionRuntimePermMode,
    t,
  ]);

  const sendInteractivePromptReply = useCallback(async (
    payload: InteractivePromptReplyPayload,
  ) => {
    let requestText = '';
    let requestImages: NativePromptImageInput[] | undefined;
    if (payload.kind === 'text') {
      requestText = buildComposerPromptText(payload.text, payload.attachments ?? []);
      const images = extractComposerImagePayloads(payload.attachments ?? []);
      requestImages = images.length > 0 ? images : undefined;
      if (!requestText.trim() && !requestImages) {
        return false;
      }
    }

    const promptEntry: LocalUserPrompt = {
      id: `user-${Date.now()}`,
      text: payload.kind === 'ask_user_question'
        ? payload.text
        : payload.kind === 'plan_exit'
          ? payload.text
          : buildComposerPromptPreview(payload.displayText ?? payload.text, payload.attachments ?? []),
      images: payload.kind === 'text' ? requestImages : undefined,
      timestamp: Date.now(),
      afterEventSeq: latestEventSeq(latestEventsRef.current) ?? undefined,
    };

    let exitedPlanModeForPrompt = false;
    let dismissedPlanExitPromptIds: string[] = [];
    if (payload.kind === 'plan_exit' && hasPlanExitPrompt) {
      dismissedPlanExitPromptIds = planExitPromptIds;
    }
    if (
      payload.kind === 'plan_exit'
      && payload.approved
      && hasPlanExitPrompt
      && session.provider === 'claude'
      && sessionRuntimePermMode === 'plan'
    ) {
      const exitedPlanMode = await applyRuntimePlanModeChange(false, {
        refreshSummaryAfterChange: false,
      });
      if (!exitedPlanMode) {
        return false;
      }
      exitedPlanModeForPrompt = true;
    }

    setIsSending(true);
    setLocalUserPrompts((previous) => [...previous, promptEntry]);
    if (payload.kind === 'text') {
      clearComposerDraft();
      setComposerPlanModeEnabled(sessionRuntimePermMode === 'plan');
    } else if (payload.kind === 'plan_exit') {
      clearComposerDraft();
      setComposerPlanModeEnabled(exitedPlanModeForPrompt ? false : sessionRuntimePermMode === 'plan');
      if (dismissedPlanExitPromptIds.length > 0) {
        setLocallyDismissedPromptIds((previous) => {
          const next = new Set(previous);
          dismissedPlanExitPromptIds.forEach((toolUseId) => next.add(toolUseId));
          return next;
        });
      }
    } else if (payload.kind === 'ask_user_question') {
      setLocallyDismissedPromptIds((previous) => {
        if (previous.has(payload.toolUseId)) {
          return previous;
        }
        const next = new Set(previous);
        next.add(payload.toolUseId);
        return next;
      });
    }

    try {
      if (payload.kind === 'ask_user_question') {
        await respondNativeSessionPrompt(session.runtime_id, {
          toolUseId: payload.toolUseId,
          promptType: 'ask_user_question',
          displayText: payload.text,
          answers: payload.answers,
          annotations: payload.annotations,
        });
      } else if (payload.kind === 'plan_exit') {
        await respondNativeSessionPrompt(session.runtime_id, {
          toolUseId: payload.toolUseId,
          promptType: 'plan_exit',
          displayText: payload.text,
          answers: payload.approved
            ? {
                decision: 'approve',
                approval: payload.text,
              }
            : {
                decision: 'revise',
                feedback: payload.text,
              },
        });
      } else {
        await sendNativeSessionInput(session.runtime_id, requestText, requestImages, promptEntry.text);
      }
      await pollEvents();
      await refreshSummary({ force: true });
      return true;
    } catch (error) {
      console.error('Failed to send interactive prompt reply:', error);
      setLocalUserPrompts((previous) =>
        previous.filter((prompt) => prompt.id !== promptEntry.id),
      );
      if (dismissedPlanExitPromptIds.length > 0) {
        setLocallyDismissedPromptIds((previous) => {
          const next = new Set(previous);
          dismissedPlanExitPromptIds.forEach((toolUseId) => next.delete(toolUseId));
          return next;
        });
      }
      if (payload.kind === 'ask_user_question') {
        setLocallyDismissedPromptIds((previous) => {
          if (!previous.has(payload.toolUseId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(payload.toolUseId);
          return next;
        });
      }
      if (payload.kind === 'plan_exit') {
        setLocallyDismissedPromptIds((previous) => {
          if (!previous.has(payload.toolUseId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(payload.toolUseId);
          return next;
        });
      }
      toast.error(t('workspace.nativeSendFailed'));
      return false;
    } finally {
      setIsSending(false);
    }
  }, [
    pollEvents,
    applyRuntimePlanModeChange,
    clearComposerDraft,
    refreshSummary,
    respondNativeSessionPrompt,
    sendNativeSessionInput,
    hasPlanExitPrompt,
    planExitPromptIds,
    session.provider,
    sessionRuntimePermMode,
    session.runtime_id,
    t,
  ]);

  const waitForPendingEnvironmentUpdate = useCallback(async () => {
    while (pendingEnvironmentUpdateRef.current) {
      const pendingUpdate = pendingEnvironmentUpdateRef.current;
      const succeeded = await pendingUpdate;
      if (!succeeded) {
        return false;
      }
      if (pendingEnvironmentUpdateRef.current === pendingUpdate) {
        return true;
      }
    }
    return true;
  }, []);

  const handleEnvChange = useCallback((envName: string) => {
    const previousEnv = sessionEnv;
    const runtimeId = session.runtime_id;
    const requestSeq = environmentUpdateRequestSeqRef.current + 1;
    const previousUpdate = pendingEnvironmentUpdateRef.current;
    environmentUpdateRequestSeqRef.current = requestSeq;
    setSessionEnv(envName);

    let updatePromise: Promise<boolean>;
    updatePromise = (async () => {
      if (previousUpdate) {
        await previousUpdate;
      }
      try {
        await updateNativeSessionSettings(runtimeId, envName, undefined);
        if (environmentUpdateRequestSeqRef.current === requestSeq) {
          await refreshSummary({ force: true });
        }
        return true;
      } catch (error) {
        console.error('Failed to update native session environment:', error);
        if (environmentUpdateRequestSeqRef.current === requestSeq) {
          setSessionEnv(previousEnv);
          toast.error(t('workspace.nativeSettingsFailed'));
        }
        return false;
      }
    })().finally(() => {
      if (pendingEnvironmentUpdateRef.current === updatePromise) {
        pendingEnvironmentUpdateRef.current = null;
      }
    });
    pendingEnvironmentUpdateRef.current = updatePromise;
  }, [refreshSummary, session.runtime_id, sessionEnv, t, updateNativeSessionSettings]);

  const handlePermModeChange = useCallback((mode: PermissionModeName) => {
    const previousRuntimeMode = sessionRuntimePermMode;
    const previousDisplayMode = sessionDisplayPermMode;
    setSessionRuntimePermMode(mode);
    setSessionDisplayPermMode(mode);
    setComposerPlanModeEnabled(false);
    void updateNativeSessionSettings(session.runtime_id, undefined, mode)
      .then(() => refreshSummary({ force: true }))
      .catch((error) => {
        console.error('Failed to update native session permission mode:', error);
        setSessionRuntimePermMode(previousRuntimeMode);
        setSessionDisplayPermMode(previousDisplayMode);
        setComposerPlanModeEnabled(previousRuntimeMode === 'plan');
        toast.error(t('workspace.nativeSettingsFailed'));
      });
  }, [
    refreshSummary,
    session.runtime_id,
    sessionDisplayPermMode,
    sessionRuntimePermMode,
    t,
    updateNativeSessionSettings,
  ]);

  const handlePlanModeEnabledChange = useCallback((enabled: boolean) => {
    void applyRuntimePlanModeChange(enabled);
  }, [applyRuntimePlanModeChange]);

  const handleEffortChange = useCallback((effort: EffortLevel) => {
    const nextEffort = normalizeEffortForProvider(effort, session.provider);
    const previousEffort = sessionEffort;
    setSessionEffort(nextEffort);
    void updateNativeSessionSettings(session.runtime_id, undefined, undefined, nextEffort)
      .then(() => refreshSummary({ force: true }))
      .catch((error) => {
        console.error('Failed to update native session effort:', error);
        setSessionEffort(previousEffort);
        toast.error(t('workspace.nativeSettingsFailed'));
      });
  }, [refreshSummary, session.provider, session.runtime_id, sessionEffort, t, updateNativeSessionSettings]);

  const handleSend = useCallback(async (payload?: ComposerSubmitPayload) => {
    if (isSending) {
      return false;
    }

    const text = payload?.text ?? composerTextRef.current.trim();
    const displayText = payload?.displayText ?? text;
    const attachments = payload?.attachments ?? [];
    if (!text && attachments.length === 0) {
      return false;
    }
    if (!await waitForPendingEnvironmentUpdate()) {
      return false;
    }
    const isCronCommand = isWorkspaceCronCommand(text);
    const cronAgentPrompt = isCronCommand
      ? buildWorkspaceCronAgentPrompt(text, session.project_dir)
      : null;
    if (isCronCommand) {
      if (attachments.length > 0) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
      if (!cronAgentPrompt) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
    }
    const promptText = cronAgentPrompt?.prompt ?? text;
    const promptDisplayText = cronAgentPrompt?.displayPrompt ?? displayText;

    const nextPrompt = makePersistableGuidanceMessage({
      id: `user-${Date.now()}`,
      text: promptText,
      displayText: promptDisplayText,
      planMode: isCronCommand ? false : composerPlanModeEnabled,
      attachments: isCronCommand ? [] : attachments,
    });
    clearComposerDraft();
    setComposerPlanModeEnabled(sessionRuntimePermMode === 'plan');

    if (!isCronCommand && hasQuickReplyPrompt && !isProcessingTurn && !hasHardBlockingAttention) {
      const planExitReplies = planExitApprovalPrompt?.prompt.prompt_type === 'plan_exit'
        ? promptQuickReplies(planExitApprovalPrompt.prompt)
        : [];
      if (
        planExitApprovalPrompt
        && attachments.length === 0
        && isPlanExitApprovalText(text, planExitReplies)
      ) {
        return sendInteractivePromptReply({
          kind: 'plan_exit',
          toolUseId: planExitApprovalPrompt.toolUseId,
          text,
          approved: true,
        });
      }
      if (planExitApprovalPrompt && attachments.length === 0) {
        return sendInteractivePromptReply({
          kind: 'plan_exit',
          toolUseId: planExitApprovalPrompt.toolUseId,
          text,
          approved: false,
        });
      }

      return sendInteractivePromptReply({
        kind: 'text',
        text,
        displayText,
        attachments,
      });
    }

    if (isProcessingTurn || hasHardBlockingAttention) {
      setQueuedMessages((previous) => [...previous, nextPrompt]);
      return true;
    }

    if (queuedMessages.length > 0 && !hasBlockingAttention) {
      const pendingBatch = [...queuedMessages, nextPrompt];
      setQueuedMessages([]);
      try {
        await sendPromptBatch(pendingBatch);
        return true;
      } catch (error) {
        setQueuedMessages(pendingBatch);
        toast.error(t('workspace.nativeSendFailed'));
        return false;
      }
    }

    try {
      await sendPromptBatch([nextPrompt]);
      return true;
    } catch (error) {
      toast.error(t('workspace.nativeSendFailed'));
      return false;
    }
  }, [
    composerPlanModeEnabled,
    clearComposerDraft,
    hasHardBlockingAttention,
    hasBlockingAttention,
    hasQuickReplyPrompt,
    isProcessingTurn,
    isSending,
    planExitApprovalPrompt,
    queuedMessages,
    sendPromptBatch,
    sendInteractivePromptReply,
    session.project_dir,
    sessionRuntimePermMode,
    t,
    waitForPendingEnvironmentUpdate,
  ]);

  const flushQueuedMessages = useCallback(async () => {
    if (
      queuedMessages.length === 0
      || isSending
      || isProcessingTurn
      || hasBlockingAttention
      || isTerminalStatus(session.status)
    ) {
      return;
    }

    if (!await waitForPendingEnvironmentUpdate()) {
      return;
    }

    const pendingBatch = queuedMessages;
    setQueuedMessages([]);

    try {
      await sendPromptBatch(pendingBatch);
    } catch (error) {
      setQueuedMessages((previous) => [...pendingBatch, ...previous]);
      toast.error(t('workspace.nativeSendFailed'));
    }
  }, [
    hasBlockingAttention,
    isProcessingTurn,
    isSending,
    queuedMessages,
    sendPromptBatch,
    session.status,
    t,
    waitForPendingEnvironmentUpdate,
  ]);

  useEffect(() => {
    setQueuedState((previousState) => {
      if (previousState.runtimeId === session.runtime_id) {
        return previousState;
      }

      return {
        runtimeId: session.runtime_id,
        messages: readStoredGuidanceQueue(session.runtime_id),
      };
    });
  }, [session.runtime_id]);

  useEffect(() => {
    if (queuedState.runtimeId !== session.runtime_id) {
      return;
    }

    writeStoredGuidanceQueue(queuedState.runtimeId, queuedState.messages);
  }, [queuedState, session.runtime_id]);

  const handlePermission = useCallback(async (requestId: string, approved: boolean) => {
    setRespondingRequestId(requestId);
    try {
      await respondNativeSessionPermission(session.runtime_id, requestId, approved);
      await pollEvents();
      await refreshSummary({ force: true });
    } catch (error) {
      console.error('Failed to respond to native permission:', error);
      toast.error(t('workspace.nativePermissionFailed'));
    } finally {
      setRespondingRequestId(null);
    }
  }, [pollEvents, refreshSummary, respondNativeSessionPermission, session.runtime_id, t]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      await stopNativeSession(session.runtime_id, 'native_session_stop_button');
      await refreshSummary({ force: true });
    } catch (error) {
      console.error('Failed to stop native session:', error);
      toast.error(t('workspace.nativeStopFailed'));
    } finally {
      setIsStopping(false);
    }
  }, [refreshSummary, session.runtime_id, stopNativeSession, t]);

  const handleHandoff = useCallback(async () => {
    setIsHandingOff(true);
    try {
      const result = await handoffNativeSessionToTerminal(session.runtime_id);
      await refreshSummary({ force: true });
      toast.success(
        t(result.status === 'pending'
          ? 'workspace.nativeHandoffPending'
          : 'workspace.nativeHandoffDone'),
      );
    } catch (error) {
      console.error('Failed to handoff native session:', error);
      toast.error(t('workspace.nativeHandoffFailed'));
    } finally {
      setIsHandingOff(false);
    }
  }, [handoffNativeSessionToTerminal, refreshSummary, session.runtime_id, t]);

  const handleRestoreFileCheckpoint = useCallback(async () => {
    if (!selectedFileCheckpoint || !canUseFileRestorePoints) {
      return;
    }

    const checkpointId = selectedFileCheckpoint.checkpointId;
    setIsRewindingFiles(true);
    pendingRewindCheckpointIdRef.current = checkpointId;
    pendingRewindStartSeqRef.current = latestEventSeq(latestEventsRef.current) ?? 0;
    clearFileRewindTimeout();
    fileRewindTimeoutRef.current = window.setTimeout(() => {
      if (pendingRewindCheckpointIdRef.current !== checkpointId) {
        return;
      }

      fileRewindTimeoutRef.current = null;
      pendingRewindCheckpointIdRef.current = null;
      pendingRewindStartSeqRef.current = 0;
      setIsRewindingFiles(false);
      toast.error(
        t('workspace.nativeRestoreFailed').replace('{error}', t('workspace.nativeRestoreTimedOut')),
      );
      void refreshSummary({ force: true });
    }, FILE_REWIND_TIMEOUT_MS);

    try {
      await rewindNativeSessionFiles(session.runtime_id, checkpointId);
      await pollEvents();
    } catch (error) {
      clearFileRewindTimeout();
      pendingRewindCheckpointIdRef.current = null;
      setIsRewindingFiles(false);
      console.error('Failed to request native file rewind:', error);
      toast.error(
        t('workspace.nativeRestoreFailed').replace('{error}', String(error)),
      );
    }
  }, [
    canUseFileRestorePoints,
    clearFileRewindTimeout,
    pollEvents,
    refreshSummary,
    rewindNativeSessionFiles,
    selectedFileCheckpoint,
    session.runtime_id,
    t,
  ]);

  useEffect(() => {
    const checkpointId = pendingRewindCheckpointIdRef.current;
    if (!checkpointId) {
      return;
    }

    const newerEvents = events.filter((event) => event.seq > pendingRewindStartSeqRef.current);
    const resultEvent = newerEvents.find((event) =>
      (event.payload.type === 'files_rewound' || event.payload.type === 'file_rewind_failed')
      && event.payload.checkpoint_id === checkpointId
    );

    if (!resultEvent) {
      return;
    }

    pendingRewindCheckpointIdRef.current = null;
    pendingRewindStartSeqRef.current = resultEvent.seq;
    clearFileRewindTimeout();
    setIsRewindingFiles(false);

    if (resultEvent.payload.type === 'files_rewound') {
      setIsRestoreDialogOpen(false);
      setSelectedFileCheckpoint(null);
      toast.success(t('workspace.nativeRestoreSuccess'));
      void refreshGitSnapshot();
      void refreshSummary({ force: true });
      return;
    }

    if (resultEvent.payload.type === 'file_rewind_failed') {
      toast.error(
        t('workspace.nativeRestoreFailed').replace('{error}', resultEvent.payload.error),
      );
    }
  }, [clearFileRewindTimeout, events, refreshGitSnapshot, refreshSummary, t]);

  useEffect(() => {
    if (
      queuedMessages.length === 0
      || isSending
      || isProcessingTurn
      || hasBlockingAttention
      || isTerminalStatus(session.status)
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void flushQueuedMessages();
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    flushQueuedMessages,
    hasBlockingAttention,
    isProcessingTurn,
    isSending,
    queuedMessages.length,
    session.status,
  ]);

  const hasComposerDraft = composerHasDraft;
  const hasComposerInput = hasComposerDraft || sessionAnnotations.annotations.length > 0;
  const shouldGuideModel = !isTerminalStatus(session.status)
    && hasComposerInput
    && (isProcessingTurn || hasHardBlockingAttention);

  return (
    <>
    <div className="relative flex h-full min-h-0 flex-col">
      {isReviewPopoverOpen && reviewModel ? (
        <Suspense fallback={null}>
          <LazyWorkspaceReviewPopover
            key={`${session.runtime_id}:${session.project_dir}`}
            session={session}
            model={reviewModel}
            gitSnapshot={gitSnapshot}
            isOpen={isReviewPopoverOpen}
            isRefreshingGit={isRefreshingGitSnapshot}
            onOpenChange={setReviewPanelOpen}
            onRefreshGit={() => void refreshGitSnapshot()}
            onLoadDiff={(filePath) => getWorkspaceFileDiff(session.project_dir, filePath)}
            onLoadMediaPreview={(filePath) => getWorkspaceMediaPreview(session.project_dir, filePath)}
            isLive
            onLoadSubagents={
              session.provider === 'claude' && session.provider_session_id
                ? (detailAgentId) =>
                    getSessionSubagents(session.provider_session_id!, session.provider, detailAgentId)
                : undefined
            }
          />
        </Suspense>
      ) : null}

      <WorkspaceTranscriptSelection
        rootRef={containerRef}
        scopeKey={`live:${session.runtime_id}`}
        isActive={isVisible}
        canCreate={!isTerminalStatus(session.status)}
        canAdd={sessionAnnotations.canAddAnnotation}
        annotations={sessionAnnotations.annotations}
        onAdd={sessionAnnotations.addAnnotation}
        onUpdate={sessionAnnotations.updateAnnotation}
        onRemove={sessionAnnotations.removeAnnotation}
      />

      <ScrollArea viewportRef={containerRef} className="workspace-transcript-scroll flex-1 bg-background/30">
        <div className="mx-auto max-w-[960px] px-8 py-8">
          {messages.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-2xl border border-border/40 bg-surface/70 p-4">
                <Layers3 className="h-6 w-6 text-muted-foreground/60" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('workspace.nativeEmptyTitle')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/75">
                  {t('workspace.nativeEmptyHint')}
                </p>
              </div>
            </div>
          ) : (
            <WorkspaceTranscriptList
              messages={messages}
              isAwaitingResponse={isAwaitingResponse}
            />
          )}
        </div>
      </ScrollArea>

      <WorkspaceSessionComposer
        value=""
        valueRevision={composerDraftRevision}
        onValueChange={handleComposerTextChange}
        onSubmit={handleSend}
        placeholder={t('workspace.composePlaceholder')}
        disabled={isTerminalStatus(session.status)}
        canSubmit={canSend}
        isSubmitting={false}
        submitLabel={t('workspace.composeSend')}
        loadingLabel={t('common.loading')}
        primaryActionLabel={
          isTerminalStatus(session.status)
            ? t('workspace.newSession')
            : !hasComposerInput && isProcessingTurn
              ? t('workspace.nativeStop')
              : shouldGuideModel
                ? t('workspace.composerGuideModel')
                : t('workspace.composeSend')
        }
        primaryActionIcon={
          isTerminalStatus(session.status)
            ? <SquarePen className="h-4 w-4" />
            : !hasComposerInput && isProcessingTurn
              ? <ProcessingActionIcon stopping={isStopping} />
              : shouldGuideModel
                ? <MessageSquareQuote className="h-4 w-4" />
                : <ArrowUp className="h-4 w-4" />
        }
        primaryActionDisabled={
          isTerminalStatus(session.status)
            ? false
            : !hasComposerInput && isProcessingTurn
              ? isStopping
              : undefined
        }
        onPrimaryAction={
          isTerminalStatus(session.status)
            ? onStartNew
            : !hasComposerInput && isProcessingTurn
              ? () => void handleStop()
              : undefined
        }
        primaryActionVariant={
          isTerminalStatus(session.status)
            ? 'outline'
            : 'default'
        }
        primaryActionClassName={
          isTerminalStatus(session.status)
            ? 'shadow-none w-auto rounded-full px-3 gap-1.5'
            : undefined
        }
        provider={session.provider}
        installedSkills={installedSkills}
        onRefreshSkills={onRefreshSkills}
        workspaceCommands={workspaceCommands}
        workingDir={session.project_dir}
        searchWorkspaceFiles={searchWorkspaceFiles}
        planModeEnabled={composerPlanModeEnabled}
        onPlanModeEnabledChange={handlePlanModeEnabledChange}
        planModeHint={session.provider === 'claude' && sessionRuntimePermMode === 'plan'
          ? t('workspace.composerPlanModeHintClaudeLocked')
          : undefined}
        codexInstalled={codexInstalled}
        opencodeInstalled={opencodeInstalled}
        onLaunchNewSession={onLaunchNewSession}
        queuedMessages={queuedMessages}
        onFlushQueuedMessages={() => void flushQueuedMessages()}
        onRemoveQueuedMessage={(id) => {
          setQueuedMessages((previous) => previous.filter((message) => message.id !== id));
        }}
        queueCanFlush={!isSending && !isProcessingTurn && !hasBlockingAttention && !isTerminalStatus(session.status)}
        annotations={sessionAnnotations.annotations}
        onUpdateAnnotation={sessionAnnotations.updateAnnotation}
        onRemoveAnnotation={sessionAnnotations.removeAnnotation}
        onClearAnnotations={sessionAnnotations.clearAnnotations}
        onAnnotationsSent={sessionAnnotations.clearAnnotations}
        aboveComposer={hasAttentionPanel ? (
          <WorkspaceAttentionPanel
            provider={session.provider}
            attentionState={attentionState}
            respondingRequestId={respondingRequestId}
            isSubmittingPrompt={isSending}
            onPermission={(requestId, approved) => {
              void handlePermission(requestId, approved);
            }}
            onSubmitPromptReply={async (payload) => {
              return await sendInteractivePromptReply(payload);
            }}
          />
        ) : null}
        controls={(
          <ComposerControls
            provider={session.provider}
            envName={sessionEnv}
            permMode={sessionPermMode}
            effort={sessionEffort}
            environments={environments}
            enabledEnvironments={enabledEnvironments}
            onEnvChange={handleEnvChange}
            onPermModeChange={handlePermModeChange}
            onEffortChange={handleEffortChange}
          />
        )}
        secondaryActions={(
          <>
            <ContextWindowIndicator usage={sessionUsage} />
            {canShowFileRestorePoints ? (
              <DropdownMenu
                modal={false}
                open={isFileRestoreMenuOpen}
                onOpenChange={setIsFileRestoreMenuOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <DropdownMenuTrigger asChild disabled={!canUseFileRestorePoints}>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 rounded-full transition-colors"
                          aria-label={t('workspace.nativeRestorePoints')}
                          disabled={!canUseFileRestorePoints}
                          onPointerDown={(event) => {
                            if (!canUseFileRestorePoints) {
                              return;
                            }
                            fileRestorePointerToggleRef.current = true;
                            event.preventDefault();
                            toggleFileRestoreMenu();
                          }}
                          onClick={() => {
                            if (fileRestorePointerToggleRef.current) {
                              fileRestorePointerToggleRef.current = false;
                              return;
                            }
                            toggleFileRestoreMenu();
                          }}
                        >
                          {isRewindingFiles ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <History className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {fileRestoreDisabledReason ?? t('workspace.nativeRestorePoints')}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  align="end"
                  side="top"
                  sideOffset={8}
                  className="frosted-panel glass-noise w-[300px] border-none p-1.5"
                >
                  {fileCheckpoints.map((checkpoint) => (
                    <DropdownMenuItem
                      key={checkpoint.checkpointId}
                      disabled={!canUseFileRestorePoints}
                      className="flex cursor-pointer flex-col items-stretch gap-1.5 px-3 py-2"
                      onSelect={(event) => {
                        event.preventDefault();
                        if (!canUseFileRestorePoints) {
                          return;
                        }
                        setIsFileRestoreMenuOpen(false);
                        setSelectedFileCheckpoint(checkpoint);
                        setIsRestoreDialogOpen(true);
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-xs font-medium text-foreground">
                          {t('workspace.nativeRestorePointTurn')
                            .replace('{index}', String(checkpoint.turnIndex))}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatCheckpointRelativeTime(checkpoint.createdAt, t)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                          {checkpoint.promptSummary || t('workspace.nativeRestorePointUnknown')}
                        </span>
                        {checkpoint.status === 'rewound' ? (
                          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            {t('workspace.nativeRestorePointRewound')}
                          </span>
                        ) : null}
                        {checkpoint.status === 'failed' ? (
                          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                            {t('workspace.nativeRestorePointFailed')}
                          </span>
                        ) : null}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <DropdownMenu modal={false} open={isExternalActionsOpen} onOpenChange={handleExternalActionsOpenChange}>
              <span
                className="inline-flex"
                onMouseEnter={openExternalActionsMenu}
                onMouseLeave={scheduleExternalActionsClose}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          'h-9 w-9 rounded-full transition-colors',
                          isExternalActionsOpen && 'bg-primary/10 text-primary',
                        )}
                        aria-label={t('workspace.externalActions')}
                      >
                        <span className="relative inline-flex h-4 w-4 items-center justify-center">
                          <Share2 className="h-4 w-4" />
                          <ChevronUp
                            className={cn(
                              'absolute -right-2 -top-1 h-2.5 w-2.5 transition-transform',
                              isExternalActionsOpen && 'rotate-180',
                            )}
                          />
                        </span>
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  {!isExternalActionsOpen && (
                    <TooltipContent side="top">{t('workspace.externalActions')}</TooltipContent>
                  )}
                </Tooltip>
              </span>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={8}
                className="min-w-[220px]"
                onMouseEnter={openExternalActionsMenu}
                onMouseLeave={scheduleExternalActionsClose}
              >
                <DropdownMenuItem
                  className="gap-2.5"
                  disabled={isTerminalStatus(session.status)}
                  onSelect={() => {
                    closeExternalActionsMenu();
                    setIsWecomBindDialogOpen(true);
                  }}
                >
                  <WeComMark className="shrink-0" />
                  <span>{t('workspace.wecomBindSession')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2.5"
                  disabled={isHandingOff || isHandoffPending}
                  onSelect={() => {
                    closeExternalActionsMenu();
                    void handleHandoff();
                  }}
                >
                  {isHandingOff || isHandoffPending ? (
                    <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <Terminal className="h-4 w-4 shrink-0" />
                  )}
                  <span>{t('workspace.nativeOpenTerminal')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      />
    </div>
    <Dialog
      open={isRestoreDialogOpen}
      onOpenChange={(open) => {
        if (isRewindingFiles) {
          return;
        }
        setIsRestoreDialogOpen(open);
        if (!open) {
          setSelectedFileCheckpoint(null);
        }
      }}
    >
      <DialogContent className="frosted-panel glass-noise max-w-[420px] border-none p-5">
        <DialogHeader>
          <DialogTitle>{t('workspace.nativeRestoreConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('workspace.nativeRestoreConfirmBody')}
          </DialogDescription>
        </DialogHeader>
        {selectedFileCheckpoint ? (
          <div className="rounded-lg border border-[hsl(var(--glass-border-light)/0.15)] bg-surface-raised/50 px-3 py-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">
                {t('workspace.nativeRestorePointTurn')
                  .replace('{index}', String(selectedFileCheckpoint.turnIndex))}
              </span>
              <span className="text-muted-foreground">
                {formatCheckpointRelativeTime(selectedFileCheckpoint.createdAt, t)}
              </span>
            </div>
            <p className="mt-1 truncate text-[12px] text-muted-foreground">
              {selectedFileCheckpoint.promptSummary || t('workspace.nativeRestorePointUnknown')}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="glass-btn-outline"
            disabled={isRewindingFiles}
            onClick={() => {
              setIsRestoreDialogOpen(false);
              setSelectedFileCheckpoint(null);
            }}
          >
            {t('workspace.nativeRestoreCancel')}
          </Button>
          <Button
            type="button"
            disabled={!selectedFileCheckpoint || !canUseFileRestorePoints}
            onClick={() => void handleRestoreFileCheckpoint()}
            className="gap-2"
          >
            {isRewindingFiles ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            <span>{t('workspace.nativeRestoreConfirmAction')}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <WorkspaceWecomBindDialog
      open={isWecomBindDialogOpen}
      onOpenChange={setIsWecomBindDialogOpen}
      session={session}
      onBound={async () => {
        await refreshSummary({ force: true });
      }}
    />
    </>
  );
}
