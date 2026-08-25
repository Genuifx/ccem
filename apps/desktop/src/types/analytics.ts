// apps/desktop/src/types/analytics.ts

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TokenUsageWithCost extends TokenUsage {
  cost: number;
  unpricedTokens: number;
  costIncomplete: boolean;
}

export interface DshSourceStatus {
  available: boolean;
  error: string | null;
  sessionCount: number;
}

export type ModelBreakdownHistory = Record<string, Record<string, TokenUsageWithCost>>;

export interface UsageStats {
  today: TokenUsageWithCost;
  week: TokenUsageWithCost;
  month: TokenUsageWithCost;
  total: TokenUsageWithCost;
  dailyHistory: Record<string, TokenUsageWithCost>; // key: YYYY-MM-DD
  hourlyHistory: Record<string, TokenUsageWithCost>; // key: YYYY-MM-DDTHH
  byModel: Record<string, TokenUsageWithCost>;
  byEnvironment: Record<string, TokenUsageWithCost>;
  lastUpdated: string;
  dshStatus?: DshSourceStatus;
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD
  tokens: number;
  cost: number;
  level: 0 | 1 | 2 | 3 | 4; // 0=none, 1=low, 2=medium, 3=high, 4=very high
}

export interface Milestone {
  id: string;
  type: 'tokens' | 'cost' | 'streak' | 'savings';
  title: string;
  description: string;
  target: number;
  current: number;
  achieved: boolean;
  achievedAt?: string;
}

export interface ChartDataPoint {
  bucketKey: string;
  date: string;
  breakdown?: Record<string, number>;
  [key: string]: number | string | Record<string, number> | undefined; // Dynamic keys for chart payloads
}
