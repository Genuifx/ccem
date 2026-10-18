import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Check, Copy, MessageSquareQuote, Pencil, Plus, Trash2, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import {
  MAX_WORKSPACE_SELECTION_CHARS,
  normalizeWorkspaceSelection,
  type WorkspaceAnnotation,
  type WorkspaceAnnotationAnchor,
  type WorkspaceAnnotationAppearance,
  type WorkspaceAnnotationColor,
  type WorkspaceAnnotationHighlightStyle,
} from './workspaceAnnotationModel';
import {
  captureWorkspaceAnnotationAnchor,
  domTextBetween,
  resolveWorkspaceAnnotationRanges,
} from './workspaceAnnotationAnchors';
import {
  visibleTextRangeRects,
  type ViewportRect,
} from './workspaceAnnotationRects';
import {
  WorkspaceAnnotationAppearanceControls,
  WorkspaceAnnotationColorPalette,
  WorkspaceAnnotationStyleToggle,
  useWorkspaceAnnotationAppearance,
} from './WorkspaceAnnotationAppearance';

interface SelectionCandidate {
  quote: string | null;
  anchor: WorkspaceAnnotationAnchor | null;
  blocked: boolean;
  rects: ViewportRect[];
  left: number;
  top: number;
  /** Separate color capsule anchored above the selection. */
  colorLeft: number;
  colorTop: number;
  editing: boolean;
  style: WorkspaceAnnotationHighlightStyle;
  color: WorkspaceAnnotationColor;
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
  /** Scroll content wrapper; highlights and markers are positioned inside it. */
  contentRef: RefObject<HTMLElement | null>;
  scopeKey: string;
  isActive?: boolean;
  canCreate?: boolean;
  canAdd: boolean;
  annotations: WorkspaceAnnotation[];
  onAdd: (
    quote: string,
    note: string,
    anchor?: WorkspaceAnnotationAnchor,
    appearance?: WorkspaceAnnotationAppearance,
  ) => boolean;
  onUpdate: (
    id: string,
    note: string,
    appearance?: Partial<WorkspaceAnnotationAppearance>,
  ) => boolean;
  onRemove: (id: string) => void;
}

function selectionNodeIsInside(root: HTMLElement, node: Node | null): boolean {
  return Boolean(node && (node === root || root.contains(node)));
}

const PLACEMENT_REFRESH_MIN_INTERVAL_MS = 200;
const ANNOTATION_LAYER_SELECTOR = '[data-workspace-annotation-layer]';
// Content-space highlights keep every line of a selection, unlike the old
// viewport-clipped overlay. Cap the DOM cost for pathologically long quotes.
const MAX_HIGHLIGHT_RECTS_PER_SELECTION = 500;

/** Convert viewport rects to coordinates relative to the scroll content box. */
function toContentRects(
  rects: ViewportRect[],
  origin: Pick<ViewportRect, 'left' | 'top'>,
): ViewportRect[] {
  return rects.map((rect) => ({
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  }));
}

function rectsEqual(left: ViewportRect[], right: ViewportRect[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((rect, index) => (
    rect.left === right[index].left
    && rect.top === right[index].top
    && rect.width === right[index].width
    && rect.height === right[index].height
  ));
}

function placementsEqual(left: AnnotationPlacement[], right: AnnotationPlacement[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((placement, index) => {
    const other = right[index];
    return placement.annotation === other.annotation
      && placement.index === other.index
      && placement.markerLeft === other.markerLeft
      && placement.markerTop === other.markerTop
      && rectsEqual(placement.rects, other.rects);
  });
}

function nodeInsideAnnotationLayer(node: Node | null): boolean {
  if (!node) {
    return false;
  }
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(ANNOTATION_LAYER_SELECTOR));
}

function mutationsTouchTranscript(records: MutationRecord[]): boolean {
  return records.some((record) => !nodeInsideAnnotationLayer(record.target));
}

function annotationMarkClass(
  style: WorkspaceAnnotationHighlightStyle,
  color: WorkspaceAnnotationColor,
): string {
  return cn(
    'absolute',
    `workspace-annotation-mark-${style}`,
    `workspace-annotation-color-${color}`,
  );
}

function useAnnotationPlacements(
  rootRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  annotations: WorkspaceAnnotation[],
  isActive: boolean,
): AnnotationPlacement[] {
  const [placements, setPlacements] = useState<AnnotationPlacement[]>([]);

  useEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content || !isActive || annotations.length === 0) {
      setPlacements((current) => (current.length === 0 ? current : []));
      return;
    }

    let frame: number | null = null;
    let fallbackTimer: number | null = null;
    let trailingTimer: number | null = null;
    let lastRunAt = 0;
    let disposed = false;

    const refresh = () => {
      frame = null;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      lastRunAt = Date.now();
      if (disposed) {
        return;
      }
      const contentRect = content.getBoundingClientRect();
      if (contentRect.width <= 0) {
        return;
      }
      // Batch resolution builds the transcript and text indexes once per pass
      // instead of re-querying/walking the DOM for every annotation.
      const ranges = resolveWorkspaceAnnotationRanges(root, annotations);
      const next = ranges.flatMap<AnnotationPlacement>((range, index) => {
        if (!range) {
          return [];
        }
        // Clip to the content box, not the viewport: offscreen lines keep
        // their highlight so native scrolling carries it into view.
        const rects = toContentRects(
          visibleTextRangeRects(range, root, contentRect),
          contentRect,
        ).slice(0, MAX_HIGHLIGHT_RECTS_PER_SELECTION);
        const lastRect = rects[rects.length - 1];
        if (!lastRect) {
          return [];
        }
        return [{
          annotation: annotations[index],
          index,
          rects,
          markerLeft: Math.max(4, Math.min(contentRect.width - 28, lastRect.right + 8)),
          markerTop: Math.max(4, Math.min(contentRect.height - 28, lastRect.top - 2)),
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
          placement.markerTop = Math.min(contentRect.height - 28, previous.markerTop + 24);
        }
      });
      setPlacements((current) => (placementsEqual(current, next) ? current : next));
    };

    const clearScheduled = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (trailingTimer !== null) {
        window.clearTimeout(trailingTimer);
        trailingTimer = null;
      }
    };

    const scheduleRefresh = () => {
      // Streaming transcripts mutate constantly; cap full recomputes to one
      // pass per interval with a trailing run so bursts stay cheap.
      const sinceLastRun = Date.now() - lastRunAt;
      if (sinceLastRun < PLACEMENT_REFRESH_MIN_INTERVAL_MS) {
        if (trailingTimer === null) {
          trailingTimer = window.setTimeout(() => {
            trailingTimer = null;
            refresh();
          }, PLACEMENT_REFRESH_MIN_INTERVAL_MS - sinceLastRun);
        }
        return;
      }
      clearScheduled();
      frame = requestAnimationFrame(refresh);
      // WKWebView suspends animation frames for occluded/background windows;
      // the timeout fallback keeps markers updating in that state.
      fallbackTimer = window.setTimeout(() => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
          refresh();
        }
      }, 250);
    };

    refresh();
    // No scroll listener: highlights and markers live in content coordinates,
    // so scrolling is handled by the compositor and never runs JS.
    window.addEventListener('resize', scheduleRefresh);
    const mutationObserver = new MutationObserver((records) => {
      // Ignore the overlay's own DOM updates or placement state would feed
      // back into another refresh pass.
      if (mutationsTouchTranscript(records)) {
        scheduleRefresh();
      }
    });
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleRefresh);
    resizeObserver?.observe(content);

    return () => {
      disposed = true;
      clearScheduled();
      window.removeEventListener('resize', scheduleRefresh);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [annotations, contentRef, isActive, rootRef]);

  return placements;
}

export function WorkspaceTranscriptSelection({
  rootRef,
  contentRef,
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
  // Live clone of the captured selection Range. DOM Ranges track boundary
  // nodes through mutations, so re-deriving rects from this Range re-anchors
  // the candidate highlight to the text as the transcript streams.
  const candidateRangeRef = useRef<Range | null>(null);
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const [note, setNote] = useState('');
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState('');
  // Viewport anchor captured when a marker opens the editor; the panel stays
  // put while the transcript scrolls beneath it.
  const [savedEditorAnchor, setSavedEditorAnchor] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const {
    appearance: defaultAppearance,
    setStyle: setDefaultStyle,
    setColor: setDefaultColor,
  } = useWorkspaceAnnotationAppearance();
  const placements = useAnnotationPlacements(rootRef, contentRef, annotations, isActive);
  const hasSelectionCandidate = Boolean(candidate);

  const appearanceFor = useCallback((annotation: WorkspaceAnnotation): WorkspaceAnnotationAppearance => ({
    style: annotation.highlightStyle ?? defaultAppearance.style,
    color: annotation.highlightColor ?? defaultAppearance.color,
  }), [defaultAppearance.color, defaultAppearance.style]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const dismiss = useCallback(() => {
    setCandidate(null);
    setNote('');
    setCopied(false);
    candidateRangeRef.current = null;
  }, []);

  const dismissSavedEditor = useCallback(() => {
    setEditingAnnotationId(null);
    setEditingAnnotationNote('');
    setSavedEditorAnchor(null);
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
    const content = contentRef.current;
    const selection = window.getSelection();
    if (!root || !content || !selection || selection.isCollapsed || selection.rangeCount === 0) {
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
    const range = selection.getRangeAt(0);
    const anchor = captureWorkspaceAnnotationAnchor(root, range);
    const viewportRects = visibleTextRangeRects(range, root);
    const lastRect = viewportRects[viewportRects.length - 1];
    const contentRect = content.getBoundingClientRect();
    const rects = toContentRects(
      visibleTextRangeRects(range, root, contentRect),
      contentRect,
    ).slice(0, MAX_HIGHLIGHT_RECTS_PER_SELECTION);

    // The canonical quote comes from the anchor's raw DOM text space.
    // selection.toString() carries WebKit's synthetic block-boundary newlines
    // which never exist in the DOM and would make the quote unresolvable on
    // every later render.
    const quote = anchor
      ? normalizeWorkspaceSelection(domTextBetween(root, anchor) ?? '')
      : null;

    if (!quote) {
      if (rawText.trim().length > MAX_WORKSPACE_SELECTION_CHARS && lastRect) {
        // Surface why the panel will not offer "add" instead of vanishing.
        const colorAnchor = viewportRects[0] ?? lastRect;
        candidateRangeRef.current = range.cloneRange();
        setCandidate({
          quote: null,
          anchor: null,
          blocked: true,
          rects,
          left: Math.max(170, Math.min(window.innerWidth - 170, lastRect.left + lastRect.width / 2)),
          top: Math.max(12, Math.min(window.innerHeight - 80, lastRect.bottom + 8)),
          colorLeft: Math.max(70, Math.min(window.innerWidth - 70, colorAnchor.left + colorAnchor.width / 2)),
          colorTop: Math.max(12, colorAnchor.top - 44),
          editing: false,
          style: defaultAppearance.style,
          color: defaultAppearance.color,
        });
        setNote('');
      } else if (!candidate?.editing) {
        dismiss();
      }
      return;
    }

    if (!lastRect) {
      return;
    }
    const colorAnchor = viewportRects[0] ?? lastRect;
    candidateRangeRef.current = range.cloneRange();
    setCandidate({
      quote,
      anchor,
      blocked: false,
      rects,
      left: Math.max(170, Math.min(window.innerWidth - 170, lastRect.left + lastRect.width / 2)),
      top: Math.max(12, Math.min(window.innerHeight - 80, lastRect.bottom + 8)),
      colorLeft: Math.max(70, Math.min(window.innerWidth - 70, colorAnchor.left + colorAnchor.width / 2)),
      colorTop: Math.max(12, colorAnchor.top - 44),
      editing: false,
      style: defaultAppearance.style,
      color: defaultAppearance.color,
    });
    setNote('');
  }, [
    canCreate,
    candidate?.editing,
    contentRef,
    defaultAppearance.color,
    defaultAppearance.style,
    dismiss,
    isActive,
    rootRef,
  ]);

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
        // Escape must not silently discard a note the user is typing; they
        // can still close via the cancel button or by clearing the text.
        const target = event.target;
        if (
          target instanceof HTMLTextAreaElement
          && target.closest('[data-workspace-selection-action]')
          && target.value.trim().length > 0
        ) {
          return;
        }
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

  // The candidate highlight lives in content coordinates captured at mouseup,
  // so scrolling needs no refresh. Streaming mutations can still move the
  // selected text; re-derive rects from the captured live Range then.
  useEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content || !hasSelectionCandidate) {
      return;
    }

    let frame: number | null = null;
    let fallbackTimer: number | null = null;

    const refresh = () => {
      frame = null;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      const range = candidateRangeRef.current;
      if (!range) {
        return;
      }
      const contentRect = content.getBoundingClientRect();
      const rects = toContentRects(
        visibleTextRangeRects(range, root, contentRect),
        contentRect,
      ).slice(0, MAX_HIGHLIGHT_RECTS_PER_SELECTION);
      setCandidate((current) => {
        if (!current || rectsEqual(current.rects, rects)) {
          return current;
        }
        return { ...current, rects };
      });
    };

    const scheduleRefresh = () => {
      if (frame === null) {
        frame = requestAnimationFrame(refresh);
        // WKWebView suspends animation frames for occluded/background
        // windows; the timeout fallback keeps the highlight anchored to the
        // text in that state (same contract as annotation placements).
        fallbackTimer = window.setTimeout(() => {
          if (frame !== null) {
            cancelAnimationFrame(frame);
            refresh();
          }
        }, 250);
      }
    };

    window.addEventListener('resize', scheduleRefresh);
    const mutationObserver = new MutationObserver((records) => {
      if (mutationsTouchTranscript(records)) {
        scheduleRefresh();
      }
    });
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
      }
      window.removeEventListener('resize', scheduleRefresh);
      mutationObserver.disconnect();
    };
  }, [contentRef, hasSelectionCandidate, rootRef]);

  // NOTE: no scroll-to-dismiss here — streaming sessions auto-scroll
  // continuously, which would destroy the candidate panel the instant it
  // appears. Escape, the cancel button, or clicking elsewhere still close it.

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
    if (!candidate?.quote || !note.trim()) {
      return;
    }
    if (onAdd(candidate.quote, note, candidate.anchor ?? undefined, {
      style: candidate.style,
      color: candidate.color,
    })) {
      window.getSelection()?.removeAllRanges();
      dismiss();
    } else {
      toast.error(t('workspace.annotationSaveFailed'));
    }
  };

  const copySelection = async () => {
    if (!candidate?.quote) {
      return;
    }
    try {
      await navigator.clipboard.writeText(candidate.quote);
      setCopied(true);
    } catch {
      toast.error(t('workspace.annotationCopyFailed'));
    }
  };

  const updateCandidateStyle = (style: WorkspaceAnnotationHighlightStyle) => {
    setDefaultStyle(style);
    setCandidate((current) => (current ? { ...current, style } : current));
  };

  const updateCandidateColor = (color: WorkspaceAnnotationColor) => {
    setDefaultColor(color);
    setCandidate((current) => (current ? { ...current, color } : current));
  };

  const editingAnnotation = editingAnnotationId
    ? annotations.find((annotation) => annotation.id === editingAnnotationId) ?? null
    : null;
  const editingAppearance = editingAnnotation ? appearanceFor(editingAnnotation) : null;

  const updateEditingAppearance = (patch: Partial<WorkspaceAnnotationAppearance>) => {
    if (!editingAnnotation) {
      return;
    }
    if (!onUpdate(editingAnnotation.id, editingAnnotation.note, patch)) {
      toast.error(t('workspace.annotationSaveFailed'));
    }
  };

  const contentWidth = contentRef.current?.clientWidth ?? window.innerWidth;

  return (
    <>
      {/* Saved + candidate highlights live in content coordinates, so native
          scrolling carries them with the text and no scroll listener or
          per-frame rect work is needed. They stay inside the transcript's
          stacking context instead of floating above dialogs. */}
      <div
        data-workspace-annotation-layer
        className="pointer-events-none absolute inset-0 z-0"
        aria-hidden="true"
      >
        {placements.flatMap((placement) => {
          const appearance = appearanceFor(placement.annotation);
          return placement.rects.map((rect, rectIndex) => (
            <span
              key={`${placement.annotation.id}:${rectIndex}`}
              data-workspace-selection-highlight="saved"
              data-annotation-style={appearance.style}
              data-annotation-color={appearance.color}
              className={annotationMarkClass(appearance.style, appearance.color)}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ));
        })}
        {candidate ? candidate.rects.map((rect, index) => (
          <span
            key={`candidate:${index}`}
            data-workspace-selection-highlight="candidate"
            data-annotation-style={candidate.style}
            data-annotation-color={candidate.color}
            data-candidate="true"
            className={annotationMarkClass(candidate.style, candidate.color)}
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        )) : null}
      </div>

      <div
        data-workspace-annotation-layer
        className="pointer-events-none absolute inset-0 z-10 select-none"
      >
        {placements.map((placement) => {
          const tooltipOnLeft = placement.markerLeft > contentWidth - 320;
          const appearance = appearanceFor(placement.annotation);
          return (
            <div
              key={placement.annotation.id}
              data-workspace-selection-action
              data-workspace-annotation-marker
              className="group absolute"
              style={{ left: placement.markerLeft, top: placement.markerTop }}
            >
              <button
                type="button"
                aria-label={t('workspace.composerAnnotationEdit')}
                className={cn(
                  'workspace-annotation-marker-badge pointer-events-auto flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold transition-transform hover:scale-105',
                  `workspace-annotation-color-${appearance.color}`,
                )}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setSavedEditorAnchor({ left: rect.left, top: rect.top });
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
      </div>

      {createPortal(
        <>
          {editingAnnotation && savedEditorAnchor ? (
            <div
              ref={savedEditorRef}
              data-ccem-native-overlay
              data-workspace-selection-action
              className="fixed z-50 w-[min(340px,calc(100vw-24px))] rounded-2xl border border-border/45 bg-popover p-3 shadow-xl"
              style={{
                left: Math.max(12, Math.min(
                  window.innerWidth - Math.min(340, window.innerWidth - 24) - 12,
                  savedEditorAnchor.left > window.innerWidth - 380
                    ? savedEditorAnchor.left - 348
                    : savedEditorAnchor.left + 30,
                )),
                top: Math.max(12, Math.min(window.innerHeight - 230, savedEditorAnchor.top - 12)),
              }}
            >
              <div className="mb-2 flex items-start gap-2">
                <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="line-clamp-3 text-[11px] leading-4.5 text-muted-foreground">
                  {editingAnnotation.quote}
                </p>
              </div>
              {editingAppearance ? (
                <WorkspaceAnnotationAppearanceControls
                  className="mb-2"
                  style={editingAppearance.style}
                  color={editingAppearance.color}
                  onStyleChange={(style) => updateEditingAppearance({ style })}
                  onColorChange={(color) => updateEditingAppearance({ color })}
                />
              ) : null}
              <textarea
                autoFocus
                maxLength={4_000}
                value={editingAnnotationNote}
                onChange={(event) => setEditingAnnotationNote(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && editingAnnotationNote.trim()) {
                    event.preventDefault();
                    if (onUpdate(editingAnnotation.id, editingAnnotationNote, editingAppearance ?? undefined)) {
                      dismissSavedEditor();
                    } else {
                      toast.error(t('workspace.annotationSaveFailed'));
                    }
                  }
                }}
                className="min-h-[72px] w-full resize-none overflow-x-hidden rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t('workspace.composerAnnotationRemove')}
                  onClick={() => {
                    onRemove(editingAnnotation.id);
                    dismissSavedEditor();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <div className="flex items-center gap-1.5">
                  <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-3" onClick={dismissSavedEditor}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    disabled={!editingAnnotationNote.trim()}
                    onClick={() => {
                      if (onUpdate(editingAnnotation.id, editingAnnotationNote, editingAppearance ?? undefined)) {
                        dismissSavedEditor();
                      } else {
                        toast.error(t('workspace.annotationSaveFailed'));
                      }
                    }}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {candidate?.editing ? (
            <div
              ref={panelRef}
              data-ccem-native-overlay
              data-workspace-selection-action
              className="fixed z-50 w-[min(420px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-border/45 bg-popover p-3 shadow-xl"
              style={{ left: candidate.left, top: candidate.top }}
            >
              <div className="space-y-2.5">
                <div className="flex items-start gap-2">
                  <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="line-clamp-3 text-xs leading-5 text-foreground/80">
                    {candidate.quote}
                  </p>
                </div>
                <WorkspaceAnnotationAppearanceControls
                  style={candidate.style}
                  color={candidate.color}
                  onStyleChange={updateCandidateStyle}
                  onColorChange={updateCandidateColor}
                />
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
                  className="min-h-[72px] w-full resize-none overflow-x-hidden rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
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
            </div>
          ) : null}

          {candidate?.blocked ? (
            <div
              data-ccem-native-overlay
              data-workspace-selection-action
              data-workspace-annotation-blocked
              className="fixed z-50 -translate-x-1/2 rounded-full border border-border/45 bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-xl"
              style={{ left: candidate.left, top: candidate.top }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {t('workspace.selectionTooLong')}
            </div>
          ) : null}

          {candidate && !candidate.editing && !candidate.blocked ? (
            <>
              <div
                data-ccem-native-overlay
                data-workspace-selection-action
                data-workspace-annotation-color-bubble
                className="fixed z-50 -translate-x-1/2 rounded-full border border-border/45 bg-popover p-1.5 shadow-xl"
                style={{ left: candidate.colorLeft, top: candidate.colorTop }}
                onMouseDown={(event) => event.preventDefault()}
              >
                <WorkspaceAnnotationColorPalette
                  color={candidate.color}
                  onColorChange={updateCandidateColor}
                />
              </div>

              <div
                data-ccem-native-overlay
                data-workspace-selection-action
                data-workspace-annotation-action-bar
                className="fixed z-50 -translate-x-1/2 rounded-full border border-border/45 bg-popover p-1 shadow-xl"
                style={{ left: candidate.left, top: candidate.top }}
                onMouseDown={(event) => event.preventDefault()}
              >
                <div className="flex items-center gap-1">
                  <WorkspaceAnnotationStyleToggle
                    style={candidate.style}
                    onStyleChange={updateCandidateStyle}
                  />
                  <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 rounded-full p-0"
                    aria-label={t(copied ? 'workspace.annotationCopied' : 'workspace.annotationCopy')}
                    title={t(copied ? 'workspace.annotationCopied' : 'workspace.annotationCopy')}
                    onClick={() => void copySelection()}
                  >
                    {copied
                      ? <Check className="h-3.5 w-3.5" />
                      : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 rounded-full px-3 text-[11px]"
                    disabled={!canAdd}
                    onClick={() => {
                      setCandidate((current) => current ? {
                        ...current,
                        editing: true,
                        // The note editor is taller and wider; keep it fully
                        // on screen when the selection sits near an edge.
                        left: Math.max(220, Math.min(window.innerWidth - 220, current.left)),
                        top: Math.max(12, Math.min(current.top, window.innerHeight - 250)),
                      } : current);
                      window.getSelection()?.removeAllRanges();
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t(canAdd ? 'workspace.selectionAddToTask' : 'workspace.selectionAnnotationLimit')}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </>,
        document.body,
      )}
    </>
  );
}

interface WorkspaceComposerAnnotationsProps {
  annotations: WorkspaceAnnotation[];
  onUpdate: (id: string, note: string) => boolean;
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
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
            <span className="min-w-0 truncate text-xs font-semibold">{t('workspace.composerAnnotationsTitle')}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 rounded-full px-2 text-[10px]" onClick={onClear}>
              <Trash2 className="mr-1 h-3 w-3" />
              {t('workspace.composerAnnotationsClear')}
            </Button>
          </div>
          <ScrollArea className="max-h-[320px] min-h-0">
            <div className="space-y-1.5">
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
                          className="min-h-[64px] w-full resize-none overflow-x-hidden rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
          </ScrollArea>
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
