import { useEffect, useState } from 'react';
import { Antigravity } from '@lobehub/icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAgyRuntime } from '@/hooks/useAgyRuntime';
import { loginAgyAccount } from '@/lib/agy-runtime';
import { useLocale } from '@/locales';

export function AgyRuntimeCard({ disabled = false }: { disabled?: boolean }) {
  const { t } = useLocale();
  const { status, loading, error, pending, refresh, saveCustomPath, login } = useAgyRuntime();
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');

  useEffect(() => {
    if (!status) return;
    setPathDraft(status.customPath ?? status.resolvedPath ?? '');
  }, [status?.customPath, status?.resolvedPath]);

  const busy = disabled || loading || pending !== null;
  const installed = Boolean(status?.installed);

  const handleLogin = async () => {
    const ok = await login();
    if (ok) {
      toast.success(t('agentProfiles.loginOpened'));
    }
  };

  const handleSavePath = async () => {
    const trimmed = pathDraft.trim();
    const next = await saveCustomPath(trimmed || null);
    if (next) {
      setEditingPath(false);
    }
  };

  const handleResetPath = async () => {
    const next = await saveCustomPath(null);
    if (next) {
      setPathDraft(next.resolvedPath ?? '');
      setEditingPath(false);
    }
  };

  return (
    <div
      data-testid="agent-profile-agy"
      className="rounded-xl border border-border-subtle p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <Antigravity.Color size={18} className="shrink-0" />
          <h3 className="text-sm font-medium">Antigravity</h3>
          {status && (
            <span
              data-testid="agy-install-badge"
              className={
                installed
                  ? 'rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400'
                  : 'rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
              }
            >
              {t(installed ? 'settings.cliInstalled' : 'settings.cliNotInstalled')}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="agy-login-button"
          disabled={busy || !installed}
          onClick={() => void handleLogin()}
        >
          {pending === 'login' ? t('agentProfiles.opening') : t('agentProfiles.loginAgy')}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">{t('agentProfiles.sharedAgy')}</p>

      {status && (
        <p className="text-xs font-mono text-muted-foreground break-all select-text">
          {status.defaultHomeDir}
        </p>
      )}

      <div className="border-t border-border-subtle pt-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground truncate font-mono select-text">
            {status?.resolvedPath ?? t('agentProfiles.agyBinaryMissing')}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="agy-path-toggle"
              disabled={busy}
              onClick={() => setEditingPath((prev) => !prev)}
            >
              {t(editingPath ? 'common.cancel' : 'agentProfiles.agyCustomPath')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void refresh(true)}
            >
              {t('claudeRuntime.refresh')}
            </Button>
          </div>
        </div>

        {editingPath && (
          <div className="flex items-center gap-2">
            <Input
              value={pathDraft}
              disabled={busy}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="/usr/local/bin/agy"
              aria-label={t('agentProfiles.agyCustomPath')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid="agy-path-input"
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="agy-path-save"
              onClick={() => void handleSavePath()}
            >
              {t('common.save')}
            </Button>
            {status?.customPath && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="agy-path-reset"
                onClick={() => void handleResetPath()}
              >
                {t('agentProfiles.agyResetPath')}
              </Button>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive break-words">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function AgyAuthRequiredDialog({
  open,
  onOpenChange,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  const [opening, setOpening] = useState(false);

  const handleLogin = async () => {
    setOpening(true);
    try {
      await loginAgyAccount();
      toast.success(t('agentProfiles.loginOpened'));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setOpening(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="agy-auth-required-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Antigravity.Color size={18} />
            <span>{t('workspace.agyAuthRequiredTitle')}</span>
          </DialogTitle>
          <DialogDescription>{t('workspace.agyAuthRequiredDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onRetry();
              }}
            >
              {t('common.retry')}
            </Button>
          )}
          <Button
            type="button"
            disabled={opening}
            data-testid="agy-auth-dialog-login"
            onClick={() => void handleLogin()}
          >
            {opening ? t('agentProfiles.opening') : t('agentProfiles.loginAgy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
