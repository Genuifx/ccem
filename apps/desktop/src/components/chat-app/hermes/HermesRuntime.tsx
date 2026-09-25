import { useState } from 'react';
import { ChevronDown, PackageCheck } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useLocale } from '@/locales';
import type { HermesRunAction, HermesStatus } from '@/lib/hermes-ipc';
import { errorText } from './hermes-presentation';

export function HermesRuntime({ installer, runtimeAvailable, installed, installing, installAccepted, cancelling, hasActions,
  activeConnection, setupActive, cancelDisabled, run, stateLabel }: {
  installer: HermesStatus['installer']; runtimeAvailable: boolean; installed: boolean; installing: boolean;
  installAccepted: boolean; cancelling: boolean; hasActions: boolean; activeConnection: boolean; setupActive: boolean;
  cancelDisabled: boolean; run: HermesRunAction; stateLabel: (value: string) => string;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const attention = !runtimeAvailable || installing || Boolean(installer.error) || !installed;
  const open = attention || expanded;
  const progress = installer.state === 'downloading' && installer.totalBytes ? Math.min(100, installer.downloadedBytes / installer.totalBytes * 100) : null;
  return <section className={`hermes-runtime${attention ? ' needs-attention' : ''}`} data-hermes-runtime>
    <Button variant="ghost" className="hermes-runtime-summary" aria-expanded={open} aria-controls="hermes-runtime-details"
      onClick={() => setExpanded((value) => !value)} disabled={attention}>
      <PackageCheck aria-hidden="true" />
      <span className="hermes-runtime-name">{t('hermes.component')}<span className="hermes-caption">{installer.version ? t('hermes.version', { version: installer.version }) : t('hermes.componentLocal')}</span></span>
      <span className="hermes-runtime-state" role="status"><span className={`hermes-status-dot${runtimeAvailable ? ' is-running' : ''}`} aria-hidden="true" />{stateLabel(installer.state)}</span>
      {!attention && <ChevronDown className={`hermes-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
    </Button>
    <div id="hermes-runtime-details" className="hermes-runtime-details" hidden={!open} data-hermes-disclosure-content>
      {!runtimeAvailable && <p className="hermes-caption">{t('hermes.installDescription')}</p>}
      {runtimeAvailable && <div className="hermes-runtime-actions">
        {installed && !installing && <Button size="sm" variant="outline" disabled={hasActions || setupActive} onClick={() => void run('install')}>{t('hermes.updateComponent')}</Button>}
        <Button size="sm" variant="ghost" disabled={hasActions || installing || activeConnection || setupActive} onClick={() => void run('removeRuntime')}>{t('hermes.removeComponent')}</Button>
      </div>}
      {installing && <div className="space-y-2"><Progress value={progress} aria-label={t('hermes.installProgress')} /><div className="hermes-install-progress">
        <span>{installAccepted ? installer.state === 'downloading' ? <>{(installer.downloadedBytes / 1024 / 1024).toFixed(1)} MB{installer.totalBytes ? ` / ${(installer.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}</> : stateLabel(installer.state) : t('hermes.installRequested')}</span>
        <Button size="sm" variant="ghost" disabled={!installAccepted || cancelling || cancelDisabled} onClick={() => void run('cancelInstall')}>{t('hermes.cancel')}</Button>
      </div></div>}
      {installer.error && <p role="alert" className="hermes-error">{errorText(installer.error)}</p>}
      {!installed && !installing && <Button disabled={hasActions || (installer.state === 'error' && !installer.retryable)} onClick={() => void run('install')}>{t(installer.state === 'paused' ? 'hermes.resumeInstall' : installer.state === 'error' || installer.state === 'cancelled' ? 'hermes.retryInstall' : 'hermes.install')}</Button>}
    </div>
  </section>;
}
