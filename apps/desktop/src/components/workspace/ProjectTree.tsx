import { memo, useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Check, Copy, Link, Pin, RefreshCw, X, Plus, ShieldAlert } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion } from '@/lib/gsapMotion';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { getHistorySessionDisplay } from '@/components/history/historySession';
import { useLocale } from '@/locales';
import type { Environment } from '@/store';
import type { HistorySessionItem, SessionStickerId, SessionTaskStage } from '@/features/conversations/types';
import { SessionTreeItemIcon, resolveSessionClient } from './sessionTreeIcons';
import { buildCcemSessionLinkForHistorySession } from './sessionLinks';
import type { WorkspaceSessionDecoration } from './useWorkspaceSessionDecorations';
import {
  SESSION_STICKERS,
  SESSION_TASK_STAGES,
  getSessionStickerDefinition,
  getSessionTaskStageDefinition,
} from './sessionAnnotations';
import {
  PinnedSessionsSection,
  PROJECT_TREE_PAGE_SIZE,
  ProjectTreeContent,
} from './ProjectTreeSections';
import {
  buildProjectNodes,
  buildProjectPrioritySessionKeys,
  classifyProject,
  reconcileProjectOrder,
  selectVisibleProjectSessions,
  sortProjectNodesByOrder,
  splitProjectNodesForSidebar,
  stabilizeProjectNodeSessions,
  type ProjectBucketOverride,
  type ProjectClassification,
  type ProjectNode,
} from './workspaceProjectTreeModel';

interface ProjectTreeProps {
  sessions: HistorySessionItem[];
  precomputedProjectNodes?: ProjectNode[];
  environmentByName?: Record<string, Environment>;
  decorationsBySessionKey?: Record<string, WorkspaceSessionDecoration>;
  canonicalKeyBySessionKey?: Readonly<Record<string, string | undefined>>;
  activeSessionKeys?: ReadonlySet<string>;
  isLoading: boolean;
  isRefreshing?: boolean;
  selectedKey: string | null;
  onSelect: (session: HistorySessionItem) => void;
  onRefresh: () => void;
  /** Save a title override. Returns a promise so callers can await it. */
  onSaveTitle?: (session: HistorySessionItem, title: string) => Promise<void>;
  onSaveAnnotation?: (
    session: HistorySessionItem,
    annotation: {
      stage?: SessionTaskStage;
      sticker?: SessionStickerId;
      label?: string;
    }
  ) => Promise<void>;
  onSessionsChanged?: () => Promise<void>;
  onCreateForProject?: (projectPath: string) => void;
  onNewSession?: () => void;
  width?: number;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function toKey(session: Pick<HistorySessionItem, 'id' | 'source'>): string {
  return `${session.source}:${session.id}`;
}

const MAX_LABEL_LENGTH = 24;
const PINNED_SESSION_KEYS_STORAGE_KEY = 'ccem-workspace-pinned-sessions';
const PROJECT_ORDER_STORAGE_KEY = 'ccem-workspace-project-order';
const PROJECT_CLASSIFICATION_STORAGE_KEY = 'ccem-workspace-project-classification';
const DISMISSED_ACTIVE_TEMP_PROJECTS_STORAGE_KEY = 'ccem-workspace-dismissed-active-temp-projects';
const EMPTY_CANONICAL_KEY_MAP: Readonly<Record<string, string | undefined>> = {};
const EMPTY_SESSION_KEY_SET: ReadonlySet<string> = new Set();

function readPinnedSessionKeys(): string[] {
  try {
    const rawValue = localStorage.getItem(PINNED_SESSION_KEYS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    const keys: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string' || seen.has(value)) {
        continue;
      }
      seen.add(value);
      keys.push(value);
    }
    return keys;
  } catch {
    return [];
  }
}

function readStringArrayStorage(key: string): string[] {
  try {
    const rawValue = localStorage.getItem(key);
    if (!rawValue) {
      return [];
    }
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const values: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string' || seen.has(value)) {
        continue;
      }
      seen.add(value);
      values.push(value);
    }
    return values;
  } catch {
    return [];
  }
}

function readProjectOrder(): string[] {
  return readStringArrayStorage(PROJECT_ORDER_STORAGE_KEY);
}

function readDismissedActiveTemporaryProjects(): string[] {
  return readStringArrayStorage(DISMISSED_ACTIVE_TEMP_PROJECTS_STORAGE_KEY);
}

function readProjectClassificationOverrides(): Record<string, ProjectBucketOverride> {
  try {
    const rawValue = localStorage.getItem(PROJECT_CLASSIFICATION_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, ProjectBucketOverride> = {};
    for (const [project, bucket] of Object.entries(parsed)) {
      if (typeof project !== 'string') {
        continue;
      }
      if (bucket === 'main' || bucket === 'temporary') {
        result[project] = bucket;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function hasSessionAnnotation(session: HistorySessionItem) {
  return !!(session.taskStage || session.taskSticker || session.taskLabel?.trim());
}

function SessionStickerPreview({
  sticker,
  className,
  size = 'md',
}: {
  sticker?: SessionStickerId;
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}) {
  const definition = getSessionStickerDefinition(sticker);
  if (!definition) {
    return null;
  }

  const sizeClasses = {
    xs: { frame: 'h-3.5 w-3.5', image: 'h-3.5 w-3.5' },
    sm: { frame: 'h-[18px] w-[18px]', image: 'h-[18px] w-[18px]' },
    md: { frame: 'h-5 w-5', image: 'h-5 w-5' },
    lg: { frame: 'h-12 w-12', image: 'h-12 w-12' },
  };
  const previewSize = sizeClasses[size];

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        previewSize.frame,
        className
      )}
      aria-hidden="true"
    >
      <img
        src={definition.imageUrl}
        alt=""
        draggable={false}
        className={cn(previewSize.image, 'object-contain drop-shadow-sm')}
      />
    </span>
  );
}

function SessionAnnotationPopover({
  session,
  t,
  onSaveAnnotation,
  variant = 'badge',
}: {
  session: HistorySessionItem;
  t: (key: string) => string;
  onSaveAnnotation?: ProjectTreeProps['onSaveAnnotation'];
  variant?: 'badge' | 'inline';
}) {
  const [open, setOpen] = useState(false);
  const [draftStage, setDraftStage] = useState<SessionTaskStage | undefined>(session.taskStage);
  const [draftSticker, setDraftSticker] = useState<SessionStickerId | undefined>(session.taskSticker);
  const [draftLabel, setDraftLabel] = useState(session.taskLabel ?? '');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraftStage(session.taskStage);
    setDraftSticker(session.taskSticker);
    setDraftLabel(session.taskLabel ?? '');
  }, [open, session.taskLabel, session.taskStage, session.taskSticker]);

  const save = useCallback(async () => {
    if (!onSaveAnnotation) {
      return;
    }
    setIsSaving(true);
    try {
      await onSaveAnnotation(session, {
        stage: draftStage,
        sticker: draftSticker,
        label: draftLabel.trim() || undefined,
      });
      setOpen(false);
    } catch (error) {
      console.error('Failed to save session annotation:', error);
    } finally {
      setIsSaving(false);
    }
  }, [draftLabel, draftStage, draftSticker, onSaveAnnotation, session]);

  const clear = useCallback(async () => {
    if (!onSaveAnnotation) {
      return;
    }
    setIsSaving(true);
    try {
      await onSaveAnnotation(session, {});
      setOpen(false);
    } catch (error) {
      console.error('Failed to clear session annotation:', error);
    } finally {
      setIsSaving(false);
    }
  }, [onSaveAnnotation, session]);

  if (!onSaveAnnotation) {
    return null;
  }

  const triggerSticker = session.taskSticker ?? 'confused';
  const stageDefinition = getSessionTaskStageDefinition(session.taskStage);
  const shouldShowAnnotationPeek = variant === 'inline' && !!(stageDefinition || session.taskLabel?.trim());
  const annotationPeekParts = [
    stageDefinition ? t(stageDefinition.labelKey) : null,
    session.taskLabel?.trim() || null,
  ].filter(Boolean);

  const triggerButton = (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
      }}
      aria-label={t('workspace.annotationOpen')}
      title={t('workspace.annotationOpen')}
      className={cn(
        variant === 'inline'
          ? cn(
              'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
              'transition-transform duration-150 hover:scale-105'
            )
          : cn(
              'absolute -bottom-0.5 -right-0.5 z-10 inline-flex h-3.5 w-3.5 items-center justify-center rounded-[5px]',
              'bg-surface-raised/95 shadow-sm ring-1 ring-border/70 transition-opacity duration-150',
              'hover:ring-primary/35',
              session.taskSticker
                ? 'opacity-100'
                : 'pointer-events-none opacity-0 focus:pointer-events-auto focus:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100'
            )
      )}
    >
      <SessionStickerPreview
        sticker={triggerSticker}
        size={variant === 'inline' ? 'md' : 'xs'}
        className={cn(!session.taskSticker && 'opacity-50')}
      />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {shouldShowAnnotationPeek ? (
        <span className="group/annotation relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden max-w-[240px] -translate-y-1/2',
              'whitespace-nowrap rounded-lg border border-border/60 bg-popover/98 px-2.5 py-1.5 text-left shadow-xl backdrop-blur-xl',
              'group-hover/annotation:block group-focus-within/annotation:block'
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-none text-foreground">
              <span className="min-w-0 truncate">{annotationPeekParts.join(' · ')}</span>
            </span>
          </span>
        </span>
      ) : (
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      )}
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="frosted-panel glass-noise w-[320px] rounded-xl p-3 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header — compact, click outside dismisses */}
        <p className="mb-2.5 text-[12px] font-semibold tracking-tight text-foreground">
          {t('workspace.annotationTitle')}
        </p>

        {/* Stage pills — tight inline row */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {SESSION_TASK_STAGES.map((stage) => {
            const selected = draftStage === stage.id;
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => setDraftStage(selected ? undefined : stage.id)}
                className={cn(
                  'inline-flex h-[22px] items-center rounded-md px-2 text-[10px] font-medium',
                  'transition-all duration-[var(--duration-fast,150ms)]',
                  selected
                    ? cn(stage.className, 'shadow-sm')
                    : 'bg-muted/25 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                {t(stage.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Sticker grid — compact 4-col, tactile hover */}
        <div className="mb-3 grid grid-cols-4 gap-1.5">
          {SESSION_STICKERS.map((sticker) => {
            const selected = draftSticker === sticker.id;
            return (
              <button
                key={sticker.id}
                type="button"
                onClick={() => setDraftSticker(selected ? undefined : sticker.id)}
                aria-label={t(sticker.labelKey)}
                title={t(sticker.labelKey)}
                className={cn(
                  'group/sticker relative inline-flex h-[52px] items-center justify-center rounded-lg',
                  'transition-all duration-[var(--duration-fast,150ms)]',
                  selected
                    ? 'bg-primary/10 shadow-[inset_0_0_0_1.5px_hsl(var(--primary)/0.3)]'
                    : 'hover:bg-muted/30 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-none'
                )}
              >
                <SessionStickerPreview
                  sticker={sticker.id}
                  size="lg"
                  className={cn(
                    'transition-transform duration-[var(--duration-fast,150ms)]',
                    '!h-9 !w-9',
                    !selected && 'group-hover/sticker:scale-110'
                  )}
                />
                {selected && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                    <Check className="h-2 w-2" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Label input — inline, no section header */}
        <div className="relative mb-3">
          <input
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value.slice(0, MAX_LABEL_LENGTH))}
            placeholder={t('workspace.annotationLabelPlaceholder')}
            className={cn(
              'h-8 w-full rounded-lg border border-border/50 bg-surface-sunken/50 px-2.5 text-[12px] text-foreground outline-none',
              'transition-all duration-[var(--duration-fast,150ms)]',
              'placeholder:text-muted-foreground/50',
              'focus:border-primary/40 focus:ring-1 focus:ring-primary/15'
            )}
          />
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] tabular-nums text-muted-foreground/40">
            {draftLabel.length}/{MAX_LABEL_LENGTH}
          </span>
        </div>

        {/* Footer — tight action row */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={clear}
            disabled={isSaving || !hasSessionAnnotation(session)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground',
              'transition-colors duration-[var(--duration-fast,150ms)]',
              'hover:bg-muted/40 hover:text-foreground',
              'disabled:pointer-events-none disabled:opacity-30'
            )}
          >
            <X className="h-3 w-3" />
            {t('workspace.annotationClear')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isSaving}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground',
              'transition-all duration-[var(--duration-fast,150ms)]',
              'hover:bg-primary/90 active:scale-[0.96]',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Check className="h-3 w-3" />
            {isSaving ? t('workspace.annotationSaving') : t('workspace.annotationSave')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const ProjectTree = memo(function ProjectTree({
  sessions,
  precomputedProjectNodes,
  environmentByName = {},
  decorationsBySessionKey = {},
  canonicalKeyBySessionKey = EMPTY_CANONICAL_KEY_MAP,
  activeSessionKeys = EMPTY_SESSION_KEY_SET,
  isLoading,
  isRefreshing = false,
  selectedKey,
  onSelect,
  onRefresh,
  onSaveTitle,
  onSaveAnnotation,
  onSessionsChanged,
  onCreateForProject,
  onNewSession,
  width,
  onResizeStart,
}: ProjectTreeProps) {
  const { t } = useLocale();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [pinnedSessionKeys, setPinnedSessionKeys] = useState(readPinnedSessionKeys);
  const [projectOrder, setProjectOrder] = useState(readProjectOrder);
  const [projectClassificationOverrides, setProjectClassificationOverrides] = useState(
    readProjectClassificationOverrides
  );
  const [dismissedActiveTemporaryProjects, setDismissedActiveTemporaryProjects] = useState(
    readDismissedActiveTemporaryProjects
  );

  const processingKeysRef = useRef<Set<string>>(new Set());
  const treeMotionRef = useRef<HTMLDivElement>(null);
  const sessionElementRef = useRef<Map<string, HTMLElement>>(new Map());
  const previousTreeRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const hasHydratedTreeMotionRef = useRef(false);
  const stableProjectNodesRef = useRef<ProjectNode[]>([]);
  const lastRevealedSelectedKeyRef = useRef<string | null>(null);
  const [freshDotKeys, setFreshDotKeys] = useState<Set<string>>(new Set());

  const canonicalizeSessionKey = useMemo(() => {
    if (Object.keys(canonicalKeyBySessionKey).length === 0) {
      return (key: string) => key;
    }
    return (key: string) => canonicalKeyBySessionKey[key] ?? key;
  }, [canonicalKeyBySessionKey]);
  const canonicalSelectedKey = selectedKey ? canonicalizeSessionKey(selectedKey) : null;

  useEffect(() => {
    setPinnedSessionKeys((previous) => {
      const seen = new Set<string>();
      const next: string[] = [];
      let changed = false;
      for (const key of previous) {
        const canonicalKey = canonicalizeSessionKey(key);
        changed ||= canonicalKey !== key || seen.has(canonicalKey);
        if (seen.has(canonicalKey)) {
          continue;
        }
        seen.add(canonicalKey);
        next.push(canonicalKey);
      }
      return changed ? next : previous;
    });
    setEditingKey((previous) => previous ? canonicalizeSessionKey(previous) : previous);
    setFreshDotKeys((previous) => {
      const next = new Set(Array.from(previous, canonicalizeSessionKey));
      return next.size === previous.size
        && [...next].every((key) => previous.has(key))
        ? previous
        : next;
    });

    const migratedProcessingKeys = new Set<string>();
    for (const key of processingKeysRef.current) {
      migratedProcessingKeys.add(canonicalizeSessionKey(key));
    }
    processingKeysRef.current = migratedProcessingKeys;
  }, [canonicalizeSessionKey]);

  useEffect(() => {
    localStorage.setItem(PINNED_SESSION_KEYS_STORAGE_KEY, JSON.stringify(pinnedSessionKeys));
  }, [pinnedSessionKeys]);

  useEffect(() => {
    localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(projectOrder));
  }, [projectOrder]);

  useEffect(() => {
    localStorage.setItem(
      PROJECT_CLASSIFICATION_STORAGE_KEY,
      JSON.stringify(projectClassificationOverrides)
    );
  }, [projectClassificationOverrides]);

  useEffect(() => {
    localStorage.setItem(
      DISMISSED_ACTIVE_TEMP_PROJECTS_STORAGE_KEY,
      JSON.stringify(dismissedActiveTemporaryProjects)
    );
  }, [dismissedActiveTemporaryProjects]);

  // Track which sessions just finished processing
  useEffect(() => {
    setFreshDotKeys((prev) => {
      let next: Set<string> | null = null;
      for (const session of sessions) {
        const rawKey = toKey(session);
        const key = canonicalizeSessionKey(rawKey);
        const decoration = decorationsBySessionKey[rawKey];
        if (decoration?.visualState === 'processing') {
          processingKeysRef.current.add(key);
        } else if (processingKeysRef.current.has(key)) {
          processingKeysRef.current.delete(key);
          if (!prev.has(key)) {
            next ??= new Set(prev);
            next.add(key);
          }
        }
      }
      return next ?? prev;
    });
  }, [canonicalizeSessionKey, sessions, decorationsBySessionKey]);

  // Dismiss fresh dot when user selects (reads) the session
  useEffect(() => {
    if (selectedKey) {
      setFreshDotKeys((prev) => {
        const canonicalKey = canonicalizeSessionKey(selectedKey);
        if (!prev.has(canonicalKey)) return prev;
        const next = new Set(prev);
        next.delete(canonicalKey);
        return next;
      });
    }
  }, [canonicalizeSessionKey, selectedKey]);

  const saveEdit = useCallback(async (session: HistorySessionItem, newTitle: string) => {
    try {
      if (onSaveTitle) {
        await onSaveTitle(session, newTitle.trim());
      }
      await onSessionsChanged?.();
    } catch (err) {
      console.error('Failed to save title:', err);
    }
  }, [onSaveTitle, onSessionsChanged]);

  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(null);
  const [projectVisibleCount, setProjectVisibleCount] = useState<Record<string, number>>({});

  const pinnedSessionKeySet = useMemo(
    () => new Set(pinnedSessionKeys.map(canonicalizeSessionKey)),
    [canonicalizeSessionKey, pinnedSessionKeys]
  );

  const sessionByKey = useMemo(() => {
    const map = new Map<string, HistorySessionItem>();
    for (const session of sessions) {
      map.set(canonicalizeSessionKey(toKey(session)), session);
    }
    return map;
  }, [canonicalizeSessionKey, sessions]);

  const pinnedSessions = useMemo(
    () => pinnedSessionKeys
      .map((key) => sessionByKey.get(canonicalizeSessionKey(key)))
      .filter((session): session is HistorySessionItem => !!session),
    [canonicalizeSessionKey, pinnedSessionKeys, sessionByKey]
  );

  const unpinnedSessions = useMemo(
    () => sessions.filter((session) => !pinnedSessionKeySet.has(canonicalizeSessionKey(toKey(session)))),
    [canonicalizeSessionKey, pinnedSessionKeySet, sessions]
  );

  const togglePinnedSession = useCallback((session: HistorySessionItem) => {
    const key = canonicalizeSessionKey(toKey(session));
    setPinnedSessionKeys((previous) => {
      if (previous.includes(key)) {
        return previous.filter((pinnedKey) => pinnedKey !== key);
      }
      return [key, ...previous.filter((pinnedKey) => pinnedKey !== key)];
    });
  }, [canonicalizeSessionKey]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy workspace session value:', error);
    }
  }, []);

  // Drag-to-reorder state for pinned sessions
  const dragSourceKeyRef = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after'>('before');

  const clearDragState = useCallback(() => {
    dragSourceKeyRef.current = null;
    setDraggingKey(null);
    setDropTargetKey(null);
    setDropPosition('before');
  }, []);

  const handlePinnedDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, session: HistorySessionItem) => {
      const key = canonicalizeSessionKey(toKey(session));
      dragSourceKeyRef.current = key;
      setDraggingKey(key);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key);
    },
    [canonicalizeSessionKey]
  );

  const handlePinnedDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, session: HistorySessionItem) => {
      if (!dragSourceKeyRef.current) return;
      const key = canonicalizeSessionKey(toKey(session));
      if (key === dragSourceKeyRef.current) {
        if (dropTargetKey) setDropTargetKey(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      const isTopHalf = event.clientY < rect.top + rect.height / 2;
      setDropTargetKey(key);
      setDropPosition(isTopHalf ? 'before' : 'after');
    },
    [canonicalizeSessionKey, dropTargetKey]
  );

  const handlePinnedDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, session: HistorySessionItem) => {
      event.preventDefault();
      const sourceKey = dragSourceKeyRef.current;
      const targetKey = canonicalizeSessionKey(toKey(session));
      if (!sourceKey || sourceKey === targetKey) {
        clearDragState();
        return;
      }
      setPinnedSessionKeys((prev) => {
        const without = prev.filter((k) => k !== sourceKey);
        const targetIndex = without.indexOf(targetKey);
        if (targetIndex === -1) return prev;
        const insertAt = dropPosition === 'before' ? targetIndex : targetIndex + 1;
        const next = [...without];
        next.splice(insertAt, 0, sourceKey);
        return next;
      });
      clearDragState();
    },
    [canonicalizeSessionKey, clearDragState, dropPosition]
  );

  const activitySortedProjectNodes = useMemo(() => {
    if (precomputedProjectNodes?.length) {
      const nodesByProject = new Map<string, ProjectNode>();
      const seenSessionKeys = new Set<string>();

      for (const node of precomputedProjectNodes) {
        const unpinnedNodeSessions = node.sessions.filter((session) => {
          const key = canonicalizeSessionKey(toKey(session));
          if (pinnedSessionKeySet.has(key) || seenSessionKeys.has(key)) {
            return false;
          }
          seenSessionKeys.add(key);
          return true;
        });

        if (unpinnedNodeSessions.length === 0) {
          continue;
        }

        nodesByProject.set(node.project, {
          ...node,
          sessions: unpinnedNodeSessions,
          latestTimestamp: unpinnedNodeSessions.reduce(
            (latest, session) => Math.max(latest, session.timestamp),
            0
          ),
        });
      }

      for (const session of unpinnedSessions) {
        const key = canonicalizeSessionKey(toKey(session));
        if (seenSessionKeys.has(key)) {
          continue;
        }

        let node = nodesByProject.get(session.project);
        if (!node) {
          node = {
            project: session.project,
            projectName: session.projectName,
            sessions: [],
            latestTimestamp: 0,
          };
          nodesByProject.set(session.project, node);
        }
        node.sessions.push(session);
        if (session.timestamp > node.latestTimestamp) {
          node.latestTimestamp = session.timestamp;
        }
      }

      const nodes = Array.from(nodesByProject.values());
      nodes.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
      for (const node of nodes) {
        node.sessions.sort((a, b) => b.timestamp - a.timestamp);
      }
      return nodes;
    }

    return buildProjectNodes(unpinnedSessions);
  }, [canonicalizeSessionKey, pinnedSessionKeySet, precomputedProjectNodes, unpinnedSessions]);

  const activityProjectOrder = useMemo(
    () => activitySortedProjectNodes.map((node) => node.project),
    [activitySortedProjectNodes]
  );

  const stableActivityProjectNodes = useMemo(() => {
    const stableNodes = stabilizeProjectNodeSessions(
      stableProjectNodesRef.current,
      activitySortedProjectNodes,
      { canonicalKeyBySessionKey },
    );
    stableProjectNodesRef.current = stableNodes;
    return stableNodes;
  }, [activitySortedProjectNodes, canonicalKeyBySessionKey]);

  const activityProjectOrderKey = activityProjectOrder.join('\u0000');

  useEffect(() => {
    setProjectOrder((previous) => {
      const next = reconcileProjectOrder(previous, activityProjectOrder);
      if (next.length === previous.length && next.every((project, index) => project === previous[index])) {
        return previous;
      }
      return next;
    });
  }, [activityProjectOrder, activityProjectOrderKey]);

  const classificationsByProject = useMemo(() => {
    const result: Record<string, ProjectClassification> = {};
    for (const node of stableActivityProjectNodes) {
      result[node.project] = classifyProject(
        node.project,
        activityProjectOrder,
        projectClassificationOverrides
      );
    }
    return result;
  }, [activityProjectOrder, stableActivityProjectNodes, projectClassificationOverrides]);

  const projectNodes = useMemo(
    () => sortProjectNodesByOrder(stableActivityProjectNodes, projectOrder),
    [projectOrder, stableActivityProjectNodes]
  );

  const temporaryCandidateProjectNodes = useMemo(
    () => projectNodes.filter((node) => classificationsByProject[node.project]?.bucket === 'temporary'),
    [classificationsByProject, projectNodes]
  );

  const dismissedActiveTemporaryProjectSet = useMemo(
    () => new Set(dismissedActiveTemporaryProjects),
    [dismissedActiveTemporaryProjects]
  );

  const activityPrioritySessionKeys = useMemo(
    () => buildProjectPrioritySessionKeys(
      activeSessionKeys,
      decorationsBySessionKey,
      canonicalKeyBySessionKey,
    ),
    [activeSessionKeys, canonicalKeyBySessionKey, decorationsBySessionKey]
  );

  const activeTemporaryProjectSet = useMemo(() => {
    const active = new Set<string>();
    for (const node of temporaryCandidateProjectNodes) {
      if (node.sessions.some((session) => (
        activityPrioritySessionKeys.has(canonicalizeSessionKey(toKey(session)))
      ))) {
        active.add(node.project);
      }
    }
    return active;
  }, [activityPrioritySessionKeys, canonicalizeSessionKey, temporaryCandidateProjectNodes]);

  useEffect(() => {
    setDismissedActiveTemporaryProjects((previous) => {
      const next = previous.filter((project) => activeTemporaryProjectSet.has(project));
      if (next.length === previous.length) {
        return previous;
      }
      return next;
    });
  }, [activeTemporaryProjectSet]);

  const {
    mainProjectNodes,
    temporaryProjectNodes,
    activeTemporaryProjectNodes,
  } = useMemo(
    () => splitProjectNodesForSidebar(
      projectNodes,
      classificationsByProject,
      activeTemporaryProjectSet,
      dismissedActiveTemporaryProjectSet
    ),
    [
      activeTemporaryProjectSet,
      classificationsByProject,
      dismissedActiveTemporaryProjectSet,
      projectNodes,
    ]
  );

  const organizeSidebar = useCallback(() => {
    setProjectOrder(activityProjectOrder);
  }, [activityProjectOrder]);

  const projectActions = useMemo(() => ({
    onMarkTemporary: (project: string) => {
      setProjectClassificationOverrides((previous) => ({
        ...previous,
        [project]: 'temporary',
      }));
    },
    onKeepMain: (project: string) => {
      setProjectClassificationOverrides((previous) => ({
        ...previous,
        [project]: 'main',
      }));
      setDismissedActiveTemporaryProjects((previous) =>
        previous.filter((candidate) => candidate !== project)
      );
    },
    onResetProjectClassification: (project: string) => {
      setProjectClassificationOverrides((previous) => {
        if (!previous[project]) {
          return previous;
        }
        const next = { ...previous };
        delete next[project];
        return next;
      });
    },
    onOrganizeSidebar: organizeSidebar,
  }), [organizeSidebar]);

  const dismissActiveTemporaryProject = useCallback((project: string) => {
    setDismissedActiveTemporaryProjects((previous) => (
      previous.includes(project) ? previous : [...previous, project]
    ));
  }, []);

  const activeProjectSet = useMemo(() => {
    const projects = new Set<string>();
    for (const node of projectNodes) {
      if (node.sessions.some((session) => (
        activityPrioritySessionKeys.has(canonicalizeSessionKey(toKey(session)))
      ))) {
        projects.add(node.project);
      }
    }
    return projects;
  }, [activityPrioritySessionKeys, canonicalizeSessionKey, projectNodes]);

  const selectedProject = useMemo(() => {
    if (!canonicalSelectedKey) {
      return null;
    }
    return projectNodes.find((node) => node.sessions.some((session) => (
      canonicalizeSessionKey(toKey(session)) === canonicalSelectedKey
    )))?.project ?? null;
  }, [canonicalSelectedKey, canonicalizeSessionKey, projectNodes]);

  const prioritySessionKeys = useMemo(() => {
    const keys = new Set(activityPrioritySessionKeys);
    if (canonicalSelectedKey) {
      keys.add(canonicalSelectedKey);
    }
    return keys;
  }, [activityPrioritySessionKeys, canonicalSelectedKey]);

  const defaultExpandedProjects = useMemo(() => new Set([
    ...mainProjectNodes.slice(0, 3).map((node) => node.project),
    ...activeTemporaryProjectNodes.map((node) => node.project),
  ]), [activeTemporaryProjectNodes, mainProjectNodes]);

  // Selecting a hidden row reveals its project once. A later explicit collapse
  // remains respected until the user selects another row.
  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    setExpandedProjects((previous) => {
      const expanded = new Set(previous ?? defaultExpandedProjects);
      if (expanded.has(selectedProject)) {
        return previous;
      }
      expanded.add(selectedProject);
      return expanded;
    });
  }, [canonicalSelectedKey, selectedProject]);

  // Active projects stay open while their activity signal is present, but only
  // until the user explicitly interacts with the tree. After the first toggle,
  // user intent wins and active projects can be collapsed like any other.
  const [hasUserToggled, setHasUserToggled] = useState(false);
  const effectiveExpanded = useMemo(() => {
    if (hasUserToggled && expandedProjects !== null) {
      return expandedProjects;
    }
    const expanded = new Set(expandedProjects ?? defaultExpandedProjects);
    for (const project of activeProjectSet) {
      expanded.add(project);
    }
    return expanded;
  }, [
    activeProjectSet,
    defaultExpandedProjects,
    expandedProjects,
    hasUserToggled,
  ]);

  // Per-project visible count helper
  const getVisibleCount = useCallback(
    (project: string) => projectVisibleCount[project] ?? PROJECT_TREE_PAGE_SIZE,
    [projectVisibleCount]
  );
  const getVisibleSessions = useCallback(
    (node: ProjectNode) => selectVisibleProjectSessions(
      node.sessions,
      getVisibleCount(node.project),
      prioritySessionKeys,
      canonicalKeyBySessionKey,
    ),
    [canonicalKeyBySessionKey, getVisibleCount, prioritySessionKeys]
  );
  const loadMore = useCallback(
    (project: string) =>
      setProjectVisibleCount((prev) => ({
        ...prev,
        [project]: (prev[project] ?? PROJECT_TREE_PAGE_SIZE) + PROJECT_TREE_PAGE_SIZE,
      })),
    []
  );
  const collapseList = useCallback(
    (project: string) =>
      setProjectVisibleCount((prev) => {
        if (!prev[project]) return prev;
        const next = { ...prev };
        delete next[project];
        return next;
      }),
    []
  );

  const toggleProject = useCallback(
    (project: string) => {
      setHasUserToggled(true);
      setExpandedProjects((prev) => {
        const next = new Set(prev ?? effectiveExpanded);
        if (next.has(project)) {
          next.delete(project);
        } else {
          next.add(project);
        }
        return next;
      });
    },
    [effectiveExpanded]
  );

  const treeMotionKey = useMemo(() => {
    const serializeProjectNode = (section: string, node: ProjectNode) => {
      const isExpanded = effectiveExpanded.has(node.project);
      if (!isExpanded) {
        return `${section}:${node.project}:collapsed`;
      }
      const visibleSessionKeys = getVisibleSessions(node)
        .map((session) => canonicalizeSessionKey(toKey(session)))
        .join(',');
      return `${section}:${node.project}:expanded:${visibleSessionKeys}`;
    };

    return [
      `loading:${isLoading}`,
      `pinned:${pinnedSessions.map((session) => canonicalizeSessionKey(toKey(session))).join(',')}`,
      ...mainProjectNodes.map((node) => serializeProjectNode('main', node)),
      ...temporaryProjectNodes.map((node) => serializeProjectNode('temporary', node)),
      ...activeTemporaryProjectNodes.map((node) => serializeProjectNode('activeTemporary', node)),
    ].join('\n');
  }, [
    activeTemporaryProjectNodes,
    canonicalizeSessionKey,
    effectiveExpanded,
    getVisibleSessions,
    isLoading,
    mainProjectNodes,
    pinnedSessions,
    temporaryProjectNodes,
  ]);

  useLayoutEffect(() => {
    const root = treeMotionRef.current;
    if (!root) {
      return;
    }

    const targets = gsap.utils.toArray<HTMLElement>('[data-project-motion-key]', root);
    const nextRects = new Map<string, DOMRect>();
    const previousRects = previousTreeRectsRef.current;
    const reduceMotion = shouldReduceMotion();

    for (const target of targets) {
      const key = target.dataset.projectMotionKey;
      if (!key) {
        continue;
      }
      nextRects.set(key, target.getBoundingClientRect());
    }

    if (!reduceMotion && hasHydratedTreeMotionRef.current) {
      for (const target of targets) {
        const key = target.dataset.projectMotionKey;
        if (!key) {
          continue;
        }
        const previous = previousRects.get(key);
        const current = nextRects.get(key);
        if (!current) {
          continue;
        }
        if (!previous) {
          gsap.fromTo(
            target,
            { autoAlpha: 0, y: 6, scale: 0.985 },
            {
              autoAlpha: 1,
              y: 0,
              scale: 1,
              duration: ccemMotion.duration.base,
              ease: ccemMotion.ease.standard,
              overwrite: 'auto',
              onComplete: () => clearMotionProps(target),
            }
          );
          continue;
        }

        const deltaY = previous.top - current.top;
        if (Math.abs(deltaY) > 1) {
          gsap.fromTo(
            target,
            { y: deltaY },
            {
              y: 0,
              duration: ccemMotion.duration.base,
              ease: ccemMotion.ease.standard,
              overwrite: 'auto',
              onComplete: () => clearMotionProps(target),
            }
          );
        }
      }
    }

    previousTreeRectsRef.current = nextRects;
    hasHydratedTreeMotionRef.current = true;
  }, [treeMotionKey]);

  useLayoutEffect(() => {
    if (!canonicalSelectedKey) {
      lastRevealedSelectedKeyRef.current = null;
      return;
    }
    if (lastRevealedSelectedKeyRef.current === canonicalSelectedKey) {
      return;
    }

    const target = sessionElementRef.current.get(canonicalSelectedKey);
    if (!target) {
      return;
    }

    const root = treeMotionRef.current;
    if (root) {
      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const isVisible = targetRect.top >= rootRect.top
        && targetRect.bottom <= rootRect.bottom;
      if (!isVisible) {
        target.scrollIntoView({ block: 'nearest' });
      }
    } else {
      target.scrollIntoView({ block: 'nearest' });
    }
    lastRevealedSelectedKeyRef.current = canonicalSelectedKey;
  }, [canonicalSelectedKey, treeMotionKey]);

  const totalProjects = projectNodes.length;
  const totalSessions = sessions.length;

  const resolveEnvironment = useCallback((session: HistorySessionItem) => {
    const decoration = decorationsBySessionKey[toKey(session)];
    const environmentName = session.envName ?? decoration?.envName;
    return environmentName ? environmentByName[environmentName] : undefined;
  }, [decorationsBySessionKey, environmentByName]);

  const getIconTitle = useCallback((session: HistorySessionItem) => {
    const decoration = decorationsBySessionKey[toKey(session)];
    const client = resolveSessionClient(session, decoration);
    const clientLabel = client === 'codex'
      ? t('workspace.newSessionCodex')
      : client === 'opencode'
        ? t('workspace.newSessionOpenCode')
        : t('workspace.newSessionClaude');

    if (decoration?.attentionKind === 'plan_review') {
      return t('workspace.sessionClientLabel').replace('{client}', clientLabel)
        + ` · ${t('workspace.sessionStatePlanReview')}`;
    }
    if (decoration?.attentionKind === 'input_required') {
      return t('workspace.sessionClientLabel').replace('{client}', clientLabel)
        + ` · ${t('workspace.sessionStateInputRequired')}`;
    }
    if (decoration?.attentionKind === 'permission_required') {
      return t('workspace.sessionClientLabel').replace('{client}', clientLabel)
        + ` · ${t('workspace.sessionStateApprovalRequired')}`;
    }
    if (decoration?.visualState === 'processing') {
      return t('workspace.sessionClientLabel').replace('{client}', clientLabel)
        + ` · ${t('workspace.sessionStateGenerating')}`;
    }

    const environment = resolveEnvironment(session);
    return environment?.name || clientLabel;
  }, [decorationsBySessionKey, resolveEnvironment, t]);

  const renderSessionRow = useCallback((
    session: HistorySessionItem,
    options: { pinnedSection?: boolean; activeTemporarySection?: boolean } = {},
  ) => {
    const rawKey = toKey(session);
    const key = canonicalizeSessionKey(rawKey);
    const isSelected = key === canonicalSelectedKey;
    const isEditing = editingKey === key;
    const isPinned = pinnedSessionKeySet.has(key);
    const pinLabel = isPinned ? t('workspace.unpinSession') : t('workspace.pinSession');
    const decoration = decorationsBySessionKey[rawKey];
    const approvalRequired = decoration?.attentionKind === 'permission_required';
    // activeTemporarySection is intentionally a no-op visually: session rows
    // share one vocabulary across sections. The option remains in the type so
    // callers can mark intent without reintroducing a side-stripe / nested-card
    // treatment. Do NOT branch on it for chrome, padding, or selected state.
    const rowChrome = options.pinnedSection ? 'mx-0' : 'mx-1';
    const rowPadding = options.pinnedSection ? 'pl-2 pr-2' : 'pl-9 pr-2';
    const editPadding = options.pinnedSection ? 'pl-2 pr-2' : 'pl-9 pr-3';

    if (isEditing) {
      return (
        <div
          key={key}
          ref={(element) => {
            if (element) {
              sessionElementRef.current.set(key, element);
            } else {
              sessionElementRef.current.delete(key);
            }
          }}
          data-project-motion-key={`session:${key}`}
          data-workspace-session-key={key}
          className={cn(
            'w-full flex items-center gap-2 py-1.5 rounded-md bg-surface-raised',
            rowChrome,
            editPadding
          )}
        >
          <span
            className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center"
            title={getIconTitle(session)}
          >
            <SessionTreeItemIcon
              session={session}
              environment={resolveEnvironment(session)}
              decoration={decoration}
              isSelected
            />
          </span>
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditingKey(null);
                void saveEdit(session, editValue);
              }
              if (e.key === 'Escape') setEditingKey(null);
            }}
            onBlur={() => setEditingKey(null)}
            className="h-5 text-[12px] bg-transparent outline-none border-b border-primary/40 flex-1 min-w-0"
          />
        </div>
      );
    }

    const sessionLink = buildCcemSessionLinkForHistorySession(session);
    const row = (
      <div
        key={key}
        ref={(element) => {
          if (element) {
            sessionElementRef.current.set(key, element);
          } else {
            sessionElementRef.current.delete(key);
          }
        }}
        data-project-motion-key={`session:${key}`}
        data-workspace-session-key={key}
        role="button"
        tabIndex={0}
        draggable={options.pinnedSection === true}
        onDragStart={options.pinnedSection ? (event) => handlePinnedDragStart(event, session) : undefined}
        onDragOver={options.pinnedSection ? (event) => handlePinnedDragOver(event, session) : undefined}
        onDrop={options.pinnedSection ? (event) => handlePinnedDrop(event, session) : undefined}
        onDragEnd={options.pinnedSection ? clearDragState : undefined}
        onClick={() => onSelect(session)}
        onDoubleClick={() => {
          setEditingKey(key);
          setEditValue(getHistorySessionDisplay(session, ''));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(session);
          }
        }}
        className={cn(
          'group/session relative w-full rounded-lg py-1.5 text-left transition-colors duration-150 outline-none',
          rowChrome,
          rowPadding,
          'focus-visible:ring-1 focus-visible:ring-primary/30',
          isSelected
            ? 'bg-primary/[0.08] text-primary'
            : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          options.pinnedSection && 'hover:bg-primary/[0.07]',
          options.pinnedSection && draggingKey !== key && 'cursor-grab active:cursor-grabbing',
          draggingKey === key && 'opacity-40'
        )}
      >
        {options.pinnedSection && dropTargetKey === key && dropPosition === 'before' && (
          <div className="pointer-events-none absolute inset-x-1 top-0 z-20 h-0.5 rounded-full bg-primary shadow-[0_0_4px_hsl(var(--primary)/0.5)]" />
        )}
        {options.pinnedSection && dropTargetKey === key && dropPosition === 'after' && (
          <div className="pointer-events-none absolute inset-x-1 bottom-0 z-20 h-0.5 rounded-full bg-primary shadow-[0_0_4px_hsl(var(--primary)/0.5)]" />
        )}
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center"
            title={getIconTitle(session)}
          >
            {session.taskSticker ? (
              <SessionAnnotationPopover
                session={session}
                t={t}
                onSaveAnnotation={onSaveAnnotation}
                variant="inline"
              />
            ) : (
              <>
                <SessionTreeItemIcon
                  session={session}
                  environment={resolveEnvironment(session)}
                  decoration={decoration}
                  isSelected={isSelected}
                />
                <SessionAnnotationPopover
                  session={session}
                  t={t}
                  onSaveAnnotation={onSaveAnnotation}
                  variant="badge"
                />
              </>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
            {getHistorySessionDisplay(session, t('history.untitledSession'))}
          </span>
          <span className="inline-flex w-10 shrink-0 items-center justify-end gap-1.5 whitespace-nowrap text-[10px] tabular-nums transition-opacity duration-150 group-hover/session:opacity-0">
            {approvalRequired ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                      'bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300'
                    )}
                    aria-label={t('workspace.sessionStateApprovalRequired')}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6} className="whitespace-nowrap">
                  {t('workspace.sessionStateApprovalRequired')}
                </TooltipContent>
              </Tooltip>
            ) : freshDotKeys.has(key) ? (
              <span className="relative inline-flex h-3.5 w-5 shrink-0 items-center justify-center">
                <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-amber-500/25 opacity-75" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-amber-500" />
              </span>
            ) : (
              <span className="text-muted-foreground/60">
                {formatRelativeTime(session.timestamp)}
              </span>
            )}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              draggable={false}
              onClick={(event) => {
                event.stopPropagation();
                togglePinnedSession(session);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-label={pinLabel}
              className={cn(
                'absolute right-2 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md',
                'pointer-events-none text-foreground/70 opacity-0 transition-opacity duration-150',
                'hover:text-foreground focus:text-foreground',
                'focus:pointer-events-auto focus:opacity-100 focus-visible:ring-1 focus-visible:ring-foreground/25',
                'group-hover/session:pointer-events-auto group-hover/session:opacity-100'
              )}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6} className="whitespace-nowrap">
            {pinLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    );

    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            onClick={() => {
              void copyText(session.id);
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            {t('workspace.copySessionId')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              void copyText(sessionLink);
            }}
          >
            <Link className="mr-2 h-3.5 w-3.5" />
            {t('workspace.copySessionLink')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }, [
    canonicalSelectedKey,
    canonicalizeSessionKey,
    clearDragState,
    copyText,
    decorationsBySessionKey,
    draggingKey,
    dropPosition,
    dropTargetKey,
    editValue,
    editingKey,
    freshDotKeys,
    getIconTitle,
    handlePinnedDragOver,
    handlePinnedDragStart,
    handlePinnedDrop,
    onSaveAnnotation,
    onSelect,
    pinnedSessionKeySet,
    resolveEnvironment,
    saveEdit,
    t,
    togglePinnedSession,
  ]);

  return (
    <div
      ref={treeMotionRef}
      style={width ? { width } : undefined}
      className="relative flex w-[clamp(220px,30vw,280px)] shrink-0 flex-col bg-sidebar backdrop-blur-xl"
    >
      <div
        data-ccem-workspace-sidebar-resize-handle="true"
        className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
        onPointerDown={onResizeStart}
      />
      {/* Header: New session + pinned conversations */}
      <div className="shrink-0 p-2 flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onNewSession}
            className={cn(
              'group flex flex-1 items-center justify-center gap-1.5 h-8 rounded-md',
              'bg-primary/10 text-primary hover:bg-primary/15',
              'text-xs font-medium',
              'active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
              'transition-all',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Plus className="h-3.5 w-3.5 transition-transform duration-200 group-hover:scale-110" />
            {t('workspace.newSession')}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={isRefreshing ? t('workspace.refreshing') : t('workspace.refresh')}
            title={isRefreshing ? t('workspace.refreshing') : t('workspace.refresh')}
            className={cn(
              'h-8 w-8 shrink-0 rounded-md',
              'bg-surface-raised/75 hover:bg-surface-raised',
              'flex items-center justify-center text-muted-foreground hover:text-foreground',
              'active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
              'disabled:cursor-default disabled:opacity-60',
              'transition-all'
            )}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
          </button>
        </div>

        <PinnedSessionsSection
          pinnedSessions={pinnedSessions}
          renderSessionRow={renderSessionRow}
          t={t}
        />
      </div>

      {/* Tree content */}
      <ProjectTreeContent
        activeTemporaryProjectNodes={activeTemporaryProjectNodes}
        classificationsByProject={classificationsByProject}
        effectiveExpanded={effectiveExpanded}
        getVisibleCount={getVisibleCount}
        getVisibleSessions={getVisibleSessions}
        isLoading={isLoading}
        mainProjectNodes={mainProjectNodes}
        onCreateForProject={onCreateForProject}
        onDismissActiveTemporaryProject={dismissActiveTemporaryProject}
        pinnedSessionsCount={pinnedSessions.length}
        projectActions={projectActions}
        renderSessionRow={renderSessionRow}
        temporaryProjectNodes={temporaryProjectNodes}
        toggleProject={toggleProject}
        collapseList={collapseList}
        loadMore={loadMore}
        t={t}
      />

      {/* Footer stats */}
      {totalSessions > 0 && (
        <div className="shrink-0 px-3 py-2 text-2xs text-muted-foreground">
          {totalProjects} {t('history.allProjects').toLowerCase()} · {totalSessions}{' '}
          {t('workspace.projectSessions')}
        </div>
      )}
    </div>
  );
});
