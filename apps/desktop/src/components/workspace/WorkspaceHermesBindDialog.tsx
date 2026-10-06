import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle, RefreshCw } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { HermesPlatformIcon } from '@/components/chat-app/hermes/HermesPlatformIcon';
import { platformDisplayName } from '@/components/chat-app/hermes/hermes-presentation';
import { sessionHermesAction, type HermesSessionHandoff } from '@/lib/hermes-ipc';
import { useLocale } from '@/locales';
import type { NativeSessionSummary } from '@/lib/tauri-ipc';
import '@/components/chat-app/hermes/hermes.css';

function botLabel(target: { label: string; platform: string }, t: (key: string) => string) {
  return target.label && target.label !== target.platform ? target.label : platformDisplayName(target.platform, target.label, t);
}

function handoffIssue(snapshot: HermesSessionHandoff): string | null {
  const binding = snapshot.binding;
  if (!binding) return null;
  if (!snapshot.bindingValid) return 'workspace.hermesHandoffRevoked';
  const target = snapshot.targets.find((r) => r.routeId === binding.routeId && r.generation === binding.generation);
  if (!target?.handoffReady) return 'workspace.hermesHandoffNotReady';
  if (!snapshot.models.some((m) => m.envName === binding.modelEnv)) return 'workspace.hermesHandoffModelUnavailable';
  if (binding.error) return 'workspace.hermesHandoffModelError';
  if (['not_sent', 'unknown', 'revoked', 'unavailable'].includes(snapshot.deliveryStatus ?? '')) return `cron.hermesDelivery_${snapshot.deliveryStatus}`;
  return null;
}

export function WorkspaceHermesBindDialog({ open, onOpenChange, session, onLegacyOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: NativeSessionSummary;
  onLegacyOpen: () => void;
}) {
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<HermesSessionHandoff | null>(null);
  const [target, setTarget] = useState('');
  const [modelEnv, setModelEnv] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const initialized = useRef(false);
  const receiveSnapshot = useCallback((data: HermesSessionHandoff) => {
    setSnapshot(data);
    if (initialized.current) return;
    const chosen = data.binding
      ? data.targets.find((r) => r.routeId === data.binding?.routeId && r.generation === data.binding?.generation)
      : data.targets.length === 1 ? data.targets[0] : undefined;
    setTarget(chosen ? `${chosen.routeId}:${chosen.generation}` : '');
    setModelEnv(data.binding?.modelEnv ?? (data.models.some((m) => m.envName === data.defaultModelEnv) ? data.defaultModelEnv : ''));
    setError(false);
    initialized.current = true;
  }, []);

  useEffect(() => {
    initialized.current = false;
    setSnapshot(null); setTarget(''); setModelEnv(''); setBusy(false);
  }, [open, session.runtime_id]);

  useEffect(() => {
    const current = ++epoch.current;
    setError(false);
    if (!open) return;
    setLoading(true);
    sessionHermesAction('sessionBinding', { runtimeId: session.runtime_id }).then((data) => {
      if (current !== epoch.current) return;
      receiveSnapshot(data);
    }).catch(() => { if (current === epoch.current) setError(true); })
      .finally(() => { if (current === epoch.current) setLoading(false); });
    return () => { ++epoch.current; };
  }, [open, session.runtime_id, revision, receiveSnapshot]);

  useEffect(() => {
    if (!open || busy || loading) return;
    let cancelled = false;
    let inFlight = false;
    const current = epoch.current;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      sessionHermesAction('sessionBinding', { runtimeId: session.runtime_id }).then((data) => {
        if (!cancelled && current === epoch.current) receiveSnapshot(data);
      }).catch(() => { /* Keep the last snapshot; explicit refresh reports errors. */ })
        .finally(() => { inFlight = false; });
    }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, busy, loading, session.runtime_id, revision, receiveSnapshot]);

  const selected = snapshot?.targets.find((r) => `${r.routeId}:${r.generation}` === target);
  const selectedModel = snapshot?.models.find((m) => m.envName === modelEnv);
  const active = snapshot?.binding;
  const activeTarget = snapshot?.targets.find((r) => r.routeId === active?.routeId && r.generation === active?.generation);
  const issue = snapshot && handoffIssue(snapshot);
  const unchanged = active && snapshot.bindingValid && selected?.routeId === active.routeId && selected?.generation === active.generation && active.modelEnv === modelEnv && active.model === selectedModel?.model;

  async function act(action: 'bindSession' | 'detachSession') {
    const current = epoch.current;
    setBusy(true); setError(false);
    try {
      const data = await sessionHermesAction(action, { runtimeId: session.runtime_id,
        ...(action === 'bindSession' ? { routeId: selected?.routeId, generation: selected?.generation, modelEnv } : { bindingId: active?.id }) });
      if (current === epoch.current) setSnapshot(data);
    } catch { if (current === epoch.current) setError(true); }
    finally { if (current === epoch.current) setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="sm:max-w-lg" data-hermes-session-handoff>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Bot className="h-5 w-5" />{t('workspace.hermesHandoffTitle')}</DialogTitle><DialogDescription>{t('workspace.hermesHandoffScope')}</DialogDescription></DialogHeader>
      <div className="space-y-5 py-2">
        <p className="truncate text-sm font-medium">{session.display_title || session.project_dir.split('/').pop()}</p>
        {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="h-4 w-4 animate-spin" />{t('workspace.hermesHandoffLoading')}</p>}
        {active && <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1.5" data-hermes-current-binding>
          <p className="flex items-center gap-2 text-sm font-medium">{activeTarget && <HermesPlatformIcon platform={activeTarget.platform} />} {activeTarget ? botLabel(activeTarget, t) : t('cron.hermesUnavailableTarget')}</p>
          <p className={`text-xs ${issue ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} role="status">{t(issue || 'workspace.hermesHandoffActive')}</p>
          {snapshot.deliveryStatus && issue !== `cron.hermesDelivery_${snapshot.deliveryStatus}` && <p className="text-xs text-muted-foreground">{t(`cron.hermesDelivery_${snapshot.deliveryStatus}`)}</p>}
        </div>}
        {snapshot && <>
          <div className="space-y-2"><Label htmlFor="hermes-handoff-target">{t('workspace.hermesHandoffBot')}</Label>
            <Select value={selected ? target : ''} onValueChange={setTarget} disabled={busy || loading}><SelectTrigger id="hermes-handoff-target"><SelectValue placeholder={t('workspace.hermesHandoffChoose')} /></SelectTrigger>
              <SelectContent>{snapshot.targets.map((r) => <SelectItem key={`${r.routeId}:${r.generation}`} value={`${r.routeId}:${r.generation}`}>
                <span className="flex items-center gap-2 [&_.hermes-platform-icon]:h-6 [&_.hermes-platform-icon]:w-6 [&_img]:h-4 [&_img]:w-4"><HermesPlatformIcon platform={r.platform} /><span className="truncate">{botLabel(r, t)} · …{r.chatId.slice(-8)}</span></span>
              </SelectItem>)}</SelectContent></Select>
            {!snapshot.targets.length && <p className="text-xs text-muted-foreground">{t('cron.hermesNoTargets')}</p>}
            {target && !selected && <p className="text-xs text-amber-600 dark:text-amber-400" role="status">{t('cron.hermesStaleTarget')}</p>}
            {selected && !selected.handoffReady && <p className="text-xs text-amber-600" role="status">{t('workspace.hermesHandoffNotReady')}</p>}
          </div>
          <div className="space-y-2"><Label htmlFor="hermes-handoff-model">{t('workspace.hermesHandoffModel')}</Label>
            <Select value={selectedModel ? modelEnv : ''} onValueChange={setModelEnv} disabled={busy || loading}><SelectTrigger id="hermes-handoff-model"><SelectValue placeholder={t('workspace.hermesHandoffChooseModel')} /></SelectTrigger>
              <SelectContent>{snapshot.models.map((m) => <SelectItem key={m.envName} value={m.envName}>{m.envName} · {m.model}</SelectItem>)}</SelectContent></Select>
            {!snapshot.models.length && <p className="text-xs text-muted-foreground">{t('workspace.hermesHandoffNoModel')}</p>}
            {modelEnv && !selectedModel && <p className="text-xs text-amber-600 dark:text-amber-400" role="status">{t('workspace.hermesHandoffModelUnavailable')}</p>}
          </div>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{t('workspace.hermesHandoffError')}</p>}
      </div>
      <DialogFooter className="gap-2 sm:justify-between">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onOpenChange(false); onLegacyOpen(); }}>{t('workspace.hermesHandoffLegacy')}</Button>
        <div className="flex items-center justify-end gap-2"><Button variant="ghost" size="icon" disabled={busy || loading} aria-label={t('cron.hermesRefresh')} onClick={() => setRevision((r) => r + 1)}><RefreshCw className="h-4 w-4" /></Button>
          {active && <Button variant="outline" disabled={busy || loading} onClick={() => void act('detachSession')}>{t('workspace.hermesHandoffDetach')}</Button>}
          <Button disabled={loading || busy || !selected?.handoffReady || !selectedModel || Boolean(unchanged)} onClick={() => void act('bindSession')}>{busy && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}{active ? t('workspace.hermesHandoffChange') : t('workspace.hermesHandoffStart')}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function WorkspaceHermesSessionBadge({ runtimeId, dialogOpen, onClick }: {
  runtimeId: string;
  dialogOpen: boolean;
  onClick: () => void;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<HermesSessionHandoff | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setStatus(null);
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await sessionHermesAction('sessionBinding', { runtimeId });
        if (!cancelled) setStatus(data);
      } catch { /* A transient refresh failure keeps the last known binding. */ }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runtimeId, dialogOpen]);
  if (!status?.binding) return null;
  const target = status.targets.find((r) => r.routeId === status.binding?.routeId && r.generation === status.binding?.generation);
  const issue = handoffIssue(status);
  return <Button variant="ghost" size="sm" onClick={onClick} data-hermes-session-badge
    className={`h-8 max-w-36 gap-1.5 rounded-full text-xs [&_.hermes-platform-icon]:h-5 [&_.hermes-platform-icon]:w-5 [&_img]:h-3.5 [&_img]:w-3.5 ${issue ? 'text-amber-600 dark:text-amber-400' : ''}`}
    title={t(issue || 'workspace.hermesHandoffActive')}>
    {target ? <HermesPlatformIcon platform={target.platform} /> : <Bot className="h-4 w-4" />}
    <span className="truncate">{!issue && target ? botLabel(target, t) : t('workspace.hermesHandoffNeedsAttention')}</span>
  </Button>;
}
