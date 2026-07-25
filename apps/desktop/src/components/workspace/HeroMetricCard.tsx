import type { LucideIcon } from '@/lib/lucide-react';
import { TrendingUp, TrendingDown } from '@/lib/lucide-react';
import { useCountUp } from '@/hooks/useCountUp';
import { cn } from '@/lib/utils';

interface HeroMetricCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  formatValue: (animated: number) => string;
  sublabel?: string;
  trend?: string;
  onClick: () => void;
}

export function HeroMetricCard({
  icon: Icon,
  label,
  value,
  formatValue,
  sublabel,
  trend,
  onClick,
}: HeroMetricCardProps) {
  const animated = useCountUp(value);

  const isPositiveTrend = trend && !trend.startsWith('-');
  const isNegativeTrend = trend && trend.startsWith('-');

  return (
    <div
      className="stat-card glass-noise cursor-pointer interactive-card group relative overflow-hidden p-3.5"
      onClick={onClick}
    >
      {/* Ambient glow */}
      <div className="absolute -top-16 -right-16 w-32 h-32 bg-primary/[0.12] rounded-full blur-[50px] pointer-events-none" />

      {/* Top row: icon + label + trend */}
      <div className="relative flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/[0.12] group-hover:bg-primary/[0.18] transition-colors">
            <Icon className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="text-2xs font-medium text-muted-foreground/70 uppercase tracking-widest">
            {label}
          </span>
        </div>

        {trend && (
          <div className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold',
            isPositiveTrend && 'bg-success/[0.12] text-success',
            isNegativeTrend && 'bg-destructive/[0.12] text-destructive'
          )}>
            {isPositiveTrend && <TrendingUp className="w-3 h-3" />}
            {isNegativeTrend && <TrendingDown className="w-3 h-3" />}
            {trend}
          </div>
        )}
      </div>

      {/* Value — 3xl instead of 4xl for better proportion */}
      <div className="relative">
        <div className="text-3xl font-bold tabular-nums tracking-tight gradient-text font-mono leading-none">
          {formatValue(animated)}
        </div>
        {sublabel && (
          <div className="text-xs text-muted-foreground/60 mt-1.5">
            {sublabel}
          </div>
        )}
      </div>

      {/* Bottom hover line */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-primary/0 via-primary/40 to-primary/0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
