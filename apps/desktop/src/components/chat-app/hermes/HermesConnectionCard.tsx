import { useState } from 'react';
import { Copy, Play, Square } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesPendingPairing, HermesPlatform, HermesRoute, HermesRunAction, HermesSource } from '@/lib/hermes-ipc';
import { errorText, platformDisplayName, timestamp, TRANSITIONING } from './hermes-presentation';

function SourceIdentity({ source }: { source: HermesSource }) {
  const { t } = useLocale();
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <dt>{t('hermes.botAccount')}</dt><dd className="break-all font-mono" title={source.accountRef}>{source.accountRef.length > 18 ? `${source.accountRef.slice(0, 8)}…${source.accountRef.slice(-6)}` : source.accountRef}</dd>
    <dt>{t('hermes.recipient')}</dt><dd className="break-all font-mono">{source.userId}</dd>
    <dt>{t('hermes.chat')}</dt><dd className="break-all font-mono">{source.chatId} ({source.chatType})</dd>
    {source.threadId && <><dt>{t('hermes.thread')}</dt><dd className="break-all font-mono">{source.threadId}</dd></>}
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
  return <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/[0.03] p-4" data-hermes-pairing={pairing.id}>
    <SourceIdentity source={pairing.source} />
    <fieldset disabled={locked} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t('hermes.authorizedWorkspaces')}</legend>
      {workspaces.length === 0 ? <p className="text-sm text-muted-foreground">{t('hermes.noWorkspaces')}</p> : <>
        <Input id={`hermes-workspace-search-${accountRef}-${pairing.id}`} type="search" value={query}
          placeholder={t('hermes.searchWorkspaces')} aria-label={t('hermes.searchWorkspaces')}
          onChange={(event) => setQuery(event.target.value)} />
        <p className="text-xs text-muted-foreground" aria-live="polite">{t('hermes.selectedWorkspaces', { count: validSelection.length })}</p>
      </>}
      <div className="max-h-48 space-y-2 overflow-y-auto pr-1">{visibleWorkspaces.map((workspace) => <label key={workspace} className="flex items-center justify-between gap-3 rounded-lg bg-background/40 px-3 py-2">
        <span className="min-w-0 break-all font-mono text-xs">{workspace}</span>
        <Switch aria-label={workspace} checked={validSelection.includes(workspace)} disabled={locked}
          onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, workspace])] : current.filter((item) => item !== workspace))} />
      </label>)}</div>
      {workspaces.length > 0 && visibleWorkspaces.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">{t('hermes.noMatchingWorkspaces')}</p>}
      <label className="flex items-center justify-between gap-3 pt-2 text-sm"><span>{t('hermes.allowInput')}</span><Switch checked={allowInput} onCheckedChange={setAllowInput} disabled={locked} aria-label={t('hermes.allowInput')} /></label>
      <label className="flex items-center justify-between gap-3 py-1 text-sm"><span>{t('hermes.notifications')}</span><Switch checked={notifications} onCheckedChange={setNotifications} disabled={locked} aria-label={t('hermes.notifications')} /></label>
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
  return <Card data-hermes-connection={connection.accountRef}>
    <CardHeader className="pb-3"><CardTitle className="flex items-start justify-between gap-3 text-base">
      <div className="min-w-0"><span className="break-words">{label}</span><p className="mt-1 text-xs font-normal text-muted-foreground">{platformLabel} · <span className="font-mono" title={connection.accountRef}>{connection.accountRef.slice(-8)}</span></p></div>
      <span className={`shrink-0 text-xs font-normal ${running ? 'text-primary' : 'text-muted-foreground'}`} role="status">{stateLabel(connection.state)}</span>
    </CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {connection.error && <p role="alert" className="text-sm text-destructive">{errorText(connection.error)}</p>}
      {requestError && <p role="alert" className="text-sm text-destructive">{requestError}</p>}
      {setupError && <p role="alert" className="text-sm text-destructive" data-hermes-setup-error>{t(setupError)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {running && <Button size="sm" disabled={disabled} onClick={() => { setCopiedCode(null); setCopyError(null); void run('openPairing', { accountRef: connection.accountRef }); }}>{t('hermes.newPairing')}</Button>}
        <Button size="sm" variant={canStop ? 'outline' : 'default'} disabled={(canStop ? stopDisabled : disabled) || connection.state === 'stopping'} onClick={() => void run(canStop ? 'stop' : 'start', { accountRef: connection.accountRef })}>
          {canStop ? <Square className="mr-2 h-3.5 w-3.5" /> : <Play className="mr-2 h-3.5 w-3.5" />}{t(canStop ? 'hermes.stop' : 'hermes.start')}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || editDisabled || transitioning} onClick={onEdit}>{t('hermes.editConnection')}</Button>
        <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(true)}>{t('hermes.removeChannel')}</Button>
      </div>
      {confirmRemove && <div className="rounded-lg border border-destructive/20 p-3 space-y-3" data-hermes-remove-confirmation>
        <p className="text-sm">{t('hermes.removeChannelConfirm', { label })}</p>
        <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={removeDisabled} onClick={() => void run('removeChannel', { accountRef: connection.accountRef })}>{t('hermes.confirmRemoveChannel')}</Button>
          <Button size="sm" variant="ghost" disabled={removeDisabled} onClick={() => setConfirmRemove(false)}>{t('hermes.cancel')}</Button></div>
      </div>}
      {connection.pairing && <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-4" data-hermes-pairing-command>
        <p className="text-sm">{pairingActive ? t('hermes.pairingInstruction') : t('hermes.pairingExpired')}</p>
        {pairingActive && <>
          <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all font-mono text-sm">{pairingCommand}</code>
            <Button variant="ghost" size="icon" aria-label={t('hermes.copyCommand')} onClick={() => {
              const code = connection.pairing!.code;
              void navigator.clipboard.writeText(pairingCommand).then(() => setCopiedCode(code)).catch(() => setCopyError(t('hermes.copyFailed')));
            }}><Copy className="h-4 w-4" /></Button>
          </div>
          <p className="text-xs text-muted-foreground" role="status">{copiedCode === connection.pairing.code ? t('hermes.copied') : t('hermes.pairingExpires', { time: new Date(timestamp(connection.pairing.expiresAt)).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US') })}</p>
        </>}
        {copyError && <p role="alert" className="text-xs text-destructive">{copyError}</p>}
      </div>}
      {connection.pending.length > 0 && <div className="space-y-3"><h4 className="text-sm font-medium">{t('hermes.pendingPairings')}</h4>
        {connection.pending.map((pairing) => <PendingPairing key={pairing.id} pairing={pairing} accountRef={connection.accountRef} workspaces={workspaces} disabled={disabled || !running} run={run} />)}
      </div>}
      {routes.length > 0 && <div className="space-y-3"><h4 className="text-sm font-medium">{t('hermes.routes')}</h4>{routes.map((route) => <div key={route.id} className="space-y-3 rounded-xl border border-border/50 p-4" data-hermes-route={route.id}>
        <div className="flex items-start justify-between gap-3"><SourceIdentity source={route.source} /><Button size="sm" variant="ghost" disabled={disabled || !route.enabled} onClick={() => void run('disableRoute', { id: route.id })}>{t(route.enabled ? 'hermes.disableRoute' : 'hermes.routeDisabled')}</Button></div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{t(route.allowInput ? 'hermes.allowInput' : 'hermes.queryOnly')}</span><span>·</span><span>{t(route.notifications ? 'hermes.notifications' : 'hermes.notificationsOff')}</span></div>
        {route.workspaces.map((workspace) => <p key={workspace} className="break-all font-mono text-xs text-muted-foreground">{workspace}</p>)}
      </div>)}</div>}
    </CardContent>
  </Card>;
}
