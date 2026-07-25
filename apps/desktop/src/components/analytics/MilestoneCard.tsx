import { Check, BarChart3, DollarSign, Flame, Gem } from '@/lib/lucide-react';
import type { Milestone } from '@/types/analytics';
import { useLocale } from '@/locales';

interface MilestoneCardProps {
  milestone: Milestone;
}

const MILESTONE_ICONS = {
  tokens: BarChart3,
  cost: DollarSign,
  streak: Flame,
  savings: Gem,
};

export function MilestoneCard({ milestone }: MilestoneCardProps) {
  const { t, lang } = useLocale();
  const progress = (milestone.current / milestone.target) * 100;
  const clampedProgress = Math.min(progress, 100);

  const Icon = MILESTONE_ICONS[milestone.type];

  return (
    <div
      className={`relative p-4 rounded-lg border ${
        milestone.achieved
          ? 'bg-primary/15 text-primary border-primary/30 milestone-achieved'
          : 'text-muted-foreground border border-dashed border-border'
      }`}
    >
      {milestone.achieved && (
        <div className="absolute top-2 right-2">
          <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center">
            <Check className="w-4 h-4 text-primary-foreground" />
          </div>
        </div>
      )}

      <div className="flex items-start gap-3">
        <Icon className="w-6 h-6 shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-semibold text-foreground mb-1">
            {milestone.title}
          </h4>
          <p className="text-sm text-muted-foreground mb-3">
            {milestone.description}
          </p>

          {!milestone.achieved && (
            <>
              <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${clampedProgress}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {milestone.current.toLocaleString()} / {milestone.target.toLocaleString()}
                {' '}({clampedProgress.toFixed(1)}%)
              </div>
            </>
          )}

          {milestone.achieved && milestone.achievedAt && (
            <div className="text-xs text-primary">
              {t('analytics.achievedAt').replace('{date}', new Date(milestone.achievedAt).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US'))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
