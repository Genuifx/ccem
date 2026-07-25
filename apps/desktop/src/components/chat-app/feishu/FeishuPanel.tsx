import { MessageCircle } from '@/lib/lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLocale } from '@/locales';

export function FeishuPanel() {
  const { t } = useLocale();

  return (
    <EmptyState
      icon={MessageCircle}
      message={t('chatApp.feishuComingSoon')}
    />
  );
}
