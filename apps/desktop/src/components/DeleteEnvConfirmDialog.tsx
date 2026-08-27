import { useEffect, useState } from 'react';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  type EnvReferenceQuery,
  isFreshReferenceResponse,
  refQueryAllowsDelete,
} from '@/lib/routerProfiles';

/**
 * Environment delete confirmation dialog built on the project's shadcn Dialog
 * (Radix-backed). Radix provides role=dialog, aria-labelledby/auto, focus trap,
 * Escape-to-close, and focus restore — none of that is hand-rolled here.
 *
 * On open / env-name change it queries `get_environment_router_references` for
 * the authoritative references across global router rules, profiles, and
 * active/recoverable sessions, and:
 *  - shows clear loading / error / empty / non-empty states inside a live region
 *    (role=status) so screen readers announce the resolved query;
 *  - disables the final delete while loading OR when references exist, with a
 *    short i18n hint to resolve them first;
 *  - on a query error leaves delete enabled (the backend rejects + the parent
 *    keeps the dialog open as the fallback);
 *  - guards against stale responses via a cancelled flag + an env-name match.
 */
export function DeleteEnvConfirmDialog({
  envName,
  confirming = false,
  onConfirm,
  onCancel,
}: {
  envName: string;
  confirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const { getEnvironmentRouterReferences } = useTauriCommands();
  const [query, setQuery] = useState<EnvReferenceQuery>({ status: 'loading', refs: [] });

  useEffect(() => {
    let cancelled = false;
    setQuery({ status: 'loading', refs: [] });
    getEnvironmentRouterReferences(envName)
      .then((refs) => {
        if (!cancelled && isFreshReferenceResponse(envName, envName)) {
          setQuery({ status: 'loaded', refs });
        }
      })
      .catch(() => {
        if (!cancelled) setQuery({ status: 'error', refs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [envName, getEnvironmentRouterReferences]);

  const message = t('environments.confirmDelete').replace('{name}', envName);
  const allowDelete = refQueryAllowsDelete(query);
  const hasRefs = query.status === 'loaded' && query.refs.length > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !confirming) onCancel(); }}>
      <DialogContent
        className="max-w-sm"
        aria-busy={confirming}
        showCloseButton={!confirming}
        closeLabel={t('common.close')}
        onEscapeKeyDown={(e) => { if (confirming) e.preventDefault(); }}
        onPointerDownOutside={(e) => { if (confirming) e.preventDefault(); }}
        onInteractOutside={(e) => { if (confirming) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>{t('environments.deleteEnvTitle')}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>

        {/* Live region: screen readers announce the resolved reference query. */}
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-border-subtle bg-surface/40 px-3 py-2"
        >
          {query.status === 'loading' ? (
            <p className="text-[12px] text-muted-foreground">{t('environments.deleteReferencesLoading')}</p>
          ) : query.status === 'error' ? (
            <p className="text-[12px] text-muted-foreground">{t('environments.deleteReferencesError')}</p>
          ) : hasRefs ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-foreground">{t('environments.deleteReferencesTitle')}</p>
              <div className="flex flex-wrap gap-1">
                {query.refs.map((ref) => (
                  <span
                    key={ref}
                    className="inline-flex items-center rounded-full bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                  >
                    {ref}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-warning">{t('environments.deleteReferencesHint')}</p>
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{t('environments.deleteReferencesEmpty')}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={confirming}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!allowDelete || confirming}
            onClick={onConfirm}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
