import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';

interface ProfileStatus {
  workingDir: string;
  trusted: boolean;
  previouslyTrusted: boolean;
  sourceWarnings: string[];
  skills: { name: string; sourcePath: string; state: 'installed' | 'linked' | 'available' }[];
}

/** Recovery is opt-in, scoped to the displayed project and selected skills. */
export function ClaudeTaskProfile({ workingDir }: { workingDir: string }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setStatus(null); setError(''); setTrust(false); setSelected([]); setBusy(false);
    return () => { generation.current += 1; };
  }, [workingDir]);

  const run = async (repair = false) => {
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const result = await invoke<ProfileStatus>(repair ? 'repair_claude_task_profile' : 'inspect_claude_task_profile', {
        workingDir: repair ? status!.workingDir : workingDir.trim(),
        ...(repair ? { trustProject: trust, skillNames: selected } : {}),
      });
      if (current === generation.current) { setStatus(result); setSelected([]); setTrust(false); }
    } catch (error) {
      if (current === generation.current) setError(String(error));
    } finally { if (current === generation.current) setBusy(false); }
  };

  return <div className="rounded-xl border border-border p-3 space-y-3" data-claude-task-profile>
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium">{t('cron.runtimeProfile')}</span>
      <Button type="button" size="sm" variant="outline" disabled={busy || !workingDir.trim()} onClick={() => void run()}>
        {busy ? t('cron.profileChecking') : t('cron.profileCheck')}
      </Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive break-words">{error}</p>}
    {status && <>
      {status.sourceWarnings.map(warning => <p key={warning} className="text-xs text-muted-foreground break-words">{warning}</p>)}
      <p className="text-xs font-mono break-all">{status.workingDir}</p>
      {status.trusted ? <p role="status" className="text-xs">{t('cron.profileTrusted')}</p> :
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-3 text-xs">
            {t('cron.profileTrustAction')}
            <Switch checked={trust} disabled={busy} onCheckedChange={setTrust} aria-label={t('cron.profileTrustAction')} />
          </label>
          <p className="text-2xs text-muted-foreground">{t('cron.profileTrustHint')}</p>
          {status.previouslyTrusted && <p className="text-2xs text-muted-foreground">{t('cron.profileLegacyTrusted')}</p>}
        </div>}
      {status.skills.some(skill => skill.state !== 'installed') && <div className="space-y-2">
        <p className="text-xs font-medium">{t('cron.profileImport')}</p>
        {status.skills.filter(skill => skill.state !== 'installed').map(skill => <label key={skill.name} className="flex items-center justify-between gap-3 text-xs">
          <span className="min-w-0 break-all">{skill.name}<span className="ml-2 text-muted-foreground">{t(skill.state === 'linked' ? 'cron.profileLinked' : 'cron.profileAvailable')}</span><span className="block text-2xs font-mono text-muted-foreground">{skill.sourcePath}</span></span>
          <Switch disabled={busy} checked={selected.includes(skill.name)} aria-label={`${t('cron.profileImport')} ${skill.name}`}
            onCheckedChange={checked => setSelected(old => checked ? [...old, skill.name] : old.filter(name => name !== skill.name))} />
        </label>)}
        <p className="text-2xs text-muted-foreground">{t('cron.profileCopyHint')}</p>
      </div>}
      <Button type="button" size="sm" disabled={busy || (!trust && !selected.length)} onClick={() => void run(true)}>{t('cron.profileApply')}</Button>
    </>}
  </div>;
}
