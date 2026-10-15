import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';
import type { AgentProfileStatus } from '@/lib/tauri-ipc';
import { invalidateHistoryCache } from '@/features/conversations/historyData';
import { useAppStore } from '@/store';

export function AgentProfilesSettings() {
  const { t } = useLocale();
  const [profiles, setProfiles] = useState<AgentProfileStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await invoke<AgentProfileStatus[]>('get_agent_profiles'));
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const login = async (provider: AgentProfileStatus['provider']) => {
    setLaunching(provider);
    try {
      await invoke('login_agent_profile', { provider });
      toast.success(t('agentProfiles.loginOpened'));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLaunching(null);
    }
  };

  const setCodexIsolation = async (isolated: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      setProfiles(await invoke<AgentProfileStatus[]>('set_codex_isolation', { isolated }));
      invalidateHistoryCache();
      useAppStore.getState().setInstalledSkills([]);
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {loading && <p role="status" className="text-sm text-muted-foreground">{t('agentProfiles.preparing')}</p>}
      {error && (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive break-words">{error}</p>
          <Button variant="outline" onClick={() => void load()}>{t('agentProfiles.retry')}</Button>
        </div>
      )}
      {!loading && !error && profiles.map((profile) => (
        <div key={profile.provider} data-testid={`agent-profile-${profile.provider}`} className="rounded-xl border border-border-subtle p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-sm font-medium">{profile.provider === 'claude' ? 'Claude Code' : 'Codex'}</h3>
            {profile.isolated && (
              <Button variant="outline" size="sm" disabled={launching !== null || saving} onClick={() => void login(profile.provider)}>
                {launching === profile.provider ? t('agentProfiles.opening') : t(profile.provider === 'claude' ? 'agentProfiles.loginClaude' : 'agentProfiles.loginCodex')}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t(profile.isolated ? 'agentProfiles.isolated' : 'agentProfiles.shared')}</p>
          {profile.provider === 'codex' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="codex-isolation" className="text-sm cursor-pointer">{t('agentProfiles.isolateCodex')}</label>
                <Switch id="codex-isolation" checked={profile.isolated} disabled={saving || launching !== null} onCheckedChange={(value) => void setCodexIsolation(value)} />
              </div>
              <p className="text-xs text-muted-foreground">{t('agentProfiles.switchHint')}</p>
              {saving && <p role="status" className="text-xs text-muted-foreground">{t('agentProfiles.saving')}</p>}
              {saveError && <p role="alert" className="text-sm text-destructive break-words">{saveError}</p>}
            </div>
          )}
          <p className="text-xs font-mono text-muted-foreground break-all select-text">{profile.directory}</p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t('agentProfiles.loginHint')}</p>
    </div>
  );
}
