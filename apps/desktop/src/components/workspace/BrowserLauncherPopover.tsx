import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileCheck2,
  Globe2,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from '@/lib/lucide-react';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type {
  LoginBrowserProfileSummary,
  LoginBrowserRecentActivity,
} from '@/lib/tauri-ipc';
import { loginBrowserLauncherClient } from '@/lib/tauriLoginBrowserLauncherClient';
import type { LoginBrowserPanelRequest } from './browserPanelTarget';
import { summarizeSavedProfileRecentProof } from './browserLauncherModel';

interface BrowserLauncherPopoverProps {
  panelOpen: boolean;
  previewOpen: boolean;
  workingDir?: string | null;
  onTogglePreview: () => void;
  onOpenLoginBrowser: (request: LoginBrowserPanelRequest) => void;
  onHostOverlayChange?: (open: boolean) => void;
}

interface ProfileProofState {
  workingDir: string;
  profileId: string;
  activity: LoginBrowserRecentActivity | null;
  unavailable: boolean;
}

interface PendingProfileAction {
  kind: 'reset' | 'delete';
  profile: LoginBrowserProfileSummary;
}

function formatProfileLastUsed(value: string | null | undefined, neverLabel: string): string {
  if (!value) return neverLabel;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function compactProfileId(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 16)}…${value.slice(-6)}`;
}

export function BrowserLauncherPopover({
  panelOpen,
  previewOpen,
  workingDir,
  onTogglePreview,
  onOpenLoginBrowser,
  onHostOverlayChange,
}: BrowserLauncherPopoverProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [profileState, setProfileState] = useState<{
    workingDir: string;
    profiles: LoginBrowserProfileSummary[];
  } | null>(null);
  const profileRequestGenerationRef = useRef(0);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileProofState, setProfileProofState] = useState<ProfileProofState | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingProfileAction, setPendingProfileAction] = useState<PendingProfileAction | null>(null);
  const onHostOverlayChangeRef = useRef(onHostOverlayChange);
  onHostOverlayChangeRef.current = onHostOverlayChange;
  const hostOverlayOpen = open || pendingProfileAction !== null;
  const profiles = profileState && profileState.workingDir === workingDir
    ? profileState.profiles
    : [];

  useEffect(() => {
    onHostOverlayChange?.(hostOverlayOpen);
  }, [hostOverlayOpen, onHostOverlayChange]);

  useEffect(() => () => {
    onHostOverlayChangeRef.current?.(false);
  }, []);

  useEffect(() => {
    const generation = profileRequestGenerationRef.current + 1;
    profileRequestGenerationRef.current = generation;
    if (!open || !workingDir) {
      setProfileState(null);
      setProfileProofState(null);
      setProfileLoadFailed(false);
      return;
    }
    setProfileState(null);
    setProfileProofState(null);
    setProfileLoadFailed(false);
    let disposed = false;
    void loginBrowserLauncherClient.listProfiles(workingDir)
      .then((nextProfiles) => {
        if (!disposed && profileRequestGenerationRef.current === generation) {
          setProfileState({ workingDir, profiles: nextProfiles });
          setProfileLoadFailed(false);
        }
      })
      .catch(() => {
        if (!disposed && profileRequestGenerationRef.current === generation) {
          setProfileState({ workingDir, profiles: [] });
          setProfileLoadFailed(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [open, workingDir]);

  const openLoginBrowser = useCallback((profileMode: 'default' | 'new') => {
    if (!workingDir?.trim()) {
      toast.error(t('workspace.loginBrowserNeedsWorkspace'));
      return;
    }
    onOpenLoginBrowser({ workingDir, profileMode });
    setOpen(false);
  }, [onOpenLoginBrowser, t, workingDir]);

  const openSavedProfile = useCallback((profile: LoginBrowserProfileSummary) => {
    const profileId = profile.profile_id.trim();
    if (!workingDir?.trim() || !profileId) {
      toast.error(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    onOpenLoginBrowser({
      workingDir,
      profileMode: 'saved',
      profileId,
    });
    setOpen(false);
  }, [onOpenLoginBrowser, t, workingDir]);

  const inspectProfileProof = useCallback(async (profile: LoginBrowserProfileSummary) => {
    if (!workingDir) return;
    if (
      profileProofState?.workingDir === workingDir
      && profileProofState.profileId === profile.profile_id
    ) {
      setProfileProofState(null);
      return;
    }
    const generation = profileRequestGenerationRef.current;
    const busyKey = `browser_login_profile_recent_activity:${profile.profile_id}`;
    setBusyAction(busyKey);
    setProfileProofState({
      workingDir,
      profileId: profile.profile_id,
      activity: null,
      unavailable: false,
    });
    try {
      const activity = await loginBrowserLauncherClient.profileRecentActivity(
        workingDir,
        profile.profile_id,
      );
      if (profileRequestGenerationRef.current === generation) {
        setProfileProofState({
          workingDir,
          profileId: profile.profile_id,
          activity,
          unavailable: false,
        });
      }
    } catch {
      if (profileRequestGenerationRef.current === generation) {
        setProfileProofState({
          workingDir,
          profileId: profile.profile_id,
          activity: null,
          unavailable: true,
        });
      }
    } finally {
      setBusyAction(null);
    }
  }, [profileProofState, workingDir]);

  const resetProfile = useCallback(async (profile: LoginBrowserProfileSummary) => {
    if (!workingDir) return;
    const generation = profileRequestGenerationRef.current;
    setBusyAction(`browser_login_reset_profile:${profile.profile_id}`);
    try {
      const next = await loginBrowserLauncherClient.resetProfile(
        workingDir,
        profile.profile_id,
        true,
      );
      if (profileRequestGenerationRef.current === generation) {
        setProfileLoadFailed(false);
        setProfileState((current) => current?.workingDir === workingDir
          ? {
              workingDir,
              profiles: current.profiles.map((candidate) => (
                candidate.profile_id === next.profile_id ? next : candidate
              )),
            }
          : current);
      }
      toast.success(t('workspace.loginProfileResetDone'));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyAction(null);
    }
  }, [t, workingDir]);

  const deleteProfile = useCallback(async (profile: LoginBrowserProfileSummary) => {
    if (!workingDir) return;
    const generation = profileRequestGenerationRef.current;
    setBusyAction(`browser_login_delete_profile:${profile.profile_id}`);
    try {
      await loginBrowserLauncherClient.deleteProfile(
        workingDir,
        profile.profile_id,
        true,
      );
      toast.success(t('workspace.loginProfileDeleteDone'));
      try {
        const next = await loginBrowserLauncherClient.listProfiles(workingDir);
        if (profileRequestGenerationRef.current === generation) {
          setProfileState({ workingDir, profiles: next });
          setProfileLoadFailed(false);
        }
      } catch {
        if (profileRequestGenerationRef.current === generation) {
          setProfileState(null);
          setProfileLoadFailed(true);
        }
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyAction(null);
    }
  }, [t, workingDir]);

  const confirmProfileAction = useCallback(async () => {
    const action = pendingProfileAction;
    if (!action || busyAction !== null) return;
    if (action.kind === 'reset') {
      await resetProfile(action.profile);
    } else {
      await deleteProfile(action.profile);
    }
    setPendingProfileAction(null);
  }, [busyAction, deleteProfile, pendingProfileAction, resetProfile]);

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
      >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-ccem-workspace-browser-toggle="true"
          aria-expanded={open}
          aria-label={t('workspace.browserHub')}
          title={t('workspace.browserHub')}
          className={cn(
            'group relative inline-flex h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none items-center justify-center rounded-full p-0',
            'status-chip-glass cursor-pointer hover:scale-[1.02] active:scale-[0.98]',
            panelOpen && 'ring-1 ring-inset ring-primary/40',
          )}
        >
          {panelOpen ? (
            <PanelRightClose className="h-3.5 w-3.5 text-primary transition-transform group-hover:scale-110" />
          ) : (
            <PanelRightOpen className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:scale-110" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] overflow-hidden rounded-2xl border border-border/50 bg-popover p-0 shadow-xl"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border/40 px-4 py-3.5">
          <div className="text-sm font-semibold text-foreground">{t('workspace.browserHub')}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t('workspace.browserHubHint')}</div>
        </div>

        <div className="space-y-2 p-2.5">
          <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-background/80 text-muted-foreground">
                <Globe2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t('workspace.previewBrowser')}</span>
                  <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    {t('workspace.browserAlwaysReady')}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('workspace.previewBrowserHint')}
                </p>
              </div>
              <Button size="sm" variant={previewOpen ? 'secondary' : 'outline'} onClick={onTogglePreview}>
                {previewOpen ? t('workspace.browserHide') : t('workspace.browserOpenShort')}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t('workspace.loginBrowser')}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('workspace.loginBrowserHint')}
                </p>
              </div>
            </div>

            <div className="mt-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="min-w-0 flex-1"
                    disabled={!workingDir || busyAction !== null}
                    onClick={() => void openLoginBrowser('default')}
                    aria-label={t('workspace.loginBrowserOpenDefault')}
                  >
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    {t('workspace.loginBrowserOpenDefault')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-w-0 flex-1"
                    disabled={!workingDir || busyAction !== null}
                    onClick={() => void openLoginBrowser('new')}
                    aria-label={t('workspace.loginBrowserNewProfile')}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('workspace.loginBrowserNewProfile')}
                  </Button>
                </div>
                {profileLoadFailed ? (
                  <p className="border-t border-border/35 pt-2 text-[11px] text-destructive">
                    {t('workspace.loginProfilesUnavailable')}
                  </p>
                ) : profiles.length > 0 ? (
                  <section
                    aria-label={t('workspace.loginSavedProfiles')}
                    className="border-t border-border/35 pt-2"
                  >
                    <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                      <span>{t('workspace.loginSavedProfiles')}</span>
                      <span aria-label={t('workspace.loginProfileCount')}>{profiles.length}</span>
                    </div>
                    <div className="mt-1.5 max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
                      {profiles.map((profile) => {
                        const proof = profileProofState
                          && profileProofState.workingDir === workingDir
                          && profileProofState.profileId === profile.profile_id
                          ? profileProofState
                          : null;
                        const proofSummary = proof?.activity
                          ? summarizeSavedProfileRecentProof(proof.activity)
                          : null;
                        const proofBusy = busyAction
                          === `browser_login_profile_recent_activity:${profile.profile_id}`;
                        return (
                          <article
                            key={profile.profile_id}
                            className="rounded-lg border border-border/35 bg-background/45 p-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[11px] font-medium text-foreground/85">
                                    {profile.is_default
                                      ? t('workspace.loginProfileDefault')
                                      : t('workspace.loginProfileIsolated')}
                                  </span>
                                </div>
                                <code
                                  className="block truncate text-[10px] text-muted-foreground"
                                  title={profile.profile_id}
                                >
                                  {compactProfileId(profile.profile_id)}
                                </code>
                              </div>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {formatProfileLastUsed(
                                  profile.last_used_at,
                                  t('workspace.loginProfileNeverUsed'),
                                )}
                              </span>
                            </div>
                            {proof ? (
                              <div
                                className="mt-1.5 rounded-md border border-border/30 bg-muted/25 px-2 py-1.5 text-[10px] text-muted-foreground"
                                aria-label={`${t('workspace.loginProfileRecentProof')} ${profile.profile_id}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span>{t('workspace.loginProfileProofMetadataOnly')}</span>
                                  {proofBusy ? (
                                    <LoaderCircle className="h-3 w-3 animate-spin" />
                                  ) : proof.unavailable ? (
                                    <span className="text-destructive">
                                      {t('workspace.loginProfileProofUnavailable')}
                                    </span>
                                  ) : proofSummary?.total ? (
                                    <span>
                                      {t('workspace.loginProfileProofArtifacts').replace(
                                        '{count}',
                                        String(proofSummary.total),
                                      )}
                                    </span>
                                  ) : (
                                    <span>{t('workspace.loginProfileProofEmpty')}</span>
                                  )}
                                </div>
                                {proofSummary?.total ? (
                                  <div className="mt-1 flex flex-wrap items-center gap-1">
                                    {proofSummary.kinds.map((kind) => (
                                      <span key={kind} className="rounded bg-background/70 px-1 py-0.5">
                                        {t(`loginBrowserControl.proofKind_${kind}`)}
                                      </span>
                                    ))}
                                    {proofSummary.latestModifiedAt ? (
                                      <span className="ml-auto">
                                        {t('workspace.loginProfileProofLatest')} · {' '}
                                        {formatProfileLastUsed(
                                          proofSummary.latestModifiedAt,
                                          t('workspace.loginProfileProofEmpty'),
                                        )}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="mt-1.5 flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyAction !== null}
                                onClick={() => void inspectProfileProof(profile)}
                                aria-label={`${t('workspace.loginProfileRecentProof')} ${profile.profile_id}`}
                              >
                                {proofBusy
                                  ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  : <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />}
                                {t('workspace.loginProfileRecentProof')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyAction !== null}
                                onClick={() => void openSavedProfile(profile)}
                                aria-label={`${t('workspace.loginProfileOpen')} ${profile.profile_id}`}
                              >
                                <Play className="mr-1.5 h-3.5 w-3.5" />
                                {t('workspace.loginProfileOpen')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyAction !== null}
                                onClick={() => setPendingProfileAction({ kind: 'reset', profile })}
                                aria-label={`${t('workspace.loginProfileReset')} ${profile.profile_id}`}
                              >
                                {busyAction === `browser_login_reset_profile:${profile.profile_id}`
                                  ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                                {t('workspace.loginProfileReset')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                disabled={busyAction !== null}
                                onClick={() => setPendingProfileAction({ kind: 'delete', profile })}
                                aria-label={`${t('workspace.loginProfileDelete')} ${profile.profile_id}`}
                              >
                                {busyAction === `browser_login_delete_profile:${profile.profile_id}`
                                  ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                                {t('workspace.loginProfileDelete')}
                              </Button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
            </div>
          </div>
        </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={pendingProfileAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && busyAction === null) setPendingProfileAction(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-md"
          onEscapeKeyDown={(event) => {
            if (busyAction !== null) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busyAction !== null) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {pendingProfileAction?.kind === 'delete'
                ? t('workspace.loginProfileDelete')
                : t('workspace.loginProfileReset')}
            </DialogTitle>
            <DialogDescription>
              {pendingProfileAction
                ? t(pendingProfileAction.kind === 'delete'
                    ? 'workspace.loginProfileDeleteConfirm'
                    : 'workspace.loginProfileResetConfirm').replace(
                      '{profile}',
                      compactProfileId(pendingProfileAction.profile.profile_id),
                    )
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => setPendingProfileAction(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant={pendingProfileAction?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={busyAction !== null}
              onClick={() => void confirmProfileAction()}
            >
              {busyAction !== null ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {pendingProfileAction?.kind === 'delete'
                ? t('common.delete')
                : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
