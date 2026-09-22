import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, RefreshCw } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useLocale } from '@/locales';
import { getHermesStatus, performHermesAction, type HermesAction, type HermesRunAction, type HermesStatus } from '@/lib/hermes-ipc';
import { HermesConnectionCard } from './HermesConnectionCard';
import { HermesChannelForm, HermesChannelPicker, HermesQrSetup } from './HermesChannelSetup';
import { errorText, INSTALLING, platformDisplayName, SETUP_CANCELLABLE, SETUP_WAIT_MS, setupErrorKey, timestamp, TRANSITIONING } from './hermes-presentation';

type Editor = { kind: 'add'; platformId?: string; manual: boolean } | { kind: 'edit'; accountRef: string };
const PAIRING_ACTIONS = new Set<HermesAction>(['openPairing', 'approvePairing']);
const RUNTIME_ACTIONS = new Set<HermesAction>(['install', 'removeRuntime', 'cancelInstall']);

export function HermesPanel() {
  const { t } = useLocale();
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [setupRequestError, setSetupRequestError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Record<string, HermesAction>>({});
  const [connectionRequestErrors, setConnectionRequestErrors] = useState<Record<string, string | null>>({});
  const [cancelling, setCancelling] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const latestStatus = useRef<HermesStatus | null>(null);
  const pendingActions = useRef(new Map<string, { action: HermesAction; id: number }>());
  const actionSequence = useRef(0);
  const scopeSequences = useRef(new Map<string, number>());
  const concurrentActions = useRef(new Set<number>());
  const pendingCancel = useRef(false);
  const pollPending = useRef(false);
  const mutationRevision = useRef(0);
  const setupDeadline = useRef<{ id: string; deadline: number } | null>(null);

  const refresh = useCallback(async () => {
    if (pollPending.current) return;
    pollPending.current = true;
    const revision = mutationRevision.current;
    try {
      const next = await getHermesStatus();
      if (mounted.current && revision === mutationRevision.current) { latestStatus.current = next; setStatus(next); setReadError(null); }
    } catch (error) {
      if (mounted.current && revision === mutationRevision.current) setReadError(errorText(error));
    } finally { pollPending.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 2000);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [refresh]);

  const run: HermesRunAction = async (action, payload, secrets = []) => {
    const isCancel = action === 'cancelInstall';
    const accountRef = payload && 'accountRef' in payload ? payload.accountRef
      : action === 'disableRoute' && payload && 'id' in payload ? latestStatus.current?.routes.find((route) => route.id === payload.id)?.source.accountRef : undefined;
    const scope = accountRef ? `account:${accountRef}` : 'global';
    const globalAction = pendingActions.current.get('global');
    const sameAccountAction = pendingActions.current.get(scope);
    const runtimeBusy = Boolean(globalAction && RUNTIME_ACTIONS.has(globalAction.action)) || INSTALLING.has(latestStatus.current?.installer.state ?? '');
    const interruptPairing = Boolean(accountRef && (action === 'stop' || action === 'removeChannel') && sameAccountAction && PAIRING_ACTIONS.has(sameAccountAction.action));
    if (isCancel) {
      if (!INSTALLING.has(latestStatus.current?.installer.state ?? '') || pendingCancel.current || (globalAction && globalAction.action !== 'install')) return false;
    } else if (pendingCancel.current || runtimeBusy || (sameAccountAction && !interruptPairing)
      || ((action === 'install' || action === 'removeRuntime') && pendingActions.current.size > 0)) return false;
    const id = ++actionSequence.current;
    if (!isCancel) {
      for (const [otherScope, pending] of pendingActions.current) {
        if (otherScope !== scope) {
          concurrentActions.current.add(pending.id);
          concurrentActions.current.add(id);
        }
      }
    }
    scopeSequences.current.set(scope, id);
    ++mutationRevision.current;
    if (isCancel) { pendingCancel.current = true; setCancelling(true); }
    else { pendingActions.current.set(scope, { action, id }); setBusyActions((current) => ({ ...current, [scope]: action })); }
    if (accountRef) setConnectionRequestErrors((current) => ({ ...current, [accountRef]: null }));
    else { setRequestError(null); setSetupRequestError(null); }
    try {
      const next = await performHermesAction(action, payload);
      if (mounted.current && id === actionSequence.current && !concurrentActions.current.has(id)) { latestStatus.current = next; setStatus(next); setReadError(null); }
      return scopeSequences.current.get(scope) === id;
    } catch (error) {
      if (mounted.current && scopeSequences.current.get(scope) === id) {
        if (accountRef) setConnectionRequestErrors((current) => ({ ...current, [accountRef]: errorText(error, secrets) }));
        else if (action === 'beginSetup' || action === 'cancelSetup') setSetupRequestError(setupErrorKey(error));
        else setRequestError(errorText(error, secrets));
      }
      return false;
    } finally {
      // Reads begun while a mutation was in flight cannot roll back its result.
      ++mutationRevision.current;
      if (isCancel) { pendingCancel.current = false; if (mounted.current) setCancelling(false); }
      else if (pendingActions.current.get(scope)?.id === id) {
        pendingActions.current.delete(scope);
        if (mounted.current) setBusyActions((current) => { const next = { ...current }; delete next[scope]; return next; });
      }
      // Concurrent replies have no backend revision. Read again after each
      // completion rather than guessing which full snapshot was captured last.
      const concurrent = concurrentActions.current.delete(id);
      if (mounted.current && (concurrent || (accountRef && id !== actionSequence.current))) await refresh();
    }
  };

  const platforms = status?.gateway.platforms ?? [];
  const connections = status?.connections ?? [];
  const setup = status?.setup;
  const setupConnecting = setup?.state === 'connecting';
  const setupPending = Boolean(setup && SETUP_CANCELLABLE.has(setup.state));
  if (setup && setupDeadline.current?.id !== setup.id) setupDeadline.current = { id: setup.id, deadline: Date.now() + SETUP_WAIT_MS };
  const waitDeadline = setupDeadline.current ? Math.min(setupDeadline.current.deadline, setup?.expiresAt === undefined ? Infinity : timestamp(setup.expiresAt)) : undefined;
  const setupExpired = setupPending && waitDeadline !== undefined && waitDeadline <= now;
  const setupState = setupExpired ? 'expired' : setup?.state;
  const setupConnection = connections.find((item) => item.accountRef === setup?.accountRef);
  const setupRecovered = (setup?.error === 'setup_pairing_failed' && Boolean(setupConnection?.pairing)) || (setup?.error === 'setup_connection_failed' && setupConnection?.state === 'running');
  const setupStatusError = setupState === 'error' && !setupRecovered ? setupErrorKey(setup?.error) : null;
  const editingConnection = editor?.kind === 'edit' ? connections.find((item) => item.accountRef === editor.accountRef) : undefined;
  const platform = platforms.find((item) => item.id === (editingConnection?.platform ?? (editor?.kind === 'add' ? editor.platformId : undefined)));
  const showEditor = editor !== null || connections.length === 0;
  const editorSetup = setup && setup.platform === platform?.id && (!setup.accountRef || setupPending || setupConnecting) && setup.state !== 'connected' ? setup : undefined;
  const manual = editor?.kind === 'edit' || (editor?.kind === 'add' && editor.manual) || !platform?.qrSetup;
  const busy = busyActions.global;
  const hasActions = Object.keys(busyActions).length > 0 || cancelling;
  const installed = status?.installer.state === 'installed';
  const runtimeAvailable = installed || Boolean(status?.installer.launch);
  const installAccepted = INSTALLING.has(status?.installer.state ?? '');
  const installing = installAccepted || busy === 'install';
  const runtimeDisabled = cancelling || installing || Boolean(busy && RUNTIME_ACTIONS.has(busy));
  const disabled = Boolean(busy) || runtimeDisabled;
  const discoveryTransitioning = TRANSITIONING.has(status?.gateway.state ?? '');
  const activeConnection = connections.some((item) => item.state === 'running' || TRANSITIONING.has(item.state));
  const editorDisabled = disabled || installing || Boolean(editingConnection && busyActions[`account:${editingConnection.accountRef}`]);
  const progress = status?.installer.state === 'downloading' && status.installer.totalBytes ? Math.min(100, status.installer.downloadedBytes / status.installer.totalBytes * 100) : null;
  const recentOperations = [...(status?.operations ?? [])].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, 8);
  const recentDeliveries = [...(status?.deliveries ?? [])].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)).slice(0, 5);

  useEffect(() => {
    if (!setup) return;
    if (setup.accountRef && (setup.state === 'connected' || setup.state === 'error')) {
      setEditor((current) => current?.kind === 'add' ? null : current);
    } else if (SETUP_CANCELLABLE.has(setup.state) || setup.state === 'connecting') {
      setEditor((current) => current ?? { kind: 'add', platformId: setup.platform, manual: false });
    }
  }, [setup?.id, setup?.state, setup?.accountRef]);

  useEffect(() => {
    if (status && editor?.kind === 'edit' && !connections.some((item) => item.accountRef === editor.accountRef)) setEditor(null);
  }, [status, connections, editor]);

  const changeEditor = async (next: Editor | null) => {
    if (disabled || setupConnecting) return;
    if (setupPending && setup) {
      if (!await run('cancelSetup', { id: setup.id })) return;
      if (latestStatus.current?.setup?.state === 'connecting') return;
    }
    if (mounted.current) { setSetupRequestError(null); setRequestError(null); setEditor(next); }
  };
  const stateLabel = (value: string) => {
    const key = `hermes.state_${value}`;
    const translated = t(key);
    return translated === key ? value : translated;
  };

  return <div className="space-y-5" data-hermes-panel>
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3"><div className="rounded-xl bg-primary/10 p-2.5 text-primary"><Bot className="h-5 w-5" /></div>
        <div><h2 className="text-xl font-semibold">{t('hermes.title')}</h2><p className="text-sm text-muted-foreground">{t('hermes.subtitle')}</p></div>
      </div>
      <Button size="icon" variant="ghost" aria-label={t('hermes.refresh')} onClick={() => { setRequestError(null); setSetupRequestError(null); void refresh(); }}><RefreshCw className="h-4 w-4" /></Button>
    </div>
    {(requestError ?? readError) && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">{requestError ?? readError}</div>}
    {!status && <p role="status" className="py-8 text-center text-sm text-muted-foreground">{t(readError ? 'hermes.statusUnavailable' : 'hermes.loading')}</p>}
    {status && <>
      <Card><CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base"><span>{t('hermes.component')}</span><span className="text-xs font-normal text-muted-foreground" role="status">{stateLabel(status.installer.state)}</span></CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {runtimeAvailable ? <div className="flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{t('hermes.version', { version: status.installer.version ?? '—' })}</span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {installed && !installing && <Button size="sm" variant="outline" disabled={hasActions || setupPending || setupConnecting} onClick={() => void run('install')}>{t('hermes.updateComponent')}</Button>}
              <Button size="sm" variant="ghost" disabled={hasActions || installing || activeConnection || setupPending || setupConnecting} onClick={() => void run('removeRuntime')}>{t('hermes.removeComponent')}</Button>
            </div>
          </div> : <p className="text-sm text-muted-foreground">{t('hermes.installDescription')}</p>}
          {installing && <div className="space-y-2"><Progress value={progress} aria-label={t('hermes.installProgress')} /><div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{installAccepted ? status.installer.state === 'downloading' ? <>{(status.installer.downloadedBytes / 1024 / 1024).toFixed(1)} MB{status.installer.totalBytes ? ` / ${(status.installer.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}</> : stateLabel(status.installer.state) : t('hermes.installRequested')}</span>
            <Button size="sm" variant="ghost" disabled={!installAccepted || cancelling || Boolean(busy && busy !== 'install')} onClick={() => void run('cancelInstall')}>{t('hermes.cancel')}</Button>
          </div></div>}
          {status.installer.error && <p role="alert" className="text-sm text-destructive">{errorText(status.installer.error)}</p>}
          {!installed && !installing && <Button disabled={hasActions || (status.installer.state === 'error' && !status.installer.retryable)} onClick={() => void run('install')}>{t(status.installer.state === 'paused' ? 'hermes.resumeInstall' : status.installer.state === 'error' || status.installer.state === 'cancelled' ? 'hermes.retryInstall' : 'hermes.install')}</Button>}
        </CardContent>
      </Card>
      {runtimeAvailable && <>
        <div className="flex items-center justify-between gap-3"><h3 className="text-base font-semibold">{t('hermes.connections')}</h3><Button size="sm" variant="outline" disabled={disabled || installing || setupConnecting} onClick={() => void changeEditor({ kind: 'add', manual: false })}>{t('hermes.addChannel')}</Button></div>
        {connections.map((connection) => {
          const accountAction = busyActions[`account:${connection.accountRef}`];
          const accountDisabled = runtimeDisabled || Boolean(accountAction);
          const interruptDisabled = runtimeDisabled || Boolean(accountAction && !PAIRING_ACTIONS.has(accountAction));
          return <HermesConnectionCard key={connection.accountRef} connection={connection} platform={platforms.find((item) => item.id === connection.platform)}
            routes={status.routes.filter((route) => route.source.accountRef === connection.accountRef)} workspaces={status.workspaces} disabled={accountDisabled} stopDisabled={interruptDisabled} removeDisabled={interruptDisabled} editDisabled={disabled || Boolean(setupConnecting)}
            requestError={connectionRequestErrors[connection.accountRef]} setupError={setup?.accountRef === connection.accountRef ? setupStatusError : null} run={run} onEdit={() => void changeEditor({ kind: 'edit', accountRef: connection.accountRef })} stateLabel={stateLabel} />;
        })}
        {showEditor && <Card data-hermes-editor><CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base">
          <span>{editingConnection ? t('hermes.editConnection') : platform ? platformDisplayName(platform.id, platform.label, t) : t('hermes.choosePlatform')}</span>
          {(platform || editingConnection) && <Button size="sm" variant="ghost" disabled={disabled || installing || setupConnecting} onClick={() => void changeEditor(editingConnection ? null : { kind: 'add', manual: false })}>{t(editingConnection ? 'hermes.closeEditor' : 'hermes.changePlatform')}</Button>}
        </CardTitle></CardHeader><CardContent className="space-y-4">
          {setupRequestError && <p role="alert" className="text-sm text-destructive" data-hermes-setup-request-error>{t(setupRequestError)}</p>}
          {editorSetup && setupStatusError && !manual && !setupRequestError && <p role="alert" className="text-sm text-destructive" data-hermes-setup-error>{t(setupStatusError)}</p>}
          {platforms.length === 0 ? <div className="space-y-3"><p className="text-sm text-muted-foreground">{t(discoveryTransitioning ? 'hermes.loadingPlatforms' : 'hermes.noPlatforms')}</p>
            {status.gateway.error && <p role="alert" className="text-sm text-destructive">{errorText(status.gateway.error)}</p>}
            <Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button>
          </div> : !platform && editingConnection ? <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{t('hermes.connectionSchemaUnavailable')}</p><Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button></div>
            : !platform ? <HermesChannelPicker platforms={platforms} disabled={disabled || Boolean(setupConnecting)} onSelect={(id) => setEditor({ kind: 'add', platformId: id, manual: false })} /> : <>
            {manual ? <HermesChannelForm key={editingConnection?.accountRef ?? `new:${platform.id}`} platform={platform} connection={editingConnection} disabled={editorDisabled || Boolean(setupConnecting)} run={run} onSaved={() => setEditor((current) => current === editor ? null : current)} onCancel={() => void changeEditor(null)} />
              : <HermesQrSetup platform={platform} setup={editorSetup} state={editorSetup ? setupState : undefined} disabled={disabled || discoveryTransitioning} onBegin={() => void run('beginSetup', { platform: platform.id })} onCancel={() => { if (editorSetup) void run('cancelSetup', { id: editorSetup.id }); }} />}
            {!editingConnection && platform.qrSetup && <Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => void changeEditor({ kind: 'add', platformId: platform.id, manual: !manual })}>{t(manual ? 'hermes.useScan' : 'hermes.manualConnect')}</Button>}
          </>}
        </CardContent></Card>}
      </>}
      {(status.operations.length > 0 || status.deliveries.length > 0) && <Card><CardHeader><CardTitle className="text-base">{t('hermes.activity')}</CardTitle></CardHeader><CardContent className="space-y-5">
        {status.operations.length > 0 && <div className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t('hermes.operations')}</h4>{recentOperations.map((operation) => <div key={operation.id} className="flex items-start justify-between gap-4 text-sm"><div className="min-w-0"><p className="break-all font-mono text-xs text-muted-foreground">{operation.runtimeId}</p><p className="mt-1 line-clamp-3 break-words">{operation.detail}</p></div><span className="shrink-0 text-xs">{stateLabel(operation.state === 'running' ? 'started' : operation.state)}</span></div>)}</div>}
        {status.deliveries.length > 0 && <div className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{t('hermes.deliveries')}</h4>{recentDeliveries.map((delivery) => <div key={delivery.id} className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-mono text-muted-foreground">{delivery.id}</span><span className="shrink-0">{stateLabel(delivery.status)}</span></div>)}</div>}
      </CardContent></Card>}
    </>}
  </div>;
}
