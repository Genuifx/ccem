import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Route, RefreshCw, AlertTriangle } from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DEFAULT_ONLY_PROFILE_ID,
  MY_DEFAULT_ROUTER_PROFILE_ID,
  buildMyDefaultApplyPatch,
  buildProfileApplyPatch,
  enqueueSessionRouterMutation,
  isSessionRouted,
  resolveRouteLabel,
} from '@/lib/routerProfiles';
import { toast } from 'sonner';
import type { RouterProfile, SessionRouterState } from '@ccem/core/browser';
import {
  resolveRouteDraftLabel,
  toggleComposerRouteDraft,
  type ComposerRouteDraft,
} from './composerRouteDraft';

/** Built-in default-only profile object for the radio + apply path. */
const DEFAULT_ONLY_PROFILE: RouterProfile = {
  id: DEFAULT_ONLY_PROFILE_ID,
  name: '',
  revision: 1,
  bindings: {},
  allowedEnvs: [],
};

/**
 * Fetch the public SessionRouterState for a runtime on demand (when the popover
 * opens) and keep it in the store. The store is the single source of truth —
 * `native-session-router-updated` events refresh it globally.
 */
function useRouteEntry(runtimeId: string | null, open: boolean) {
  const router = useAppStore((s) => (runtimeId ? s.sessionRouters[runtimeId] ?? null : null));
  const { getSessionRouter } = useTauriCommands();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runtimeId || !open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSessionRouter(runtimeId)
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeId, open, getSessionRouter]);

  return { router, loading, error };
}

/**
 * Apply a named profile (or built-in default-only) to a session via one CAS
 * write, serialized per-runtime through the shared `enqueueSessionRouterMutation`
 * singleton alongside custom-edit apply and env hot-switch. Each task reads the
 * FRESH revision at execution time, so a rapid A→B (e.g. Popover radio then
 * Composer menu, or apply then env switch) lands B on the bumped revision
 * instead of ROUTER_REVISION_CONFLICT losing the user's last intent.
 */
export function useApplyRouteProfile(runtimeId: string) {
  const { updateSessionRouter } = useTauriCommands();
  const { t } = useLocale();
  return useCallback(
    (profile: RouterProfile): Promise<boolean> =>
      enqueueSessionRouterMutation(runtimeId, async () => {
        // Read the FRESH router + revision at execution time (after any prior
        // queued apply for this runtime has settled and refreshed the store via
        // updateSessionRouter's setSessionRouter on success/conflict).
        const router = useAppStore.getState().sessionRouters[runtimeId];
        if (!router) return false;
        const result = await updateSessionRouter(
          runtimeId,
          router.revision,
          buildProfileApplyPatch(router, profile),
        );
        if (result.ok) {
          toast.success(t('router.applied'));
          return true;
        }
        if (result.conflict.code === 'ROUTER_REVISION_CONFLICT') {
          toast.warning(t('router.conflict'));
        } else {
          toast.error(t('router.applyFailed', { message: result.conflict.message }));
        }
        return false;
      }),
    [runtimeId, updateSessionRouter, t],
  );
}

/**
 * Apply the virtual "my defaults" option to a running session: same
 * per-runtime mutation queue and fresh-revision read as profile applies, so a
 * rapid my-default → profile (or profile → env-switch) sequence lands on the
 * bumped revision instead of losing the user's last intent.
 */
export function useApplyMyDefaultRoute(runtimeId: string) {
  const { updateSessionRouter } = useTauriCommands();
  const { t } = useLocale();
  return useCallback(
    (): Promise<boolean> =>
      enqueueSessionRouterMutation(runtimeId, async () => {
        // FRESH router + config at execution time (config may have been edited
        // on the Environments page after the popover opened).
        const router = useAppStore.getState().sessionRouters[runtimeId];
        const config = useAppStore.getState().routerConfig;
        if (!router || !config) return false;
        const result = await updateSessionRouter(
          runtimeId,
          router.revision,
          buildMyDefaultApplyPatch(router, config),
        );
        if (result.ok) {
          toast.success(t('router.applied'));
          return true;
        }
        if (result.conflict.code === 'ROUTER_REVISION_CONFLICT') {
          toast.warning(t('router.conflict'));
        } else {
          toast.error(t('router.applyFailed', { message: result.conflict.message }));
        }
        return false;
      }),
    [runtimeId, updateSessionRouter, t],
  );
}

/** Localized label text for a session's route. */
function useRouteLabelText(runtimeId: string | null) {
  const { t } = useLocale();
  const router = useAppStore((s) => (runtimeId ? s.sessionRouters[runtimeId] ?? null : null));
  const profiles = useAppStore((s) => s.routerConfig?.profiles ?? []);
  return useMemo(() => {
    const info = resolveRouteLabel(router, profiles);
    if (info.kind === 'direct') return t('router.direct');
    if (info.kind === 'profile') return info.profileName ?? t('router.custom');
    if (info.kind === 'myDefault') return t('router.routeMyDefault');
    if (info.kind === 'custom') return t('router.custom');
    return t('router.defaultOnly');
  }, [router, profiles, t]);
}

/** Compact running-session route picker. Persistent bindings and authorization live on Environments. */
function RoutePopoverBody({
  runtimeId,
  router,
  loading,
  error,
  onClose,
  onNavigateEnvironments,
}: {
  runtimeId: string;
  router: SessionRouterState | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onNavigateEnvironments?: () => void;
}) {
  const { t } = useLocale();
  const routerConfig = useAppStore((s) => s.routerConfig);
  const routerStatus = useAppStore((s) => s.routerStatus);
  const { restartNativeSessionDirect } = useTauriCommands();
  const applyProfile = useApplyRouteProfile(runtimeId);
  const applyMyDefault = useApplyMyDefaultRoute(runtimeId);
  const radioId = useId();
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const profiles = routerConfig?.profiles ?? [];
  const profileOptions = useMemo(
    () => [
      {
        id: MY_DEFAULT_ROUTER_PROFILE_ID,
        name: t('router.routeMyDefault'),
        description: t('router.routeMyDefaultHint'),
        profile: null,
      },
      {
        id: DEFAULT_ONLY_PROFILE_ID,
        name: t('router.defaultOnly'),
        description: t('router.defaultOnlyHint'),
        profile: DEFAULT_ONLY_PROFILE,
      },
      ...profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: t('router.profileBindingsCount', {
          count: Object.keys(profile.bindings).length,
        }),
        profile,
      })),
    ],
    [profiles, t],
  );

  const routeLabel = resolveRouteLabel(router, profiles);
  const selectedProfileId = routeLabel.kind === 'myDefault'
    ? MY_DEFAULT_ROUTER_PROFILE_ID
    : routeLabel.kind === 'profile'
      ? routeLabel.profileId
      : routeLabel.kind === 'defaultOnly'
        ? DEFAULT_ONLY_PROFILE_ID
        : null;
  const state = routerStatus?.state;
  const showRestart =
    router?.launchTransport === 'routed' && (state === 'degraded' || state === 'failed');
  const isDirect = router?.launchTransport === 'direct';

  const handleApplyProfile = useCallback(
    async (profileId: string) => {
      if (!router || applying) return;
      setApplying(true);
      try {
        let applied = false;
        if (profileId === MY_DEFAULT_ROUTER_PROFILE_ID) {
          applied = await applyMyDefault();
        } else {
          const profile = profileId === DEFAULT_ONLY_PROFILE_ID
            ? DEFAULT_ONLY_PROFILE
            : profiles.find((candidate) => candidate.id === profileId);
          if (profile) applied = await applyProfile(profile);
        }
        if (applied) onClose();
      } finally {
        setApplying(false);
      }
    },
    [router, applying, profiles, applyMyDefault, applyProfile, onClose],
  );

  const handleRestartDirect = useCallback(async () => {
    setRestarting(true);
    try {
      await restartNativeSessionDirect(runtimeId);
      toast.success(t('router.directTransport'));
      onClose();
    } catch (err) {
      toast.error(t('router.applyFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRestarting(false);
    }
  }, [restartNativeSessionDirect, runtimeId, t, onClose]);

  return (
    <div className="flex min-h-0 w-full flex-col p-0">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <Route className="h-3.5 w-3.5 text-primary/80" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t('router.routeDraftTitle')}</div>
          {!isDirect ? (
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {t('router.routePickerHint')}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
            isDirect ? 'bg-muted/60 text-muted-foreground' : 'bg-primary/[0.08] text-primary/70',
          )}
        >
          {isDirect ? t('router.directTransport') : t('router.routed')}
        </span>
      </div>

      {showRestart ? (
        <div className="mx-3 mb-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <AlertTriangle className="h-3 w-3" />
            {t('router.blocked')}
          </div>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{t('router.blockedHint')}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 h-7 w-full rounded-md text-[11px]"
            disabled={restarting}
            onClick={() => void handleRestartDirect()}
          >
            <RefreshCw className={cn('h-3 w-3', restarting && 'animate-spin')} />
            {restarting ? t('router.restarting') : t('router.restartDirect')}
          </Button>
        </div>
      ) : null}

      {isDirect ? (
        <p className="px-3 pb-3 text-[11px] leading-4 text-muted-foreground">
          {t('router.directHint')}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {selectedProfileId === null ? (
            <div className="mx-1 mb-1.5 rounded-lg bg-muted/35 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
              {t('router.customSnapshotHint')}
            </div>
          ) : null}
          <RadioGroup
            value={selectedProfileId ?? ''}
            onValueChange={(value) => void handleApplyProfile(value)}
            disabled={!router || loading || applying}
            aria-label={t('router.profileSection')}
            className="gap-0.5"
          >
            {profileOptions.map((option) => {
              const id = `${radioId}-${option.id}`;
              return (
                <label
                  key={option.id}
                  htmlFor={id}
                  onClick={(event) => {
                    if (option.id !== selectedProfileId) return;
                    event.preventDefault();
                    void handleApplyProfile(option.id);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2 transition-colors glass-dropdown-item',
                    option.id === selectedProfileId ? 'text-primary' : 'text-foreground/85',
                    (loading || applying) && 'pointer-events-none opacity-60',
                  )}
                >
                  <RadioGroupItem value={option.id} id={id} className="mt-0.5" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12px] font-medium">{option.name}</span>
                    <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>

          {router?.warnings?.map((warning, index) => (
            <p key={index} className="mx-1 mt-1 text-[10px] leading-4 text-warning">
              {warning}
            </p>
          ))}
          {error ? (
            <p className="mx-1 mt-1 text-[10px] text-destructive">{t('router.loadFailed')}</p>
          ) : null}
        </div>
      )}

      {onNavigateEnvironments ? (
        <div className="shrink-0 border-t border-border/35 p-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-full justify-center rounded-md text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              onClose();
              onNavigateEnvironments();
            }}
          >
            {t('router.manageProfiles')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Shared trigger+popover logic. `trigger` renders the chip/pill button. */
function RouteControl({
  runtimeId,
  trigger,
  align,
  onNavigateEnvironments,
}: {
  runtimeId: string;
  trigger: () => React.ReactNode;
  align: 'start' | 'end';
  onNavigateEnvironments?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { router, loading, error } = useRouteEntry(runtimeId, open);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger()}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[332px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover p-0 shadow-lg"
      >
        <RoutePopoverBody
          key={runtimeId}
          runtimeId={runtimeId}
          router={router}
          loading={loading}
          error={error}
          onClose={() => setOpen(false)}
          onNavigateEnvironments={onNavigateEnvironments}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Status-strip Route chip. Transport truth = the session's launchTransport:
 * routing is opted in per Composer at creation time and never hot-swapped in
 * flight. Only direct/new sessions show the muted "direct" chip, which points
 * at the Environments page (default rules & profiles live there; Settings no
 * longer exposes any router enable toggle).
 */
export function WorkspaceRouteChip({
  runtimeId,
  onNavigateEnvironments,
  compact = false,
}: {
  runtimeId: string | null;
  onNavigateEnvironments?: () => void;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const routerStatus = useAppStore((s) => s.routerStatus);
  const router = useAppStore((s) => (runtimeId ? s.sessionRouters[runtimeId] ?? null : null));
  const labelText = useRouteLabelText(runtimeId);

  if (!runtimeId) return null;

  const routed = isSessionRouted(router);
  const state = routerStatus?.state;
  const sessionDegraded = routed && (state === 'degraded' || state === 'failed');

  if (!routed) {
    // Direct / new session → muted "direct" chip (click → environments).
    const reason = routerStatus?.error;
    const title = reason ? `${t('router.directHint')} — ${reason}` : t('router.directHint');
    return (
      <button
        type="button"
        title={title}
        onClick={onNavigateEnvironments}
        className={cn(
          'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full',
          compact ? 'h-8 gap-1 px-2' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
          'status-chip-glass opacity-70 hover:opacity-100',
          onNavigateEnvironments ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <Route className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium text-muted-foreground sm:text-[13px]">
          {t('router.direct')}
        </span>
      </button>
    );
  }

  return (
    <RouteControl
      runtimeId={runtimeId}
      align="start"
      onNavigateEnvironments={onNavigateEnvironments}
      trigger={() => (
        <button
          type="button"
          title={t('router.title')}
          className={cn(
            'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full cursor-pointer',
            compact ? 'h-8 gap-1 px-2' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
            'status-chip-glass hover:scale-[1.02] active:scale-[0.98]',
            sessionDegraded && 'ring-1 ring-inset ring-warning/40',
          )}
        >
          <Route className={cn('h-3.5 w-3.5', sessionDegraded ? 'text-warning' : 'text-primary/80')} />
          <span className="max-w-[8rem] truncate text-[12px] font-medium text-foreground sm:max-w-[10rem] sm:text-[13px]">
            {sessionDegraded ? t('router.degraded') : labelText}
          </span>
        </button>
      )}
    />
  );
}

/**
 * Composer Route pill — focusable button, shown for EVERY routed session
 * (named profile, my-defaults seed, default-only, or custom bindings):
 * visibility is transport truth, not route richness. The VISIBLE text always
 * leads with the mode itself (「动态路由」/ "Dynamic routing") followed by the
 * current label — an icon alone is not acceptance-sufficient.
 */
export function WorkspaceRoutePill({
  runtimeId,
  onNavigateEnvironments,
}: {
  runtimeId: string | null;
  onNavigateEnvironments?: () => void;
}) {
  const { t } = useLocale();
  const routerStatus = useAppStore((s) => s.routerStatus);
  const router = useAppStore((s) => (runtimeId ? s.sessionRouters[runtimeId] ?? null : null));
  const labelText = useRouteLabelText(runtimeId);

  if (!runtimeId) return null;
  // Transport truth: the pill is the routed session's authoritative badge.
  if (!isSessionRouted(router)) return null;

  const degraded = routerStatus?.state === 'degraded' || routerStatus?.state === 'failed';
  const label = `${t('router.routeDraftTitle')} · ${degraded ? t('router.degraded') : labelText}`;

  return (
    <RouteControl
      runtimeId={runtimeId}
      align="start"
      onNavigateEnvironments={onNavigateEnvironments}
      trigger={() => (
        <button
          type="button"
          title={label}
          aria-label={label}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[10px] font-medium leading-5 cursor-pointer',
            'transition-colors hover:bg-primary/[0.10]',
            degraded ? 'bg-warning/10 text-warning' : 'bg-primary/[0.06] text-primary/70',
          )}
        >
          <Route className="h-3 w-3" />
          {label}
        </button>
      )}
    />
  );
}

export { RoutePopoverBody };

/**
 * Composer "+" menu row for a NEW-SESSION draft composer: the per-Composer
 * Dynamic Routing opt-in. Default off. Enabling only records the opt-in and
 * reveals the route pill above the input — the routing snapshot itself is
 * read from the CURRENT RouterConfig at submit time (not captured here).
 * Pure local draft state — no IPC write happens until the first submit
 * carries it as `routerLaunchDraft`.
 */
export function ComposerRouteDraftRow({
  draft,
  onDraftChange,
}: {
  draft: ComposerRouteDraft;
  onDraftChange: (draft: ComposerRouteDraft) => void;
}) {
  const { t } = useLocale();

  return (
    <>
      <div className="mx-2 my-1.5 h-px border-t border-border/50" />
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors glass-dropdown-item">
            <Route className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-colors',
              draft.optIn && 'text-foreground',
            )} />
            <span className={cn(
              'flex-1 text-left transition-colors',
              draft.optIn && 'text-foreground',
            )}>
              {t('router.routeDraftTitle')}
            </span>
            <Switch
              checked={draft.optIn}
              onCheckedChange={(checked) => onDraftChange(toggleComposerRouteDraft(checked))}
              aria-label={t('router.routeDraftTitle')}
              className="data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted/85"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[280px] text-[12px] leading-5">
          {t('router.routeDraftHint')}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Draft route pill above the composer input. Opens the same-style profile
 * popover, but selections only update the LOCAL draft (no CAS write — there is
 * no runtime yet). Options: my defaults + named profiles; no free-text entry.
 */
export function ComposerRouteDraftPill({
  draft,
  onDraftChange,
}: {
  draft: ComposerRouteDraft;
  onDraftChange: (draft: ComposerRouteDraft) => void;
}) {
  const { t } = useLocale();
  const routerConfig = useAppStore((s) => s.routerConfig);
  const [open, setOpen] = useState(false);
  const radioId = useId();
  const profiles = routerConfig?.profiles ?? [];

  const labelInfo = resolveRouteDraftLabel(draft, routerConfig);
  const selectionLabel = labelInfo.kind === 'profile'
    ? labelInfo.profileName
    : labelInfo.kind === 'defaultOnly'
      ? t('router.defaultOnly')
    : labelInfo.kind === 'missingProfile'
      ? t('router.routeDraftProfileMissing')
      : t('router.routeMyDefault');
  // The mode itself must be VISIBLE in the pill (not just icon/title/aria):
  // 「动态路由 · <当前选择>」 / "Dynamic routing · <selection>".
  const label = `${t('router.routeDraftTitle')} · ${selectionLabel}`;
  const statefulTitle = label;

  const radioValue = draft.profileId === null ? MY_DEFAULT_ROUTER_PROFILE_ID : draft.profileId;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={statefulTitle}
          aria-label={statefulTitle}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[10px] font-medium leading-5 cursor-pointer',
            'transition-colors hover:bg-primary/[0.10]',
            labelInfo.kind === 'missingProfile'
              ? 'bg-warning/10 text-warning'
              : 'bg-primary/[0.06] text-primary/70',
          )}
        >
          <Route className="h-3 w-3" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="flex w-[260px] max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover p-0 shadow-lg"
      >
        <div className="flex min-h-0 w-full flex-col p-2">
          <div className="shrink-0 px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
            {t('router.routeDraftPopoverTitle')}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RadioGroup
              value={radioValue}
              onValueChange={(v) => {
                onDraftChange(
                  v === MY_DEFAULT_ROUTER_PROFILE_ID
                    ? { optIn: true, profileId: null }
                    : { optIn: true, profileId: v },
                );
                setOpen(false);
              }}
              className="gap-0.5"
            >
              <label
                htmlFor={`${radioId}-my-defaults`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                  draft.profileId === null ? 'text-primary' : 'text-foreground/85',
                )}
              >
                <RadioGroupItem value={MY_DEFAULT_ROUTER_PROFILE_ID} id={`${radioId}-my-defaults`} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{t('router.routeMyDefault')}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{t('router.routeMyDefaultHint')}</span>
                </span>
              </label>
              <label
                htmlFor={`${radioId}-default-only`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                  draft.profileId === DEFAULT_ONLY_PROFILE_ID ? 'text-primary' : 'text-foreground/85',
                )}
              >
                <RadioGroupItem value={DEFAULT_ONLY_PROFILE_ID} id={`${radioId}-default-only`} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{t('router.defaultOnly')}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{t('router.defaultOnlyHint')}</span>
                </span>
              </label>
              {profiles.map((p) => (
                <label
                  key={p.id}
                  htmlFor={`${radioId}-${p.id}`}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                    draft.profileId === p.id ? 'text-primary' : 'text-foreground/85',
                  )}
                >
                  <RadioGroupItem value={p.id} id={`${radioId}-${p.id}`} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {t('router.profileBindingsCount', { count: Object.keys(p.bindings).length })}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
          <p className="shrink-0 px-1 pt-1.5 text-[10px] leading-4 text-muted-foreground/80">
            {t('router.routeDraftPopoverHint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
