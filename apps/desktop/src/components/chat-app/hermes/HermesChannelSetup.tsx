import { useState } from 'react';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowRight, CheckCircle2, ChevronDown, ExternalLink, KeyRound, Lock, QrCode, RefreshCw, ShieldCheck } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesPlatform, HermesRunAction, HermesSetup } from '@/lib/hermes-ipc';
import { errorText, platformAvailabilityKey, platformDisplayName, SETUP_CANCELLABLE } from './hermes-presentation';
import { HermesPlatformIcon } from './HermesVisuals';

function SetupDocs({ platform }: { platform: HermesPlatform }) {
  const { t } = useLocale();
  const [openError, setOpenError] = useState<string | null>(null);
  let href: string | undefined;
  try { const url = new URL(platform.setupUrl ?? ''); if (url.protocol === 'https:' && !url.username && !url.password) href = url.href; } catch { /* This registry entry has no official setup URL. */ }
  const target = href;
  return target ? <div className="space-y-2"><a href={target} target="_blank" rel="noreferrer noopener" className="hermes-text-link" onClick={(event) => {
    event.preventDefault();
    setOpenError(null);
    void openExternal(target).catch((error) => setOpenError(errorText(error)));
  }}>{t('hermes.setupGuide')}<ExternalLink aria-hidden="true" /></a>
    {openError && <p role="alert" className="hermes-error">{t('settings.openExternalFailed', { error: openError })}</p>}
  </div> : null;
}

export function HermesChannelPicker({ platforms, disabled, onSelect }: { platforms: HermesPlatform[]; disabled: boolean; onSelect: (id: string) => void }) {
  const { t } = useLocale();
  const [showOthers, setShowOthers] = useState(false);
  const [query, setQuery] = useState('');
  const integrated = platforms.filter((item) => item.strictSend && item.unavailableReason !== 'integration_unsupported')
    .sort((a, b) => Number(!a.available) - Number(!b.available));
  const qr = integrated.filter((item) => item.qrSetup);
  const manual = integrated.filter((item) => !item.qrSetup);
  const others = platforms.filter((item) => !integrated.includes(item));
  const filteredOthers = others.filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const tile = (platform: HermesPlatform) => {
    const unavailable = platformAvailabilityKey(platform);
    return <div key={platform.id} className="hermes-platform-option" data-hermes-platform={platform.id}>
      <Button variant="ghost" className="hermes-platform-button" disabled={disabled || Boolean(unavailable)} onClick={() => onSelect(platform.id)}>
        <HermesPlatformIcon platform={platform.id} />
        <span className="hermes-platform-copy"><span className="hermes-platform-name">{platformDisplayName(platform.id, platform.label, t)}</span>
          <span className="hermes-caption">{t(unavailable ?? (platform.qrSetup ? 'hermes.platformQrAvailable' : 'hermes.platformManualAvailable'))}</span>
        </span>
        <ArrowRight className="hermes-option-arrow" aria-hidden="true" />
      </Button>
      {unavailable && <div className="hermes-unavailable-guide"><SetupDocs platform={platform} /></div>}
    </div>;
  };
  return <div data-hermes-channel-picker>
    <div className={`hermes-catalog${qr.length > 0 && manual.length > 0 ? ' hermes-catalog-split' : ''}`}>
      {qr.length > 0 && <section className="hermes-catalog-group"><h4><QrCode aria-hidden="true" />{t('hermes.scanChannels')}</h4>
        <div className="hermes-platform-list">{qr.map(tile)}</div>
      </section>}
      {manual.length > 0 && <section className="hermes-catalog-group"><h4><KeyRound aria-hidden="true" />{t('hermes.manualChannels')}</h4>
        <div className="hermes-platform-list">{manual.map(tile)}</div>
      </section>}
    </div>
    {others.length > 0 && <div className="hermes-catalog-more"><Button size="sm" variant="ghost" aria-expanded={showOthers}
      aria-controls="hermes-other-channels" onClick={() => setShowOthers((value) => !value)}>
      {t('hermes.otherChannels', { count: others.length })}<ChevronDown className={`hermes-chevron ${showOthers ? 'is-open' : ''}`} aria-hidden="true" />
    </Button>
      {showOthers && <div id="hermes-other-channels" className="space-y-3 pt-3" data-hermes-other-channels>
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('hermes.searchChannels')} aria-label={t('hermes.searchChannels')} />
        <div className="hermes-other-list">{filteredOthers.map(tile)}</div>
        {filteredOthers.length === 0 && <p className="hermes-caption">{t('hermes.noMatchingChannels')}</p>}
      </div>}
    </div>}
  </div>;
}

export function HermesChannelForm({ platform, connection, disabled, run, onSaved, onCancel }: {
  platform: HermesPlatform; connection?: HermesConnection; disabled: boolean; run: HermesRunAction; onSaved: (accountRef?: string) => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(connection?.label ?? '');
  const configured = connection?.configuredFields ?? [];
  const unavailable = platformAvailabilityKey(platform);
  const changed = !connection || label.trim() !== connection.label || platform.fields.some((field) => Boolean(fields[field.key]?.trim()));
  const valid = !unavailable && platform.fields.every((field) => !field.required || Boolean(fields[field.key]?.trim()) || configured.includes(field.key));
  return <form className="hermes-manual-layout" data-hermes-manual data-account-ref={connection?.accountRef ?? ''} onSubmit={(event) => {
    event.preventDefault();
    if (disabled || !valid || !changed) return;
    const submitted = Object.fromEntries(platform.fields.filter((field) => fields[field.key]?.trim()).map((field) => [field.key, fields[field.key].trim()]));
    const redact = platform.fields.filter((field) => field.secret).flatMap((field) => {
      const value = fields[field.key] ?? '';
      return value.trim() ? [value, value.trim()] : [];
    });
    void run('configureChannel', { platform: platform.id, fields: submitted, ...(connection ? { accountRef: connection.accountRef } : {}),
      ...(label.trim() || connection ? { label: label.trim() } : {}) }, redact).then((ok) => { if (ok) { setFields({}); onSaved(ok.configuredAccountRef); } });
  }}>
    <div className="hermes-form-fields">
      <div className="hermes-form-heading"><h3>{t('hermes.manualTitle')}</h3><p>{t('hermes.manualDescription', { platform: platformDisplayName(platform.id, platform.label, t) })}</p></div>
      {unavailable && <p role="status" className="hermes-caption">{t(unavailable)}</p>}
      {platform.fields.map((field) => <div key={field.key} className="hermes-field">
        <Label htmlFor={`hermes-field-${field.key}`}>{field.label}{!field.required && <span className="hermes-optional">{t('hermes.optional')}</span>}</Label>
        <Input id={`hermes-field-${field.key}`} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false}
          value={fields[field.key] ?? ''} disabled={disabled || Boolean(unavailable)} placeholder={configured.includes(field.key) ? t('hermes.alreadyConfigured') : undefined}
          onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} />
      </div>)}
      <div className="hermes-field"><Label htmlFor="hermes-connection-label">{t('hermes.connectionLabel')}</Label>
        <Input id="hermes-connection-label" value={label} maxLength={128} disabled={disabled} placeholder={platformDisplayName(platform.id, platform.label, t)} onChange={(event) => setLabel(event.target.value)} />
      </div>
      {connection && changed && <p className="hermes-caption">{t('hermes.configRequiresPairing')}</p>}
      <div className="hermes-form-actions"><Button type="submit" disabled={disabled || !valid || !changed}>{t('hermes.saveChannel')}</Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>{t('hermes.cancel')}</Button></div>
    </div>
    <aside className="hermes-form-aside"><KeyRound aria-hidden="true" /><h4>{t('hermes.credentialsTitle')}</h4>
      <SetupDocs platform={platform} />
      <p className="hermes-security-note"><Lock aria-hidden="true" />{t('hermes.credentialsPrivate')}</p>
    </aside>
  </form>;
}

export function HermesQrSetup({ platform, setup, state, disabled, onBegin, onCancel }: {
  platform: HermesPlatform; setup?: HermesSetup | null; state?: HermesSetup['state']; disabled: boolean; onBegin: () => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const platformLabel = platformDisplayName(platform.id, platform.label, t);
  const waiting = state === 'waiting' && Boolean(setup?.qrPayload);
  const working = state === 'generating' || state === 'connecting';
  const retry = state === 'expired' || state === 'error';
  return <div className="hermes-scan-layout" data-hermes-setup data-setup-state={state ?? 'idle'}>
    <div className="hermes-scan-intro">
      <HermesPlatformIcon platform={platform.id} large />
      <h3>{t('hermes.scanTitle', { platform: platformLabel })}</h3>
      <p className="hermes-scan-description">{t('hermes.scanDescription', { platform: platformLabel })}</p>
      <ol className="hermes-scan-instructions">
        <li><span aria-hidden="true">1</span><p>{t('hermes.scanInstructionOpen', { platform: platformLabel })}</p></li>
        <li><span aria-hidden="true">2</span><p>{t('hermes.scanInstructionConfirm')}</p></li>
        <li><span aria-hidden="true">3</span><p>{t('hermes.scanInstructionAuthorize')}</p></li>
      </ol>
      {platform.setupService && <p className="hermes-caption" data-hermes-setup-service>{t('hermes.scanServiceNotice', { service: platform.setupService })}</p>}
      <p className="hermes-security-note"><ShieldCheck aria-hidden="true" />{t('hermes.scanPermissionNote')}</p>
    </div>
    <div className="hermes-scan-stage">
      <div className={`hermes-qr-frame${working ? ' is-working' : ''}`} aria-busy={working}>
        {waiting ? <QRCodeSVG value={setup!.qrPayload!} size={208} level="M" marginSize={4} role="img" data-hermes-qr aria-label={t('hermes.scanQrLabel', { platform: platformLabel })} />
          : <div className="hermes-qr-placeholder">
            {state === 'connecting' ? <CheckCircle2 aria-hidden="true" /> : <QrCode aria-hidden="true" />}
            {working ? <span className="hermes-qr-loading" aria-hidden="true" /> : <Button disabled={disabled} onClick={onBegin}>{t(retry ? 'hermes.scanRetry' : 'hermes.scanGenerate')}</Button>}
          </div>}
      </div>
      <div className="hermes-scan-status" role="status" aria-live="polite">
        {(working || waiting) && <><span className="hermes-status-dot" aria-hidden="true" />{t(state === 'generating' ? 'hermes.scanGenerating' : state === 'connecting' ? 'hermes.scanConnecting' : 'hermes.scanWaiting', { platform: platformLabel })}</>}
        {state === 'expired' && t('hermes.scanExpired')}
        {state === 'cancelled' && t('hermes.scanCancelled')}
        {(!state || state === 'error') && t('hermes.scanReady')}
      </div>
      <div className="hermes-scan-actions">
        {waiting && <Button size="sm" variant="ghost" disabled={disabled} onClick={onBegin}><RefreshCw aria-hidden="true" />{t('hermes.scanRefresh')}</Button>}
        {state && SETUP_CANCELLABLE.has(state) && <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>{t('hermes.cancel')}</Button>}
      </div>
    </div>
  </div>;
}
