import { Check, Play } from '@/lib/lucide-react';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import type { HistorySessionItem } from '@/features/conversations/types';
import { getHistorySessionDisplay } from '@/components/history/historySession';

interface ResumeBarProps {
  selectedSession: HistorySessionItem | null;
  onResume: () => void;
  resumed: boolean;
}

export function ResumeBar({ selectedSession, onResume, resumed }: ResumeBarProps) {
  const { t } = useLocale();

  return (
    <div className="shrink-0 border-t border-border/30 bg-surface backdrop-blur-xl px-4 py-3">
      {selectedSession ? (
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-foreground truncate">
              <span className="font-medium">{selectedSession.projectName}</span>
              <span className="mx-2 text-muted-foreground">/</span>
              <span className="text-muted-foreground">{getHistorySessionDisplay(selectedSession, '')}</span>
            </p>
          </div>
          <button
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 h-8 px-4 rounded-lg text-sm font-medium text-white transition-all',
              'liquid-launch-btn',
              resumed && 'launched'
            )}
            onClick={onResume}
            disabled={resumed}
          >
            {resumed ? (
              <>
                <Check className="w-3.5 h-3.5" />
                {t('workspace.resumed')}
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                {t('workspace.resumeSession')}
              </>
            )}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center">
          {t('workspace.selectToResume')}
        </p>
      )}
    </div>
  );
}
