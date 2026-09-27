import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesRunAction } from '@/lib/hermes-ipc';

type ToolsMode = NonNullable<HermesConnection['toolsMode']>;

export function HermesToolsMode({ connection, disabled, run }: {
  connection: HermesConnection; disabled: boolean; run: HermesRunAction;
}) {
  const { t } = useLocale();
  const id = useId();
  const saved = connection.toolsMode ?? 'ccem';
  const [draft, setDraft] = useState<ToolsMode | null>(null);
  const [lastSaved, setLastSaved] = useState<ToolsMode | null>(null);
  // Polling can update capabilities or other settings without replacing a draft.
  // Return to following the saved value only after that selection is observed.
  useEffect(() => { setDraft((value) => value === saved ? null : value); }, [saved]);
  const selected = draft ?? saved;
  const unavailable = selected === 'native' && connection.nativeToolsAvailable !== true;
  const changed = selected !== saved;
  return <section className="hermes-conversation-model" data-hermes-tools-mode>
    <Label htmlFor={id}>{t('hermes.toolsMode')}</Label>
    <div className="flex items-center gap-2">
      <Select value={selected} onValueChange={(value) => {
        if (value !== 'native' && value !== 'ccem') return;
        setDraft(value === saved ? null : value); setLastSaved(null);
      }} disabled={disabled}>
        <SelectTrigger id={id} className="min-w-0 flex-1 [&>span:first-child]:truncate" aria-describedby={`${id}-scope`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="native">{t('hermes.toolsModeNative')}</SelectItem>
          <SelectItem value="ccem">{t('hermes.toolsModeCcem')}</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" disabled={disabled || unavailable || !changed} onClick={async () => {
        if (disabled || unavailable || !changed) return;
        const result = await run('configureTools', { accountRef: connection.accountRef, toolsMode: selected });
        if (result) setLastSaved(selected);
      }}>{t('hermes.saveToolsMode')}</Button>
    </div>
    <p className="hermes-caption" id={`${id}-scope`}>{t(selected === 'native' ? 'hermes.toolsModeNativeHint' : 'hermes.toolsModeCcemHint')}</p>
    {selected === 'native' && <p className="hermes-caption">{t('hermes.toolsModeWorkspaceBoundary')}</p>}
    {(unavailable || (lastSaved === selected && !changed)) && <p className={unavailable ? 'hermes-error' : 'hermes-caption'} role="status">
      {t(unavailable ? 'hermes.nativeToolsUpdateRequired' : 'hermes.toolsModeSaved')}
    </p>}
  </section>;
}
