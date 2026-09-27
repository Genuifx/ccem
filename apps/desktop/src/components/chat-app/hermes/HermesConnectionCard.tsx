import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bell, ArrowRight, Copy, FolderOpen, MessageCircle, Play, ShieldCheck, Square } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesPendingPairing, HermesPlatform, HermesRoute, HermesRunAction, HermesSource } from '@/lib/hermes-ipc';
import { errorText, platformDisplayName, timestamp, TRANSITIONING } from './hermes-presentation';
import { HermesPlatformIcon, workspaceName } from './HermesVisuals';
import { effectiveAccess, RouteAccessEditor, WorkspaceAccessFields, type WorkspaceAccess } from './HermesWorkspaceAccess';
import { HermesConversationModel } from './HermesConversationModel';

function SourceIdentity({ source }: { source: HermesSource }) {
  const { t } = useLocale();
  return <dl className="hermes-identity">
    <dt>{t('hermes.botAccount')}</dt><dd title={source.accountRef}>{source.accountRef.length > 18 ? `${source.accountRef.slice(0, 8)}…${source.accountRef.slice(-6)}` : source.accountRef}</dd>
    <dt>{t('hermes.recipient')}</dt><dd>{source.userId}</dd>
    <dt>{t('hermes.chat')}</dt><dd>{source.chatId} ({source.chatType})</dd>
    {source.threadId && <><dt>{t('hermes.thread')}</dt><dd>{source.threadId}</dd></>}
  </dl>;
}

function PendingPairing({ pairing, accountRef, workspaces, disabled, run }: {
  pairing: HermesPendingPairing; accountRef: string; workspaces: string[]; disabled: boolean; run: HermesRunAction;
}) {
  const { t } = useLocale();
  const [access, setAccess] = useState<WorkspaceAccess>({ workspaces: [], allowInput: false, notifications: true });
  const [showAccess, setShowAccess] = useState(false);
  const expired = !(timestamp(pairing.expiresAt) > Date.now());
  const value = { ...access, workspaces: access.workspaces.filter((workspace) => workspaces.includes(workspace)) };
  const locked = disabled || expired || pairing.source.accountRef !== accountRef;
  const accessId = `hermes-pairing-access-${accountRef}-${pairing.id}`;
  return <div className="hermes-pairing" data-hermes-pairing={pairing.id}>
    <h4>{t('hermes.pendingPairings')}</h4>
    <SourceIdentity source={pairing.source} />
    <Button type="button" size="sm" variant="ghost" aria-expanded={showAccess} aria-controls={accessId} onClick={() => setShowAccess(!showAccess)}>
      <FolderOpen aria-hidden="true" />{t('hermes.optionalWorkspaceAccess')}{value.workspaces.length > 0 && <span> · {value.workspaces.length}</span>}
    </Button>
    <div id={accessId} hidden={!showAccess} data-hermes-disclosure-content>
      <WorkspaceAccessFields id={`${accountRef}-${pairing.id}`} workspaces={workspaces} value={value} onChange={setAccess} disabled={locked} />
    </div>
    <Button size="sm" disabled={locked} onClick={() => void run('approvePairing', { accountRef, id: pairing.id, ...effectiveAccess(value) })}>
      {expired ? t('hermes.pairingExpired') : t('hermes.approvePairing')}
    </Button>
  </div>;
}

export function HermesConnectionCard({ connection, platform, routes, stateLabel, onOpen, highlighted, requestError, setupError }: {
  connection: HermesConnection; platform?: HermesPlatform; routes: HermesRoute[]; stateLabel: (value: string) => string;
  onOpen: () => void; highlighted: boolean; requestError?: string | null; setupError?: string | null;
}) {
  const { t } = useLocale();
  const platformLabel = platformDisplayName(connection.platform, platform?.label, t);
  const label = !connection.label || connection.label === connection.platform || connection.label === platform?.label ? platformLabel : connection.label;
  const active = routes.filter((route) => route.enabled);
  const workspaceCount = new Set(active.flatMap((route) => route.workspaces)).size;
  const attention = Boolean(connection.error || requestError || setupError);
  return <article className={`hermes-connection${highlighted ? ' is-highlighted' : ''}`} data-hermes-connection={connection.accountRef}>
    <header className="hermes-connection-header">
      <HermesPlatformIcon platform={connection.platform} />
      <div className="hermes-connection-title"><h4>{label}</h4><p>{platformLabel} · <span className="font-mono" title={connection.accountRef}>{connection.accountRef.slice(-8)}</span></p>
        <p>{active.length ? workspaceCount ? t('hermes.accessSummary', { count: workspaceCount }) : t('hermes.pairedWithoutWorkspace') : t('hermes.needsPairing')}{workspaceCount > 0 && <> · {t(active.some((route) => route.allowInput) ? 'hermes.allowInput' : 'hermes.queryOnly')}</>}</p>
      </div>
      <span className="hermes-connection-state" role="status"><span className={`hermes-status-dot${connection.state === 'running' && !attention ? ' is-running' : ''}`} aria-hidden="true" />{attention ? t('hermes.needsAttention') : stateLabel(connection.state)}</span>
      <Button size="sm" variant="ghost" aria-haspopup="dialog" data-hermes-open={connection.accountRef} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>
        {t(connection.pending.length ? 'hermes.pendingPairings' : 'hermes.connectionDetails')}<ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </header>
  </article>;
}

export function HermesConnectionDetails({ connection, platform, routes, workspaces, conversationModels = [], disabled, stopDisabled, removeDisabled, editDisabled, setupError, requestError, run, onEdit, stateLabel, authorizationOnly = false }: {
  connection: HermesConnection; platform?: HermesPlatform; routes: HermesRoute[]; workspaces: string[];
  conversationModels?: { envName: string; model: string }[];
  disabled: boolean; stopDisabled: boolean; removeDisabled: boolean; editDisabled: boolean; setupError?: string | null; requestError?: string | null; run: HermesRunAction; onEdit: () => void; stateLabel: (value: string) => string; authorizationOnly?: boolean;
}) {
  const { t, lang } = useLocale();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const running = connection.state === 'running';
  const canStop = ['running', 'starting', 'configuring', 'reconnecting'].includes(connection.state);
  const transitioning = TRANSITIONING.has(connection.state);
  const pairingActive = connection.pairing && timestamp(connection.pairing.expiresAt) > Date.now();
  const pairingCommand = connection.pairing ? `${platform?.commandPrefix ?? '/ccem'} connect ${connection.pairing.code}` : '';
  const platformLabel = platformDisplayName(connection.platform, platform?.label, t);
  const label = !connection.label || connection.label === connection.platform || connection.label === platform?.label ? platformLabel : connection.label;
  const activeRoutes = routes.filter((route) => route.enabled);
  return <div className="hermes-connection-details" data-hermes-connection-details={connection.accountRef}>
      <div className="hermes-detail-context">
        {authorizationOnly && <HermesPlatformIcon platform={connection.platform} />}
        <div>{authorizationOnly && <h4>{label}</h4>}<p className="hermes-connection-state" role="status"><span className={`hermes-status-dot${running ? ' is-running' : ''}`} aria-hidden="true" />{stateLabel(connection.state)}</p></div>
      </div>
      {connection.error && <p role="alert" className="hermes-alert">{errorText(connection.error)}</p>}
      {requestError && <p role="alert" className="hermes-alert">{requestError}</p>}
      {setupError && <p role="alert" className="hermes-alert" data-hermes-setup-error>{t(setupError)}</p>}
      <div className="hermes-connection-toolbar">
        {running && <Button size="sm" variant={activeRoutes.length ? 'outline' : 'default'} disabled={disabled} onClick={() => { setCopiedCode(null); setCopyError(null); void run('openPairing', { accountRef: connection.accountRef }); }}>{t('hermes.newPairing')}</Button>}
        <Button size="sm" variant={canStop ? 'outline' : 'default'} disabled={(canStop ? stopDisabled : disabled) || connection.state === 'stopping'} onClick={() => void run(canStop ? 'stop' : 'start', { accountRef: connection.accountRef })}>
          {canStop ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}{t(canStop ? 'hermes.stop' : 'hermes.start')}
        </Button>
        {!authorizationOnly && <><Button size="sm" variant="ghost" disabled={disabled || editDisabled || transitioning} onClick={onEdit}>{t('hermes.editConnection')}</Button>
        <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(true)}>{t('hermes.removeChannel')}</Button></>}
        <span className="hermes-account-id" title={connection.accountRef}>{connection.accountRef.slice(-12)}</span>
      </div>
      {confirmRemove && <div className="hermes-remove-confirmation" data-hermes-remove-confirmation>
        <p>{t('hermes.removeChannelConfirm', { label })}</p>
        <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={removeDisabled} onClick={() => void run('removeChannel', { accountRef: connection.accountRef })}>{t('hermes.confirmRemoveChannel')}</Button>
          <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(false)}>{t('hermes.cancel')}</Button></div>
      </div>}
      {connection.pairing && <div className="hermes-pairing-command" data-hermes-pairing-command>
        <p className="text-sm">{pairingActive ? t('hermes.pairingInstruction') : t('hermes.pairingExpired')}</p>
        {pairingActive && <>
          <div className="hermes-command-line"><code>{pairingCommand}</code>
            <Button variant="ghost" size="icon" aria-label={t('hermes.copyCommand')} onClick={() => {
              const code = connection.pairing!.code;
              void navigator.clipboard.writeText(pairingCommand).then(() => setCopiedCode(code)).catch(() => setCopyError(t('hermes.copyFailed')));
            }}><Copy className="h-4 w-4" /></Button>
          </div>
          <p className="hermes-caption" role="status">{copiedCode === connection.pairing.code ? t('hermes.copied') : t('hermes.pairingExpires', { time: new Date(timestamp(connection.pairing.expiresAt)).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US') })}</p>
        </>}
        {copyError && <p role="alert" className="hermes-error">{copyError}</p>}
      </div>}
      {connection.pending.map((pairing) => <PendingPairing key={pairing.id} pairing={pairing} accountRef={connection.accountRef} workspaces={workspaces} disabled={disabled || !running} run={run} />)}
      <HermesConversationModel connection={connection} models={conversationModels} disabled={disabled} run={run} />
      {routes.length > 0 && <div className="hermes-routes"><h4>{t('hermes.routes')}</h4>{routes.map((route) => <PairedChat key={route.id} route={route} workspaces={workspaces} disabled={disabled} accessDisabled={disabled || !connection.enabled} run={run} />)}</div>}
  </div>;
}

function PairedChat({ route, workspaces, disabled, accessDisabled, run }: { route: HermesRoute; workspaces: string[]; disabled: boolean; accessDisabled: boolean; run: HermesRunAction }) {
  const { t } = useLocale();
  const [editingAccess, setEditingAccess] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);
  const accessButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => { setEditingAccess(false); }, [route.generation, route.enabled]);
  useLayoutEffect(() => {
    if (editingAccess) elementRef.current?.querySelector<HTMLElement>('[data-hermes-route-editor]')?.focus();
    else if (wasEditing.current) (accessButtonRef.current ?? elementRef.current)?.focus();
    wasEditing.current = editingAccess;
  }, [editingAccess]);
  return <div ref={elementRef} tabIndex={-1} className="hermes-route" data-hermes-route={route.id}>
        <div className="hermes-route-top"><div className="hermes-route-title"><MessageCircle aria-hidden="true" /><span>{t(route.source.chatType === 'dm' ? 'hermes.directChat' : 'hermes.chat')} · {route.source.userId.length > 18 ? `${route.source.userId.slice(0, 8)}…${route.source.userId.slice(-4)}` : route.source.userId}</span></div>
          <Button size="sm" variant="ghost" disabled={disabled || !route.enabled} onClick={() => void run('disableRoute', { id: route.id })}>{t(route.enabled ? 'hermes.disableRoute' : 'hermes.routeDisabled')}</Button></div>
        {route.workspaces.length > 0 ? <div className="hermes-permissions"><span><ShieldCheck aria-hidden="true" />{t(route.allowInput ? 'hermes.allowInput' : 'hermes.queryOnly')}</span><span><Bell aria-hidden="true" />{t(route.notifications ? 'hermes.notifications' : 'hermes.notificationsOff')}</span></div>
          : <p className="hermes-caption">{t('hermes.noWorkspaceAccess')}</p>}
        <div className="hermes-route-workspaces">{route.workspaces.map((workspace) => <span key={workspace} className="hermes-workspace-tag" title={workspace}><FolderOpen aria-hidden="true" />{workspaceName(workspace)}</span>)}</div>
        {route.enabled && (editingAccess ? <RouteAccessEditor key={route.generation} route={route} workspaces={workspaces} disabled={accessDisabled} run={run} onClose={() => setEditingAccess(false)} />
          : <Button ref={accessButtonRef} size="sm" variant="outline" disabled={accessDisabled} onClick={() => setEditingAccess(true)}>{t('hermes.manageWorkspaceAccess')}</Button>)}
        <details className="hermes-identity-disclosure"><summary>{t('hermes.identityDetails')}</summary><SourceIdentity source={route.source} />
          <div className="space-y-1">{route.workspaces.map((workspace) => <p key={workspace} className="break-all font-mono text-xs text-muted-foreground">{workspace}</p>)}</div>
        </details>
      </div>;
}
