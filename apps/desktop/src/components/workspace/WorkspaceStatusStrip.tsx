import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Settings2,
  ClipboardCheck,
  Search,
  Command,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  SquarePen,
} from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { getEnvColorVar, cn } from '@/lib/utils';
import { shallow } from 'zustand/shallow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { enqueueSessionRouterMutation, resolveDisplayEnv, resolveEnvSwitchAction, resolveEnvSwitchCasPatch } from '@/lib/routerProfiles';
import { toast } from 'sonner';
import { ModelIcon } from '@/components/history/ModelIcon';
import { resolveEnvironmentIconHint } from '@/components/workspace/sessionTreeIcons';
import { ScrollArea } from '@/components/ui/scroll-area';
import { WorkspaceStatusCapsule } from './WorkspaceStatusCapsule';
import { WorkspaceRouteChip } from './WorkspaceRouter';
import type { Environment } from '@/store';
import { filterRuntimeEnvironments } from '@/lib/enabledEnvironments';
import {
  WORKSPACE_REVIEW_POPOVER_ID,
  workspaceReviewTriggerRef,
} from './workspaceReviewAnchor';

function EnvironmentLobeIcon({
  environment,
  size = 14,
}: {
  environment?: Environment;
  size?: number;
}) {
  return (
    <ModelIcon
      model={resolveEnvironmentIconHint(environment)}
      size={size}
      className="shrink-0"
      disableContrastBg
    />
  );
}

// The streak metric uses the shared util in @/lib/streak — the same
// calculation as the boot-time value in App.tsx and the Rust backend.
interface WorkspaceStatusStripProps {
  onNavigate: (tab: string) => void;
  onOpenSearch: () => void;
  browserOpen?: boolean;
  onToggleBrowser?: () => void;
  /** Split view has no single session to review: hide the review entry. */
  hideReview?: boolean;
  /** Optional env context (e.g. the active history/live session env) to keep visible alongside the global current env. */
  envContext?: string;
  /** Active native session runtimeId (live mode); the Route chip is per-session. */
  activeRuntimeId?: string | null;
  /** Direct-session chip target: default rules & profiles live on Environments. */
  onNavigateEnvironments?: () => void;
  /** Conversation list visibility; the toggle lives here so collapsing hides the list entirely. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** Shown only while the list is collapsed, so starting a session never needs the list. */
  onNewSession?: () => void;
}

// Density follows the strip's own content width (sidebar / side panel / window all
// change it), not the viewport: below SEARCH_ICON_ONLY_WIDTH the search field
// folds to an icon; below COMPACT_WIDTH the capsules tighten too.
const SEARCH_ICON_ONLY_WIDTH = 720;
const COMPACT_WIDTH = 520;
const SEARCH_SHORTCUT_WIDTH = 860;

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const SIDEBAR_ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function WorkspaceStatusStrip({
  onNavigate,
  onOpenSearch,
  browserOpen = false,
  onToggleBrowser,
  hideReview = false,
  envContext,
  activeRuntimeId,
  onNavigateEnvironments,
  sidebarCollapsed = false,
  onToggleSidebar,
  onNewSession,
}: WorkspaceStatusStripProps) {
  const { t } = useLocale();
  const { currentEnv, environments, enabledEnvironments } = useAppStore(
    (state) => ({
      currentEnv: state.currentEnv,
      environments: state.environments,
      enabledEnvironments: state.enabledEnvironments,
    }),
    shallow
  );
  const activeRouter = useAppStore((state) =>
    activeRuntimeId ? state.sessionRouters[activeRuntimeId] ?? null : null,
  );
  // Display truth: a routed session's env chip reflects its router defaultEnv
  // (the very value a CAS edit changes), so A→B shows/checks B — never the stale
  // global currentEnv. Direct/new sessions fall back to the global currentEnv.
  const displayEnv = resolveDisplayEnv(currentEnv, activeRouter);
  const statusStripCurrentEnvs = [currentEnv, envContext, displayEnv]
    .filter((name): name is string => Boolean(name));
  const runtimeEnvironments = filterRuntimeEnvironments(environments, enabledEnvironments, {
    currentEnv: statusStripCurrentEnvs.length > 0 ? statusStripCurrentEnvs : null,
  });
  const { reviewEntry, reviewPanelOpen, setReviewPanelOpen } = useAppStore(
    (state) => ({
      reviewEntry: state.reviewEntry,
      reviewPanelOpen: state.reviewPanelOpen,
      setReviewPanelOpen: state.setReviewPanelOpen,
    }),
    shallow
  );
  const routerStatus = useAppStore((state) => state.routerStatus);
  const { switchEnvironment, updateSessionRouter } = useTauriCommands();

  // Transport truth: a routed session never falls through to the global environment switch.
  //   cas     → routed + live port: CAS defaultEnv (preserves allowed/bindings)
  //   blocked → routed but listener port gone: no state change; recover via the
  //             route popover's restart-direct (NOT a global env switch)
  //   global  → direct / new session: legacy global environment switch
  const handleEnvSelect = useCallback(
    async (envName: string) => {
      if (!activeRuntimeId) {
        await switchEnvironment(envName);
        return;
      }
      const action = resolveEnvSwitchAction(activeRouter, routerStatus?.actualPort ?? null);
      if (action === 'blocked') {
        toast.warning(t('router.blocked'));
        return;
      }
      if (action === 'global') {
        await switchEnvironment(envName);
        return;
      }
      // action === 'cas': serialize with profile/custom applies on this runtime
      // and read the FRESH router (revision + allowedEnvs) at execution, so a
      // rapid apply→switch lands on the bumped revision. Transport truth: even
      // if the fresh router is missing at execution time we must NOT fall back
      // to switchEnvironment (that would reroute a routed session globally) —
      // fail closed instead.
      await enqueueSessionRouterMutation(activeRuntimeId, async () => {
        const fresh = useAppStore.getState().sessionRouters[activeRuntimeId];
        const decision = resolveEnvSwitchCasPatch(fresh, envName);
        if (decision.kind === 'failClosed') {
          toast.error(t('router.loadFailed'));
          return;
        }
        const result = await updateSessionRouter(activeRuntimeId, decision.router.revision, decision.patch);
        if (result.ok) return;
        if (result.conflict.code === 'ROUTER_REVISION_CONFLICT') {
          // Store already rebased to conflict.current.
          toast.warning(t('router.conflict'));
          return;
        }
        toast.error(t('router.applyFailed', { message: result.conflict.message }));
      });
    },
    [activeRuntimeId, activeRouter, routerStatus, updateSessionRouter, switchEnvironment, t],
  );

  const displayEnvironment = environments.find((env) => env.name === displayEnv);
  const [stripRef, stripWidth] = useElementWidth<HTMLDivElement>();
  // Before the first measurement assume a roomy strip (the common case).
  const width = stripWidth ?? Number.POSITIVE_INFINITY;
  const compact = browserOpen || width < COMPACT_WIDTH;
  const searchIconOnly = browserOpen || width < SEARCH_ICON_ONLY_WIDTH;
  const showSearchShortcut = width >= SEARCH_SHORTCUT_WIDTH;

  return (
    <div
      ref={stripRef}
      data-tauri-drag-region
      data-ccem-workspace-status-compact={browserOpen ? 'browser' : compact ? 'narrow' : searchIconOnly ? 'search-icon' : 'default'}
      className={cn(
        'workspace-status-strip flex shrink-0 items-center min-w-0 overflow-x-auto scroll-glass-root [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        // Fixed h-12 in every mode: the row's center must stay on the macOS
        // traffic lights (trafficLightPosition y=28); only the gaps tighten.
        'h-12',
        browserOpen ? 'gap-1 pr-1' : compact ? 'gap-1.5' : 'gap-2.5',
      )}
    >
      {onToggleSidebar ? (
        <div className="mr-1 flex shrink-0 items-center">
          <button
            type="button"
            data-ccem-workspace-sidebar-toggle="true"
            aria-label={t(sidebarCollapsed ? 'workspace.expandSidebar' : 'workspace.collapseSidebar')}
            aria-pressed={!sidebarCollapsed}
            title={`${t(sidebarCollapsed ? 'workspace.expandSidebar' : 'workspace.collapseSidebar')} (⌘B)`}
            onClick={onToggleSidebar}
            className={SIDEBAR_ICON_BUTTON_CLASS}
          >
            <PanelLeft className="h-[15px] w-[15px]" />
          </button>
          {onNewSession ? (
            // Always mounted: the slot's width animates 0 <-> 28px so the
            // capsules after it slide instead of jumping on collapse/expand.
            <div
              aria-hidden={!sidebarCollapsed}
              className={cn(
                'flex shrink-0 overflow-hidden transition-[width,opacity] [transition-duration:var(--duration-base)] [transition-timing-function:var(--ease-default)] motion-reduce:transition-none',
                sidebarCollapsed ? 'w-7 opacity-100' : 'pointer-events-none w-0 opacity-0',
              )}
            >
              <button
                type="button"
                data-ccem-workspace-new-session="true"
                aria-label={t('workspace.newSession')}
                title={t('workspace.newSession')}
                tabIndex={sidebarCollapsed ? undefined : -1}
                onClick={onNewSession}
                className={SIDEBAR_ICON_BUTTON_CLASS}
              >
                <SquarePen className="h-[15px] w-[15px]" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <WorkspaceStatusCapsule onNavigate={onNavigate} compact={compact} />

      {/* Environment quick-switch capsule — icon language matches composer env picker */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={displayEnv || '—'}
            className={cn(
              'group relative inline-flex min-w-0 items-center whitespace-nowrap rounded-full',
              compact ? 'h-8 gap-1 px-2' : 'h-8 gap-2 px-3.5',
              'status-chip-glass',
              'hover:scale-[1.02] active:scale-[0.98]',
              'cursor-pointer'
            )}
          >
            <span className="relative flex items-center justify-center">
              <EnvironmentLobeIcon environment={displayEnvironment} size={14} />
            </span>
            <span className={cn(
              'min-w-0 truncate whitespace-nowrap font-medium text-foreground transition-colors',
              compact ? 'max-w-[7rem] text-[12px]' : 'max-w-[10rem] text-[13px]',
            )}>
              {displayEnv || '—'}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px] p-0">
          <div className="px-3 pt-2.5 pb-1 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
            {t('workspace.environmentLabel')}
          </div>
          <ScrollArea
            className={cn('min-h-0', runtimeEnvironments.length > 6 && 'max-h-[200px]')}
          >
            <div className="p-1.5 pt-0">
            {runtimeEnvironments.map((env) => {
              const isActive = env.name === displayEnv;
              return (
                <DropdownMenuItem
                  key={env.name}
                  className={cn(
                    'gap-2 rounded-lg px-3 py-2 glass-dropdown-item',
                    isActive && 'text-primary',
                  )}
                  onSelect={() => {
                    if (!isActive) void handleEnvSelect(env.name);
                  }}
                >
                  <EnvironmentLobeIcon environment={env} size={13} />
                  <span className="flex-1 text-left text-sm">{env.name}</span>
                  {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              );
            })}
            </div>
          </ScrollArea>
          {environments.length > 0 && <DropdownMenuSeparator className="mx-1.5" />}
          <DropdownMenuItem
            className="mx-1.5 mb-1.5 gap-2 rounded-lg px-3 py-2 text-muted-foreground glass-dropdown-item"
            onSelect={() => onNavigate('environments')}
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
            <span className="text-sm">{t('workspace.manageEnvs')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Route chip — per-session router control (CCEM Router) */}
      <WorkspaceRouteChip
        runtimeId={activeRuntimeId ?? null}
        onNavigateEnvironments={onNavigateEnvironments}
        compact={compact}
      />

      {/* Global search trigger — spotlight-style field, distinct from status chips */}
      <button
        type="button"
        data-ccem-workspace-search-trigger="true"
        title={t('workspace.globalSearchPlaceholder')}
        onClick={onOpenSearch}
        aria-label={t('workspace.globalSearchPlaceholder')}
        className={cn(
          'group ml-auto inline-flex shrink-0 items-center rounded-full',
          searchIconOnly
            ? 'h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none justify-center px-0'
            : cn('h-8 gap-2 px-3', showSearchShortcut ? 'w-[220px]' : 'w-[160px]'),
          'border border-[hsl(var(--glass-border-light))]/40 bg-muted/25',
          'transition-colors duration-150',
          'hover:border-[hsl(var(--glass-border-light))]/70 hover:bg-muted/40'
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {!searchIconOnly ? (
          <>
            <span className="flex-1 truncate text-left text-[12px] text-muted-foreground/70">
              {t('workspace.globalSearchPlaceholder')}
            </span>
            {showSearchShortcut ? (
              <kbd className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border/30 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/60">
                <Command className="h-2.5 w-2.5" />
                K
              </kbd>
            ) : null}
          </>
        ) : null}
      </button>

      {/* Review audit entry — far-right, context-aware; hidden in split view */}
      {hideReview ? null : <button
        ref={workspaceReviewTriggerRef}
        type="button"
        data-ccem-workspace-review-trigger
        aria-haspopup="dialog"
        aria-expanded={reviewPanelOpen}
        aria-controls={reviewPanelOpen ? WORKSPACE_REVIEW_POPOVER_ID : undefined}
        title={t('workspace.reviewEntry')}
        onClick={() => setReviewPanelOpen(!reviewPanelOpen)}
        className={cn(
          'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full cursor-pointer',
          'h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none justify-center gap-0 px-0',
          'status-chip-glass',
          'hover:scale-[1.02] active:scale-[0.98]',
          reviewPanelOpen && 'ring-1 ring-inset ring-primary/40'
        )}
      >
        <span className="relative flex items-center justify-center w-3.5 h-3.5">
          <ClipboardCheck
            className={cn(
              'w-3.5 h-3.5 transition-transform duration-200 group-hover:scale-110',
              !reviewEntry && 'text-muted-foreground'
            )}
            style={reviewEntry ? { color: `hsl(${getEnvColorVar(reviewEntry.envName)})` } : undefined}
          />
          {reviewEntry ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background"
              style={{ backgroundColor: `hsl(${getEnvColorVar(reviewEntry.envName)})` }}
            />
          ) : null}
        </span>
        <span className="sr-only">{t('workspace.reviewEntry')}</span>
        {reviewEntry && reviewEntry.failedTools > 0 ? (
          <span className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground',
            'absolute -right-1 -top-1',
          )}>
            {reviewEntry.failedTools}
          </span>
        ) : null}
      </button>}

      {onToggleBrowser ? (
        <button
          type="button"
          data-ccem-workspace-browser-toggle="true"
          aria-label={t(browserOpen ? 'workspace.sidePanelClose' : 'workspace.sidePanelOpen')}
          title={t(browserOpen ? 'workspace.sidePanelClose' : 'workspace.sidePanelOpen')}
          onClick={onToggleBrowser}
          className={cn(
            'group relative inline-flex h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none items-center justify-center rounded-full p-0',
            'status-chip-glass cursor-pointer hover:scale-[1.02] active:scale-[0.98]',
            browserOpen && 'ring-1 ring-inset ring-primary/40',
          )}
        >
          {browserOpen ? (
            <PanelRightClose className="h-3.5 w-3.5 text-primary transition-transform group-hover:scale-110" />
          ) : (
            <PanelRightOpen className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:scale-110" />
          )}
        </button>
      ) : null}
    </div>
  );
}
