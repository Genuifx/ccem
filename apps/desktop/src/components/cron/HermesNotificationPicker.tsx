import { useEffect, useId, useState } from 'react';
import { useLocale } from '@/locales';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HermesPlatformIcon } from '@/components/chat-app/hermes/HermesPlatformIcon';
import { getHermesNotificationTargets, type CronHermesNotification, type HermesNotificationTarget } from '@/lib/hermes-ipc';
import '@/components/chat-app/hermes/hermes.css';

const key = (target: CronHermesNotification) => `${target.routeId}:${target.generation}`;

export function HermesNotificationPicker({ value, onChange }: {
  value: CronHermesNotification | null;
  onChange: (value: CronHermesNotification | null) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const [targets, setTargets] = useState<HermesNotificationTarget[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState('loading');
    getHermesNotificationTargets().then((result) => {
      if (active) { setTargets(result); setState('ready'); }
    }).catch(() => { if (active) { setTargets([]); setState('error'); } });
    return () => { active = false; };
  }, [revision]);

  const missing = value && !targets.some((target) => key(target) === key(value));
  return <div className="space-y-2" data-cron-hermes-picker>
    <label htmlFor={id} className="text-xs font-medium">{t('cron.hermesRecipient')}</label>
    <Select value={value ? key(value) : 'off'} disabled={state === 'loading'} onValueChange={(next) => {
      if (next === 'off') { onChange(null); return; }
      const target = targets.find((target) => key(target) === next);
      if (target) onChange({ routeId: target.routeId, generation: target.generation });
    }}>
      <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="h-11">
        <SelectValue placeholder={t('cron.hermesOff')} />
      </SelectTrigger>
      <SelectContent className="z-[160] max-w-[min(90vw,600px)]">
        <SelectItem value="off">{t('cron.hermesOff')}</SelectItem>
        {missing && <SelectItem value={key(value)} disabled>{t('cron.hermesUnavailableTarget')}</SelectItem>}
        {targets.map((target) => <SelectItem key={key(target)} value={key(target)}>
          <span className="flex items-center gap-2 text-xs [&_.hermes-platform-icon]:h-6 [&_.hermes-platform-icon]:w-6 [&_img]:h-4 [&_img]:w-4">
            <HermesPlatformIcon platform={target.platform} />
            <span className="truncate">{target.label} · {target.chatType === 'dm' || target.chatType === 'private' ? t('cron.hermesPrivateChat') : t('cron.hermesGroupChat')} {target.chatId}{target.threadId ? ` / ${target.threadId}` : ''}</span>
          </span>
        </SelectItem>)}
      </SelectContent>
    </Select>
    <div id={`${id}-hint`} className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
      <p role={state === 'error' || (missing && state === 'ready') ? 'status' : undefined}>
        {state === 'loading' ? t('cron.hermesLoading') : state === 'error' ? t('cron.hermesLoadFailed')
          : missing ? t('cron.hermesStaleTarget') : targets.length === 0 ? t('cron.hermesNoTargets') : t('cron.hermesNotificationHint')}
      </p>
      {state !== 'loading' && <Button variant="ghost" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={() => setRevision((value) => value + 1)}>{t('cron.hermesRefresh')}</Button>}
    </div>
  </div>;
}
