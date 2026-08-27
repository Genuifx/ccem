// apps/desktop/src/lib/mockAnalytics.ts
import type { UsageStats, Milestone, DailyActivity } from '@/types/analytics';

export function generateMockUsageStats(): UsageStats {
  const today = {
    inputTokens: 32000,
    outputTokens: 16200,
    cacheReadTokens: 8000,
    cacheCreationTokens: 4000,
    cost: 0.24,
    unpricedTokens: 0,
    costIncomplete: false,
  };

  const week = {
    inputTokens: 180000,
    outputTokens: 92000,
    cacheReadTokens: 45000,
    cacheCreationTokens: 22000,
    cost: 1.86,
    unpricedTokens: 0,
    costIncomplete: false,
  };

  const month = {
    inputTokens: 720000,
    outputTokens: 368000,
    cacheReadTokens: 180000,
    cacheCreationTokens: 88000,
    cost: 7.44,
    unpricedTokens: 0,
    costIncomplete: false,
  };

  const total = {
    inputTokens: 2480000,
    outputTokens: 1260000,
    cacheReadTokens: 620000,
    cacheCreationTokens: 300000,
    cost: 24.80,
    unpricedTokens: 0,
    costIncomplete: false,
  };

  // Generate daily history for last 30 days
  const dailyHistory: Record<string, typeof today> = {};
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    dailyHistory[dateStr] = {
      inputTokens: Math.floor(Math.random() * 50000) + 10000,
      outputTokens: Math.floor(Math.random() * 25000) + 5000,
      cacheReadTokens: Math.floor(Math.random() * 12000) + 3000,
      cacheCreationTokens: Math.floor(Math.random() * 6000) + 1500,
      cost: Math.random() * 0.5 + 0.1,
      unpricedTokens: 0,
      costIncomplete: false,
    };
  }

  // Generate hourly history for last 24 hours
  const hourlyHistory: Record<string, typeof today> = {};
  for (let i = 0; i < 24; i++) {
    const date = new Date(now);
    date.setHours(date.getHours() - i);
    const hourStr = `${date.toISOString().split('T')[0]}T${String(date.getHours()).padStart(2, '0')}`;
    hourlyHistory[hourStr] = {
      inputTokens: Math.floor(Math.random() * 8000) + 1000,
      outputTokens: Math.floor(Math.random() * 4000) + 500,
      cacheReadTokens: Math.floor(Math.random() * 2000) + 300,
      cacheCreationTokens: Math.floor(Math.random() * 1000) + 100,
      cost: Math.random() * 0.08 + 0.01,
      unpricedTokens: 0,
      costIncomplete: false,
    };
  }

  const byModel = {
    'claude-opus-4-5': {
      inputTokens: 1200000,
      outputTokens: 600000,
      cacheReadTokens: 300000,
      cacheCreationTokens: 150000,
      cost: 12.50,
      unpricedTokens: 0,
      costIncomplete: false,
    },
    'claude-sonnet-4-5': {
      inputTokens: 800000,
      outputTokens: 400000,
      cacheReadTokens: 200000,
      cacheCreationTokens: 100000,
      cost: 8.30,
      unpricedTokens: 0,
      costIncomplete: false,
    },
    'glm-4-flash': {
      inputTokens: 400000,
      outputTokens: 200000,
      cacheReadTokens: 100000,
      cacheCreationTokens: 40000,
      cost: 3.20,
      unpricedTokens: 0,
      costIncomplete: false,
    },
    'deepseek-chat': {
      inputTokens: 80000,
      outputTokens: 60000,
      cacheReadTokens: 20000,
      cacheCreationTokens: 10000,
      cost: 0.80,
      unpricedTokens: 0,
      costIncomplete: false,
    },
  };

  const byEnvironment = {
    official: {
      inputTokens: 1500000,
      outputTokens: 750000,
      cacheReadTokens: 375000,
      cacheCreationTokens: 187500,
      cost: 15.60,
      unpricedTokens: 0,
      costIncomplete: false,
    },
    'GLM-4': {
      inputTokens: 600000,
      outputTokens: 300000,
      cacheReadTokens: 150000,
      cacheCreationTokens: 75000,
      cost: 6.20,
      unpricedTokens: 0,
      costIncomplete: false,
    },
    DeepSeek: {
      inputTokens: 380000,
      outputTokens: 210000,
      cacheReadTokens: 95000,
      cacheCreationTokens: 37500,
      cost: 3.00,
      unpricedTokens: 0,
      costIncomplete: false,
    },
  };

  return {
    today,
    week,
    month,
    total,
    dailyHistory,
    hourlyHistory,
    byModel,
    byEnvironment,
    lastUpdated: `mock:${now.toISOString()}`,
  };
}

export function generateMockMilestones(): Milestone[] {
  return [
    // Token milestones (5 total)
    {
      id: '1',
      type: 'tokens',
      title: '100K Tokens',
      description: '累计使用 100K tokens',
      target: 100000,
      current: 2480000,
      achieved: true,
      achievedAt: '2025-12-15T10:30:00Z',
    },
    {
      id: '2',
      type: 'tokens',
      title: '500K Tokens',
      description: '累计使用 500K tokens',
      target: 500000,
      current: 2480000,
      achieved: true,
      achievedAt: '2026-01-10T08:45:00Z',
    },
    {
      id: '3',
      type: 'tokens',
      title: '1M Tokens',
      description: '累计使用 1M tokens',
      target: 1000000,
      current: 2480000,
      achieved: true,
      achievedAt: '2026-01-20T14:20:00Z',
    },
    {
      id: '4',
      type: 'tokens',
      title: '5M Tokens',
      description: '累计使用 5M tokens',
      target: 5000000,
      current: 2480000,
      achieved: false,
    },
    {
      id: '5',
      type: 'tokens',
      title: '10M Tokens',
      description: '累计使用 10M tokens',
      target: 10000000,
      current: 2480000,
      achieved: false,
    },
    // Cost milestones (4 total)
    {
      id: '6',
      type: 'cost',
      title: '第一个 $10',
      description: '累计消费 $10',
      target: 10,
      current: 24.80,
      achieved: true,
      achievedAt: '2025-12-20T09:15:00Z',
    },
    {
      id: '7',
      type: 'cost',
      title: '$50',
      description: '累计消费 $50',
      target: 50,
      current: 24.80,
      achieved: false,
    },
    {
      id: '8',
      type: 'cost',
      title: '$100',
      description: '累计消费 $100',
      target: 100,
      current: 24.80,
      achieved: false,
    },
    {
      id: '9',
      type: 'cost',
      title: '$500',
      description: '累计消费 $500',
      target: 500,
      current: 24.80,
      achieved: false,
    },
    // Streak milestones (4 total)
    {
      id: '10',
      type: 'streak',
      title: '7天连续',
      description: '连续使用 7 天',
      target: 7,
      current: 42,
      achieved: true,
      achievedAt: '2025-12-25T00:00:00Z',
    },
    {
      id: '11',
      type: 'streak',
      title: '30天连续',
      description: '连续使用 30 天',
      target: 30,
      current: 42,
      achieved: true,
      achievedAt: '2026-01-18T00:00:00Z',
    },
    {
      id: '12',
      type: 'streak',
      title: '100天连续',
      description: '连续使用 100 天',
      target: 100,
      current: 42,
      achieved: false,
    },
    {
      id: '13',
      type: 'streak',
      title: '365天连续',
      description: '连续使用 365 天',
      target: 365,
      current: 42,
      achieved: false,
    },
    // Savings milestones (3 total)
    {
      id: '14',
      type: 'savings',
      title: '节省 $10',
      description: '通过使用替代模型节省 $10',
      target: 10,
      current: 8.50,
      achieved: false,
    },
    {
      id: '15',
      type: 'savings',
      title: '节省 $50',
      description: '通过使用替代模型节省 $50',
      target: 50,
      current: 8.50,
      achieved: false,
    },
    {
      id: '16',
      type: 'savings',
      title: '节省 $100',
      description: '通过使用替代模型节省 $100',
      target: 100,
      current: 8.50,
      achieved: false,
    },
  ];
}

export function generateMockDailyActivity(): DailyActivity[] {
  const activities: DailyActivity[] = [];
  const now = new Date();

  // Generate 365 days of activity
  for (let i = 0; i < 365; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const tokens = Math.floor(Math.random() * 60000);
    const cost = tokens * 0.000005;

    let level: DailyActivity['level'] = 0;
    if (tokens > 50000) level = 4;
    else if (tokens > 35000) level = 3;
    else if (tokens > 20000) level = 2;
    else if (tokens > 5000) level = 1;

    activities.push({
      date: dateStr,
      tokens,
      cost,
      level,
    });
  }

  return activities.reverse();
}
