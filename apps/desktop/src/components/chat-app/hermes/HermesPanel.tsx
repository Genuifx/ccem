import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, KeyRound, Plus, QrCode, RefreshCw, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import { getHermesStatus, performHermesAction, type HermesAction, type HermesRunAction, type HermesStatus } from '@/lib/hermes-ipc';
import { HermesRuntime } from './HermesRuntime';
import { HermesSteps } from './HermesVisuals';
import './hermes.css';
import { HermesConnectionCard } from './HermesConnectionCard';
import { HermesChannelForm, HermesChannelPicker, HermesQrSetup } from './HermesChannelSetup';
import { errorText, INSTALLING, platformDisplayName, SETUP_CANCELLABLE, SETUP_WAIT_MS, setupErrorKey, timestamp, TRANSITIONING } from './hermes-presentation';

type Editor = { kind: 'add'; platformId?: string; manual: boolean } | { kind: 'edit'; accountRef: string };
const PAIRING_ACTIONS = new Set<HermesAction>(['openPairing', 'approvePairing']);
const RUNTIME_ACTIONS = new Set<HermesAction>(['install', 'removeRuntime', 'cancelInstall']);

export function HermesPanel() {
  const { t, lang } = useLocale();
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [setupRequestError, setSetupRequestError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Record<string, HermesAction>>({});
  const [connectionRequestErrors, setConnectionRequestErrors] = useState<Record<string, string | null>>({});
  const [cancelling, setCancelling] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [now, setNow] = useState(Date.now());
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const previousEditorKey = useRef('closed');
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

  const editorKey = editor?.kind === 'edit' ? editor.accountRef : editor?.platformId ?? (editor ? 'picker' : 'closed');
  useEffect(() => {
    if (editor) editorHeadingRef.current?.focus();
    else if (previousEditorKey.current !== 'closed') addButtonRef.current?.focus();
    previousEditorKey.current = editorKey;
  }, [editorKey]);

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

  return <div className="hermes-panel" data-hermes-panel>
    <header className="hermes-page-header">
      <div><h2>{t('hermes.title')}</h2><p>{t('hermes.subtitle')}</p></div>
      <div className="hermes-header-actions">
        <Button size="icon" variant="ghost" aria-label={t('hermes.refresh')} onClick={() => { setRequestError(null); setSetupRequestError(null); void refresh(); }}><RefreshCw className="h-4 w-4" /></Button>
        {runtimeAvailable && <Button ref={addButtonRef} size="sm" disabled={disabled || installing || setupConnecting} onClick={() => void changeEditor({ kind: 'add', manual: false })}><Plus className="h-4 w-4" aria-hidden="true" />{t('hermes.addChannel')}</Button>}
      </div>
    </header>
    {(requestError ?? readError) && <div role="alert" className="hermes-alert">{requestError ?? readError}</div>}
    {!status && <div className="hermes-loading" role="status"><span className="hermes-loading-line" aria-hidden="true" /><p>{t(readError ? 'hermes.statusUnavailable' : 'hermes.loading')}</p></div>}
    {status && <>
      {runtimeAvailable && <>
        {showEditor && <section className="hermes-editor" data-hermes-editor>
          <header className="hermes-editor-header">
            <div className="hermes-editor-heading"><h3 ref={editorHeadingRef} tabIndex={-1}>{editingConnection ? t('hermes.editConnection') : platform ? platformDisplayName(platform.id, platform.label, t) : t('hermes.choosePlatform')}</h3>
              {!platform && !editingConnection && <p>{t('hermes.choosePlatformHint')}</p>}
            </div>
            <div className="hermes-editor-navigation">
              {platform && !editingConnection && <Button size="sm" variant="ghost" disabled={disabled || installing || setupConnecting} onClick={() => void changeEditor({ kind: 'add', manual: false })}><ArrowLeft aria-hidden="true" />{t('hermes.changePlatform')}</Button>}
              {(connections.length > 0 || editingConnection) && <Button size="icon" variant="ghost" aria-label={t('hermes.closeEditor')} disabled={disabled || installing || setupConnecting} onClick={() => void changeEditor(null)}><X aria-hidden="true" /></Button>}
            </div>
          </header>
          {!editingConnection && <HermesSteps current={platform ? 2 : 1} />}
          <div className="hermes-editor-content">
            {setupRequestError && <p role="alert" className="hermes-alert" data-hermes-setup-request-error>{t(setupRequestError)}</p>}
            {editorSetup && setupStatusError && !manual && !setupRequestError && <p role="alert" className="hermes-alert" data-hermes-setup-error>{t(setupStatusError)}</p>}
            {platforms.length === 0 ? <div className="hermes-discovery"><p>{t(discoveryTransitioning ? 'hermes.loadingPlatforms' : 'hermes.noPlatforms')}</p>
              {status.gateway.error && <p role="alert" className="hermes-error">{errorText(status.gateway.error)}</p>}
              <Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button>
            </div> : !platform && editingConnection ? <div className="hermes-discovery"><p role="status">{t('hermes.connectionSchemaUnavailable')}</p><Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button></div>
              : !platform ? <HermesChannelPicker platforms={platforms} disabled={disabled || Boolean(setupConnecting)} onSelect={(id) => void changeEditor({ kind: 'add', platformId: id, manual: false })} /> : <>
              {manual ? <HermesChannelForm key={editingConnection?.accountRef ?? `new:${platform.id}`} platform={platform} connection={editingConnection} disabled={editorDisabled || Boolean(setupConnecting)} run={run} onSaved={() => setEditor((current) => current === editor ? null : current)} onCancel={() => void changeEditor(null)} />
                : <HermesQrSetup platform={platform} setup={editorSetup} state={editorSetup ? setupState : undefined} disabled={disabled || discoveryTransitioning} onBegin={() => void run('beginSetup', { platform: platform.id })} onCancel={() => { if (editorSetup) void run('cancelSetup', { id: editorSetup.id }); }} />}
              {!editingConnection && platform.qrSetup && <footer className="hermes-editor-footer"><Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => void changeEditor({ kind: 'add', platformId: platform.id, manual: !manual })}><span aria-hidden="true">{manual ? <QrCode /> : <KeyRound />}</span>{t(manual ? 'hermes.useScan' : 'hermes.manualConnect')}<ArrowRight aria-hidden="true" /></Button></footer>}
            </>}
          </div>
        </section>}
        {connections.length > 0 && <section className="hermes-connections" aria-labelledby="hermes-connections-title">
          <div className="hermes-section-heading"><h3 id="hermes-connections-title">{t('hermes.connections')}<span className="hermes-count">{connections.length}</span></h3><span className="hermes-caption">{t('hermes.connectionsHint')}</span></div>
          <div className="hermes-connection-list">{connections.map((connection) => {
            const accountAction = busyActions[`account:${connection.accountRef}`];
            const accountDisabled = runtimeDisabled || Boolean(accountAction);
            const interruptDisabled = runtimeDisabled || Boolean(accountAction && !PAIRING_ACTIONS.has(accountAction));
            return <HermesConnectionCard key={connection.accountRef} connection={connection} platform={platforms.find((item) => item.id === connection.platform)}
              routes={status.routes.filter((route) => route.source.accountRef === connection.accountRef)} workspaces={status.workspaces} disabled={accountDisabled} stopDisabled={interruptDisabled} removeDisabled={interruptDisabled} editDisabled={disabled || Boolean(setupConnecting)}
              requestError={connectionRequestErrors[connection.accountRef]} setupError={setup?.accountRef === connection.accountRef ? setupStatusError : null} run={run} onEdit={() => void changeEditor({ kind: 'edit', accountRef: connection.accountRef })} stateLabel={stateLabel} />;
          })}</div>
        </section>}
      </>}
      {(status.operations.length > 0 || status.deliveries.length > 0) && <section className="hermes-activity" aria-labelledby="hermes-activity-title">
        <div className="hermes-section-heading"><h3 id="hermes-activity-title">{t('hermes.activity')}</h3><Activity aria-hidden="true" /></div>
        <div className="hermes-activity-columns">
          {status.operations.length > 0 && <div><h4 className="hermes-caption">{t('hermes.operations')}</h4>{recentOperations.map((operation) => <div key={operation.id} className="hermes-activity-row"><div className="min-w-0"><p className="hermes-activity-detail">{operation.detail}</p><p className="hermes-activity-id" title={operation.runtimeId}>{operation.runtimeId}</p></div><span className="hermes-activity-state">{stateLabel(operation.state === 'running' ? 'started' : operation.state)}</span></div>)}</div>}
          {status.deliveries.length > 0 && <div><h4 className="hermes-caption">{t('hermes.deliveries')}</h4>{recentDeliveries.map((delivery) => {
            const date = new Date(timestamp(delivery.createdAt));
            return <div key={delivery.id} className="hermes-activity-row"><div className="min-w-0"><p>{t('hermes.chatNotification')}{Number.isFinite(date.getTime()) && <> · <time dateTime={date.toISOString()}>{date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></>}</p><p className="hermes-activity-id" title={delivery.id}>{delivery.id.length > 16 ? `…${delivery.id.slice(-8)}` : delivery.id}</p></div><span className="hermes-activity-state">{stateLabel(delivery.status)}</span></div>;
          })}</div>}
        </div>
      </section>}
      <HermesRuntime installer={status.installer} runtimeAvailable={runtimeAvailable} installed={installed} installing={installing}
        installAccepted={installAccepted} cancelling={cancelling} hasActions={hasActions} activeConnection={activeConnection}
        setupActive={setupPending || Boolean(setupConnecting)} cancelDisabled={Boolean(busy && busy !== 'install')} run={run} stateLabel={stateLabel} />
    </>}
  </div>;
}
