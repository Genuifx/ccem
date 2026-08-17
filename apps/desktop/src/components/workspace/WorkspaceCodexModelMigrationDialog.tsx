import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/locales';
import type { CodexModelMigrationWarning } from './workspaceCodexModelMigration';

interface WorkspaceCodexModelMigrationDialogProps {
  open: boolean;
  warning: CodexModelMigrationWarning | null;
  onCancel: () => void;
  onContinue: () => void;
}

export function WorkspaceCodexModelMigrationDialog({
  open,
  warning,
  onCancel,
  onContinue,
}: WorkspaceCodexModelMigrationDialogProps) {
  const { t } = useLocale();

  return (
    <Dialog
      open={open && warning !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) {
          onCancel();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="frosted-panel glass-noise sm:max-w-lg"
        data-codex-model-migration-dialog
      >
        {warning ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('workspace.codexModelMigrationTitle')}</DialogTitle>
              <DialogDescription>
                {t('workspace.codexModelMigrationDescription', {
                  model: warning.model,
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-lg border border-border/70 bg-muted/35 px-4 py-3 text-sm">
              <div className="text-muted-foreground">
                {t('workspace.codexModelMigrationReplacementLabel')}
              </div>
              <div className="mt-1 font-mono font-medium text-foreground">
                {warning.model} → {warning.replacement}
              </div>
            </div>

            <p className="text-sm leading-6 text-muted-foreground">
              {t('workspace.codexModelMigrationBoundary')}
            </p>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                data-codex-model-migration-cancel
              >
                {t('workspace.codexModelMigrationCancel')}
              </Button>
              <Button
                type="button"
                onClick={onContinue}
                data-codex-model-migration-continue
              >
                {t('workspace.codexModelMigrationContinue')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
