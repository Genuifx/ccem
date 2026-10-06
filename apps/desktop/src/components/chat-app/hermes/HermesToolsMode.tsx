import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesRunAction } from '@/lib/hermes-ipc';

type ToolsMode = NonNullable<HermesConnection['toolsMode']>;

function ToolsModeOption({ mode }: { mode: ToolsMode }) {
  const { t } = useLocale();
  const descriptionId = useId();
  const native = mode === 'native';
  const label = t(native ? 'hermes.toolsModeNative' : 'hermes.toolsModeCcem');
  const capabilities = t(native ? 'hermes.toolsModeNativeHint' : 'hermes.toolsModeCcemHint');
  const boundary = t(native ? 'hermes.toolsModeWorkspaceBoundary' : 'hermes.toolsModeCcemBoundary');
  return <HoverCard openDelay={250} closeDelay={100}>
    <HoverCardTrigger asChild>
      <SelectItem value={mode} aria-describedby={descriptionId} data-hermes-tools-option={mode}>{label}</SelectItem>
    </HoverCardTrigger>
    <span id={descriptionId} className="sr-only">{capabilities} {boundary}</span>
    <HoverCardContent side="right" align="start" sideOffset={8} collisionPadding={12}
      className="pointer-events-none z-[60] w-72 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
      data-hermes-tools-explanation={mode}>
      <p className="font-semibold">{label}</p>
      <p className="leading-relaxed text-muted-foreground">{capabilities}</p>
      <p className="border-t border-border/40 pt-2 text-xs leading-relaxed text-muted-foreground">{boundary}</p>
    </HoverCardContent>
  </HoverCard>;
}

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
          <ToolsModeOption mode="native" />
          <ToolsModeOption mode="ccem" />
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
