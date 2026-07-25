import { CheckCircle2, MessageSquareWarning, XCircle } from '@/lib/lucide-react';
import { useLocale } from '@/locales';
import type { TelegramBridgeStatus } from '@/lib/tauri-ipc';

export function TelegramStatusBadge({ status }: { status: TelegramBridgeStatus }) {
  const { t } = useLocale();

  if (status.running) {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-success">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {t('settings.telegramRunning')}
      </span>
    );
  }

  if (status.configured) {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-warning">
        <MessageSquareWarning className="w-3.5 h-3.5" />
        {t('settings.telegramConfigured')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
      <XCircle className="w-3.5 h-3.5" />
      {t('settings.telegramNotConfigured')}
    </span>
  );
}
