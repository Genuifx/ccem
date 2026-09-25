import { useState } from 'react';
import { Bell, ChevronDown, Copy, FolderOpen, MessageCircle, Play, ShieldCheck, Square } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesPendingPairing, HermesPlatform, HermesRoute, HermesRunAction, HermesSource } from '@/lib/hermes-ipc';
import { errorText, platformDisplayName, timestamp, TRANSITIONING } from './hermes-presentation';
import { HermesPlatformIcon, HermesSteps, workspaceName } from './HermesVisuals';

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
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [allowInput, setAllowInput] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const expired = !(timestamp(pairing.expiresAt) > Date.now());
  const validSelection = selected.filter((workspace) => workspaces.includes(workspace));
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const locked = disabled || expired || pairing.source.accountRef !== accountRef;
  return <div className="hermes-pairing" data-hermes-pairing={pairing.id}>
    <h4>{t('hermes.pendingPairings')}</h4>
    <SourceIdentity source={pairing.source} />
    <fieldset disabled={locked} className="hermes-workspaces">
      <legend>{t('hermes.authorizedWorkspaces')}</legend>
      {workspaces.length === 0 ? <p className="hermes-caption">{t('hermes.noWorkspaces')}</p> : <>
        <Input id={`hermes-workspace-search-${accountRef}-${pairing.id}`} type="search" value={query}
          placeholder={t('hermes.searchWorkspaces')} aria-label={t('hermes.searchWorkspaces')}
          onChange={(event) => setQuery(event.target.value)} />
        <p className="hermes-caption" aria-live="polite">{t('hermes.selectedWorkspaces', { count: validSelection.length })}</p>
      </>}
      <div className="hermes-workspace-list">{visibleWorkspaces.map((workspace) => <label key={workspace} className="hermes-workspace-option">
        <FolderOpen aria-hidden="true" /><span><strong>{workspaceName(workspace)}</strong><small>{workspace}</small></span>
        <Switch aria-label={workspace} checked={validSelection.includes(workspace)} disabled={locked}
          onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, workspace])] : current.filter((item) => item !== workspace))} />
      </label>)}</div>
      {workspaces.length > 0 && visibleWorkspaces.length === 0 && <p className="hermes-caption">{t('hermes.noMatchingWorkspaces')}</p>}
      <label className="hermes-permission-option"><span>{t('hermes.allowInput')}</span><Switch checked={allowInput} onCheckedChange={setAllowInput} disabled={locked} aria-label={t('hermes.allowInput')} /></label>
      <label className="hermes-permission-option"><span>{t('hermes.notifications')}</span><Switch checked={notifications} onCheckedChange={setNotifications} disabled={locked} aria-label={t('hermes.notifications')} /></label>
    </fieldset>
    <Button size="sm" disabled={locked || validSelection.length === 0} onClick={() => void run('approvePairing', { accountRef, id: pairing.id, workspaces: validSelection, allowInput, notifications })}>
      {expired ? t('hermes.pairingExpired') : t('hermes.approvePairing')}
    </Button>
  </div>;
}

export function HermesConnectionCard({ connection, platform, routes, workspaces, disabled, stopDisabled, removeDisabled, editDisabled, setupError, requestError, run, onEdit, stateLabel }: {
  connection: HermesConnection; platform?: HermesPlatform; routes: HermesRoute[]; workspaces: string[];
  disabled: boolean; stopDisabled: boolean; removeDisabled: boolean; editDisabled: boolean; setupError?: string | null; requestError?: string | null; run: HermesRunAction; onEdit: () => void; stateLabel: (value: string) => string;
}) {
  const { t, lang } = useLocale();
  const [expanded, setExpanded] = useState(false);
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
  const attention = Boolean(connection.error || requestError || setupError || connection.pairing || connection.pending.length > 0 || confirmRemove);
  const open = expanded || attention;
  const detailsId = `hermes-connection-details-${connection.accountRef}`;
  return <article className="hermes-connection" data-hermes-connection={connection.accountRef}>
    <header className="hermes-connection-header">
      <HermesPlatformIcon platform={connection.platform} />
      <div className="hermes-connection-title"><h4>{label}</h4><p>{platformLabel} · <span className="font-mono" title={connection.accountRef}>{connection.accountRef.slice(-8)}</span> · {t(activeRoutes.length ? 'hermes.pairedChatsCount' : 'hermes.needsPairing', { count: activeRoutes.length })}</p></div>
      <span className="hermes-connection-state" role="status"><span className={`hermes-status-dot${running ? ' is-running' : ''}`} aria-hidden="true" />{stateLabel(connection.state)}</span>
      <div className="hermes-connection-actions">
        {running && <Button size="sm" variant={activeRoutes.length ? 'ghost' : 'default'} disabled={disabled} onClick={() => { setCopiedCode(null); setCopyError(null); void run('openPairing', { accountRef: connection.accountRef }); }}>{t('hermes.newPairing')}</Button>}
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={detailsId} disabled={attention} onClick={() => setExpanded((value) => !value)}>
          {t('hermes.connectionDetails')}<ChevronDown className={`hermes-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
        </Button>
      </div>
    </header>
    <div id={detailsId} className="hermes-connection-details" hidden={!open} data-hermes-disclosure-content>
      {connection.error && <p role="alert" className="hermes-alert">{errorText(connection.error)}</p>}
      {requestError && <p role="alert" className="hermes-alert">{requestError}</p>}
      {setupError && <p role="alert" className="hermes-alert" data-hermes-setup-error>{t(setupError)}</p>}
      <div className="hermes-connection-toolbar">
        <Button size="sm" variant={canStop ? 'outline' : 'default'} disabled={(canStop ? stopDisabled : disabled) || connection.state === 'stopping'} onClick={() => void run(canStop ? 'stop' : 'start', { accountRef: connection.accountRef })}>
          {canStop ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}{t(canStop ? 'hermes.stop' : 'hermes.start')}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || editDisabled || transitioning} onClick={onEdit}>{t('hermes.editConnection')}</Button>
        <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(true)}>{t('hermes.removeChannel')}</Button>
        <span className="hermes-account-id" title={connection.accountRef}>{connection.accountRef.slice(-12)}</span>
      </div>
      {confirmRemove && <div className="hermes-remove-confirmation" data-hermes-remove-confirmation>
        <p>{t('hermes.removeChannelConfirm', { label })}</p>
        <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={removeDisabled} onClick={() => void run('removeChannel', { accountRef: connection.accountRef })}>{t('hermes.confirmRemoveChannel')}</Button>
          <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(false)}>{t('hermes.cancel')}</Button></div>
      </div>}
      {connection.pairing && <div className="hermes-pairing-command" data-hermes-pairing-command>
        <HermesSteps current={3} />
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
      {routes.length > 0 && <div className="hermes-routes"><h4>{t('hermes.routes')}</h4>{routes.map((route) => <div key={route.id} className="hermes-route" data-hermes-route={route.id}>
        <div className="hermes-route-top"><div className="hermes-route-title"><MessageCircle aria-hidden="true" /><span>{t(route.source.chatType === 'dm' ? 'hermes.directChat' : 'hermes.chat')} · {route.source.userId.length > 18 ? `${route.source.userId.slice(0, 8)}…${route.source.userId.slice(-4)}` : route.source.userId}</span></div>
          <Button size="sm" variant="ghost" disabled={disabled || !route.enabled} onClick={() => void run('disableRoute', { id: route.id })}>{t(route.enabled ? 'hermes.disableRoute' : 'hermes.routeDisabled')}</Button></div>
        <div className="hermes-permissions"><span><ShieldCheck aria-hidden="true" />{t(route.allowInput ? 'hermes.allowInput' : 'hermes.queryOnly')}</span><span><Bell aria-hidden="true" />{t(route.notifications ? 'hermes.notifications' : 'hermes.notificationsOff')}</span></div>
        <div className="hermes-route-workspaces">{route.workspaces.map((workspace) => <span key={workspace} className="hermes-workspace-tag" title={workspace}><FolderOpen aria-hidden="true" />{workspaceName(workspace)}</span>)}</div>
        <details className="hermes-identity-disclosure"><summary>{t('hermes.identityDetails')}</summary><SourceIdentity source={route.source} />
          <div className="space-y-1">{route.workspaces.map((workspace) => <p key={workspace} className="break-all font-mono text-xs text-muted-foreground">{workspace}</p>)}</div>
        </details>
      </div>)}</div>}
    </div>
  </article>;
}
