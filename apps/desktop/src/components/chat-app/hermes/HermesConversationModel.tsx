import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale } from '@/locales';
import type { HermesConnection, HermesRunAction } from '@/lib/hermes-ipc';

export function HermesConversationModel({ connection, models, disabled, run }: {
  connection: HermesConnection; models: { envName: string; model: string }[];
  disabled: boolean; run: HermesRunAction;
}) {
  const { t } = useLocale();
  const id = useId();
  const saved = connection.conversationModel?.envName ?? '';
  const [selected, setSelected] = useState(saved);
  const [didSave, setDidSave] = useState(false);
  useEffect(() => { setSelected(saved); setDidSave(false); }, [connection.accountRef, saved]);
  const available = models.some((model) => model.envName === selected);
  const changed = selected !== saved || models.find((model) => model.envName === selected)?.model !== connection.conversationModel?.model;
  return <section className="hermes-conversation-model" data-hermes-conversation-model>
    <Label htmlFor={id}>{t('hermes.conversationModel')}</Label>
    <div className="flex items-center gap-2">
      <Select value={selected} onValueChange={(value) => { setSelected(value); setDidSave(false); }} disabled={disabled || !models.length}>
        <SelectTrigger id={id} className="min-w-0 flex-1"><SelectValue placeholder={t('hermes.chooseConversationModel')} /></SelectTrigger>
        <SelectContent>{models.map((model) => <SelectItem key={model.envName} value={model.envName}>{model.envName} · {model.model}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" disabled={disabled || !available || !changed} onClick={async () => {
        const result = await run('configureConversation', { accountRef: connection.accountRef, modelEnv: selected });
        if (result) setDidSave(true);
      }}>{t('hermes.saveConversationModel')}</Button>
    </div>
    <p className="hermes-caption" role="status">{t(!models.length ? 'hermes.noConversationModels' : saved && !models.some((m) => m.envName === saved) ? 'hermes.conversationModelUnavailable' : didSave ? 'hermes.conversationModelSaved' : 'hermes.conversationModelHint')}</p>
  </section>;
}
