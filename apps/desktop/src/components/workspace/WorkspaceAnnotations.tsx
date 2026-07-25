import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, MessageSquareQuote, Pencil, Plus, Trash2, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import {
  MAX_WORKSPACE_SELECTION_CHARS,
  normalizeWorkspaceSelection,
  type WorkspaceAnnotation,
  type WorkspaceAnnotationAnchor,
} from './workspaceAnnotationModel';
import {
  captureWorkspaceAnnotationAnchor,
  resolveWorkspaceAnnotationRange,
} from './workspaceAnnotationAnchors';
import {
  visibleTextRangeRects,
  type ViewportRect,
} from './workspaceAnnotationRects';

interface SelectionCandidate {
  quote: string;
  anchor: WorkspaceAnnotationAnchor;
  rects: ViewportRect[];
  left: number;
  top: number;
  editing: boolean;
}

interface AnnotationPlacement {
  annotation: WorkspaceAnnotation;
  index: number;
  rects: ViewportRect[];
  markerLeft: number;
  markerTop: number;
}

interface WorkspaceTranscriptSelectionProps {
  rootRef: RefObject<HTMLElement | null>;
  scopeKey: string;
  isActive?: boolean;
  canCreate?: boolean;
  canAdd: boolean;
  annotations: WorkspaceAnnotation[];
  onAdd: (quote: string, note: string, anchor?: WorkspaceAnnotationAnchor) => boolean;
  onUpdate: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}

function selectionNodeIsInside(root: HTMLElement, node: Node | null): boolean {
  return Boolean(node && (node === root || root.contains(node)));
}

function useAnnotationPlacements(
  rootRef: RefObject<HTMLElement | null>,
  annotations: WorkspaceAnnotation[],
  isActive: boolean,
): AnnotationPlacement[] {
  const [placements, setPlacements] = useState<AnnotationPlacement[]>([]);
  const annotationKey = useMemo(
    () => annotations.map((annotation) => [
      annotation.id,
      annotation.quote,
      annotation.anchor?.startItemKey ?? '',
      annotation.anchor?.startOffset ?? '',
      annotation.anchor?.endItemKey ?? '',
      annotation.anchor?.endOffset ?? '',
    ].join(':')).join('|'),
    [annotations],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isActive) {
      setPlacements([]);
      return;
    }

    let frame: number | null = null;
    const refresh = () => {
      frame = null;
      const next = annotations.flatMap<AnnotationPlacement>((annotation, index) => {
        const range = resolveWorkspaceAnnotationRange(root, annotation);
        if (!range) {
          return [];
        }
        const rects = visibleTextRangeRects(range, root);
        const lastRect = rects[rects.length - 1];
        if (!lastRect) {
          return [];
        }
        return [{
          annotation,
          index,
          rects,
          markerLeft: Math.max(12, Math.min(window.innerWidth - 32, lastRect.right + 8)),
          markerTop: Math.max(8, Math.min(window.innerHeight - 28, lastRect.top - 2)),
        }];
      });

      next.sort((left, right) => left.markerTop - right.markerTop);
      next.forEach((placement, index) => {
        const previous = next[index - 1];
        if (
          previous
          && Math.abs(placement.markerLeft - previous.markerLeft) < 30
          && placement.markerTop - previous.markerTop < 24
        ) {
          placement.markerTop = Math.min(window.innerHeight - 28, previous.markerTop + 24);
        }
      });
      setPlacements(next);
    };
    const scheduleRefresh = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(refresh);
    };

    refresh();
    root.addEventListener('scroll', scheduleRefresh, { passive: true });
    window.addEventListener('resize', scheduleRefresh);
    const mutationObserver = new MutationObserver(scheduleRefresh);
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleRefresh);
    resizeObserver?.observe(root);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      root.removeEventListener('scroll', scheduleRefresh);
      window.removeEventListener('resize', scheduleRefresh);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [annotationKey, annotations, isActive, rootRef]);

  return placements;
}

export function WorkspaceTranscriptSelection({
  rootRef,
  scopeKey,
  isActive = true,
  canCreate = true,
  canAdd,
  annotations,
  onAdd,
  onUpdate,
  onRemove,
}: WorkspaceTranscriptSelectionProps) {
  const { t } = useLocale();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const savedEditorRef = useRef<HTMLDivElement | null>(null);
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const [note, setNote] = useState('');
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState('');
  const placements = useAnnotationPlacements(rootRef, annotations, isActive);
  const hasSelectionCandidate = Boolean(candidate);

  const dismiss = useCallback(() => {
    setCandidate(null);
    setNote('');
  }, []);

  const dismissSavedEditor = useCallback(() => {
    setEditingAnnotationId(null);
    setEditingAnnotationNote('');
  }, []);

  const captureSelection = useCallback((event?: Event) => {
    if (!isActive || !canCreate) {
      return;
    }
    const target = event?.target;
    if (target instanceof Element && target.closest('[data-workspace-selection-action]')) {
      return;
    }

    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      if (!candidate?.editing) {
        dismiss();
      }
      return;
    }
    if (
      !selectionNodeIsInside(root, selection.anchorNode)
      || !selectionNodeIsInside(root, selection.focusNode)
    ) {
      if (!candidate?.editing) {
        dismiss();
      }
      return;
    }

    const rawText = selection.toString();
    const quote = normalizeWorkspaceSelection(rawText);
    if (!quote) {
      if (rawText.trim().length > MAX_WORKSPACE_SELECTION_CHARS) {
        setCandidate(null);
      } else if (!candidate?.editing) {
        dismiss();
      }
      return;
    }

    const range = selection.getRangeAt(0);
    const anchor = captureWorkspaceAnnotationAnchor(root, range);
    const rects = visibleTextRangeRects(range, root);
    const lastRect = rects[rects.length - 1];
    if (!anchor || !lastRect) {
      return;
    }
    setCandidate({
      quote,
      anchor,
      rects,
      left: Math.max(124, Math.min(window.innerWidth - 124, lastRect.left + lastRect.width / 2)),
      top: Math.max(12, Math.min(window.innerHeight - 72, lastRect.bottom + 8)),
      editing: false,
    });
    setNote('');
  }, [canCreate, candidate?.editing, dismiss, isActive, rootRef]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        !candidate?.editing
        && !(target instanceof Element && target.closest('[data-workspace-selection-action]'))
      ) {
        dismiss();
      }
    };
    const handleMouseUp = (event: MouseEvent) => captureSelection(event);
    const handleKeyDown = (event: KeyboardEvent) => {
      const changesSelection = (
        event.shiftKey
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
          .includes(event.key)
      ) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a');
      if (
        !candidate?.editing
        && changesSelection
      ) {
        dismiss();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
        dismissSavedEditor();
        return;
      }
      if (event.key.startsWith('Arrow') || event.key === 'Shift') {
        captureSelection(event);
      }
    };
    const handleResize = () => dismiss();
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [candidate?.editing, captureSelection, dismiss, dismissSavedEditor]);

  useEffect(() => {
    dismiss();
    dismissSavedEditor();
    window.getSelection()?.removeAllRanges();
  }, [dismiss, dismissSavedEditor, isActive, scopeKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    if (hasSelectionCandidate) {
      root.dataset.workspaceSelectionHighlightActive = 'true';
    } else {
      delete root.dataset.workspaceSelectionHighlightActive;
    }
    return () => {
      delete root.dataset.workspaceSelectionHighlightActive;
    };
  }, [hasSelectionCandidate, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    root.addEventListener('scroll', dismiss, { passive: true });
    return () => root.removeEventListener('scroll', dismiss);
  }, [dismiss, rootRef]);

  useEffect(() => {
    if (!candidate?.editing) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        dismiss();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [candidate?.editing, dismiss]);

  useEffect(() => {
    if (!editingAnnotationId) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !savedEditorRef.current?.contains(target)
        && !(target instanceof Element && target.closest('[data-workspace-annotation-marker]'))
      ) {
        dismissSavedEditor();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [dismissSavedEditor, editingAnnotationId]);

  if (!isActive || typeof document === 'undefined') {
    return null;
  }

  const save = () => {
    if (!candidate || !note.trim()) {
      return;
    }
    if (onAdd(candidate.quote, note, candidate.anchor)) {
      window.getSelection()?.removeAllRanges();
      dismiss();
    }
  };

  const editingPlacement = editingAnnotationId
    ? placements.find((placement) => placement.annotation.id === editingAnnotationId) ?? null
    : null;

  return createPortal(
    <>
      <div className="pointer-events-none fixed inset-0 z-[70]" aria-hidden="true">
        {placements.flatMap((placement) => placement.rects.map((rect, rectIndex) => (
          <span
            key={`${placement.annotation.id}:${rectIndex}`}
            data-workspace-selection-highlight="saved"
            className="fixed rounded-[2px] bg-primary/15 ring-1 ring-inset ring-primary/15"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        )))}
        {candidate ? candidate.rects.map((rect, index) => (
          <span
            key={`candidate:${index}`}
            data-workspace-selection-highlight="candidate"
            className="fixed rounded-[2px] bg-primary/20 ring-1 ring-inset ring-primary/25"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        )) : null}
      </div>

      {placements.map((placement) => {
        const tooltipOnLeft = placement.markerLeft > window.innerWidth - 300;
        return (
          <div
            key={placement.annotation.id}
            data-workspace-selection-action
            data-workspace-annotation-marker
            className="group fixed z-[90]"
            style={{ left: placement.markerLeft, top: placement.markerTop }}
          >
            <button
              type="button"
              aria-label={t('workspace.composerAnnotationEdit')}
              className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground shadow-[0_4px_14px_rgba(0,122,255,0.28)] transition-transform hover:scale-105"
              onClick={() => {
                setEditingAnnotationId(placement.annotation.id);
                setEditingAnnotationNote(placement.annotation.note);
                dismiss();
              }}
            >
              {placement.index + 1}
            </button>
            {editingAnnotationId !== placement.annotation.id ? (
              <div
                className={cn(
                  'pointer-events-none absolute top-1/2 w-[min(300px,calc(100vw-56px))] -translate-y-1/2 rounded-xl border border-border/45 bg-popover px-3 py-2 text-xs leading-5 text-foreground opacity-0 shadow-xl transition-opacity group-hover:opacity-100',
                  tooltipOnLeft ? 'right-8' : 'left-8',
                )}
              >
                <p className="line-clamp-4 whitespace-pre-wrap">{placement.annotation.note}</p>
              </div>
            ) : null}
          </div>
        );
      })}

      {editingPlacement ? (
        <div
          ref={savedEditorRef}
          data-workspace-selection-action
          className="fixed z-[100] w-[min(340px,calc(100vw-24px))] rounded-2xl border border-border/45 bg-popover p-3 shadow-xl"
          style={{
            left: Math.max(12, Math.min(
              window.innerWidth - Math.min(340, window.innerWidth - 24) - 12,
              editingPlacement.markerLeft > window.innerWidth - 380
                ? editingPlacement.markerLeft - 348
                : editingPlacement.markerLeft + 30,
            )),
            top: Math.max(12, Math.min(window.innerHeight - 190, editingPlacement.markerTop - 12)),
          }}
        >
          <div className="mb-2 flex items-start gap-2">
            <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="line-clamp-3 text-[11px] leading-4.5 text-muted-foreground">
              {editingPlacement.annotation.quote}
            </p>
          </div>
          <textarea
            autoFocus
            maxLength={4_000}
            value={editingAnnotationNote}
            onChange={(event) => setEditingAnnotationNote(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && editingAnnotationNote.trim()) {
                event.preventDefault();
                onUpdate(editingPlacement.annotation.id, editingAnnotationNote);
                dismissSavedEditor();
              }
            }}
            className="min-h-[72px] w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className="rounded-full p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('workspace.composerAnnotationRemove')}
              onClick={() => {
                onRemove(editingPlacement.annotation.id);
                dismissSavedEditor();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <div className="flex gap-1.5">
              <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-3" onClick={dismissSavedEditor}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 rounded-full px-3"
                disabled={!editingAnnotationNote.trim()}
                onClick={() => {
                  onUpdate(editingPlacement.annotation.id, editingAnnotationNote);
                  dismissSavedEditor();
                }}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {candidate ? (
        <div
          ref={panelRef}
          data-workspace-selection-action
          className={cn(
            'fixed z-[100] -translate-x-1/2 rounded-2xl border border-border/45 bg-popover shadow-xl',
            candidate.editing ? 'w-[min(420px,calc(100vw-24px))] p-3' : 'p-1',
          )}
          style={{ left: candidate.left, top: candidate.top }}
          onMouseDown={(event) => {
            if (!candidate.editing) {
              event.preventDefault();
            }
          }}
        >
          {candidate.editing ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-2">
                <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="line-clamp-3 text-xs leading-5 text-foreground/80">
                  {candidate.quote}
                </p>
              </div>
              <textarea
                autoFocus
                maxLength={4_000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    save();
                  }
                }}
                placeholder={t('workspace.selectionAnnotationPlaceholder')}
                className="min-h-[72px] w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {t('workspace.selectionAnnotationSubmitHint')}
                </span>
                <div className="flex gap-1.5">
                  <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-3" onClick={dismiss}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="button" size="sm" className="h-7 rounded-full px-3" disabled={!note.trim()} onClick={save}>
                    <Check className="mr-1 h-3.5 w-3.5" />
                    {t('workspace.selectionAnnotationAdd')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-xl px-3"
              disabled={!canAdd}
              onClick={() => {
                setCandidate((current) => current ? {
                  ...current,
                  editing: true,
                  top: Math.max(12, Math.min(current.top, window.innerHeight - 230)),
                } : current);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t(canAdd ? 'workspace.selectionAddToTask' : 'workspace.selectionAnnotationLimit')}
            </Button>
          )}
        </div>
      ) : null}
    </>,
    document.body,
  );
}

interface WorkspaceComposerAnnotationsProps {
  annotations: WorkspaceAnnotation[];
  onUpdate: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

export function WorkspaceComposerAnnotations({
  annotations,
  onUpdate,
  onRemove,
  onClear,
}: WorkspaceComposerAnnotationsProps) {
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState('');
  const countLabel = useMemo(
    () => t('workspace.composerAnnotationCount').replace('{count}', String(annotations.length)),
    [annotations.length, t],
  );

  if (annotations.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/40 bg-surface px-2.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-muted/60"
          >
            <MessageSquareQuote className="h-3.5 w-3.5 text-muted-foreground" />
            {countLabel}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-[min(440px,calc(100vw-24px))] rounded-2xl border-border/45 bg-popover p-2 shadow-xl"
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-xs font-semibold">{t('workspace.composerAnnotationsTitle')}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-2 text-[10px]" onClick={onClear}>
              <Trash2 className="mr-1 h-3 w-3" />
              {t('workspace.composerAnnotationsClear')}
            </Button>
          </div>
          <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
            {annotations.map((annotation, index) => (
              <div key={annotation.id} className="rounded-xl bg-surface px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-muted-foreground">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 text-[11px] leading-4.5 text-muted-foreground">
                      {annotation.quote}
                    </p>
                    {editingId === annotation.id ? (
                      <div className="mt-2 space-y-1.5">
                        <textarea
                          autoFocus
                          maxLength={4_000}
                          value={editingNote}
                          onChange={(event) => setEditingNote(event.target.value)}
                          className="min-h-[64px] w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        />
                        <div className="flex justify-end gap-1">
                          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setEditingId(null)}>
                            {t('common.cancel')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={!editingNote.trim()}
                            onClick={() => {
                              onUpdate(annotation.id, editingNote);
                              setEditingId(null);
                            }}
                          >
                            {t('common.save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-foreground/90">{annotation.note}</p>
                    )}
                  </div>
                  {editingId !== annotation.id ? (
                    <div className="flex shrink-0 gap-0.5">
                      <button
                        type="button"
                        className="rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        aria-label={t('workspace.composerAnnotationEdit')}
                        onClick={() => {
                          setEditingId(annotation.id);
                          setEditingNote(annotation.note);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        aria-label={t('workspace.composerAnnotationRemove')}
                        onClick={() => onRemove(annotation.id)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label={t('workspace.composerAnnotationsClear')}
        onClick={onClear}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
