import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Bot, Copy, Play, RefreshCw, Square } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';
import {
  getHermesStatus,
  performHermesAction,
  type HermesAction,
  type HermesActionPayloads,
  type HermesPendingPairing,
  type HermesSource,
  type HermesStatus,
} from '@/lib/hermes-ipc';

const INSTALLING = new Set(['checking', 'downloading', 'verifying', 'extracting', 'activating']);
const SETUP_CANCELLABLE = new Set(['generating', 'waiting']);
const SETUP_WAIT_MS = 300_000;
const SETUP_ERROR_KEYS = new Map([
  ['setup_request_failed', 'hermes.scanRequestFailed'],
  ['setup_invalid_response', 'hermes.scanInvalidResponse'],
  ['setup_invalid_credentials', 'hermes.scanInvalidCredentials'],
  ['setup_connection_failed', 'hermes.scanConnectionFailed'],
  ['setup_pairing_failed', 'hermes.scanPairingFailed'],
  ['setup_not_supported', 'hermes.scanNotSupported'],
  ['setup_expired', 'hermes.scanExpired'],
  ['setup_busy_retry', 'hermes.scanBusyRetry'],
  ['setup_already_connecting', 'hermes.scanAlreadyConnecting'],
]);

function timestamp(value: string | number): number {
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}

function errorText(error: unknown, secrets: string[] = []): string {
  let message = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error ? String(error.message)
    : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('••••••');
  return message;
}

function setupErrorKey(error: unknown): string {
  return SETUP_ERROR_KEYS.get(errorText(error).trim()) ?? 'hermes.scanError';
}

type RunAction = <A extends HermesAction>(action: A, payload?: HermesActionPayloads[A]) => Promise<boolean>;

function SourceIdentity({ source }: { source: HermesSource }) {
  const { t } = useLocale();
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{source.platform} · {source.profile} · {source.transportProfile}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <dt>{t('hermes.botAccount')}</dt><dd className="break-all font-mono" title={source.accountRef}>{source.accountRef.length > 18 ? `${source.accountRef.slice(0, 8)}…${source.accountRef.slice(-6)}` : source.accountRef}</dd>
        <dt>{t('hermes.recipient')}</dt><dd className="break-all font-mono">{source.userId}</dd>
        <dt>{t('hermes.chat')}</dt><dd className="break-all font-mono">{source.chatId} ({source.chatType})</dd>
        {source.threadId && <><dt>{t('hermes.thread')}</dt><dd className="break-all font-mono">{source.threadId}</dd></>}
      </dl>
    </div>
  );
}

function PendingPairing({ pairing, workspaces, disabled, run }: {
  pairing: HermesPendingPairing;
  workspaces: string[];
  disabled: boolean;
  run: RunAction;
}) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [allowInput, setAllowInput] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const expired = !(timestamp(pairing.expiresAt) > Date.now());
  const validSelection = selected.filter((workspace) => workspaces.includes(workspace));
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.toLocaleLowerCase().includes(workspaceQuery.trim().toLocaleLowerCase()));
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-4 space-y-4" data-hermes-pairing={pairing.id}>
      <SourceIdentity source={pairing.source} />
      <fieldset disabled={disabled || expired} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t('hermes.authorizedWorkspaces')}</legend>
        {workspaces.length === 0 && <p className="text-sm text-muted-foreground">{t('hermes.noWorkspaces')}</p>}
        {workspaces.length > 0 && <>
          <Input id={`hermes-workspace-search-${pairing.id}`} type="search" value={workspaceQuery}
            placeholder={t('hermes.searchWorkspaces')} aria-label={t('hermes.searchWorkspaces')}
            onChange={(event) => setWorkspaceQuery(event.target.value)} />
          <p className="text-xs text-muted-foreground" aria-live="polite">{t('hermes.selectedWorkspaces', { count: validSelection.length })}</p>
        </>}
        <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
        {visibleWorkspaces.map((workspace) => (
          <label key={workspace} className="flex items-center justify-between gap-3 rounded-lg bg-background/40 px-3 py-2">
            <span className="min-w-0 break-all text-xs font-mono">{workspace}</span>
            <Switch aria-label={workspace} checked={validSelection.includes(workspace)}
              disabled={disabled || expired}
              onCheckedChange={(checked) => setSelected((current) => checked
                ? [...new Set([...current, workspace])] : current.filter((item) => item !== workspace))} />
          </label>
        ))}
        {workspaces.length > 0 && visibleWorkspaces.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">{t('hermes.noMatchingWorkspaces')}</p>}
        </div>
        <label className="flex items-center justify-between gap-3 pt-2 text-sm">
          <span>{t('hermes.allowInput')}</span>
          <Switch checked={allowInput} onCheckedChange={setAllowInput} disabled={disabled || expired} aria-label={t('hermes.allowInput')} />
        </label>
        <label className="flex items-center justify-between gap-3 py-1 text-sm">
          <span>{t('hermes.notifications')}</span>
          <Switch checked={notifications} onCheckedChange={setNotifications} disabled={disabled || expired} aria-label={t('hermes.notifications')} />
        </label>
      </fieldset>
      <Button size="sm" disabled={disabled || expired || validSelection.length === 0}
        onClick={() => void run('approvePairing', { id: pairing.id, workspaces: validSelection, allowInput, notifications })}>
        {expired ? t('hermes.pairingExpired') : t('hermes.approvePairing')}
      </Button>
    </div>
  );
}

export function HermesPanel() {
  const { t, lang } = useLocale();
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [setupRequestError, setSetupRequestError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<HermesAction | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [platformId, setPlatformId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const latestStatus = useRef<HermesStatus | null>(null);
  const pendingAction = useRef<HermesAction | null>(null);
  const pendingCancel = useRef(false);
  const pollPending = useRef(false);
  const mutationRevision = useRef(0);
  const secrets = useRef<string[]>([]);
  const setupDeadline = useRef<{ id: string; deadline: number } | null>(null);

  const refresh = useCallback(async () => {
    if (pollPending.current || (pendingAction.current && pendingAction.current !== 'install')) return;
    pollPending.current = true;
    const revision = mutationRevision.current;
    try {
      const next = await getHermesStatus();
      if (mounted.current && revision === mutationRevision.current) { latestStatus.current = next; setStatus(next); setReadError(null); }
    } catch (error) {
      if (mounted.current && revision === mutationRevision.current) setReadError(errorText(error, secrets.current));
    } finally {
      pollPending.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 2000);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [refresh]);

  const platforms = status?.gateway.platforms ?? [];
  const platform = platforms.find((item) => item.id === platformId);
  useEffect(() => {
    if (platforms.some((item) => item.id === platformId)) return;
    const configuredId = status?.gateway.configuredPlatform;
    const next = platforms.some((item) => item.id === configuredId)
      ? configuredId! : (platforms.find((item) => item.available && item.strictSend && item.qrSetup)
        ?? platforms.find((item) => item.available && item.strictSend))?.id ?? '';
    if (next === platformId) return;
    setPlatformId(next);
    setFields({});
  }, [status?.gateway.configuredPlatform, platforms, platformId]);
  secrets.current = (platform?.fields ?? []).filter((field) => field.secret).map((field) => fields[field.key] ?? '');

  const run: RunAction = async (action, payload) => {
    const isCancel = action === 'cancelInstall';
    if (isCancel && !INSTALLING.has(status?.installer.state ?? '')) return false;
    if (isCancel ? pendingCancel.current || (pendingAction.current !== null && pendingAction.current !== 'install') : pendingAction.current !== null || pendingCancel.current) return false;
    if (isCancel) { pendingCancel.current = true; setCancelling(true); }
    else { pendingAction.current = action; setBusy(action); }
    const revision = ++mutationRevision.current;
    const redact = [...secrets.current];
    setRequestError(null);
    setSetupRequestError(null);
    try {
      const next = await performHermesAction(action, payload);
      if (mounted.current && revision === mutationRevision.current) { latestStatus.current = next; setStatus(next); }
      return true;
    } catch (error) {
      if (mounted.current && revision === mutationRevision.current) {
        if (action === 'beginSetup' || action === 'cancelSetup') setSetupRequestError(setupErrorKey(error));
        else setRequestError(errorText(error, redact));
      }
      return false;
    } finally {
      if (isCancel) { pendingCancel.current = false; if (mounted.current) setCancelling(false); }
      else { pendingAction.current = null; if (mounted.current) setBusy(null); }
    }
  };

  const stateLabel = (state: string) => {
    const key = `hermes.state_${state}`;
    const translated = t(key);
    return translated === key ? state : translated;
  };
  const disabled = busy !== null || cancelling;
  const installed = status?.installer.state === 'installed';
  const installAccepted = INSTALLING.has(status?.installer.state ?? '');
  const installing = installAccepted || busy === 'install';
  const running = status?.gateway.state === 'running';
  const transitioning = ['starting', 'stopping', 'configuring'].includes(status?.gateway.state ?? '');
  const configured = Boolean(status?.gateway.configuredPlatform);
  const setup = status?.setup;
  if (setup && setupDeadline.current?.id !== setup.id) {
    setupDeadline.current = { id: setup.id, deadline: Date.now() + SETUP_WAIT_MS };
  }
  const waitDeadline = setupDeadline.current ? Math.min(setupDeadline.current.deadline,
    setup?.expiresAt === undefined ? Infinity : timestamp(setup.expiresAt)) : undefined;
  const setupExpired = setup && SETUP_CANCELLABLE.has(setup.state) && waitDeadline !== undefined && waitDeadline <= now;
  const setupState = setupExpired ? 'expired' : setup?.state;
  const setupConnecting = setup?.state === 'connecting';
  const setupPending = setup && SETUP_CANCELLABLE.has(setup.state);
  const qrPlatform = (platform?.qrSetup && platform.available && platform.strictSend ? platform : undefined)
    ?? platforms.find((item) => item.qrSetup && item.available && item.strictSend);
  const showSetup = !running && !manualOpen && Boolean(
    (setup && setup.state !== 'connected') || (!configured && qrPlatform),
  );
  const showManual = !running && !setupConnecting && (manualOpen || (!configured && !showSetup));
  const switchToManual = async () => {
    if (disabled || setupConnecting) return;
    if (setupPending) {
      if (!await run('cancelSetup', { id: setup.id })) return;
      if (latestStatus.current?.setup?.state === 'connecting') return;
    }
    setManualOpen(true);
  };
  const beginSetup = () => {
    const id = setup?.platform ?? qrPlatform?.id;
    if (id) void run('beginSetup', { platform: id });
  };
  const needsMetadata = !configured && platforms.length === 0;
  const isConfiguredPlatform = status?.gateway.configuredPlatform === platformId;
  const configuredFields = isConfiguredPlatform ? status?.gateway.configuredFields ?? [] : [];
  const configValid = platform?.available && platform.strictSend && platform.fields.every((field) => !field.required || fields[field.key]?.trim() || configuredFields.includes(field.key));
  const configChanged = !isConfiguredPlatform || platform?.fields.some((field) => Boolean(fields[field.key]?.trim()));
  const progress = status?.installer.totalBytes ? Math.min(100, (status.installer.downloadedBytes / status.installer.totalBytes) * 100) : null;
  const pairingActive = status?.pairing && timestamp(status.pairing.expiresAt) > Date.now();
  const setupStatusError = setupState === 'error' && !manualOpen && !setupRequestError
    && !(setup?.error === 'setup_pairing_failed' && status?.pairing);
  const visibleError = requestError ?? readError;
  const recentOperations = [...(status?.operations ?? [])].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, 8);
  const recentDeliveries = [...(status?.deliveries ?? [])].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)).slice(0, 5);

  useEffect(() => {
    if (running) { setManualOpen(false); setFields({}); }
  }, [running]);

  return (
    <div className="space-y-5" data-hermes-panel>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary"><Bot className="h-5 w-5" /></div>
          <div><h2 className="text-xl font-semibold">{t('hermes.title')}</h2><p className="text-sm text-muted-foreground">{t('hermes.subtitle')}</p></div>
        </div>
        <Button size="icon" variant="ghost" aria-label={t('hermes.refresh')} onClick={() => { setRequestError(null); setSetupRequestError(null); void refresh(); }}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {visibleError && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">{visibleError}</div>}
      {!status && <p role="status" className="py-8 text-center text-sm text-muted-foreground">{visibleError ? t('hermes.statusUnavailable') : t('hermes.loading')}</p>}

      {status && <>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base">
            <span>{t('hermes.component')}</span><span className="text-xs font-normal text-muted-foreground" role="status">{stateLabel(status.installer.state)}</span>
          </CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {installed ? <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{t('hermes.version', { version: status.installer.version ?? '—' })}</span>
              {!running && !transitioning && <Button size="sm" variant="ghost" disabled={disabled || Boolean(setupPending) || setupConnecting} onClick={() => void run('removeRuntime')}>{t('hermes.removeComponent')}</Button>}
            </div> : <p className="text-sm text-muted-foreground">{t('hermes.installDescription')}</p>}
            {installing && <div className="space-y-2">
              <Progress value={progress} aria-label={t('hermes.installProgress')} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{installAccepted ? <>{(status.installer.downloadedBytes / 1024 / 1024).toFixed(1)} MB{status.installer.totalBytes ? ` / ${(status.installer.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}</> : t('hermes.installRequested')}</span>
                <Button size="sm" variant="ghost" disabled={!installAccepted || cancelling || (busy !== null && busy !== 'install')} onClick={() => void run('cancelInstall')}>{t('hermes.cancel')}</Button>
              </div>
            </div>}
            {status.installer.error && <p role="alert" className="text-sm text-destructive">{errorText(status.installer.error)}</p>}
            {!installed && !installing && <Button disabled={disabled || (status.installer.state === 'error' && !status.installer.retryable)} onClick={() => void run('install')}>
              {status.installer.state === 'paused' ? t('hermes.resumeInstall') : status.installer.state === 'error' || status.installer.state === 'cancelled' ? t('hermes.retryInstall') : t('hermes.install')}
            </Button>}
          </CardContent>
        </Card>

        {installed && <Card>
          <CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base">
            <span>{t('hermes.channel')}</span><span className={`text-xs font-normal ${running ? 'text-primary' : 'text-muted-foreground'}`} role="status">{stateLabel(status.gateway.state)}</span>
          </CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {status.gateway.error && <p role="alert" className="text-sm text-destructive">{errorText(status.gateway.error, secrets.current)}</p>}
            {setupRequestError && <p role="alert" className="text-sm text-destructive" data-hermes-setup-request-error>{t(setupRequestError)}</p>}
            {setupStatusError && <p role="alert" className="text-sm text-destructive" data-hermes-setup-error>{t(setupErrorKey(setup?.error))}</p>}
            {running && <p className="text-sm font-medium">{t('hermes.channelConnected', { platform: platforms.find((item) => item.id === status.gateway.configuredPlatform)?.label ?? status.gateway.configuredPlatform ?? '' })}</p>}
            {!running && configured && !showSetup && !manualOpen && <p className="text-sm text-muted-foreground">{t('hermes.savedConnection', { platform: platforms.find((item) => item.id === status.gateway.configuredPlatform)?.label ?? status.gateway.configuredPlatform ?? '' })}</p>}
            {showSetup && <div className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-5" data-hermes-setup data-setup-state={setupState ?? 'idle'}>
              <div className="space-y-1"><h3 className="text-sm font-medium">{t('hermes.scanTitle')}</h3>
                <p className="text-sm text-muted-foreground">{t('hermes.scanDescription')}</p>
              </div>
              {setupState === 'waiting' && setup?.qrPayload && <div className="flex justify-center">
                <div className="rounded-xl bg-white p-2"><QRCodeSVG value={setup.qrPayload} size={208} level="M" marginSize={4} role="img" aria-label={t('hermes.scanQrLabel')} /></div>
              </div>}
              {(setupState === 'generating' || setupState === 'waiting' || setupState === 'connecting') && <p role="status" className="text-center text-sm text-muted-foreground">
                {t(setupState === 'generating' ? 'hermes.scanGenerating' : setupState === 'connecting' ? 'hermes.scanConnecting' : 'hermes.scanWaiting')}
              </p>}
              {setupState === 'expired' && <p role="status" className="text-sm text-muted-foreground">{t('hermes.scanExpired')}</p>}
              {setupState === 'cancelled' && <p role="status" className="text-sm text-muted-foreground">{t('hermes.scanCancelled')}</p>}
              <div className="flex flex-wrap justify-center gap-2">
                {setupState !== 'generating' && setupState !== 'connecting' && <Button size="sm" disabled={disabled || transitioning} onClick={beginSetup}>
                  {t(setupState === 'waiting' ? 'hermes.scanRefresh' : setupState === 'expired' || setupState === 'error' ? 'hermes.scanRetry' : 'hermes.scanGenerate')}
                </Button>}
                {setupPending && !setupExpired && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run('cancelSetup', { id: setup.id })}>{t('hermes.cancel')}</Button>}
              </div>
            </div>}
            {platforms.length === 0 && !showSetup && !running && <p className="text-sm text-muted-foreground">{t(transitioning ? 'hermes.loadingPlatforms' : 'hermes.noPlatforms')}</p>}
            {platforms.length > 0 && showManual && <form className="space-y-4" data-hermes-manual onSubmit={(event) => {
              event.preventDefault();
              if (!configValid || !configChanged || !platform) return;
              const submitted = Object.fromEntries(platform.fields.filter((field) => fields[field.key]?.trim()).map((field) => [field.key, fields[field.key].trim()]));
              void run('configureChannel', { platform: platform.id, fields: submitted }).then((ok) => { if (ok && mounted.current) setFields({}); });
            }}>
              <div className="space-y-2"><Label htmlFor="hermes-platform">{t('hermes.platform')}</Label>
                <Select value={platformId} disabled={disabled || running || transitioning} onValueChange={(value) => { setPlatformId(value); setFields({}); }}>
                  <SelectTrigger id="hermes-platform"><SelectValue placeholder={t('hermes.choosePlatform')} /></SelectTrigger>
                  <SelectContent>{platforms.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.available || !item.strictSend}>{item.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {!running && !transitioning && platform?.fields.map((field) => <div key={`${platform.id}:${field.key}`} className="space-y-2">
                <Label htmlFor={`hermes-field-${field.key}`}>{field.label}{field.required ? ' *' : ''}</Label>
                <Input id={`hermes-field-${field.key}`} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                  value={fields[field.key] ?? ''} disabled={disabled || !platform.available}
                  placeholder={configuredFields.includes(field.key) ? t('hermes.alreadyConfigured') : undefined}
                  onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} />
              </div>)}
              {!running && !transitioning && <>
                {configChanged && status.routes.some((route) => route.enabled) && <p className="text-xs text-muted-foreground">{t('hermes.configRequiresPairing')}</p>}
                <Button type="submit" variant="outline" size="sm" disabled={disabled || !configValid || !configChanged}>{t('hermes.saveChannel')}</Button>
              </>}
            </form>}
            {!running && !transitioning && <div className="flex flex-wrap gap-2">
              {!showManual && <Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => void switchToManual()}>{t(configured ? 'hermes.editConnection' : 'hermes.manualConnect')}</Button>}
              {manualOpen && !configured && qrPlatform && <Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => { setManualOpen(false); setFields({}); setPlatformId(qrPlatform.id); }}>{t('hermes.useScan')}</Button>}
            </div>}
            {(running || configured || (needsMetadata && !showSetup)) && <div className="flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
              {running && <Button size="sm" disabled={disabled} onClick={() => { setCopied(false); void run('openPairing'); }}>{t('hermes.newPairing')}</Button>}
              <Button size="sm" variant={running ? 'ghost' : 'default'} disabled={disabled || transitioning || setupConnecting} onClick={() => void run(running ? 'stop' : 'start')}>
                {running ? <Square className="mr-2 h-3.5 w-3.5" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                {running ? t('hermes.stop') : t(needsMetadata ? 'hermes.loadPlatforms' : 'hermes.start')}
              </Button>
            </div>}
            {status.pairing && <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
              <p className="text-sm">{pairingActive ? t('hermes.pairingInstruction') : t('hermes.pairingExpired')}</p>
              {pairingActive && <>
                <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-sm font-mono">/ccem connect {status.pairing.code}</code>
                  <Button variant="ghost" size="icon" aria-label={t('hermes.copyCommand')} onClick={() => {
                    void navigator.clipboard.writeText(`/ccem connect ${status.pairing!.code}`).then(() => setCopied(true)).catch((error) => setRequestError(errorText(error)));
                  }}><Copy className="h-4 w-4" /></Button>
                </div>
                <p className="text-xs text-muted-foreground" role="status">{copied ? t('hermes.copied') : t('hermes.pairingExpires', { time: new Date(timestamp(status.pairing.expiresAt)).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US') })}</p>
              </>}
            </div>}
          </CardContent>
        </Card>}

        {status.pending.length > 0 && <Card>
          <CardHeader><CardTitle className="text-base">{t('hermes.pendingPairings')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">{status.pending.map((pairing) => <PendingPairing key={pairing.id} pairing={pairing} workspaces={status.workspaces} disabled={disabled || !running} run={run} />)}</CardContent>
        </Card>}

        {status.routes.length > 0 && <Card>
          <CardHeader><CardTitle className="text-base">{t('hermes.routes')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">{status.routes.map((route) => <div key={route.id} className="space-y-3 rounded-xl border border-border/50 p-4">
            <div className="flex items-start justify-between gap-3"><SourceIdentity source={route.source} />
              <Button size="sm" variant="ghost" disabled={disabled || !route.enabled} onClick={() => void run('disableRoute', { id: route.id })}>{route.enabled ? t('hermes.disableRoute') : t('hermes.routeDisabled')}</Button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{route.allowInput ? t('hermes.allowInput') : t('hermes.queryOnly')}</span><span>·</span><span>{route.notifications ? t('hermes.notifications') : t('hermes.notificationsOff')}</span></div>
            {route.workspaces.map((workspace) => <p key={workspace} className="break-all font-mono text-xs text-muted-foreground">{workspace}</p>)}
          </div>)}</CardContent>
        </Card>}

        {(status.operations.length > 0 || status.deliveries.length > 0) && <Card>
          <CardHeader><CardTitle className="text-base">{t('hermes.activity')}</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            {status.operations.length > 0 && <div className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t('hermes.operations')}</h4>{recentOperations.map((operation) => <div key={operation.id} className="flex items-start justify-between gap-4 text-sm">
              <div className="min-w-0"><p className="break-all font-mono text-xs text-muted-foreground">{operation.runtimeId}</p><p className="mt-1 line-clamp-3 break-words">{operation.detail}</p></div><span className="shrink-0 text-xs">{stateLabel(operation.state === 'running' ? 'started' : operation.state)}</span>
            </div>)}</div>}
            {status.deliveries.length > 0 && <div className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{t('hermes.deliveries')}</h4>{recentDeliveries.map((delivery) => <div key={delivery.id} className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-mono text-muted-foreground">{delivery.id}</span><span className="shrink-0">{stateLabel(delivery.status)}</span></div>)}</div>}
          </CardContent>
        </Card>}
      </>}
    </div>
  );
}
