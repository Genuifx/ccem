import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useLocale } from '@/locales';
import { useRouterConfigEditor } from '@/hooks/useRouterConfig';
import { DEFAULT_ROUTER_PORT } from '@ccem/core/browser';
import { toast } from 'sonner';

/**
 * Settings → Router section. Infrastructure only: port + status. Routing
 * itself is opted in per Composer (the "+"-menu 「动态路由」 row); default
 * bindings / allowed / dynamicRouting / profiles live on the Environments
 * page (EnvironmentsRouterRules). There is deliberately NO enable toggle —
 * Settings must not gate routing.
 *
 * This is a dedicated child component so its hooks run only when mounted (the
 * section is active), never violating the parent Settings' hook ordering.
 */
export function SettingsRouterSection() {
  const { t } = useLocale();
  const { config, status, commit } = useRouterConfigEditor();
  const [portDraft, setPortDraft] = useState<string>(String(DEFAULT_ROUTER_PORT));

  const savedPort = config?.port ?? DEFAULT_ROUTER_PORT;

  // Sync the port input to the authoritative value whenever it changes
  // (initial load, a successful save, or an external edit). useEffect — never a
  // render-phase write — so it tracks subsequent config updates too.
  useEffect(() => {
    setPortDraft(String(savedPort));
  }, [savedPort]);

  const actualPort = status?.actualPort ?? null;
  const portPending = actualPort != null && actualPort !== savedPort;
  const stateKey = status?.state
    ? `router.status${status.state.charAt(0).toUpperCase()}${status.state.slice(1)}`
    : null;

  const commitPort = async () => {
    const trimmed = portDraft.trim();
    // Exact integer (rejects "123abc", "1.5", "1e2", ""); no backend write on bad input.
    const isInteger = /^\d+$/.test(trimmed);
    const parsed = isInteger ? Number(trimmed) : NaN;
    if (!isInteger || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setPortDraft(String(savedPort));
      toast.error(t('settings.routerPortInvalid'));
      return;
    }
    if (parsed === savedPort) return;
    try {
      await commit({ port: parsed });
    } catch {
      // commit() reloaded truth on failure; revert the input to the saved value.
      setPortDraft(String(savedPort));
      toast.error(t('settings.routerSaveFailed'));
    }
  };

  if (!config) {
    return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {t('settings.routerPort')}
        </label>
        <p className="text-sm text-muted-foreground mb-2">{t('settings.routerPortDesc')}</p>
        <Input
          type="number"
          min={1}
          max={65535}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={() => void commitPort()}
          className="max-w-[200px] h-9 rounded-lg border-border-subtle"
        />
        {portPending ? (
          <p className="mt-2 text-[12px] text-warning">
            {t('settings.routerActualPort', { port: actualPort })}
          </p>
        ) : null}
      </div>

      <div className="border-t border-border-subtle" />

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {t('settings.routerStatus')}
        </label>
        <p className="text-sm text-muted-foreground">
          {stateKey ? t(stateKey) : '—'}
          {actualPort != null ? ` · 127.0.0.1:${actualPort}` : ''}
        </p>
      </div>
    </div>
  );
}
