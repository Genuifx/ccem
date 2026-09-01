import type { DailyActivity, TokenUsageWithCost, UsageStats } from '@/types/analytics';

export type PosterTheme = 'dark' | 'light';
export type PosterStyle = 'classic' | 'terminal' | 'dataink';
export type TimeRange = 'day' | 'week' | 'month';

export interface PosterCardProps {
  chartIdPrefix: string;
  dailyActivities: DailyActivity[];
  dateRange: string;
  osInfo: string;
  streakDays: number;
  totalTokens: number;
  theme: PosterTheme;
  timeRange: TimeRange;
  usageStats: UsageStats;
  username: string;
  rangeTokens: number;
  rangeModelData: Record<string, TokenUsageWithCost>;
}

export const GITHUB_URL = 'https://github.com/Genuifx/ccem';
export const POSTER_W = 440;
export const POSTER_H = 720;

export function formatLargeNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function shortenModel(name: string) {
  return name
    .replace('claude-', '')
    .replace('anthropic/', '')
    .replace('-latest', '')
    .replace('-20250', '');
}

export function sumTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}
