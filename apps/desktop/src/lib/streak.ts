// apps/desktop/src/lib/streak.ts
// Single source of truth for the workspace/analytics streak metric.
// Must stay behaviorally in sync with calculate_streak in src-tauri/src/analytics.rs.
import type { UsageStats } from '@/types/analytics';

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Count consecutive local-calendar usage days ending today — or, before the
 * day's first usage, ending yesterday. The current day is still in progress,
 * so an empty today must not break an otherwise intact streak (morning and
 * just-after-midnight views keep yesterday's streak instead of collapsing
 * to zero).
 */
export function calculateContinuousUsageDays(
  dailyHistory: UsageStats['dailyHistory'],
  now: Date = new Date(),
): number {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!dailyHistory[localDateKey(date)]) {
    date.setDate(date.getDate() - 1);
  }

  let streak = 0;
  while (dailyHistory[localDateKey(date)]) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}
