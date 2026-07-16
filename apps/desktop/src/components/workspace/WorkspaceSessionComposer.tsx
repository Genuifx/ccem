import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';
import {
  ArrowUp,
  Box,
  Check,
  Command,
  FileText,
  FolderTree,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  MessageSquareQuote,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import { Claude, Codex, OpenCode } from '@lobehub/icons';
import { PromptArea } from '@/components/prompt-area';
import { plainTextToSegments, segmentsToPlainText } from '@/components/segment-helpers';
import { TriggerPopover } from '@/components/trigger-popover';
import type {
  ChipClickContext,
  ChipSegment,
  PromptAreaHandle,
  PromptAreaTriggerPanelState,
  Segment,
  TriggerConfig,
  TriggerSuggestion,
} from '@/components/types';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SelectedSkillContent, WorkspaceFileSuggestion } from '@/lib/tauri-ipc';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { InstalledSkill, LaunchClient } from '@/store';
import {
  getComposerCapabilities,
  type ComposerCommandDefinition,
  type WorkspaceComposerProvider,
} from './composerCapabilities';
import {
  createComposerFileAttachment,
  createComposerImageAttachment,
  createComposerImagePlaceholder,
  createComposerTextAttachment,
  ensureComposerImagePlaceholders,
  getComposerImageAttachmentSrc,
  getNextComposerImagePlaceholderIndex,
  isLargeComposerPaste,
  loadComposerRecentFiles,
  mergeComposerAttachments,
  revokeComposerImageUrls,
  saveComposerRecentFile,
  validateComposerImageFile,
  type ComposerAttachment,
  type ComposerImageAttachment,
  type ComposerRecentFile,
  type ComposerSubmitPayload,
} from './composerAttachments';
import {
  buildComposerDisplayText,
  buildComposerPromptWithSelectedSkills,
  buildComposerSuggestions,
  composerTextMayContainSkillReference,
  parseComposerTokens,
  selectedSkillFilesFromComposerText,
  type ComposerSuggestion,
  type ComposerToken,
  type ComposerTokenKind,
} from './composerModel';
import { composerSegmentsReferenceImageAttachment } from './composerImageReferences';
import { WorkspaceComposerAnnotations } from './WorkspaceAnnotations';
import {
  buildComposerPromptWithAnnotations,
  type WorkspaceAnnotation,
} from './workspaceAnnotationModel';

export interface ComposerQueuedMessage {
  id: string;
  text: string;
  displayText?: string;
  planMode?: boolean;
  attachments?: ComposerAttachment[];
}

interface WorkspaceSessionComposerProps {
  value: string;
  valueRevision?: number;
  onValueChange: (value: string) => void;
  onSubmit: (payload: ComposerSubmitPayload) => boolean | void | Promise<boolean | void>;
  placeholder: string;
  disabled?: boolean;
  canSubmit: boolean;
  isSubmitting?: boolean;
  submitLabel: string;
  loadingLabel?: string;
  aboveComposer?: ReactNode;
  aboveTextarea?: ReactNode;
  onPrimaryAction?: () => void | Promise<void>;
  primaryActionLabel?: string;
  primaryActionIcon?: ReactNode;
  primaryActionDisabled?: boolean;
  primaryActionVariant?: ButtonProps['variant'];
  primaryActionClassName?: string;
  controls?: ReactNode;
  secondaryActions?: ReactNode;
  textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'placeholder' | 'disabled'>;
  provider?: WorkspaceComposerProvider;
  installedSkills?: InstalledSkill[];
  onRefreshSkills?: () => Promise<InstalledSkill[]>;
  workspaceCommands?: ComposerCommandDefinition[];
  workingDir?: string | null;
  searchWorkspaceFiles?: (
    workingDir: string,
    query?: string,
    limit?: number,
  ) => Promise<WorkspaceFileSuggestion[]>;
  planModeEnabled?: boolean;
  onPlanModeEnabledChange?: (enabled: boolean) => void;
  planModeAvailable?: boolean;
  planModeHint?: string;
  codexInstalled?: boolean;
  opencodeInstalled?: boolean;
  onLaunchNewSession?: (client: LaunchClient) => void;
  queuedMessages?: ComposerQueuedMessage[];
  onFlushQueuedMessages?: () => void | Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
  queueCanFlush?: boolean;
  annotations?: WorkspaceAnnotation[];
  onUpdateAnnotation?: (id: string, note: string) => void;
  onRemoveAnnotation?: (id: string) => void;
  onClearAnnotations?: () => void;
  onAnnotationsSent?: () => void;
}

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === 'text') {
    return <FileText className="h-3.5 w-3.5" />;
  }

  if (attachment.kind === 'image') {
    return <ImageIcon className="h-3.5 w-3.5" />;
  }

  return <Paperclip className="h-3.5 w-3.5" />;
}

function suggestionIcon(kind: ComposerSuggestion['kind']) {
  switch (kind) {
    case 'skill':
      return <Box className="h-3.5 w-3.5" strokeWidth={2.05} />;
    case 'command':
      return <Command className="h-3.5 w-3.5" />;
    case 'file':
      return <FolderTree className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

function SkillGlyphBadge({
  disabled = false,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span className={cn(
      'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border shadow-[inset_0_1px_0_hsl(var(--glass-border-light)/0.14)]',
      disabled
        ? 'border-destructive/15 bg-destructive/[0.055] text-destructive'
        : 'border-primary/15 bg-primary/[0.065] text-primary',
      className,
    )}>
      <Box className="h-4 w-4" strokeWidth={2.1} />
    </span>
  );
}

function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ComposerPromptChipKind = ComposerTokenKind | 'image';

interface ComposerPromptChipData {
  kind: ComposerPromptChipKind;
  suggestion?: ComposerSuggestion;
  path?: string;
  attachmentId?: string;
  placeholder?: string;
  name?: string;
}

interface InlineSkillPopoverState {
  token: ComposerToken;
  anchor: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readComposerPromptChipData(value: unknown): ComposerPromptChipData | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  if (value.kind !== 'skill' && value.kind !== 'command' && value.kind !== 'file' && value.kind !== 'image') {
    return null;
  }

  return {
    kind: value.kind,
    suggestion: isRecord(value.suggestion) ? value.suggestion as unknown as ComposerSuggestion : undefined,
    path: typeof value.path === 'string' ? value.path : undefined,
    attachmentId: typeof value.attachmentId === 'string' ? value.attachmentId : undefined,
    placeholder: typeof value.placeholder === 'string' ? value.placeholder : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
  };
}

function displayTextForComposerSuggestion(suggestion: ComposerSuggestion): string {
  const trigger = suggestion.label[0];
  if ((trigger === '/' || trigger === '$' || trigger === '@') && suggestion.label.length > 1) {
    return suggestion.label.slice(1);
  }
  return suggestion.label;
}

function composerSuggestionToTriggerSuggestion(suggestion: ComposerSuggestion): TriggerSuggestion {
  const displayText = displayTextForComposerSuggestion(suggestion);
  return {
    value: suggestion.path ?? suggestion.id,
    label: suggestion.label,
    description: suggestion.subtitle,
    icon: suggestionIcon(suggestion.kind),
    badges: suggestion.badges,
    disabled: suggestion.disabled,
    data: {
      kind: suggestion.kind,
      suggestion,
      path: suggestion.path,
      displayText,
    },
  };
}

function selectedTokenFromPromptChip(chip: ChipSegment): ComposerToken | null {
  const data = readComposerPromptChipData(chip.data);
  if (data?.kind !== 'skill' || !data.suggestion?.path || chip.trigger !== '$') {
    return null;
  }

  return {
    id: `skill-chip-${data.suggestion.path}`,
    kind: 'skill',
    raw: `${chip.trigger}${chip.displayText}`,
    display: `${chip.trigger}${chip.displayText}`,
    subtitle: data.suggestion.subtitle,
    path: data.suggestion.path,
    skill: data.suggestion.skill,
  };
}

function removeImageAttachmentFromSegments(
  segments: Segment[],
  attachment: ComposerImageAttachment,
): Segment[] {
  return segments
    .map((segment): Segment | null => {
      if (segment.type === 'chip') {
        const data = readComposerPromptChipData(segment.data);
        const isTargetImage = data?.kind === 'image'
          && (data.attachmentId === attachment.id || data.placeholder === attachment.placeholder);
        return isTargetImage ? null : segment;
      }
      return {
        type: 'text',
        text: segment.text
          .replace(attachment.placeholder, '')
          .replace(/[ \t]{2,}/g, ' '),
      };
    })
    .filter((segment): segment is Segment => Boolean(segment));
}

function ComposerAttachmentChip({
  attachment,
  onRemove,
  onImageClick,
}: {
  attachment: ComposerAttachment;
  onRemove: (id: string) => void;
  onImageClick?: (attachment: ComposerImageAttachment) => void;
}) {
  const { t } = useLocale();

  const secondaryLabel = attachment.kind === 'file'
    ? attachment.displayPath
    : attachment.kind === 'image'
      ? formatImageSize(attachment.byteSize)
      : `${attachment.lineCount} lines`;

  const title = attachment.kind === 'file'
    ? attachment.absolutePath
    : attachment.name;

  const imageSrc = attachment.kind === 'image'
    ? getComposerImageAttachmentSrc(attachment)
    : null;
  const thumbnail = attachment.kind === 'image' && imageSrc
    ? (
      <button
        type="button"
        className="shrink-0 overflow-hidden rounded-lg border border-border/45 bg-background/80 outline-none transition-[border-color,box-shadow] hover:border-primary/45 focus-visible:ring-2 focus-visible:ring-primary/40"
        onClick={() => onImageClick?.(attachment as ComposerImageAttachment)}
        aria-label={t('workspace.composerImagePreviewOpen')}
        title={t('workspace.composerImagePreviewOpen')}
      >
        <img
          src={imageSrc}
          alt={attachment.name}
          className="h-11 w-16 object-contain"
        />
      </button>
    )
    : (
      <span className="rounded-md bg-background/80 p-1 text-muted-foreground">
        {attachmentIcon(attachment)}
      </span>
    );

  return (
    <span
      data-composer-attachment-chip
      data-attachment-id={attachment.id}
      className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted/55 px-2.5 py-1.5 text-left text-foreground"
      title={title}
    >
      {thumbnail}
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium leading-4">
          {attachment.name}
        </span>
        <span className="block truncate text-[9px] leading-3.5 text-muted-foreground/85">
          {secondaryLabel}
        </span>
      </span>
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
        onClick={() => onRemove(attachment.id)}
        aria-label={t('workspace.composerRemoveAttachment')}
        title={t('workspace.composerRemoveAttachment')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ComposerSkillInfoPanel({
  token,
  onClose,
}: {
  token: ComposerToken;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const skill = token.skill;
  const badges = [
    skill?.provider,
    skill?.scope,
    skill?.visibility && skill.visibility !== 'native' ? skill.visibility : undefined,
  ].filter(Boolean) as string[];
  const diagnostics = skill?.diagnostics ?? [];

  return (
    <div
      data-composer-skill-info-panel
      className="rounded-[16px] bg-surface px-3 py-3"
    >
      <div className="space-y-2.5">
        <div className="flex items-start gap-2">
          <SkillGlyphBadge disabled={skill?.disabled} className="mt-0.5 h-7 w-7 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">
                {skill?.displayName ?? skill?.name ?? token.display}
              </p>
              {badges.slice(0, 3).map((badge) => (
                <span
                  key={badge}
                  className="rounded-[5px] bg-muted/70 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                >
                  {badge}
                </span>
              ))}
            </div>
            {skill?.description ? (
              <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-muted-foreground">
                {skill.description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <div className="space-y-1 text-[10px] leading-4 text-muted-foreground">
          {skill?.source || skill?.pluginName || skill?.pluginMarketplace ? (
            <p>
              <span className="text-foreground/75">{t('workspace.composerSkillSource')}:</span>{' '}
              {[skill.source, skill.pluginName, skill.pluginMarketplace].filter(Boolean).join(' / ')}
            </p>
          ) : null}
          <p className="break-all">
            <span className="text-foreground/75">{t('workspace.composerSkillPath')}:</span>{' '}
            {token.path ?? skill?.skillFile ?? skill?.path}
          </p>
          <p>
            <span className="text-foreground/75">{t('workspace.composerSkillImplicit')}:</span>{' '}
            {skill?.implicitAllowed === false
              ? t('workspace.composerSkillExplicitOnly')
              : t('workspace.composerSkillProviderNative')}
          </p>
          {diagnostics.length > 0 ? (
            <p className="rounded-lg bg-muted/45 px-2 py-1.5 text-[10px] leading-4">
              {diagnostics.join(' / ')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ComposerQuickMenu({
  codexInstalled,
  opencodeInstalled,
  planModeEnabled,
  planButtonVisible,
  planModeHint,
  planModeKind,
  provider,
  onLaunchNewSession,
  onPlanModeEnabledChange,
}: {
  codexInstalled: boolean;
  opencodeInstalled: boolean;
  planModeEnabled: boolean;
  planButtonVisible: boolean;
  planModeHint?: string;
  planModeKind: 'session_permission' | 'command_prefix';
  provider: WorkspaceComposerProvider;
  onLaunchNewSession?: (client: LaunchClient) => void;
  onPlanModeEnabledChange?: (enabled: boolean) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  const sdkItems: { client: LaunchClient; icon: ReactNode; label: string; installed: boolean }[] = [
    { client: 'claude', icon: <Claude.Color size={16} />, label: t('workspace.newSessionClaude'), installed: true },
    { client: 'codex', icon: <Codex.Color size={16} />, label: t('workspace.newSessionCodex'), installed: codexInstalled },
    { client: 'opencode', icon: <OpenCode size={16} />, label: t('workspace.newSessionOpenCode'), installed: opencodeInstalled },
  ];

  const resolvedPlanHint = planModeHint ?? (
    planModeKind === 'session_permission'
      ? t('workspace.composerPlanModeHintClaude')
      : t('workspace.composerPlanModeHintCodex')
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30"
          aria-label={t('workspace.composerQuickMenuLabel')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-auto min-w-[200px] rounded-xl border border-border/40 bg-popover p-1.5 shadow-md"
      >
        {sdkItems.map((item) => (
          <button
            key={item.client}
            type="button"
            disabled={!item.installed}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none',
              'transition-colors glass-dropdown-item',
              !item.installed && 'cursor-not-allowed opacity-50',
            )}
            onClick={() => {
              if (item.installed && onLaunchNewSession) {
                onLaunchNewSession(item.client);
                setOpen(false);
              }
            }}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="flex-1 text-left">{item.label}</span>
            {item.client === provider && (
              <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
            )}
            {!item.installed && (
              <span className="text-2xs text-muted-foreground">({t('settings.cliNotInstalled')})</span>
            )}
          </button>
        ))}

        {planButtonVisible ? (
          <>
            <div className="mx-2 my-1.5 h-px border-t border-border/50" />
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors glass-dropdown-item"
                >
                  <ListChecks className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-colors',
                    planModeEnabled && 'text-foreground',
                  )} />
                  <span className={cn(
                    'flex-1 text-left transition-colors',
                    planModeEnabled && 'text-foreground',
                  )}>
                    {t('workspace.composerPlanModeShort')}
                  </span>
                  <Switch
                    checked={planModeEnabled}
                    onCheckedChange={(checked) => onPlanModeEnabledChange?.(checked)}
                    aria-label={t('workspace.composerPlanModeShort')}
                    className="data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted/85"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[280px] text-[12px] leading-5">
                {resolvedPlanHint}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ComposerQueueDock({
  messages,
  canFlush,
  onFlush,
  onRemove,
}: {
  messages: ComposerQueuedMessage[];
  canFlush: boolean;
  onFlush?: () => void | Promise<void>;
  onRemove?: (id: string) => void;
}) {
  const { t } = useLocale();

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="px-0.5 py-0.5">
      <div className="flex items-center gap-2.5">
        <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
          <MessageSquareQuote className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold leading-4 text-foreground">
            {t('workspace.composerQueuedTitle')}
          </p>
          <p className="text-[10px] leading-4 text-muted-foreground">
            {t('workspace.composerQueuedCount').replace('{count}', String(messages.length))}
          </p>
          <p className="text-[10px] leading-4 text-muted-foreground/85">
            {t(canFlush ? 'workspace.composerQueuedReady' : 'workspace.composerQueuedWaiting')}
          </p>
        </div>
        {onFlush ? (
          <Button
            type="button"
            size="sm"
            className="h-6 rounded-full px-2.5 text-[10px]"
            disabled={!canFlush}
            onClick={() => void onFlush()}
          >
            {t(canFlush ? 'workspace.composerQueuedSendAll' : 'workspace.composerQueuedWaitAction')}
          </Button>
        ) : null}
      </div>

      <div className="mt-2 space-y-1">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className="flex items-start gap-2 rounded-[16px] bg-surface px-2 py-1.5"
          >
            <div className="mt-0.5 rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold leading-4 text-muted-foreground">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 whitespace-pre-wrap text-[11px] leading-4.5 text-foreground/92">
                {message.displayText ?? message.text}
              </p>
              {message.attachments?.length ? (
                <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground/80">
                  {t('workspace.composerAttachmentSummary').replace('{count}', String(message.attachments.length))}
                </p>
              ) : null}
              {message.planMode ? (
                <p className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-primary/85">
                  {t('workspace.composerPlanModeShort')}
                </p>
              ) : null}
            </div>
            {onRemove ? (
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                onClick={() => onRemove(message.id)}
                aria-label={t('workspace.composerRemoveQueued')}
                title={t('workspace.composerRemoveQueued')}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ComposerAttentionPanel({
  queuedMessages,
  queueCanFlush,
  onFlushQueuedMessages,
  onRemoveQueuedMessage,
}: {
  queuedMessages: ComposerQueuedMessage[];
  queueCanFlush: boolean;
  onFlushQueuedMessages?: () => void | Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
}) {
  const showQueue = queuedMessages.length > 0;

  if (!showQueue) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <ComposerQueueDock
        messages={queuedMessages}
        canFlush={queueCanFlush}
        onFlush={onFlushQueuedMessages}
        onRemove={onRemoveQueuedMessage}
      />
    </div>
  );
}

function ComposerTriggerSuggestionPanel({
  state,
}: {
  state: PromptAreaTriggerPanelState;
}) {
  return (
    <div className="max-h-[min(42vh,320px)] overflow-y-auto pr-0.5">
      <TriggerPopover
        suggestions={state.suggestions}
        loading={state.loading}
        error={state.error}
        emptyMessage={state.emptyMessage}
        selectedIndex={state.selectedIndex}
        onSelect={state.onSelect}
        onDismiss={state.onDismiss}
        triggerChar={state.triggerChar}
        placement="static"
        className="max-h-none"
      />
    </div>
  );
}

export function WorkspaceSessionComposer({
  value,
  valueRevision = 0,
  onValueChange,
  onSubmit,
  placeholder,
  disabled = false,
  canSubmit,
  isSubmitting = false,
  submitLabel,
  loadingLabel = submitLabel,
  aboveComposer,
  aboveTextarea,
  onPrimaryAction,
  primaryActionLabel,
  primaryActionIcon,
  primaryActionDisabled,
  primaryActionVariant = 'default',
  primaryActionClassName,
  controls,
  secondaryActions,
  textareaProps,
  provider = 'claude',
  installedSkills = [],
  onRefreshSkills,
  workspaceCommands = [],
  workingDir,
  searchWorkspaceFiles,
  planModeEnabled = false,
  onPlanModeEnabledChange,
  planModeAvailable,
  planModeHint,
  codexInstalled = false,
  opencodeInstalled = false,
  onLaunchNewSession,
  queuedMessages = [],
  onFlushQueuedMessages,
  onRemoveQueuedMessage,
  queueCanFlush = true,
  annotations = [],
  onUpdateAnnotation,
  onRemoveAnnotation,
  onClearAnnotations,
  onAnnotationsSent,
}: WorkspaceSessionComposerProps) {
  const { t } = useLocale();
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attentionDockRef = useRef<HTMLDivElement | null>(null);
  const attachmentStripRef = useRef<HTMLDivElement | null>(null);
  const primaryActionButtonRef = useRef<HTMLButtonElement | null>(null);
  const promptAreaRef = useRef<PromptAreaHandle | null>(null);
  const syncedPlainTextRef = useRef(value);
  const syncedValueRevisionRef = useRef(valueRevision);
  const previousAttachmentIdsRef = useRef<string[]>([]);
  const [composerSegments, setComposerSegments] = useState<Segment[]>(() => plainTextToSegments(value));
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const [recentFiles, setRecentFiles] = useState<ComposerRecentFile[]>([]);
  const [isDragTarget, setIsDragTarget] = useState(false);
  const [draggedFileCount, setDraggedFileCount] = useState(0);
  const [inlineSkillPopover, setInlineSkillPopover] = useState<InlineSkillPopoverState | null>(null);
  const [triggerPanelState, setTriggerPanelState] = useState<PromptAreaTriggerPanelState | null>(null);
  const [previewingImageId, setPreviewingImageId] = useState<string | null>(null);
  const [previewImageSize, setPreviewImageSize] = useState<{ width: number; height: number } | null>(null);
  const composerPlainText = useMemo(() => segmentsToPlainText(composerSegments), [composerSegments]);
  const previewingImage = useMemo(
    () => attachments.find((attachment): attachment is ComposerImageAttachment => (
      attachment.kind === 'image' && attachment.id === previewingImageId
    )) ?? null,
    [attachments, previewingImageId],
  );
  const previewingImageSrc = previewingImage ? getComposerImageAttachmentSrc(previewingImage) : null;
  const previewImageFrameStyle = useMemo<CSSProperties | undefined>(() => {
    if (!previewImageSize) {
      return undefined;
    }

    return {
      aspectRatio: `${previewImageSize.width} / ${previewImageSize.height}`,
      width: `min(${previewImageSize.width}px, min(92vw, 960px), calc(min(78vh, 720px) * ${previewImageSize.width} / ${previewImageSize.height}))`,
    };
  }, [previewImageSize]);
  const canSubmitWithAttachments = canSubmit
    || composerPlainText.trim().length > 0
    || attachments.length > 0
    || annotations.length > 0;
  const resolvedActionLabel = isSubmitting ? loadingLabel : (primaryActionLabel ?? submitLabel);
  const resolvedPrimaryDisabled = primaryActionDisabled ?? (!canSubmitWithAttachments || disabled);
  const resolvedPrimaryIcon = isSubmitting
    ? <LoaderCircle className="h-4 w-4 animate-spin" />
    : (primaryActionIcon ?? <ArrowUp className="h-4 w-4" />);
  const capabilities = getComposerCapabilities(provider);
  const planButtonVisible = planModeAvailable ?? Boolean(onPlanModeEnabledChange);
  const recentFileSuggestions = useMemo<ComposerSuggestion[]>(
    () => recentFiles.map((entry) => ({
      id: `recent-file-${entry.path}`,
      kind: 'file' as const,
      label: entry.relativePath ? `@${entry.relativePath}` : entry.displayPath,
      replacement: entry.relativePath ? `@${entry.relativePath}` : entry.path,
      subtitle: entry.path,
      path: entry.path,
    })),
    [recentFiles],
  );
  const selectedSkillTokens = useMemo(
    () => {
      const chipTokens = composerSegments
        .filter((segment): segment is ChipSegment => segment.type === 'chip')
        .map(selectedTokenFromPromptChip)
        .filter((token): token is ComposerToken => Boolean(token));
      const parsedTokens = composerTextMayContainSkillReference(composerPlainText)
        ? parseComposerTokens(composerPlainText, provider, installedSkills)
          .filter((token) => token.kind === 'skill' && token.path)
        : [];
      const seen = new Set<string>();
      return [...chipTokens, ...parsedTokens].filter((token) => {
        const key = token.path ?? token.raw;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    },
    [composerPlainText, composerSegments, installedSkills, provider],
  );

  useEffect(() => {
    if (!inlineSkillPopover) {
      return;
    }

    const selectedKey = inlineSkillPopover.token.path ?? inlineSkillPopover.token.raw;
    const stillSelected = selectedSkillTokens.some((token) => (token.path ?? token.raw) === selectedKey);
    if (!stillSelected) {
      setInlineSkillPopover(null);
    }
  }, [inlineSkillPopover, selectedSkillTokens]);

  useEffect(() => {
    setPreviewImageSize(null);
  }, [previewingImageSrc]);

  useEffect(() => {
    if (
      value === syncedPlainTextRef.current
      && valueRevision === syncedValueRevisionRef.current
    ) {
      return;
    }
    syncedValueRevisionRef.current = valueRevision;
    syncedPlainTextRef.current = value;
    setComposerSegments(plainTextToSegments(value));
  }, [value, valueRevision]);

  useEffect(() => {
    setRecentFiles(loadComposerRecentFiles(workingDir));
    setAttachments((previous) => {
      revokeComposerImageUrls(previous);
      attachmentsRef.current = [];
      return [];
    });
    setIsDragTarget(false);
    setDraggedFileCount(0);
  }, [workingDir]);

  useEffect(() => {
    return () => {
      revokeComposerImageUrls(attachmentsRef.current);
    };
  }, []);

  const addAttachments = useCallback((nextAttachments: ComposerAttachment[]) => {
    if (nextAttachments.length === 0) {
      return;
    }

    const next = mergeComposerAttachments(attachmentsRef.current, nextAttachments);
    attachmentsRef.current = next;
    setAttachments(next);
    for (const attachment of nextAttachments) {
      if (attachment.kind !== 'file') {
        continue;
      }
      saveComposerRecentFile(workingDir, attachment);
    }
    setRecentFiles(loadComposerRecentFiles(workingDir));
  }, [workingDir]);

  const syncComposerSegments = useCallback((segments: Segment[]) => {
    setComposerSegments(segments);
    const plainText = segmentsToPlainText(segments);
    syncedPlainTextRef.current = plainText;
    onValueChange(plainText);
  }, [onValueChange]);

  const pruneUnreferencedImageAttachments = useCallback((segments: Segment[]) => {
    let changed = false;
    const next = attachmentsRef.current.filter((attachment) => {
      if (attachment.kind !== 'image') {
        return true;
      }
      if (composerSegmentsReferenceImageAttachment(segments, attachment)) {
        return true;
      }
      changed = true;
      if (attachment.objectUrl) {
        URL.revokeObjectURL(attachment.objectUrl);
      }
      return false;
    });
    if (changed) {
      attachmentsRef.current = next;
      setAttachments(next);
    }
  }, []);

  const handlePromptSegmentsChange = useCallback((segments: Segment[]) => {
    syncComposerSegments(segments);
    pruneUnreferencedImageAttachments(segments);
  }, [pruneUnreferencedImageAttachments, syncComposerSegments]);

  const handleImagePaste = useCallback(async (files: File[]) => {
    if (!capabilities.supportsImages) {
      return;
    }

    const imageAttachments: ComposerImageAttachment[] = [];
    const firstImageIndex = getNextComposerImagePlaceholderIndex(attachmentsRef.current);
    for (const file of files) {
      const validation = validateComposerImageFile(file);
      if (!validation.valid) {
        const errorMessage = t(validation.errorKey);
        toast.error(errorMessage);
        console.warn(`Image paste rejected: ${errorMessage}`);
        continue;
      }

      try {
        const placeholder = createComposerImagePlaceholder(firstImageIndex + imageAttachments.length);
        const attachment = await createComposerImageAttachment(
          file,
          t('workspace.composerImagePastedName'),
          'paste',
          placeholder,
        );
        imageAttachments.push(attachment);
      } catch (error) {
        console.error('Failed to read pasted image:', error);
        toast.error(t('workspace.composerImageReadFailed'));
      }
    }

    if (imageAttachments.length > 0) {
      for (const attachment of imageAttachments) {
        promptAreaRef.current?.insertChip({
          trigger: '',
          value: attachment.placeholder,
          displayText: attachment.placeholder,
          data: {
            kind: 'image',
            attachmentId: attachment.id,
            placeholder: attachment.placeholder,
            name: attachment.name,
          } satisfies ComposerPromptChipData,
        });
      }
      addAttachments(imageAttachments);
    }
  }, [addAttachments, capabilities.supportsImages, t]);

  const handleBeforeTextPaste = useCallback((text: string) => {
    if (!isLargeComposerPaste(text)) {
      return false;
    }
    addAttachments([createComposerTextAttachment(
      text,
      t('workspace.composerPastedTextName'),
      'paste',
    )]);
    return true;
  }, [addAttachments, t]);

  const promptAreaTriggers = useMemo<TriggerConfig[]>(() => {
    const suggestionQuery = (kind: ComposerTokenKind, trigger: '$' | '/' | '@', query: string, files: WorkspaceFileSuggestion[] = []) => (
      buildComposerSuggestions({
        activeQuery: {
          kind,
          trigger,
          query,
          range: { start: 0, end: query.length + 1 },
        },
        provider,
        installedSkills,
        workspaceCommands,
        fileSuggestions: files,
      }).map(composerSuggestionToTriggerSuggestion)
    );

    return [
      {
        char: '/',
        position: 'any',
        mode: 'dropdown',
        chipStyle: 'pill',
        chipClassName: 'ccem-prompt-chip',
        accessibilityLabel: 'command or skill',
        onSearch: (query) => suggestionQuery('command', '/', query),
        onSelect: (suggestion) => {
          const data = readComposerPromptChipData(suggestion.data);
          return data?.suggestion ? displayTextForComposerSuggestion(data.suggestion) : suggestion.label.replace(/^\//, '');
        },
      },
      {
        char: '$',
        position: 'any',
        mode: 'dropdown',
        chipStyle: 'pill',
        chipClassName: 'ccem-prompt-chip',
        accessibilityLabel: 'skill',
        onSearch: (query) => suggestionQuery('skill', '$', query),
        onSelect: (suggestion) => {
          const data = readComposerPromptChipData(suggestion.data);
          return data?.suggestion ? displayTextForComposerSuggestion(data.suggestion) : suggestion.label.replace(/^\$/, '');
        },
      },
      {
        char: '@',
        position: 'any',
        mode: 'dropdown',
        chipStyle: 'pill',
        chipClassName: 'ccem-prompt-chip',
        accessibilityLabel: 'workspace file',
        onSearch: async (query, { signal }) => {
          if (!workingDir || !searchWorkspaceFiles) {
            return [];
          }
          if (!query && attachments.length === 0 && recentFileSuggestions.length > 0) {
            return recentFileSuggestions.map(composerSuggestionToTriggerSuggestion);
          }
          const files = await searchWorkspaceFiles(workingDir, query, 8);
          if (signal.aborted) {
            return [];
          }
          return suggestionQuery('file', '@', query, files);
        },
        onSelect: (suggestion) => {
          const data = readComposerPromptChipData(suggestion.data);
          return data?.suggestion ? displayTextForComposerSuggestion(data.suggestion) : suggestion.label.replace(/^@/, '');
        },
      },
    ];
  }, [attachments.length, installedSkills, provider, recentFileSuggestions, searchWorkspaceFiles, workingDir, workspaceCommands]);

  const handlePromptChipAdd = useCallback((chip: ChipSegment) => {
    const data = readComposerPromptChipData(chip.data);
    if (data?.kind === 'file' && data.path) {
      saveComposerRecentFile(workingDir, createComposerFileAttachment(data.path, workingDir, 'search'));
      setRecentFiles(loadComposerRecentFiles(workingDir));
    }
  }, [workingDir]);

  const handlePromptChipClick = useCallback((chip: ChipSegment, context: ChipClickContext) => {
    const token = selectedTokenFromPromptChip(chip);
    if (!token) {
      setInlineSkillPopover(null);
      return;
    }

    const shell = composerShellRef.current;
    const shellRect = shell?.getBoundingClientRect();
    const rect = context.element.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    setInlineSkillPopover({
      token,
      anchor: {
        left: rect.left - shellRect.left,
        top: rect.top - shellRect.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const previous = attachmentsRef.current;
    const removed = previous.find((attachment) => attachment.id === id);
    if (removed?.kind === 'image' && removed.objectUrl) {
      URL.revokeObjectURL(removed.objectUrl);
    }
    if (removed?.kind === 'image') {
      setPreviewingImageId((current) => (current === removed.id ? null : current));
    }
    if (removed?.kind === 'image') {
      setComposerSegments((segments) => {
        const nextSegments = removeImageAttachmentFromSegments(segments, removed);
        const plainText = segmentsToPlainText(nextSegments);
        syncedPlainTextRef.current = plainText;
        onValueChange(plainText);
        return nextSegments;
      });
    }
    const next = previous.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
  }, [onValueChange]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        const shell = composerShellRef.current;
        if (!shell) {
          return;
        }
        const payload = event.payload;

        const insideComposer = (() => {
          if (payload.type === 'leave') {
            return false;
          }
          const rect = shell.getBoundingClientRect();
          const scale = window.devicePixelRatio || 1;
          const x = payload.position.x / scale;
          const y = payload.position.y / scale;
          return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        })();

        if (payload.type === 'enter') {
          setDraggedFileCount(payload.paths.length);
          setIsDragTarget(insideComposer);
          return;
        }

        if (payload.type === 'over') {
          setIsDragTarget(insideComposer);
          return;
        }

        if (payload.type === 'leave') {
          setIsDragTarget(false);
          setDraggedFileCount(0);
          return;
        }

        setIsDragTarget(false);
        setDraggedFileCount(0);
        if (!insideComposer) {
          return;
        }

        addAttachments(payload.paths.map((path: string) => createComposerFileAttachment(path, workingDir, 'drop')));
      })
      .then((dispose) => {
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        console.error('Failed to subscribe to workspace composer drag and drop:', error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addAttachments, workingDir]);

  const handleComposerSubmit = useCallback(async () => {
    const promptValue = promptAreaRef.current?.getPlainText() ?? segmentsToPlainText(composerSegments);
    const currentAttachments = attachmentsRef.current;
    let text = ensureComposerImagePlaceholders(promptValue, currentAttachments);
    let displayText = ensureComposerImagePlaceholders(buildComposerDisplayText(promptValue), currentAttachments);
    let latestInstalledSkills = installedSkills;
    if (onRefreshSkills) {
      try {
        const refreshedSkills = await onRefreshSkills();
        if (refreshedSkills.length > 0) {
          latestInstalledSkills = refreshedSkills;
        }
      } catch (error) {
        console.error('Failed to refresh skills before composer submit:', error);
      }
    }
    const selectedSkillFiles = Array.from(new Set([
      ...selectedSkillTokens
        .filter((token) => token.path)
        .map((token) => token.path as string),
      ...selectedSkillFilesFromComposerText(promptValue, provider, latestInstalledSkills, workspaceCommands),
    ]));
    if (selectedSkillFiles.length > 0) {
      try {
        const selectedSkills = await invoke<SelectedSkillContent[]>('read_skill_files', {
          skillFiles: selectedSkillFiles,
        });
        const unreadableSkills = selectedSkills.filter((skill) => (
          skill.content.trim().length === 0
          && skill.diagnostics.some((diagnostic) => diagnostic.trim().length > 0)
        ));
        if (unreadableSkills.length > 0) {
          toast.error(t('workspace.composerSkillReadFailed'));
          return false;
        }
        text = buildComposerPromptWithSelectedSkills(displayText, selectedSkills);
      } catch (error) {
        console.error('Failed to read selected skill files for composer prompt:', error);
        toast.error(t('workspace.composerSkillReadFailed'));
        return false;
      }
    }
    if (annotations.length > 0) {
      text = buildComposerPromptWithAnnotations(text, annotations);
      if (!displayText.trim()) {
        displayText = t('workspace.composerAnnotationsOnly')
          .replace('{count}', String(annotations.length));
      }
    }

    const payload: ComposerSubmitPayload = {
      text,
      displayText,
      attachments: currentAttachments,
    };

    if (!payload.text && payload.attachments.length === 0) {
      return false;
    }

    const result = await onSubmit(payload);
    if (result !== false) {
      promptAreaRef.current?.clear();
      revokeComposerImageUrls(currentAttachments);
      attachmentsRef.current = [];
      setAttachments([]);
      setIsDragTarget(false);
      setDraggedFileCount(0);
      setInlineSkillPopover(null);
      setTriggerPanelState(null);
      onAnnotationsSent?.();
    }
    return result;
  }, [
    composerSegments,
    installedSkills,
    annotations,
    onAnnotationsSent,
    onRefreshSkills,
    onSubmit,
    provider,
    selectedSkillTokens,
    t,
    workspaceCommands,
  ]);

  const hasComposerAttentionPanel = queuedMessages.length > 0;

  const triggerAttentionPanel = useMemo(() => (
    triggerPanelState ? <ComposerTriggerSuggestionPanel state={triggerPanelState} /> : null
  ), [triggerPanelState]);

  const composerAttentionPanel = useMemo(() => {
    if (!hasComposerAttentionPanel) {
      return null;
    }

    return (
      <ComposerAttentionPanel
        queuedMessages={queuedMessages}
        queueCanFlush={queueCanFlush}
        onFlushQueuedMessages={onFlushQueuedMessages}
        onRemoveQueuedMessage={onRemoveQueuedMessage}
      />
    );
  }, [
    hasComposerAttentionPanel,
    onFlushQueuedMessages,
    onRemoveQueuedMessage,
    queueCanFlush,
    queuedMessages,
  ]);

  const combinedAboveComposer = useMemo(() => {
    if (!aboveComposer && !triggerAttentionPanel && !composerAttentionPanel) {
      return null;
    }

    const hasInterruption = Boolean(aboveComposer);

    return (
      <div
        data-attention-state={hasInterruption ? 'interruption' : 'auxiliary'}
        className={cn(
          'rounded-t-[18px] rounded-b-none border-x border-t bg-surface-raised px-2.5 pt-2 pb-6 transition-[border-color,box-shadow] duration-300',
          'motion-reduce:transition-none',
          hasInterruption
            ? 'border-border/70 shadow-[0_2px_4px_rgba(0,0,0,0.06),0_10px_28px_-12px_rgba(0,0,0,0.16),inset_0_0.5px_0_hsl(30_8%_82%/0.06)]'
            : 'border-border/40 shadow-[0_1px_3px_rgba(0,0,0,0.05),0_4px_12px_rgba(0,0,0,0.07),inset_0_0.5px_0_hsl(30_8%_82%/0.04)]',
        )}
        style={{ transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)' }}
      >
        <div className="space-y-1">
          {aboveComposer ? (
            <div className="max-h-[min(60vh,440px)] overflow-y-auto pr-0.5">
              {aboveComposer}
            </div>
          ) : null}
          {aboveComposer && (triggerAttentionPanel || composerAttentionPanel) ? (
            <div className="h-px bg-border/35" aria-hidden="true" />
          ) : null}
          {triggerAttentionPanel}
          {triggerAttentionPanel && composerAttentionPanel ? (
            <div className="h-px bg-border/35" aria-hidden="true" />
          ) : null}
          {composerAttentionPanel ? (
            hasInterruption ? (
              <div className="max-h-[120px] overflow-y-auto">
                {composerAttentionPanel}
              </div>
            ) : (
              composerAttentionPanel
            )
          ) : null}
        </div>
      </div>
    );
  }, [
    aboveComposer,
    composerAttentionPanel,
    triggerAttentionPanel,
  ]);
  const attentionMotionKey = [
    aboveComposer ? 'interrupt' : 'base',
    triggerPanelState ? 'trigger' : 'no-trigger',
    hasComposerAttentionPanel ? 'queue' : 'no-queue',
    queuedMessages.length,
  ].join(':');
  const attachmentMotionKey = useMemo(
    () => attachments.map((attachment) => attachment.id).join('|'),
    [attachments],
  );

  useGSAP(() => {
    const dock = attentionDockRef.current;
    if (!dock) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(dock);
      return;
    }

    gsap.killTweensOf(dock);
    gsap.fromTo(
      dock,
      { autoAlpha: 0, y: 12, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [attentionMotionKey], scope: composerShellRef });

  useGSAP(() => {
    const strip = attachmentStripRef.current;
    const currentIds = attachments.map((attachment) => attachment.id);
    const previousIds = previousAttachmentIdsRef.current;
    previousAttachmentIdsRef.current = currentIds;
    if (!strip) {
      return;
    }

    const newChips = gsap.utils.toArray<HTMLElement>('[data-composer-attachment-chip]', strip)
      .filter((element) => {
        const id = element.dataset.attachmentId;
        return id ? !previousIds.includes(id) : false;
      });

    if (shouldReduceMotion() || newChips.length === 0) {
      return;
    }

    gsap.fromTo(
      newChips,
      { autoAlpha: 0, y: 8, scale: 0.96 },
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
  }, { dependencies: [attachmentMotionKey, isDragTarget], scope: composerShellRef });

  useGSAP(() => {
    const button = primaryActionButtonRef.current;
    if (!button || shouldReduceMotion()) {
      return;
    }

    gsap.fromTo(
      button,
      { scale: 0.94 },
      {
        scale: 1,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        clearProps: 'transform',
      },
    );
  }, { dependencies: [resolvedActionLabel, isSubmitting], scope: composerShellRef });

  return (
    <div className="px-2 pb-3 pt-2 sm:px-4">
      <div ref={composerShellRef} className="relative mx-auto w-full max-w-5xl">
        {combinedAboveComposer ? (
          <div ref={attentionDockRef} className="workspace-attention-dock pointer-events-none absolute inset-x-0 bottom-[calc(100%-18px)] z-10 flex justify-center">
            <div className="pointer-events-auto w-[95%]">
              {combinedAboveComposer}
            </div>
          </div>
        ) : null}

        {inlineSkillPopover ? (
          <Popover open onOpenChange={(open) => {
            if (!open) {
              setInlineSkillPopover(null);
            }
          }}>
            <PopoverAnchor asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute"
                style={{
                  left: inlineSkillPopover.anchor.left,
                  top: inlineSkillPopover.anchor.top,
                  width: inlineSkillPopover.anchor.width,
                  height: inlineSkillPopover.anchor.height,
                }}
              />
            </PopoverAnchor>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={8}
              collisionPadding={12}
              className="z-[70] w-[360px] max-w-[calc(100vw-24px)] rounded-xl border-border/45 bg-popover p-0 shadow-md"
            >
              <ComposerSkillInfoPanel
                token={inlineSkillPopover.token}
                onClose={() => setInlineSkillPopover(null)}
              />
            </PopoverContent>
          </Popover>
        ) : null}

        <div
          data-composer-shell-card
          className={cn(
            'relative z-20 rounded-[20px] border border-border/40 bg-surface-raised px-5 py-3 shadow-[0_40px_120px_-70px_rgba(0,0,0,0.38)] transition-[border-color,box-shadow] duration-300',
            isDragTarget && 'border-primary/45 bg-primary/[0.035]',
            planModeEnabled && 'border-primary/15',
          )}
        >
          {planModeEnabled ? (
            <div className="mb-3 flex items-center">
              <span className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary/[0.06] px-2 py-0.5 text-[10px] font-medium leading-5 text-primary/70">
                <ListChecks className="h-3 w-3" />
                {t('workspace.composerPlanModeShort')}
              </span>
            </div>
          ) : null}
          {annotations.length > 0 && onUpdateAnnotation && onRemoveAnnotation && onClearAnnotations ? (
            <div className={cn(aboveTextarea ? 'mb-2' : 'mb-3')}>
              <WorkspaceComposerAnnotations
                annotations={annotations}
                onUpdate={onUpdateAnnotation}
                onRemove={onRemoveAnnotation}
                onClear={onClearAnnotations}
              />
            </div>
          ) : null}
          {aboveTextarea ? (
            <div className="mb-3">
              {aboveTextarea}
            </div>
          ) : null}

          {(attachments.length > 0 || isDragTarget) ? (
            <div
              ref={attachmentStripRef}
              className={cn(
                'mb-3 rounded-xl border border-dashed bg-surface px-3 py-2.5',
                isDragTarget
                  ? 'border-primary/45 bg-primary/[0.045]'
                  : 'border-border/30',
              )}
            >
              <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                <span>{isDragTarget ? t('workspace.composerAttachmentDropHint') : t('workspace.composerAttachmentsLabel')}</span>
                {isDragTarget && draggedFileCount > 0 ? (
                  <span className="tabular-nums">{draggedFileCount}</span>
                ) : null}
              </div>

              {attachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <ComposerAttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={removeAttachment}
                      onImageClick={(image) => setPreviewingImageId(image.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="relative min-h-[72px]">
            <PromptArea
              ref={promptAreaRef}
              value={composerSegments}
              onChange={handlePromptSegmentsChange}
              triggers={promptAreaTriggers}
              placeholder={placeholder}
              disabled={disabled}
              minHeight={72}
              maxHeight={260}
              markdown={false}
              onSubmit={() => void handleComposerSubmit()}
              onChipClick={handlePromptChipClick}
              onChipAdd={handlePromptChipAdd}
              onImagePaste={(files) => void handleImagePaste(files)}
              onBeforeTextPaste={handleBeforeTextPaste}
              onTriggerPanelChange={setTriggerPanelState}
              triggerPanelPlacement="external"
              onKeyDown={(event) => {
                textareaProps?.onKeyDown?.(event as unknown as ReactKeyboardEvent<HTMLTextAreaElement>);
                if (event.defaultPrevented) {
                  return;
                }

                if (event.key === 'Tab' && event.shiftKey && planButtonVisible && onPlanModeEnabledChange) {
                  event.preventDefault();
                  onPlanModeEnabledChange(!planModeEnabled);
                }
              }}
              className="ccem-prompt-area"
              aria-label={placeholder}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2.5 border-t border-border/40 pt-2">
            <ComposerQuickMenu
              codexInstalled={codexInstalled}
              opencodeInstalled={opencodeInstalled}
              planModeEnabled={planModeEnabled}
              planButtonVisible={planButtonVisible}
              planModeHint={planModeHint}
              planModeKind={capabilities.planModeKind}
              provider={provider}
              onLaunchNewSession={onLaunchNewSession}
              onPlanModeEnabledChange={onPlanModeEnabledChange}
            />

            {controls}

            <div className="ml-auto flex items-center gap-2">
              {secondaryActions}

              <Button
                ref={primaryActionButtonRef}
                type="button"
                size="icon"
                variant={primaryActionVariant}
                aria-label={resolvedActionLabel}
                title={resolvedActionLabel}
                disabled={resolvedPrimaryDisabled}
                onClick={() => {
                  if (onPrimaryAction) {
                    void onPrimaryAction();
                    return;
                  }
                  void handleComposerSubmit();
                }}
                className={cn(
                  'h-9 w-9 rounded-full shadow-[0_14px_36px_-18px_rgba(0,0,0,0.42)]',
                  primaryActionClassName,
                )}
              >
                {resolvedPrimaryIcon}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={previewingImage !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewingImageId(null);
            setPreviewImageSize(null);
          }
        }}
      >
        <DialogContent
          className="w-fit max-w-[calc(100vw-2rem)] border-border/45 bg-popover p-0 sm:max-w-[calc(100vw-3rem)] sm:rounded-2xl"
        >
          <DialogTitle className="sr-only">
            {t('workspace.composerImagePreview')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {previewingImage?.name ?? ''}
          </DialogDescription>
          {previewingImage && previewingImageSrc ? (
            <div className="flex w-fit max-w-full flex-col items-center gap-3 p-2">
              <div
                className="flex max-h-[min(78vh,720px)] max-w-[min(92vw,960px)] items-center justify-center overflow-hidden rounded-xl bg-black/85"
                style={previewImageFrameStyle}
              >
                <img
                  src={previewingImageSrc}
                  alt={previewingImage.name}
                  className={cn(
                    'block object-contain',
                    previewImageSize
                      ? 'h-full w-full'
                      : 'max-h-[min(78vh,720px)] max-w-[min(92vw,960px)]',
                  )}
                  onLoad={(event) => {
                    const { naturalHeight, naturalWidth } = event.currentTarget;
                    if (naturalWidth > 0 && naturalHeight > 0) {
                      setPreviewImageSize({ width: naturalWidth, height: naturalHeight });
                    }
                  }}
                />
              </div>
              <div className="flex w-full items-center justify-between gap-3 px-1 pb-1 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate font-medium text-foreground/85">
                  {previewingImage.name}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatImageSize(previewingImage.byteSize)}
                </span>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
