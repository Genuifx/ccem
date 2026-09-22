import { useState } from 'react';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesPlatform, HermesRunAction, HermesSetup } from '@/lib/hermes-ipc';
import { errorText, platformAvailabilityKey, platformDisplayName, SETUP_CANCELLABLE } from './hermes-presentation';

function SetupDocs({ platform }: { platform: HermesPlatform }) {
  const { t } = useLocale();
  const [openError, setOpenError] = useState<string | null>(null);
  let href: string | undefined;
  try { const url = new URL(platform.setupUrl ?? ''); if (url.protocol === 'https:' && !url.username && !url.password) href = url.href; } catch { /* No official setup URL in this registry entry. */ }
  const target = href;
  return target ? <div className="space-y-1"><a href={target} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline-offset-4 hover:underline" onClick={(event) => {
    event.preventDefault();
    setOpenError(null);
    void openExternal(target).catch((error) => setOpenError(errorText(error)));
  }}>{t('hermes.setupGuide')}</a>
    {openError && <p role="alert" className="text-xs text-destructive">{t('settings.openExternalFailed', { error: openError })}</p>}
  </div> : null;
}

export function HermesChannelPicker({ platforms, disabled, onSelect }: { platforms: HermesPlatform[]; disabled: boolean; onSelect: (id: string) => void }) {
  const { t } = useLocale();
  const [showOthers, setShowOthers] = useState(false);
  const [query, setQuery] = useState('');
  const integrated = platforms.filter((item) => item.strictSend && item.unavailableReason !== 'integration_unsupported')
    .sort((a, b) => Number(!a.available) - Number(!b.available));
  const others = platforms.filter((item) => !integrated.includes(item));
  const filteredOthers = others.filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const tile = (platform: HermesPlatform) => {
    const unavailable = platformAvailabilityKey(platform);
    return <div key={platform.id} className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/30 p-4" data-hermes-platform={platform.id}>
      <div className="min-w-0 space-y-1"><p className="text-sm font-medium">{platformDisplayName(platform.id, platform.label, t)}</p>
        <p className="text-xs text-muted-foreground">{t(unavailable ?? (platform.qrSetup ? 'hermes.platformQrAvailable' : 'hermes.platformManualAvailable'))}</p>
        {unavailable && <SetupDocs platform={platform} />}
      </div>
      <Button size="sm" variant="outline" disabled={disabled || Boolean(unavailable)} onClick={() => onSelect(platform.id)}>{t('hermes.selectChannel')}</Button>
    </div>;
  };
  return <div className="space-y-4" data-hermes-channel-picker>
    <div className="grid gap-3 sm:grid-cols-2">{integrated.map(tile)}</div>
    {others.length > 0 && <div className="space-y-3"><Button size="sm" variant="ghost" aria-expanded={showOthers} onClick={() => setShowOthers((value) => !value)}>{t('hermes.otherChannels', { count: others.length })}</Button>
      {showOthers && <div className="space-y-3" data-hermes-other-channels>
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('hermes.searchChannels')} aria-label={t('hermes.searchChannels')} />
        <div className="max-h-80 space-y-3 overflow-y-auto pr-1">{filteredOthers.map(tile)}</div>
        {filteredOthers.length === 0 && <p className="text-sm text-muted-foreground">{t('hermes.noMatchingChannels')}</p>}
      </div>}
    </div>}
  </div>;
}

export function HermesChannelForm({ platform, connection, disabled, run, onSaved, onCancel }: {
  platform: HermesPlatform; connection?: HermesConnection; disabled: boolean; run: HermesRunAction; onSaved: () => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(connection?.label ?? '');
  const configured = connection?.configuredFields ?? [];
  const unavailable = platformAvailabilityKey(platform);
  const changed = !connection || label.trim() !== connection.label || platform.fields.some((field) => Boolean(fields[field.key]?.trim()));
  const valid = !unavailable && platform.fields.every((field) => !field.required || Boolean(fields[field.key]?.trim()) || configured.includes(field.key));
  return <form className="space-y-4" data-hermes-manual data-account-ref={connection?.accountRef ?? ''} onSubmit={(event) => {
    event.preventDefault();
    if (disabled || !valid || !changed) return;
    const submitted = Object.fromEntries(platform.fields.filter((field) => fields[field.key]?.trim()).map((field) => [field.key, fields[field.key].trim()]));
    const redact = platform.fields.filter((field) => field.secret).flatMap((field) => {
      const value = fields[field.key] ?? '';
      return value.trim() ? [value, value.trim()] : [];
    });
    void run('configureChannel', { platform: platform.id, fields: submitted, ...(connection ? { accountRef: connection.accountRef } : {}),
      ...(label.trim() || connection ? { label: label.trim() } : {}) }, redact).then((ok) => { if (ok) { setFields({}); onSaved(); } });
  }}>
    {unavailable && <p role="status" className="text-sm text-muted-foreground">{t(unavailable)}</p>}
    <div className="space-y-2"><Label htmlFor="hermes-connection-label">{t('hermes.connectionLabel')}</Label>
      <Input id="hermes-connection-label" value={label} maxLength={128} disabled={disabled} placeholder={platformDisplayName(platform.id, platform.label, t)} onChange={(event) => setLabel(event.target.value)} />
    </div>
    {platform.fields.map((field) => <div key={field.key} className="space-y-2">
      <Label htmlFor={`hermes-field-${field.key}`}>{field.label}{field.required ? ' *' : ''}</Label>
      <Input id={`hermes-field-${field.key}`} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false}
        value={fields[field.key] ?? ''} disabled={disabled || Boolean(unavailable)} placeholder={configured.includes(field.key) ? t('hermes.alreadyConfigured') : undefined}
        onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} />
    </div>)}
    <SetupDocs platform={platform} />
    {connection && changed && <p className="text-xs text-muted-foreground">{t('hermes.configRequiresPairing')}</p>}
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={disabled || !valid || !changed}>{t('hermes.saveChannel')}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>{t('hermes.cancel')}</Button></div>
  </form>;
}

export function HermesQrSetup({ platform, setup, state, disabled, onBegin, onCancel }: {
  platform: HermesPlatform; setup?: HermesSetup | null; state?: HermesSetup['state']; disabled: boolean; onBegin: () => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const platformLabel = platformDisplayName(platform.id, platform.label, t);
  return <div className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-5" data-hermes-setup data-setup-state={state ?? 'idle'}>
    <div className="space-y-1"><h3 className="text-sm font-medium">{t('hermes.scanTitle', { platform: platformLabel })}</h3><p className="text-sm text-muted-foreground">{t('hermes.scanDescription', { platform: platformLabel })}</p>
      {platform.setupService && <p className="text-xs text-muted-foreground" data-hermes-setup-service>{t('hermes.scanServiceNotice', { service: platform.setupService })}</p>}
    </div>
    {state === 'waiting' && setup?.qrPayload && <div className="flex justify-center"><div className="rounded-xl bg-white p-2"><QRCodeSVG value={setup.qrPayload} size={208} level="M" marginSize={4} role="img" data-hermes-qr aria-label={t('hermes.scanQrLabel', { platform: platformLabel })} /></div></div>}
    {(state === 'generating' || state === 'waiting' || state === 'connecting') && <p role="status" className="text-center text-sm text-muted-foreground">{t(state === 'generating' ? 'hermes.scanGenerating' : state === 'connecting' ? 'hermes.scanConnecting' : 'hermes.scanWaiting', { platform: platformLabel })}</p>}
    {state === 'expired' && <p role="status" className="text-sm text-muted-foreground">{t('hermes.scanExpired')}</p>}
    {state === 'cancelled' && <p role="status" className="text-sm text-muted-foreground">{t('hermes.scanCancelled')}</p>}
    <div className="flex flex-wrap justify-center gap-2">
      {state !== 'generating' && state !== 'connecting' && <Button size="sm" disabled={disabled} onClick={onBegin}>{t(state === 'waiting' ? 'hermes.scanRefresh' : state === 'expired' || state === 'error' ? 'hermes.scanRetry' : 'hermes.scanGenerate')}</Button>}
      {state && SETUP_CANCELLABLE.has(state) && <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>{t('hermes.cancel')}</Button>}
    </div>
  </div>;
}
