import type { LucideIcon } from '@/lib/lucide-react';
import { useCountUp } from '@/hooks/useCountUp';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  icon: LucideIcon;
  iconColor: string;
  label: string;
  value: number;
  formatValue: (animated: number) => string;
  sublabel?: string;
  sublabelColor?: string;
  borderAlert?: boolean;
  onClick: () => void;
}

export function MetricCard({
  icon: Icon,
  iconColor,
  label,
  value,
  formatValue,
  sublabel,
  sublabelColor,
  borderAlert,
  onClick,
}: MetricCardProps) {
  const animated = useCountUp(value);

  return (
    <div
      className={cn(
        'stat-card glass-noise text-card-foreground p-3 cursor-pointer interactive-card group',
        borderAlert && 'border-destructive/30'
      )}
      onClick={onClick}
    >
      {/* Icon + label row */}
      <div className="flex items-center gap-1.5 mb-2">
        <div className={cn(
          'w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
          'bg-white/[0.06] group-hover:bg-white/[0.10] transition-colors'
        )}>
          <Icon className={cn('w-3 h-3', iconColor)} />
        </div>
        <span className="text-2xs font-medium text-muted-foreground/70 uppercase tracking-wider truncate">
          {label}
        </span>
      </div>

      {/* Value */}
      <div className="gradient-text text-lg font-bold tabular-nums leading-none">
        {formatValue(animated)}
      </div>

      {/* Sublabel */}
      {sublabel && (
        <div className={cn('text-2xs mt-1 truncate opacity-60', sublabelColor || 'text-muted-foreground')}>
          {sublabel}
        </div>
      )}
    </div>
  );
}
