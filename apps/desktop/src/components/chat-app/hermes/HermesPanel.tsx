import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, MessageCircle, Plus, QrCode, RefreshCw } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import { getHermesStatus, performHermesAction, type HermesAction, type HermesRunAction, type HermesStatus } from '@/lib/hermes-ipc';
import { HermesRuntime } from './HermesRuntime';
import { HermesSteps } from './HermesVisuals';
import './hermes.css';
import { HermesConnectionDrawer } from './HermesConnectionDrawer';
import { HermesConnectionCard, HermesConnectionDetails } from './HermesConnectionCard';
import { HermesChannelForm, HermesChannelPicker, HermesQrSetup } from './HermesChannelSetup';
import { errorText, INSTALLING, platformDisplayName, SETUP_CANCELLABLE, SETUP_WAIT_MS, setupErrorKey, timestamp, TRANSITIONING } from './hermes-presentation';

type Wizard = { kind: 'add'; platformId?: string; manual: boolean } | { kind: 'authorize'; accountRef: string };
type Details = { accountRef: string; editing: boolean };
const PAIRING_ACTIONS = new Set<HermesAction>(['openPairing', 'approvePairing']);
const RUNTIME_ACTIONS = new Set<HermesAction>(['install', 'removeRuntime', 'cancelInstall']);

export function HermesPanel({ children }: { children?: ReactNode }) {
  const { t, lang } = useLocale();
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [setupRequestError, setSetupRequestError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Record<string, HermesAction>>({});
  const [connectionRequestErrors, setConnectionRequestErrors] = useState<Record<string, string | null>>({});
  const [cancelling, setCancelling] = useState(false);
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const returnAccount = useRef<string | null>(null);
  const observedAuthorization = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewKey = useRef('closed');
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
    let result: HermesStatus | false = false;
    try {
      const next = await performHermesAction(action, payload);
      if (action === 'configureChannel' && scopeSequences.current.get(scope) === id) {
        if (!accountRef && !next.configuredAccountRef) throw new Error(t('hermes.configurationResultMissing'));
      }
      if (mounted.current && id === actionSequence.current && !concurrentActions.current.has(id)) { latestStatus.current = next; setStatus(next); setReadError(null); }
      result = next;
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
    // A newer same-scope action can start while the final refresh is in flight.
    // Validate after that await before a caller uses this receipt to navigate.
    return mounted.current && scopeSequences.current.get(scope) === id ? result : false;
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
  const detailConnection = connections.find((item) => item.accountRef === details?.accountRef);
  const authorizationConnection = wizard?.kind === 'authorize' ? connections.find((item) => item.accountRef === wizard.accountRef) : undefined;
  const platform = platforms.find((item) => item.id === (wizard?.kind === 'add' ? wizard.platformId : authorizationConnection?.platform));
  const editorSetup = setup && setup.platform === platform?.id && (!setup.accountRef || setupPending || setupConnecting) && setup.state !== 'connected' ? setup : undefined;
  const manual = (wizard?.kind === 'add' && wizard.manual) || !platform?.qrSetup;
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
  const recentOperations = [...(status?.operations ?? [])].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, 8);
  const recentDeliveries = [...(status?.deliveries ?? [])].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)).slice(0, 5);

  useEffect(() => {
    if (!setup) return;
    if (setup.accountRef && (setup.state === 'connected' || setup.state === 'error')) {
      // Only the active scan may advance this wizard. Historical setup results
      // must not hijack a later manual draft or reopen a completed flow.
      setWizard((current) => current?.kind === 'add' && !current.manual && current.platformId === setup.platform
        ? { kind: 'authorize', accountRef: setup.accountRef! } : current);
    } else if (SETUP_CANCELLABLE.has(setup.state) || setup.state === 'connecting') {
      setWizard((current) => {
        if (current) return current;
        listScroll.current = panelRef.current?.closest('main')?.scrollTop ?? 0;
        return { kind: 'add', platformId: setup.platform, manual: false };
      });
    }
  }, [setup?.id, setup?.state, setup?.accountRef]);

  useEffect(() => {
    if (!status) return;
    if (details && !detailConnection) setDetails(null);
    if (wizard?.kind === 'authorize') {
      if (authorizationConnection) observedAuthorization.current = wizard.accountRef;
      else if (observedAuthorization.current === wizard.accountRef) setWizard(null);
    } else observedAuthorization.current = null;
  }, [status, details, detailConnection, wizard, authorizationConnection]);

  const viewKey = wizard?.kind === 'authorize' ? `authorize:${wizard.accountRef}` : wizard ? `${wizard.platformId ?? 'picker'}:${wizard.manual}` : 'closed';
  useLayoutEffect(() => {
    const scroller = panelRef.current?.closest('main');
    if (wizard) {
      if (scroller) scroller.scrollTop = 0;
      editorHeadingRef.current?.focus({ preventScroll: true });
    } else if (previousViewKey.current !== 'closed') {
      if (scroller) scroller.scrollTop = listScroll.current;
      const target = returnAccount.current && [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-hermes-open]') ?? [])]
        .find((item) => item.dataset.hermesOpen === returnAccount.current);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' }); }
      else addButtonRef.current?.focus({ preventScroll: true });
      returnAccount.current = null;
    }
    previousViewKey.current = viewKey;
  }, [viewKey]);

  const changeWizard = async (next: Wizard | null, accountRef?: string) => {
    if (disabled || setupConnecting) return;
    if (setupPending && setup) {
      const result = await run('cancelSetup', { id: setup.id });
      if (!result) return;
      const latest = result.setup;
      // This action's receipt decides navigation even when its full snapshot was
      // discarded because a different account changed concurrently.
      if (latest && latestStatus.current?.setup?.id === latest.id && SETUP_CANCELLABLE.has(latestStatus.current.setup.state)
        && (latest.state === 'connecting' || latest.accountRef)) {
        latestStatus.current = { ...latestStatus.current, setup: latest };
        setStatus(latestStatus.current);
      }
      if (latest?.state === 'connecting') return;
      if (latest?.accountRef && (latest.state === 'connected' || latest.state === 'error')) {
        setWizard({ kind: 'authorize', accountRef: latest.accountRef });
        return;
      }
    }
    if (mounted.current) {
      setSetupRequestError(null); setRequestError(null);
      if (!next) { returnAccount.current = accountRef ?? null; setHighlighted(accountRef ?? null); }
      else if (!wizard) { setHighlighted(null); listScroll.current = panelRef.current?.closest('main')?.scrollTop ?? 0; }
      setWizard(next);
    }
  };
  const connectionProps = (connection: NonNullable<typeof detailConnection>) => {
    const action = busyActions[`account:${connection.accountRef}`];
    const interruptDisabled = runtimeDisabled || Boolean(action && !PAIRING_ACTIONS.has(action));
    return { connection, platform: platforms.find((item) => item.id === connection.platform),
      routes: status?.routes.filter((route) => route.source.accountRef === connection.accountRef) ?? [], workspaces: status?.workspaces ?? [],
      disabled: runtimeDisabled || Boolean(action), stopDisabled: interruptDisabled, removeDisabled: interruptDisabled,
      editDisabled: disabled || Boolean(setupConnecting), requestError: connectionRequestErrors[connection.accountRef],
      setupError: setup?.accountRef === connection.accountRef ? setupStatusError : null, run, stateLabel,
      onEdit: () => setDetails({ accountRef: connection.accountRef, editing: true }) };
  };
  const stateLabel = (value: string) => {
    const key = `hermes.state_${value}`;
    const translated = t(key);
    return translated === key ? value : translated;
  };

  const authorized = Boolean(authorizationConnection && status?.routes.some((route) => route.source.accountRef === authorizationConnection.accountRef && route.enabled));
  return <div ref={panelRef} className="hermes-panel" data-hermes-panel data-hermes-view={wizard ? 'add' : 'list'}>
    {wizard ? <>
      <header className="hermes-wizard-navigation">
        <Button variant="ghost" size="sm" disabled={disabled || setupConnecting} onClick={() => void changeWizard(null)}><ArrowLeft aria-hidden="true" />{t('hermes.backToConnections')}</Button>
        <span className="hermes-caption">{t('hermes.addChannel')}</span>
      </header>
      <section className="hermes-editor hermes-wizard" data-hermes-editor>
        <header className="hermes-editor-header">
          <div className="hermes-editor-heading"><h3 ref={editorHeadingRef} tabIndex={-1}>{wizard.kind === 'authorize' ? t(authorized ? 'hermes.connectionReady' : 'hermes.authorizeConnection') : platform ? platformDisplayName(platform.id, platform.label, t) : t('hermes.choosePlatform')}</h3>
            {!platform && <p>{t('hermes.choosePlatformHint')}</p>}
          </div>
          {wizard.kind === 'add' && platform && <Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => void changeWizard({ kind: 'add', manual: false })}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('hermes.changePlatform')}</Button>}
        </header>
        <HermesSteps current={wizard.kind === 'authorize' ? 3 : platform ? 2 : 1} />
        <div className="hermes-editor-content">
          {(requestError ?? readError) && <p role="alert" className="hermes-alert">{requestError ?? readError}</p>}
          {setupRequestError && <p role="alert" className="hermes-alert" data-hermes-setup-request-error>{t(setupRequestError)}</p>}
          {wizard.kind === 'authorize' ? authorizationConnection ? <>
            {authorized ? <div className="hermes-complete" role="status"><CheckCircle2 aria-hidden="true" /><h4>{t('hermes.connectionReady')}</h4><p>{t('hermes.connectionReadyHint')}</p>
              <Button onClick={() => void changeWizard(null, authorizationConnection.accountRef)}>{t('hermes.finishSetup')}</Button>
            </div> : <><p className="hermes-authorization-intro">{t('hermes.authorizeHint')}</p>
              <HermesConnectionDetails key={authorizationConnection.accountRef} {...connectionProps(authorizationConnection)} authorizationOnly />
              <footer className="hermes-editor-footer"><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void changeWizard(null, authorizationConnection.accountRef)}>{t('hermes.authorizeLater')}</Button></footer>
            </>}
          </> : <p className="hermes-loading" role="status">{t('hermes.loading')}</p> : <>
            {editorSetup && setupStatusError && !manual && !setupRequestError && <p role="alert" className="hermes-alert" data-hermes-setup-error>{t(setupStatusError)}</p>}
            {platforms.length === 0 ? <div className="hermes-discovery"><p>{t(discoveryTransitioning ? 'hermes.loadingPlatforms' : 'hermes.noPlatforms')}</p>
              {status?.gateway.error && <p role="alert" className="hermes-error">{errorText(status.gateway.error)}</p>}
              <Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button>
            </div> : !platform ? <HermesChannelPicker platforms={platforms} disabled={disabled || Boolean(setupConnecting)} onSelect={(id) => void changeWizard({ kind: 'add', platformId: id, manual: false })} /> : <>
              {manual ? <HermesChannelForm key={`new:${platform.id}`} platform={platform} disabled={disabled || Boolean(setupConnecting)} run={run} onSaved={(accountRef) => {
                setWizard((current) => current === wizard && accountRef ? { kind: 'authorize', accountRef } : current);
              }} onCancel={() => void changeWizard(null)} />
                : <HermesQrSetup platform={platform} setup={editorSetup} state={editorSetup ? setupState : undefined} disabled={disabled || discoveryTransitioning} onBegin={() => void run('beginSetup', { platform: platform.id })} onCancel={() => { if (editorSetup) void run('cancelSetup', { id: editorSetup.id }); }} />}
              {platform.qrSetup && <footer className="hermes-editor-footer"><Button size="sm" variant="ghost" disabled={disabled || setupConnecting} onClick={() => void changeWizard({ kind: 'add', platformId: platform.id, manual: !manual })}><span aria-hidden="true">{manual ? <QrCode /> : <KeyRound />}</span>{t(manual ? 'hermes.useScan' : 'hermes.manualConnect')}<ArrowRight aria-hidden="true" /></Button></footer>}
            </>}
          </>}
        </div>
      </section>
    </> : <>
      <header className="hermes-page-header">
        <div><h2>{t('hermes.title')}</h2><p>{t('hermes.subtitle')}</p></div>
        <div className="hermes-header-actions">
          <Button size="icon" variant="ghost" aria-label={t('hermes.refresh')} onClick={() => { setRequestError(null); setSetupRequestError(null); void refresh(); }}><RefreshCw className="h-4 w-4" /></Button>
          {runtimeAvailable && <Button ref={addButtonRef} data-hermes-add size="sm" disabled={disabled || installing || setupConnecting} onClick={() => void changeWizard({ kind: 'add', manual: false })}><Plus className="h-4 w-4" aria-hidden="true" />{t('hermes.addChannel')}</Button>}
        </div>
      </header>
      {(requestError ?? readError) && <div role="alert" className="hermes-alert">{requestError ?? readError}</div>}
      {!status && <div className="hermes-loading" role="status"><span className="hermes-loading-line" aria-hidden="true" /><p>{t(readError ? 'hermes.statusUnavailable' : 'hermes.loading')}</p></div>}
      {status && <>
        {runtimeAvailable && (connections.length > 0 ? <section className="hermes-connections" aria-labelledby="hermes-connections-title">
          <div className="hermes-section-heading"><h3 id="hermes-connections-title">{t('hermes.connections')}<span className="hermes-count">{connections.length}</span></h3><span className="hermes-caption">{t('hermes.connectionsHint')}</span></div>
          <div className="hermes-connection-list">{connections.map((connection) => <HermesConnectionCard key={connection.accountRef}
            {...connectionProps(connection)} highlighted={highlighted === connection.accountRef} onOpen={() => setDetails({ accountRef: connection.accountRef, editing: false })} />)}</div>
        </section> : <div className="hermes-empty"><MessageCircle aria-hidden="true" /><h3>{t('hermes.noConnections')}</h3><p>{t('hermes.noConnectionsHint')}</p></div>)}
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
        {children}
      </>}
    </>}
    {details && detailConnection && !wizard && <HermesConnectionDrawer key={detailConnection.accountRef} accountRef={detailConnection.accountRef}
      title={detailConnection.label && detailConnection.label !== detailConnection.platform ? detailConnection.label : platformDisplayName(detailConnection.platform, platforms.find((item) => item.id === detailConnection.platform)?.label, t)}
      description={t(details.editing ? 'hermes.editConnection' : 'hermes.connectionDetails')} onClose={() => setDetails(null)}>
      {details.editing ? <>
        {connectionRequestErrors[detailConnection.accountRef] && <p role="alert" className="hermes-alert">{connectionRequestErrors[detailConnection.accountRef]}</p>}
        {platforms.find((item) => item.id === detailConnection.platform) ? <HermesChannelForm key={detailConnection.accountRef}
          platform={platforms.find((item) => item.id === detailConnection.platform)!} connection={detailConnection}
          disabled={disabled || Boolean(busyActions[`account:${detailConnection.accountRef}`])} run={run}
          onSaved={() => setDetails((current) => current === details ? { ...current, editing: false } : current)}
          onCancel={() => setDetails((current) => current ? { ...current, editing: false } : current)} />
          : <div className="hermes-discovery"><p role="status">{t('hermes.connectionSchemaUnavailable')}</p><Button size="sm" disabled={disabled || discoveryTransitioning} onClick={() => void run('refreshPlatforms')}>{t('hermes.loadPlatforms')}</Button></div>}
      </> : <HermesConnectionDetails {...connectionProps(detailConnection)} />}
    </HermesConnectionDrawer>}
  </div>;
}
