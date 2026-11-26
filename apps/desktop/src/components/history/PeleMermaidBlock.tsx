import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  detectType,
  load,
  mount,
  registered,
  type DiagramType,
  type MountOptions,
  type Mounted,
  type RenderResult,
} from 'pele/lazy';
import { Check, Code, Copy, Eye, Maximize2, X } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { Dialog, DialogContent } from '@/components/ui/dialog';

interface PeleMermaidBlockProps {
  code: string;
  codeTone?: 'default' | 'reading';
}

type RenderStatus = 'pending' | 'ready' | 'error';

const CONTAINER_ANCESTOR_SELECTOR =
  '.workspace-msg-virtualized, [data-ccem-markdown-preview], [data-workspace-transcript-column]';

const CODE_FONT_FAMILY = "'JetBrains Mono', 'SF Mono', 'Cascadia Code', monospace";

function formatErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || 'Invalid Mermaid syntax';
}

function resolveAvailableWidth(host: HTMLElement | null, horizontalInset: number): number | undefined {
  if (!host) return undefined;
  const ancestor = host.closest<HTMLElement>(CONTAINER_ANCESTOR_SELECTOR);
  const measuredWidth = Math.max(ancestor?.clientWidth ?? 0, host.clientWidth);
  if (measuredWidth <= 0) return undefined;
  return Math.max(240, measuredWidth - horizontalInset);
}

function useAvailableDiagramWidth(
  hostRef: React.RefObject<HTMLDivElement | null>,
  horizontalInset: number,
  enabled: boolean,
): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;

    const updateWidth = () => {
      const next = resolveAvailableWidth(host, horizontalInset);
      setWidth((current) => (current === next ? current : next));
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const target = host.closest<HTMLElement>(CONTAINER_ANCESTOR_SELECTOR) ?? host;
    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) return;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          updateWidth();
        });
      } else {
        updateWidth();
      }
    });

    observer.observe(target);
    return () => {
      observer.disconnect();
      if (rafId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled, horizontalInset, hostRef]);

  return width;
}

interface PeleDiagramCanvasProps {
  code: string;
  zoom: 'auto' | boolean;
  horizontalInset: number;
  className?: string;
  onStatusChange?: (status: RenderStatus, diagramType: DiagramType | null, errorMessage: string | null) => void;
}

function PeleDiagramCanvas({
  code,
  zoom,
  horizontalInset,
  className,
  onStatusChange,
}: PeleDiagramCanvasProps) {
  const { t } = useLocale();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef<Mounted | null>(null);
  const hasRenderedRef = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const availableWidth = useAvailableDiagramWidth(hostRef, horizontalInset, true);

  const zoomOptions = useMemo<MountOptions['zoom']>(() => {
    if (zoom === false) return false;
    return {
      always: zoom === true,
      controls: true,
      maxScale: 4,
      labels: {
        zoomIn: t('history.mermaidZoomIn'),
        zoomOut: t('history.mermaidZoomOut'),
        reset: t('history.mermaidZoomReset'),
      },
    };
  }, [t, zoom]);

  const buildMountOptions = useCallback(
    (detectedType: DiagramType | null): MountOptions => ({
      responsive: true,
      maxWidth: availableWidth,
      autoDirection: true,
      padding: 12,
      images: false,
      linkSchemes: ['https', 'http'],
      zoom: zoomOptions,
      onRender: (result: RenderResult) => {
        hasRenderedRef.current = true;
        onStatusChangeRef.current?.('ready', result.type ?? detectedType, null);
      },
      onError: (error: unknown) => {
        const message = formatErrorSummary(error);
        if (hasRenderedRef.current) {
          onStatusChangeRef.current?.('ready', detectedType, message);
        } else {
          onStatusChangeRef.current?.('error', detectedType, message);
        }
      },
    }),
    [availableWidth, zoomOptions],
  );

  useEffect(() => () => {
    mountedRef.current?.destroy();
    mountedRef.current = null;
    hasRenderedRef.current = false;
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const trimmed = code.trim();
    if (!trimmed) {
      mountedRef.current?.destroy();
      mountedRef.current = null;
      hasRenderedRef.current = false;
      host.replaceChildren();
      onStatusChangeRef.current?.('pending', null, null);
      return;
    }

    let cancelled = false;
    let detected: DiagramType | null = null;
    try {
      detected = detectType(code);
    } catch {
      detected = null;
    }

    const applyMountOrUpdate = () => {
      if (cancelled || !hostRef.current) return;
      const options = buildMountOptions(detected);
      if (mountedRef.current) {
        mountedRef.current.update(code, options);
      } else {
        mountedRef.current = mount(hostRef.current, code, options);
      }
      if (!mountedRef.current.result && mountedRef.current.error) {
        // Keep the error state clean when no prior SVG exists; the frame shows
        // the calm source fallback instead of Pele's raw error pre block.
        hostRef.current.replaceChildren();
      }
    };

    if (!detected) {
      if (!hasRenderedRef.current) {
        mountedRef.current?.destroy();
        mountedRef.current = null;
        host.replaceChildren();
        onStatusChangeRef.current?.('pending', null, null);
      }
      return;
    }

    if (registered(detected)) {
      applyMountOrUpdate();
      return () => {
        cancelled = true;
      };
    }

    if (!hasRenderedRef.current) {
      onStatusChangeRef.current?.('pending', detected, null);
    }

    void load(detected)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) {
          if (!hasRenderedRef.current) {
            onStatusChangeRef.current?.('error', detected, `Unsupported diagram type: ${detected}`);
          }
          return;
        }
        applyMountOrUpdate();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!hasRenderedRef.current) {
          onStatusChangeRef.current?.('error', detected, formatErrorSummary(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [buildMountOptions, code]);

  return (
    <div
      ref={hostRef}
      data-pele-canvas="true"
      className={cn(
        'pele-diagram-host relative w-full',
        zoom === true ? 'overflow-hidden' : 'overflow-x-auto',
        className,
      )}
    />
  );
}

function MermaidCopyButton({ text, dark }: { text: string; dark: boolean }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
        dark
          ? 'text-white/45 hover:bg-white/[0.06] hover:text-white/80'
          : 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground',
      )}
      aria-label={copied ? t('history.copied') : t('history.copyCode')}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          {t('history.copied')}
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          {t('history.copyCode')}
        </>
      )}
    </button>
  );
}

export const PeleMermaidBlock = memo(function PeleMermaidBlock({
  code,
  codeTone = 'reading',
}: PeleMermaidBlockProps) {
  const { t } = useLocale();
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<RenderStatus>('pending');
  const [diagramType, setDiagramType] = useState<DiagramType | null>(() => {
    try {
      return detectType(code);
    } catch {
      return null;
    }
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleStatusChange = useCallback(
    (nextStatus: RenderStatus, nextType: DiagramType | null, nextError: string | null) => {
      setStatus(nextStatus);
      setDiagramType(nextType);
      setErrorMessage(nextError);
    },
    [],
  );

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  const isReading = codeTone === 'reading';
  const showSourceFallback = viewMode === 'source' || status !== 'ready';

  return (
    <div
      data-pele-mermaid="true"
      data-pele-state={status}
      data-pele-type={diagramType ?? ''}
      className={cn(
        'pele-diagram-surface my-3 overflow-hidden rounded-xl border',
        isReading
          ? 'shadow-[0_1px_2px_rgb(15_23_42/0.04)]'
          : 'border-[#1e1e2e]/50 bg-[#1e1e2e]',
      )}
      style={
        isReading
          ? {
              background: 'var(--pele-card-bg)',
              borderColor: 'var(--workspace-reading-code-border)',
            }
          : undefined
      }
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-b px-3 py-1.5',
          !isReading && 'border-white/[0.06]',
        )}
        style={
          isReading
            ? {
                background: 'var(--workspace-reading-code-header-bg)',
                borderColor: 'var(--workspace-reading-code-header-border)',
              }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'font-mono text-[10.5px] uppercase tracking-wider',
              !isReading && 'text-white/40',
            )}
            style={isReading ? { color: 'var(--workspace-reading-code-label)' } : undefined}
          >
            mermaid
          </span>
          {diagramType ? (
            <span
              className={cn(
                'truncate rounded px-1.5 py-0.5 font-mono text-[10px]',
                isReading
                  ? 'bg-background/60 text-muted-foreground/80'
                  : 'bg-white/[0.06] text-white/50',
              )}
            >
              {diagramType}
            </span>
          ) : null}
          {status === 'error' && errorMessage ? (
            <span
              title={errorMessage}
              className="truncate text-[10.5px] text-muted-foreground/75"
            >
              {t('history.mermaidRenderFallback')}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {status === 'ready' ? (
            <>
              <div
                role="group"
                className={cn(
                  'inline-flex items-center rounded-md p-0.5',
                  isReading ? 'bg-background/55' : 'bg-white/[0.06]',
                )}
              >
                <button
                  type="button"
                  onClick={() => setViewMode('preview')}
                  aria-pressed={viewMode === 'preview'}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                    viewMode === 'preview'
                      ? isReading
                        ? 'bg-surface-raised text-foreground shadow-sm'
                        : 'bg-white/15 text-white'
                      : isReading
                        ? 'text-muted-foreground/70 hover:text-foreground'
                        : 'text-white/45 hover:text-white/80',
                  )}
                >
                  <Eye className="h-3 w-3" />
                  {t('history.mermaidPreview')}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('source')}
                  aria-pressed={viewMode === 'source'}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                    viewMode === 'source'
                      ? isReading
                        ? 'bg-surface-raised text-foreground shadow-sm'
                        : 'bg-white/15 text-white'
                      : isReading
                        ? 'text-muted-foreground/70 hover:text-foreground'
                        : 'text-white/45 hover:text-white/80',
                  )}
                >
                  <Code className="h-3 w-3" />
                  {t('history.mermaidSource')}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label={t('history.mermaidExpand')}
                title={t('history.mermaidExpand')}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
                  isReading
                    ? 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'
                    : 'text-white/45 hover:bg-white/[0.06] hover:text-white/80',
                )}
              >
                <Maximize2 className="h-3 w-3" />
              </button>
            </>
          ) : null}
          <MermaidCopyButton text={code} dark={!isReading} />
        </div>
      </div>

      {/* Keep Pele canvas mounted with non-zero layout width while viewMode === 'preview'
          so streaming syntax never trips Pele's hidden-container skip guard. */}
      {viewMode === 'preview' ? (
        <div
          className={cn(
            status === 'ready'
              ? 'px-4 py-4'
              : 'pointer-events-none h-0 overflow-hidden px-4 opacity-0',
          )}
          aria-hidden={status !== 'ready' || undefined}
        >
          <PeleDiagramCanvas
            code={code}
            zoom="auto"
            horizontalInset={40}
            onStatusChange={handleStatusChange}
          />
        </div>
      ) : null}

      {showSourceFallback ? (
        <pre
          className={cn(
            'overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.65]',
            isReading
              ? 'text-[color:var(--workspace-reading-code-text)]'
              : 'text-white/85',
          )}
          style={{ fontFamily: CODE_FONT_FAMILY }}
        >
          <code>{code}</code>
        </pre>
      ) : null}

      {expanded ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            showCloseButton={false}
            className="pele-diagram-surface flex h-[min(86vh,860px)] w-[min(92vw,1240px)] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 p-0 shadow-2xl sm:max-w-[92vw]"
            style={{ background: 'var(--pele-card-bg)' }}
          >
            <div
              className="flex shrink-0 items-center justify-between border-b px-4 py-2.5"
              style={{
                background: 'var(--workspace-reading-code-header-bg)',
                borderColor: 'var(--workspace-reading-code-header-border)',
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="font-mono text-[11px] uppercase tracking-wider"
                  style={{ color: 'var(--workspace-reading-code-label)' }}
                >
                  mermaid
                </span>
                {diagramType ? (
                  <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                    {diagramType}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <MermaidCopyButton text={code} dark={false} />
                <button
                  type="button"
                  aria-label={t('history.mermaidDialogClose')}
                  onClick={() => setExpanded(false)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
              <PeleDiagramCanvas
                code={code}
                zoom
                horizontalInset={64}
                className="flex h-full items-center justify-center"
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
});
