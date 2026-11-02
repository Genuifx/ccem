import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useClaudeRuntime } from '@/hooks/useClaudeRuntime';
import { isClaudeRuntimeInstalling, type ClaudeRuntimeSource } from '@/lib/claude-runtime';
import { useLocale } from '@/locales';

const REGISTRIES = { official: 'https://registry.npmjs.org/', mirror: 'https://registry.npmmirror.com/' };
const registryPreset = (url: string) => url === REGISTRIES.official ? 'official' : url === REGISTRIES.mirror ? 'mirror' : 'custom';

export function ClaudeRuntimeSettings({ disabled = false, required = false }: {
  disabled?: boolean;
  required?: boolean;
}) {
  const { t } = useLocale();
  const runtime = useClaudeRuntime();
  const { status, loading, error, pending, installing } = runtime;
  const registryId = useId();
  const [editingRegistry, setEditingRegistry] = useState(false);
  const [registryDraft, setRegistryDraft] = useState('');
  useEffect(() => {
    if (!status) return;
    setRegistryDraft(status.registryUrl);
    setEditingRegistry(false);
  }, [status?.registryUrl]);
  const registryChoice = editingRegistry ? 'custom' : registryPreset(status?.registryUrl ?? REGISTRIES.official);
  const registryUnsaved = registryChoice === 'custom' && registryDraft.trim() !== status?.registryUrl;
  const busy = disabled || loading || pending !== null || installing;
  const selected = status?.selected;
  const downloadAndUse = required && status?.preference === 'system';
  const canDownload = Boolean(status?.supported && status.managed.state !== 'available');
  const progress = status?.install.totalBytes && status.install.state === 'downloading'
    ? Math.min(100, status.install.downloadedBytes / status.install.totalBytes * 100)
    : null;
  const downloadLabel = downloadAndUse ? 'claudeRuntime.downloadAndUse'
    : status?.install.state === 'error' || status?.install.state === 'cancelled'
      ? 'claudeRuntime.retryDownload' : 'claudeRuntime.download';
  const phase = status?.install.state === 'idle' ? 'downloading' : status?.install.state;

  return (
    <section className="space-y-3" data-claude-runtime-settings>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('claudeRuntime.title')}</h4>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runtime.refresh(true)} data-claude-runtime-refresh>
          {t('claudeRuntime.refresh')}
        </Button>
      </div>
      {loading && !status && <p role="status" className="text-sm text-muted-foreground">{t('claudeRuntime.checking')}</p>}
      {status && <>
        <div role="group" aria-label={t('claudeRuntime.source')} className="flex flex-wrap gap-1 rounded-lg bg-muted/40 p-1">
          {(['auto', 'system', 'managed'] as ClaudeRuntimeSource[]).map((source) => (
            <Button key={source} size="sm" variant={status.preference === source ? 'secondary' : 'ghost'}
              className="flex-1" disabled={busy} aria-pressed={status.preference === source}
              data-claude-runtime-source={source} onClick={() => void runtime.setSource(source)}>
              {t(`claudeRuntime.source_${source}`)}
            </Button>
          ))}
        </div>
        <div className="space-y-1" data-claude-runtime-selection>
          <p role="status" className="text-sm">
            {selected
              ? t('claudeRuntime.selected', { source: t(`claudeRuntime.source_${selected.source}`), version: selected.version })
              : t('claudeRuntime.unavailable')}
          </p>
          {selected && <p className="break-all font-mono text-xs text-muted-foreground select-text">{selected.path}</p>}
          {!selected && status.preference !== 'managed' && <p className="text-xs text-muted-foreground">
            {t(`claudeRuntime.system_${status.system.state}`)}
            {status.system.version ? ` · ${status.system.version}` : ''}
          </p>}
          {!selected && status.system.detail && status.preference !== 'managed' && (
            <p className="break-words text-xs text-muted-foreground">{status.system.detail}</p>
          )}
          {!selected && status.preference !== 'system' && status.managed.detail && (
            <p className="break-words text-xs text-muted-foreground">{status.managed.detail}</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('claudeRuntime.newSessionsOnly')}</p>
        <div className="space-y-2 border-t border-border/40 pt-3" data-claude-runtime-registry>
          <label htmlFor={registryId} className="text-sm font-medium">{t('claudeRuntime.registry')}</label>
          <Select value={status.registryError && !editingRegistry ? '' : registryChoice} disabled={busy} onValueChange={(choice) => {
            if (choice === 'custom') {
              setRegistryDraft(registryPreset(status.registryUrl) === 'custom' ? status.registryUrl : '');
              setEditingRegistry(true);
            } else if (choice === 'official' || choice === 'mirror') {
              setEditingRegistry(false);
              const url = REGISTRIES[choice];
              if (url !== status.registryUrl || status.registryError) void runtime.setRegistry(url);
            }
          }}>
            <SelectTrigger id={registryId} data-claude-runtime-registry-select><SelectValue placeholder={t('claudeRuntime.registrySelect')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="official" data-claude-runtime-registry-option="official">{t('claudeRuntime.registryOfficial')}</SelectItem>
              <SelectItem value="mirror" data-claude-runtime-registry-option="mirror">{t('claudeRuntime.registryMirror')}</SelectItem>
              <SelectItem value="custom" data-claude-runtime-registry-option="custom">{t('claudeRuntime.registryCustom')}</SelectItem>
            </SelectContent>
          </Select>
          {registryChoice === 'custom' && <div className="flex items-center gap-2">
            <Input value={registryDraft} disabled={busy} onChange={(event) => setRegistryDraft(event.target.value)}
              aria-label={t('claudeRuntime.registryUrl')} placeholder="https://registry.example.com/npm/"
              autoCapitalize="none" autoCorrect="off" spellCheck={false} data-claude-runtime-registry-input />
            <Button size="sm" variant="outline" disabled={busy || !registryDraft.trim() || (!registryUnsaved && !status.registryError)}
              onClick={async () => {
                const next = await runtime.setRegistry(registryDraft.trim());
                if (next) { setRegistryDraft(next.registryUrl); setEditingRegistry(false); }
              }} data-claude-runtime-registry-save>
              {t('common.save')}
            </Button>
          </div>}
          <p className="text-xs text-muted-foreground">{t('claudeRuntime.registryHint')}</p>
          {pending === 'registry' && <p role="status" className="text-xs text-muted-foreground">{t('claudeRuntime.registrySaving')}</p>}
          {status.registryError && <p role="alert" className="break-words text-sm text-destructive">{status.registryError}</p>}
        </div>
        {!status.supported && <p role="alert" className="text-sm text-muted-foreground">
          {status.unsupportedReason || t('claudeRuntime.unsupported')}
        </p>}
        {installing && <div className="space-y-2" data-claude-runtime-progress>
          <Progress value={progress} aria-label={t('claudeRuntime.downloadProgress')} />
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-xs text-muted-foreground">
              {t(`claudeRuntime.phase_${phase ?? 'downloading'}`)}
              {status.install.state === 'downloading' && status.install.totalBytes != null && (
                ` · ${(status.install.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(status.install.totalBytes / 1024 / 1024).toFixed(1)} MB`
              )}
            </p>
            <Button size="sm" variant="ghost" disabled={disabled || pending === 'cancel' || !isClaudeRuntimeInstalling(status)}
              onClick={() => void runtime.cancel()} data-claude-runtime-cancel>
              {t(pending === 'cancel' ? 'claudeRuntime.cancelling' : 'claudeRuntime.cancel')}
            </Button>
          </div>
        </div>}
        {!installing && status.install.state === 'cancelled' && (
          <p role="status" className="text-xs text-muted-foreground">{t('claudeRuntime.cancelled')}</p>
        )}
        {status.install.error && <p role="alert" className="break-words text-sm text-destructive">{status.install.error}</p>}
        {canDownload && !installing && <Button size="sm" variant={required ? 'default' : 'outline'} disabled={busy || registryUnsaved || Boolean(status.registryError)}
          onClick={() => void runtime.install(downloadAndUse)} data-claude-runtime-download>
          {t(downloadLabel, { version: status.recommendedVersion })}
        </Button>}
        {required && downloadAndUse && status.managed.state === 'available' && !installing && (
          <Button size="sm" disabled={busy} onClick={() => void runtime.setSource('managed')} data-claude-runtime-use-managed>
            {t('claudeRuntime.useManaged')}
          </Button>
        )}
      </>}
      {error !== null && <div role="alert" className="space-y-2">
        <p className="break-words text-sm text-destructive">{error || t('claudeRuntime.statusFailed')}</p>
        {!status && <Button size="sm" variant="outline" disabled={loading} onClick={() => void runtime.refresh(true)}>
          {t('claudeRuntime.refresh')}
        </Button>}
      </div>}
    </section>
  );
}

export function ClaudeRuntimeRequiredDialog({ open, onOpenChange, context = 'draft' }: {
  open: boolean; onOpenChange: (open: boolean) => void; context?: 'draft' | 'login';
}) {
  const { t } = useLocale();
  const closeLabel = t(context === 'login' ? 'claudeRuntime.backToSettings' : 'claudeRuntime.backToDraft');
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="overflow-y-auto" data-claude-runtime-required closeLabel={closeLabel}>
      <DialogHeader>
        <DialogTitle>{t('claudeRuntime.requiredTitle')}</DialogTitle>
        <DialogDescription>{t(context === 'login' ? 'claudeRuntime.requiredLoginDescription' : 'claudeRuntime.requiredDescription')}</DialogDescription>
      </DialogHeader>
      {open && <ClaudeRuntimeSettings required />}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{closeLabel}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
