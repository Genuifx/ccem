import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, RefreshCw, AlertTriangle, Check, ChevronDown } from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useRouterConfigEditor } from '@/hooks/useRouterConfig';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DEFAULT_ONLY_PROFILE_ID,
  MY_DEFAULT_ROUTER_PROFILE_ID,
  buildCustomEditPatch,
  buildMyDefaultApplyPatch,
  buildProfileApplyPatch,
  buildSaveAsDefaultPatch,
  computeAutoIncludedEnvs,
  computeCandidateEnvs,
  computeFinalAllowedEnvs,
  enqueueSessionRouterMutation,
  isSessionRouted,
  resolveRouteLabel,
} from '@/lib/routerProfiles';
import { createReentryGuard, type ReentryGuard } from '@/lib/asyncGuard';
import { toast } from 'sonner';
import { BUILTIN_CLAUDE_AGENT_NAMES } from '@ccem/core/browser';
import type { RouterProfile, SessionRouterState } from '@ccem/core/browser';
import {
  resolveRouteDraftLabel,
  toggleComposerRouteDraft,
  type ComposerRouteDraft,
} from './composerRouteDraft';

/** Sentinel Select value meaning "no per-type binding → fall through to default". */
const BINDING_FOLLOW_DEFAULT = '__ccem_default__';

/** Editable binding map keyed by arbitrary string (avoids the `>>` tsx lexer pitfall). */
type BindingDraft = Record<string, string>;

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

/** Shared popover body: profile radio + view/edit defaultEnv/bindings/allowed/dynamic. */
function RoutePopoverBody({
  runtimeId,
  router,
  loading,
  error,
  onClose,
}: {
  runtimeId: string;
  router: SessionRouterState | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const environments = useAppStore((s) => s.environments);
  const routerConfig = useAppStore((s) => s.routerConfig);
  const routerStatus = useAppStore((s) => s.routerStatus);
  const { updateSessionRouter, restartNativeSessionDirect } = useTauriCommands();
  const { commit: commitGlobal } = useRouterConfigEditor();
  const applyProfile = useApplyRouteProfile(runtimeId);
  const applyMyDefault = useApplyMyDefaultRoute(runtimeId);

  const existingNames = useMemo(() => environments.map((e) => e.name), [environments]);
  const candidateEnvs = useMemo(
    () => computeCandidateEnvs(existingNames, router),
    [existingNames, router],
  );

  const [defaultEnv, setDefaultEnv] = useState(router?.defaultEnv ?? candidateEnvs[0] ?? '');
  const [bindings, setBindings] = useState<BindingDraft>({ ...(router?.bindings ?? {}) } as BindingDraft);
  // allowedEnvs is an INDEPENDENT draft (not recompressed) so explicit
  // dynamic-routing-only authorizations are preserved across edits.
  const [baseAllowed, setBaseAllowed] = useState<string[]>(router?.allowedEnvs ?? []);
  const [dynamic, setDynamic] = useState<boolean>(router?.dynamicRouting ?? true);
  const [showBindings, setShowBindings] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  // Synchronous same-tick mutex: React state alone cannot stop a double-submit
  // (both handlers read `false` before the setState flushes). The guard's
  // `begin()` flips a closure flag synchronously.
  const saveGuardRef = useRef<ReentryGuard | null>(null);
  if (!saveGuardRef.current) saveGuardRef.current = createReentryGuard();

  // Re-sync drafts when the authoritative revision advances (event rebased the
  // store, e.g. after a CAS conflict or a profile apply). Initial mount is a
  // no-op because revRef is seeded from the same revision.
  const revRef = useRef<number | null>(router?.revision ?? null);
  useEffect(() => {
    if (!router) return;
    if (revRef.current !== router.revision) {
      revRef.current = router.revision;
      setDefaultEnv(router.defaultEnv);
      setBindings({ ...router.bindings } as BindingDraft);
      setBaseAllowed(router.allowedEnvs);
      setDynamic(router.dynamicRouting);
    }
  }, [router]);

  const profiles = routerConfig?.profiles ?? [];
  const profileOptions = useMemo(() => {
    const opts: { id: string; name: string }[] = [
      { id: MY_DEFAULT_ROUTER_PROFILE_ID, name: t('router.routeMyDefault') },
      { id: DEFAULT_ONLY_PROFILE_ID, name: t('router.defaultOnly') },
    ];
    for (const p of profiles) opts.push({ id: p.id, name: p.name });
    return opts;
  }, [t, profiles]);

  // Which radio option appears selected (default-only when effectively default).
  const selectedProfileId = router
    ? (router.sourceProfileId
      ?? (Object.keys(router.bindings).length === 0 ? DEFAULT_ONLY_PROFILE_ID : null))
    : null;

  const autoIncluded = useMemo(
    () => computeAutoIncludedEnvs(defaultEnv, bindings),
    [defaultEnv, bindings],
  );

  const state = routerStatus?.state;
  const showRestart =
    router?.launchTransport === 'routed' && (state === 'degraded' || state === 'failed');
  const isDirect = router?.launchTransport === 'direct';

  const bindingRows = useMemo(() => {
    const rows: { key: string; label: string }[] = [
      { key: 'background', label: t('router.background') },
      { key: 'subagent:*', label: t('router.subagentAny') },
    ];
    for (const name of BUILTIN_CLAUDE_AGENT_NAMES) {
      rows.push({ key: `subagent:${name}`, label: name });
    }
    const covered = new Set(rows.map((r) => r.key));
    for (const key of Object.keys(router?.bindings ?? {})) {
      if (!covered.has(key)) rows.push({ key, label: key });
    }
    return rows;
  }, [t, router]);

  const handleBindingChange = useCallback((key: string, value: string) => {
    setBindings((prev) => {
      const next = { ...prev };
      if (value === BINDING_FOLLOW_DEFAULT) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const toggleAllowed = useCallback(
    (env: string) => {
      if (autoIncluded.includes(env)) return; // default/binding targets are forced-on
      setBaseAllowed((prev) =>
        prev.includes(env) ? prev.filter((e) => e !== env) : [...prev, env],
      );
    },
    [autoIncluded],
  );

  const handleApplyProfile = useCallback(
    async (profileId: string) => {
      if (profileId === MY_DEFAULT_ROUTER_PROFILE_ID) {
        await applyMyDefault();
        return;
      }
      const profile =
        profileId === DEFAULT_ONLY_PROFILE_ID
          ? DEFAULT_ONLY_PROFILE
          : profiles.find((p) => p.id === profileId);
      if (!profile) return;
      await applyProfile(profile);
    },
    [profiles, applyProfile, applyMyDefault],
  );

  const handleApply = useCallback(async () => {
    if (!router) return;
    setApplying(true);
    const finalAllowed = computeFinalAllowedEnvs(baseAllowed, defaultEnv, bindings, existingNames);
    const patch = buildCustomEditPatch({
      defaultEnv,
      bindings,
      allowedEnvs: finalAllowed,
      dynamicRouting: dynamic,
    });
    // Serialize with profile applies + env hot-switch on the SAME runtime and
    // read the FRESH revision at execution, so a rapid radio→Apply (or
    // Apply→radio, Apply→env-switch) lands on the bumped revision.
    const result = await enqueueSessionRouterMutation(runtimeId, async () => {
      const fresh = useAppStore.getState().sessionRouters[runtimeId];
      return updateSessionRouter(runtimeId, fresh ? fresh.revision : router.revision, patch);
    });
    setApplying(false);
    if (result.ok) {
      toast.success(t('router.applied'));
      onClose();
    } else if (result.conflict.code === 'ROUTER_REVISION_CONFLICT') {
      // Store rebased to conflict.current; drafts re-sync via revRef.
      toast.warning(t('router.conflict'));
    } else {
      toast.error(t('router.applyFailed', { message: result.conflict.message }));
    }
  }, [router, baseAllowed, defaultEnv, bindings, dynamic, existingNames, updateSessionRouter, runtimeId, t, onClose]);

  // Promote the current session draft to the serialized global default queue;
  // this remains independent of the session CAS apply path.
  const handleSaveAsDefault = useCallback(async () => {
    const guard = saveGuardRef.current;
    if (!guard || !guard.begin()) return; // synchronous same-tick claim
    setSavingDefault(true);
    const patch = buildSaveAsDefaultPatch({
      defaultEnv,
      bindings,
      baseAllowed,
      dynamicRouting: dynamic,
      existingNames,
    });
    try {
      await commitGlobal(patch);
      toast.success(t('router.savedAsDefault'));
    } catch (err) {
      toast.error(t('router.applyFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      guard.end();
      setSavingDefault(false);
    }
  }, [defaultEnv, bindings, baseAllowed, dynamic, existingNames, commitGlobal, t]);

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
    <div className="flex min-h-0 w-full flex-1 flex-col p-0">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <Route className="h-3.5 w-3.5 text-primary/80" />
        <span className="text-sm font-medium text-foreground">{t('router.title')}</span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
            isDirect ? 'bg-muted/60 text-muted-foreground' : 'bg-primary/[0.08] text-primary/70',
          )}
        >
          {isDirect ? t('router.directTransport') : t('router.routed')}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <div className="px-3 pb-3 text-[11px] leading-4 text-muted-foreground">
            {t('router.directHint')}
          </div>
        ) : (
          <div className="space-y-3 px-3 pb-2">
          {/* Profile radio (default-only + routerConfig.profiles) */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">{t('router.profileSection')}</label>
            <RadioGroup
              value={selectedProfileId ?? ''}
              onValueChange={(v) => void handleApplyProfile(v)}
              disabled={!router || applying}
              className="gap-0.5"
            >
              {profileOptions.map((opt) => (
                <label
                  key={opt.id}
                  htmlFor={`rp-${opt.id}`}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                    opt.id === selectedProfileId ? 'text-primary' : 'text-foreground/85',
                  )}
                >
                  <RadioGroupItem value={opt.id} id={`rp-${opt.id}`} />
                  <span className="min-w-0 flex-1 truncate text-left">{opt.name}</span>
                </label>
              ))}
            </RadioGroup>
            {selectedProfileId === null ? (
              <div className="px-2 py-1 text-[10px] text-muted-foreground">{t('router.custom')}</div>
            ) : null}
          </div>

          <div className="h-px bg-border/30" />

          {/* Default env */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">{t('router.defaultEnv')}</label>
            <Select value={defaultEnv} onValueChange={setDefaultEnv}>
              <SelectTrigger className="h-8 w-full rounded-lg border-border/45 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidateEnvs.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Custom bindings — progressively expanded */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setShowBindings((v) => !v)}
              className="flex w-full items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', showBindings && 'rotate-180')} />
              {t('router.expandBindings')}
              {Object.keys(bindings).length > 0 ? (
                <span className="ml-auto rounded-full bg-muted/50 px-1.5 text-[10px] text-foreground/70">
                  {Object.keys(bindings).length}
                </span>
              ) : null}
            </button>
            {showBindings ? (
              <div className="space-y-1 pt-0.5">
                {bindingRows.map((row) => {
                  const value = bindings[row.key] ?? BINDING_FOLLOW_DEFAULT;
                  return (
                    <div key={row.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85" title={row.key}>
                        {row.label}
                      </span>
                      <Select value={value} onValueChange={(v) => handleBindingChange(row.key, v)}>
                        <SelectTrigger className="h-7 w-[136px] rounded-md border-border/40 px-2 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BINDING_FOLLOW_DEFAULT}>{t('router.bindingDefault')}</SelectItem>
                          {candidateEnvs.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* Allowed envs — independent draft; default/binding targets forced-on */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">{t('router.allowedEnvs')}</label>
            <div className="flex flex-wrap gap-1">
              {candidateEnvs.length === 0 ? (
                <span className="text-[10px] text-muted-foreground/70">—</span>
              ) : (
                candidateEnvs.map((name) => {
                  const forced = autoIncluded.includes(name);
                  const checked = forced || baseAllowed.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      disabled={forced}
                      title={forced ? t('router.allowedForced') : undefined}
                      onClick={() => toggleAllowed(name)}
                      className={cn(
                        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] transition-colors',
                        checked
                          ? 'bg-primary/[0.10] text-primary/80'
                          : 'bg-muted/40 text-muted-foreground hover:bg-muted/70',
                        forced && 'cursor-default opacity-80',
                        !forced && 'cursor-pointer',
                      )}
                    >
                      {checked ? <Check className="h-2.5 w-2.5" /> : null}
                      {name}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Dynamic routing */}
          <div className="flex items-center gap-2.5 rounded-lg px-1 py-1">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-foreground/85">{t('router.dynamicRouting')}</div>
              <div className="text-[10px] leading-4 text-muted-foreground">{t('router.dynamicRoutingHint')}</div>
            </div>
            <Switch checked={dynamic} onCheckedChange={setDynamic} aria-label={t('router.dynamicRouting')} />
          </div>

          {router?.warnings && router.warnings.length > 0 ? (
            <div className="space-y-1 rounded-lg bg-muted/35 px-2 py-1.5">
              {router.warnings.map((w, i) => (
                <p key={i} className="text-[10px] leading-4 text-warning">
                  {w}
                </p>
              ))}
            </div>
          ) : null}

            <p className="text-[10px] leading-4 text-muted-foreground/80">{t('router.nextRequestHint')}</p>
          </div>
        )}

        {error ? <p className="px-3 pb-2 text-[10px] text-destructive">{t('router.loadFailed')}</p> : null}
      </div>
      {!isDirect ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/35 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 rounded-md text-[11px] text-muted-foreground hover:text-foreground"
            disabled={!router || !routerConfig || applying || loading || savingDefault}
            title={t('router.saveAsDefaultHint')}
            onClick={() => void handleSaveAsDefault()}
          >
            {savingDefault ? t('router.savingDefault') : t('router.saveAsDefault')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-md text-[11px]"
            disabled={!router || applying || loading}
            onClick={() => void handleApply()}
          >
            {t('router.apply')}
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
}: {
  runtimeId: string;
  trigger: () => React.ReactNode;
  align: 'start' | 'end';
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
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <RoutePopoverBody
          key={runtimeId}
          runtimeId={runtimeId}
          router={router}
          loading={loading}
          error={error}
          onClose={() => setOpen(false)}
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
export function WorkspaceRoutePill({ runtimeId }: { runtimeId: string | null }) {
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
 * Composer "+" menu row for a RUNNING routed session: expands an inline profile
 * radio (default-only + routerConfig.profiles) within the SAME popover; each
 * selection applies via one CAS write. There is deliberately NO on/off Switch —
 * transport cannot be hot-toggled, and "off" would have meant clearing bindings
 * while the session stays routed (misleading). Direct running sessions render
 * nothing; routing is opted in at creation time via ComposerRouteDraftRow.
 */
export function ComposerRouteMenuRow({ runtimeId }: { runtimeId: string }) {
  const { t } = useLocale();
  const router = useAppStore((s) => s.sessionRouters[runtimeId] ?? null);
  const profiles = useAppStore((s) => s.routerConfig?.profiles ?? []);
  const applyProfile = useApplyRouteProfile(runtimeId);
  const applyMyDefault = useApplyMyDefaultRoute(runtimeId);
  const [expanded, setExpanded] = useState(false);

  if (!router || router.launchTransport !== 'routed') return null;

  const profileOptions: { id: string; name: string }[] = [
    { id: MY_DEFAULT_ROUTER_PROFILE_ID, name: t('router.routeMyDefault') },
    { id: DEFAULT_ONLY_PROFILE_ID, name: t('router.defaultOnly') },
    ...profiles.map((p) => ({ id: p.id, name: p.name })),
  ];
  const selectedId = router.sourceProfileId
    ?? (Object.keys(router.bindings).length === 0 ? DEFAULT_ONLY_PROFILE_ID : null);
  const currentLabel = selectedId === MY_DEFAULT_ROUTER_PROFILE_ID
    ? t('router.routeMyDefault')
    : selectedId
      ? (profileOptions.find((o) => o.id === selectedId)?.name ?? t('router.custom'))
      : t('router.custom');

  const resolveProfile = (id: string) =>
    id === DEFAULT_ONLY_PROFILE_ID
      ? { id: DEFAULT_ONLY_PROFILE_ID, name: '', revision: 1, bindings: {}, allowedEnvs: [] }
      : profiles.find((p) => p.id === id) ?? null;

  const handleSelect = (id: string) => {
    if (id === MY_DEFAULT_ROUTER_PROFILE_ID) {
      void applyMyDefault();
      return;
    }
    const profile = resolveProfile(id);
    if (profile) void applyProfile(profile);
  };

  return (
    <>
      <div className="mx-2 my-1.5 h-px border-t border-border/50" />
      <div className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors glass-dropdown-item">
        <Route className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate">{t('router.title')}</span>
          <span className="truncate text-[11px] text-muted-foreground">{currentLabel}</span>
          <ChevronDown className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>
      {expanded ? (
        <div className="mb-1 ml-2 mr-1">
          <RadioGroup
            value={selectedId ?? ''}
            onValueChange={(v) => handleSelect(v)}
            className="gap-0.5"
          >
            {profileOptions.map((opt) => (
              <label
                key={opt.id}
                htmlFor={`rm-${opt.id}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                  opt.id === selectedId ? 'text-primary' : 'text-foreground/85',
                )}
              >
                <RadioGroupItem value={opt.id} id={`rm-${opt.id}`} />
                <span className="min-w-0 flex-1 truncate text-left">{opt.name}</span>
              </label>
            ))}
          </RadioGroup>
          {selectedId === null ? (
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground">{t('router.custom')}</div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

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

/** Sentinel radio id meaning "my defaults" (RouterConfig snapshot). */
const ROUTE_DRAFT_MY_DEFAULTS_ID = '__ccem_my_defaults__';

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
  const profiles = routerConfig?.profiles ?? [];

  const labelInfo = resolveRouteDraftLabel(draft, routerConfig);
  const selectionLabel = labelInfo.kind === 'profile'
    ? labelInfo.profileName
    : labelInfo.kind === 'missingProfile'
      ? t('router.routeDraftProfileMissing')
      : t('router.routeMyDefault');
  // The mode itself must be VISIBLE in the pill (not just icon/title/aria):
  // 「动态路由 · <当前选择>」 / "Dynamic routing · <selection>".
  const label = `${t('router.routeDraftTitle')} · ${selectionLabel}`;
  const statefulTitle = label;

  const radioValue = draft.profileId === null ? ROUTE_DRAFT_MY_DEFAULTS_ID : draft.profileId;

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
        className="w-[260px] max-w-[calc(100vw-24px)] rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover p-0 shadow-lg"
      >
        <div className="p-2">
          <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
            {t('router.routeDraftPopoverTitle')}
          </div>
          <RadioGroup
            value={radioValue}
            onValueChange={(v) => {
              onDraftChange(
                v === ROUTE_DRAFT_MY_DEFAULTS_ID
                  ? { optIn: true, profileId: null }
                  : { optIn: true, profileId: v },
              );
            }}
            className="gap-0.5"
          >
            <label
              htmlFor="rd-my-defaults"
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                draft.profileId === null ? 'text-primary' : 'text-foreground/85',
              )}
            >
              <RadioGroupItem value={ROUTE_DRAFT_MY_DEFAULTS_ID} id="rd-my-defaults" />
              <span className="min-w-0 flex-1 truncate text-left">{t('router.routeMyDefault')}</span>
            </label>
            {profiles.map((p) => (
              <label
                key={p.id}
                htmlFor={`rd-${p.id}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors glass-dropdown-item cursor-pointer',
                  draft.profileId === p.id ? 'text-primary' : 'text-foreground/85',
                )}
              >
                <RadioGroupItem value={p.id} id={`rd-${p.id}`} />
                <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
              </label>
            ))}
          </RadioGroup>
          <p className="px-1 pt-1.5 text-[10px] leading-4 text-muted-foreground/80">
            {t('router.routeDraftPopoverHint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
