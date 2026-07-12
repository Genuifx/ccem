import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AlertTriangle,
  Bot,
  Camera,
  ClipboardCheck,
  Download,
  Files,
  Fingerprint,
  Globe2,
  Hand,
  LoaderCircle,
  LockKeyhole,
  Network,
  Pause,
  Power,
  Radio,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Upload,
  UserRound,
} from 'lucide-react';
import { LocaleProvider, useLocale } from '@/locales';
import type {
  LoginBrowserRecentActivity,
  LoginBrowserRecentArtifactKind,
  LoginBrowserSessionSnapshot,
} from '@/lib/tauri-ipc';
import { loginBrowserControlClient as controlClient } from '@/lib/tauriLoginBrowserControlClient';
import {
  compactOpaqueId,
  deriveLoginBrowserControlModel,
  formatLoginBrowserArtifactBytes,
  formatLoginBrowserControlError,
  LOGIN_BROWSER_RECENT_ARTIFACT_KINDS,
  summarizeLoginBrowserRecentActivity,
  type LoginBrowserControlAction,
  type LoginBrowserOwnerTone,
} from '@/components/login-browser/loginBrowserControlModel';
import '@/components/login-browser/loginBrowserControl.css';

const REFRESH_INTERVAL_MS = 1_500;

function applySystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const update = () => {
    document.documentElement.classList.toggle('light', media.matches);
  };
  update();
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}

function controlActionLabel(
  action: LoginBrowserControlAction,
  snapshot: LoginBrowserSessionSnapshot,
  t: (key: string) => string,
): string {
  switch (action) {
    case 'handoff':
      return snapshot.control === 'paused'
        ? t('loginBrowserControl.resumeAgent')
        : t('loginBrowserControl.handoffAgent');
    case 'pause':
      return t('loginBrowserControl.pauseAgent');
    case 'takeover':
      return t('loginBrowserControl.takeover');
    case 'force_close':
      return t('loginBrowserControl.forceStop');
    case 'close':
    default:
      return t('loginBrowserControl.closeBrowser');
  }
}

function actionIcon(action: LoginBrowserControlAction) {
  switch (action) {
    case 'handoff':
      return <Bot aria-hidden="true" />;
    case 'pause':
      return <Pause aria-hidden="true" />;
    case 'takeover':
      return <Hand aria-hidden="true" />;
    case 'force_close':
      return <AlertTriangle aria-hidden="true" />;
    case 'close':
    default:
      return <Power aria-hidden="true" />;
  }
}

function ownerIcon(tone: LoginBrowserOwnerTone) {
  switch (tone) {
    case 'agent':
      return <Bot aria-hidden="true" />;
    case 'paused':
      return <Pause aria-hidden="true" />;
    case 'danger':
      return <AlertTriangle aria-hidden="true" />;
    case 'human':
    default:
      return <UserRound aria-hidden="true" />;
  }
}

function proofKindIcon(kind: LoginBrowserRecentArtifactKind) {
  switch (kind) {
    case 'screenshot':
      return <Camera aria-hidden="true" />;
    case 'interaction_snapshot':
      return <ScanSearch aria-hidden="true" />;
    case 'console_log':
      return <SquareTerminal aria-hidden="true" />;
    case 'network_log':
      return <Network aria-hidden="true" />;
    case 'audit_log':
    default:
      return <ClipboardCheck aria-hidden="true" />;
  }
}

function OwnerState({
  snapshot,
  tone,
}: {
  snapshot: LoginBrowserSessionSnapshot;
  tone: LoginBrowserOwnerTone;
}) {
  const { t } = useLocale();
  const title = t(`loginBrowserControl.owner_${tone}`);
  const detail = t(`loginBrowserControl.ownerHint_${tone}`);

  return (
    <section className="login-browser-owner" data-tone={tone} aria-live="polite">
      <div className="login-browser-owner-icon">{ownerIcon(tone)}</div>
      <div className="login-browser-owner-copy">
        <span className="login-browser-eyebrow">{t('loginBrowserControl.authority')}</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="login-browser-epoch" title={t('loginBrowserControl.epochHint')}>
        <span>GEN</span>
        <b>{snapshot.handoff_epoch}</b>
      </div>
    </section>
  );
}

function IdentityRow({
  icon,
  label,
  value,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="login-browser-identity-row">
      <span className="login-browser-identity-icon">{icon}</span>
      <span className="login-browser-identity-label">{label}</span>
      <strong title={title ?? value}>{value}</strong>
    </div>
  );
}

function RecentProof({
  activity,
  unavailable,
}: {
  activity: LoginBrowserRecentActivity;
  unavailable: boolean;
}) {
  const { t, lang } = useLocale();
  const summary = useMemo(
    () => summarizeLoginBrowserRecentActivity(activity),
    [activity],
  );
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    [lang],
  );
  const latestDate = summary.latest ? new Date(summary.latest.modified_at) : null;
  const latestTime = latestDate && Number.isFinite(latestDate.getTime())
    ? timeFormatter.format(latestDate)
    : '—';

  return (
    <section
      className="login-browser-recent-proof"
      aria-label={t('loginBrowserControl.recentProof')}
      aria-live="polite"
    >
      <header>
        <span className="login-browser-proof-title">
          <Files aria-hidden="true" />
          <strong>{t('loginBrowserControl.recentProof')}</strong>
          <b>{summary.total}</b>
        </span>
        <span className="login-browser-proof-boundary" data-error={unavailable}>
          {unavailable
            ? t('loginBrowserControl.proofUnavailable')
            : t('loginBrowserControl.proofMetadataOnly')}
        </span>
      </header>

      {summary.latest ? (
        <>
          <div
            className="login-browser-proof-kinds"
            role="list"
            aria-label={t('loginBrowserControl.proofKinds')}
          >
            {LOGIN_BROWSER_RECENT_ARTIFACT_KINDS.map((kind) => (
              summary.counts[kind] > 0 ? (
                <span key={kind} role="listitem" data-kind={kind}>
                  {proofKindIcon(kind)}
                  {t(`loginBrowserControl.proofKind_${kind}`)}
                  <b>{summary.counts[kind]}</b>
                </span>
              ) : null
            ))}
          </div>
          <div className="login-browser-proof-latest">
            <span>{t('loginBrowserControl.proofLatest')}</span>
            <code>{compactOpaqueId(summary.latest.artifact_id)}</code>
            <span>{formatLoginBrowserArtifactBytes(summary.latest.byte_size)}</span>
            <time dateTime={summary.latest.modified_at}>{latestTime}</time>
            {summary.latest.immutable ? (
              <span
                className="login-browser-proof-flag"
                role="img"
                aria-label={t('loginBrowserControl.proofImmutable')}
                title={t('loginBrowserControl.proofImmutable')}
              >
                <LockKeyhole aria-hidden="true" />
              </span>
            ) : null}
            {summary.latest.untrusted ? (
              <span
                className="login-browser-proof-flag login-browser-proof-untrusted"
                role="img"
                aria-label={t('loginBrowserControl.proofUntrusted')}
                title={t('loginBrowserControl.proofUntrusted')}
              >
                <ShieldAlert aria-hidden="true" />
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="login-browser-proof-empty">
          <span>{unavailable
            ? t('loginBrowserControl.proofUnavailable')
            : t('loginBrowserControl.proofEmpty')}</span>
          <span>{t('loginBrowserControl.proofMetadataOnly')}</span>
        </div>
      )}
    </section>
  );
}

function EmptyControl({ error }: { error: string | null }) {
  const { t } = useLocale();
  return (
    <div className="login-browser-control-state" role={error ? 'alert' : 'status'}>
      <div className="login-browser-state-mark" data-error={Boolean(error)}>
        {error ? <AlertTriangle aria-hidden="true" /> : <Radio aria-hidden="true" />}
      </div>
      <strong>
        {error
          ? t('loginBrowserControl.unavailable')
          : t('loginBrowserControl.noSession')}
      </strong>
      <p>{error ?? t('loginBrowserControl.noSessionHint')}</p>
    </div>
  );
}

function LoginBrowserControlContent() {
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<LoginBrowserSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentActivity, setRecentActivity] = useState<LoginBrowserRecentActivity>({
    artifacts: [],
  });
  const [activityUnavailable, setActivityUnavailable] = useState(false);
  const [busyAction, setBusyAction] = useState<LoginBrowserControlAction | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const activityRefreshInFlightRef = useRef(false);

  const applyProjection = useCallback((next: LoginBrowserSessionSnapshot | null) => {
    if (!mountedRef.current) return;
    setSnapshot((current) => {
      if (
        current
        && next
        && current.session_id === next.session_id
        && next.handoff_epoch < current.handoff_epoch
      ) {
        return current;
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const next = await controlClient.snapshot();
      applyProjection(next);
      if (mountedRef.current) setError(null);
    } catch (nextError) {
      if (mountedRef.current) setError(formatLoginBrowserControlError(nextError));
    } finally {
      refreshInFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [applyProjection]);

  const refreshRecentActivity = useCallback(async () => {
    if (activityRefreshInFlightRef.current) return;
    activityRefreshInFlightRef.current = true;
    try {
      const next = await controlClient.recentActivity();
      if (mountedRef.current) {
        setRecentActivity(next);
        setActivityUnavailable(false);
      }
    } catch {
      if (mountedRef.current) setActivityUnavailable(true);
    } finally {
      activityRefreshInFlightRef.current = false;
    }
  }, []);

  const refreshCycle = useCallback(async () => {
    await Promise.allSettled([refresh(), refreshRecentActivity()]);
  }, [refresh, refreshRecentActivity]);

  useEffect(() => {
    mountedRef.current = true;
    const stopThemeSync = applySystemTheme();
    void refreshCycle();
    const intervalId = window.setInterval(() => void refreshCycle(), REFRESH_INTERVAL_MS);
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void controlClient.subscribe((next) => {
      applyProjection(next);
      setError(null);
      setLoading(false);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((nextError) => {
      if (!disposed) setError(formatLoginBrowserControlError(nextError));
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      stopThemeSync();
      window.clearInterval(intervalId);
      unlisten?.();
    };
  }, [applyProjection, refreshCycle]);

  const model = useMemo(
    () => snapshot ? deriveLoginBrowserControlModel(snapshot) : null,
    [snapshot],
  );

  const runAction = useCallback(async (action: LoginBrowserControlAction) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(action);
    setError(null);
    try {
      switch (action) {
        case 'handoff':
          applyProjection(await controlClient.handoff());
          break;
        case 'pause':
          applyProjection(await controlClient.pause());
          break;
        case 'takeover':
          applyProjection(await controlClient.takeover());
          break;
        case 'force_close':
        case 'close':
          await controlClient.close(action === 'force_close');
          applyProjection(null);
          await getCurrentWindow().close().catch(() => {});
          break;
      }
    } catch (nextError) {
      if (mountedRef.current) setError(formatLoginBrowserControlError(nextError));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  }, [applyProjection]);

  const renderAction = (
    action: LoginBrowserControlAction,
    emphasis: 'primary' | 'secondary' | 'danger',
  ) => {
    if (!snapshot) return null;
    const label = controlActionLabel(action, snapshot, t);
    return (
      <button
        type="button"
        className="login-browser-action"
        data-emphasis={emphasis}
        disabled={busyAction !== null}
        onClick={() => void runAction(action)}
        aria-label={label}
      >
        <span>{busyAction === action ? <LoaderCircle className="login-browser-spin" /> : actionIcon(action)}</span>
        {label}
      </button>
    );
  };

  return (
    <main className="login-browser-control-window" aria-busy={busyAction !== null || loading}>
      <div className="login-browser-control-panel">
        <header className="login-browser-control-header" data-tauri-drag-region>
          <div className="login-browser-brand" data-tauri-drag-region>
            <span className="login-browser-brand-mark"><ShieldCheck aria-hidden="true" /></span>
            <div data-tauri-drag-region>
              <span data-tauri-drag-region>CCEM OWNED</span>
              <strong data-tauri-drag-region>{t('loginBrowserControl.title')}</strong>
            </div>
          </div>
          <span className="login-browser-live" data-active={snapshot?.status === 'running'}>
            <i />
            {snapshot?.status === 'running'
              ? t('loginBrowserControl.live')
              : t('loginBrowserControl.standby')}
          </span>
        </header>

        {loading && !snapshot ? (
          <div className="login-browser-control-state" role="status">
            <LoaderCircle className="login-browser-spin login-browser-loading-mark" aria-hidden="true" />
            <strong>{t('loginBrowserControl.connecting')}</strong>
            <p>{t('loginBrowserControl.connectingHint')}</p>
          </div>
        ) : snapshot && model ? (
          <>
            <div className="login-browser-control-body">
            <section className="login-browser-identity" aria-label={t('loginBrowserControl.identity')}>
              <IdentityRow
                icon={<Fingerprint aria-hidden="true" />}
                label={t('loginBrowserControl.profile')}
                value={compactOpaqueId(snapshot.profile_id)}
                title={snapshot.profile_id}
              />
              <IdentityRow
                icon={<Globe2 aria-hidden="true" />}
                label={t('loginBrowserControl.origin')}
                value={snapshot.current_origin ?? t('loginBrowserControl.noOrigin')}
                title={snapshot.current_origin ?? undefined}
              />
              <IdentityRow
                icon={<LockKeyhole aria-hidden="true" />}
                label={t('loginBrowserControl.session')}
                value={compactOpaqueId(snapshot.session_id)}
                title={snapshot.session_id}
              />
            </section>

            <section
              className="login-browser-policy"
              aria-label={t('loginBrowserControl.policyBoundary')}
            >
              <span>
                <Download aria-hidden="true" />
                {t('loginBrowserControl.downloadsBlocked')}
              </span>
              <span>
                <Upload aria-hidden="true" />
                {t('loginBrowserControl.uploadsBlocked')}
              </span>
            </section>

            <OwnerState snapshot={snapshot} tone={model.ownerTone} />

            <RecentProof activity={recentActivity} unavailable={activityUnavailable} />

            {error ? <p className="login-browser-inline-error" role="alert">{error}</p> : null}

            <section className="login-browser-actions" aria-label={t('loginBrowserControl.actions')}>
              {model.primaryAction
                ? renderAction(
                    model.primaryAction,
                    model.primaryAction === 'pause' ? 'danger' : 'primary',
                  )
                : null}
              {model.secondaryAction ? renderAction(model.secondaryAction, 'secondary') : null}
            </section>
            </div>

            <footer className="login-browser-control-footer">
              <div>
                <span>{t('loginBrowserControl.runtime')}</span>
                <strong>CHROMIUM {snapshot.runtime_version}</strong>
              </div>
              {model.closeAction
                ? renderAction(
                    model.closeAction,
                    model.closeAction === 'force_close' ? 'danger' : 'secondary',
                  )
                : (
                  <span className="login-browser-closing">
                    <LoaderCircle className="login-browser-spin" aria-hidden="true" />
                    {t(`loginBrowserControl.status_${snapshot.status}`)}
                  </span>
                )}
            </footer>
          </>
        ) : (
          <EmptyControl error={error} />
        )}
      </div>
    </main>
  );
}

export function LoginBrowserControl() {
  return (
    <LocaleProvider>
      <LoginBrowserControlContent />
    </LocaleProvider>
  );
}
