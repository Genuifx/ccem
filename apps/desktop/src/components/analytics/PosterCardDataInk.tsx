import { QRCodeSVG } from 'qrcode.react';
import { useLocale } from '@/locales';
import { formatTokens } from '@/lib/utils';
import {
  GITHUB_URL,
  POSTER_W,
  POSTER_H,
  formatLargeNumber,
  shortenModel,
  sumTokens,
} from './poster-types';
import type { PosterCardProps } from './poster-types';

/* ── Data Ink Model Bar (horizontal thin bars) ── */

function DataInkModelBar({ byModel }: { byModel: PosterCardProps['rangeModelData'] }) {
  const { t } = useLocale();
  const models = Object.entries(byModel)
    .map(([name, usage]) => ({ name, tokens: sumTokens(usage) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4);

  if (models.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#9ca3af' }}>
        {t('analytics.shareNoModelData')}
      </div>
    );
  }

  const total = models.reduce((sum, m) => sum + m.tokens, 0);

  return (
    <div>
      {models.map((m) => {
        const pct = Math.round((m.tokens / total) * 100);
        return (
          <div key={m.name} style={{ display: 'flex', alignItems: 'center', margin: '10px 0' }}>
            <span style={{ fontSize: 12, color: '#4b5563', width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortenModel(m.name)}
            </span>
            <div style={{ flex: 1, height: 3, background: '#f0eeeb', borderRadius: 2, margin: '0 12px' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: '#3730a3', borderRadius: 2 }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#1a1a2e', width: 36, textAlign: 'right' }}>
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Lollipop Activity Chart ── */

function DataInkActivity({ dailyActivities, timeRange }: { dailyActivities: PosterCardProps['dailyActivities']; timeRange: PosterCardProps['timeRange'] }) {
  // Get relevant slice
  let slice = dailyActivities.slice(-7);
  if (timeRange === 'month') {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    slice = dailyActivities.filter(a => new Date(a.date) >= startOfMonth).slice(-14);
  } else if (timeRange === 'day') {
    slice = dailyActivities.slice(-7);
  }

  if (slice.length === 0) return null;

  const maxTokens = Math.max(...slice.map(a => a.tokens), 1);
  const chartH = 60;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: chartH }}>
      {slice.map((a, i) => {
        const h = Math.max(4, (a.tokens / maxTokens) * (chartH - 12));
        const dayLabel = new Date(a.date).toLocaleDateString('en', { weekday: 'narrow' });
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3730a3', flexShrink: 0 }} />
            <div style={{ width: 2, height: h, background: '#3730a3', borderRadius: 1 }} />
            <span style={{ fontSize: 9, color: '#9ca3af' }}>{dayLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Main Data Ink Poster ── */

export function PosterCardDataInk({
  dailyActivities,
  dateRange,
  streakDays,
  totalTokens,
  timeRange,
  usageStats,
  username,
  rangeTokens,
  rangeModelData,
}: PosterCardProps) {
  const { t } = useLocale();

  const baseStyle: React.CSSProperties = {
    width: POSTER_W,
    height: POSTER_H,
    background: '#faf9f7',
    padding: '36px 40px 32px',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  };

  return (
    <div style={baseStyle}>
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, color: '#3730a3' }}>
          CCEM
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 400 }}>
          {dateRange}
        </div>
      </div>

      {/* Hero section */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
          {t(timeRange === 'day' ? 'analytics.shareDayTokens' : timeRange === 'month' ? 'analytics.shareMonthTokens' : 'analytics.shareWeekTokens')}
        </div>
        {/* Adaptive font size so large numbers never overflow the 440px card */}
        {(() => {
          const numStr = formatLargeNumber(rangeTokens);
          const fontSize = numStr.length <= 8 ? 64 : numStr.length <= 11 ? 48 : 36;
          return (
            <div style={{ fontSize, fontWeight: 900, color: '#1a1a2e', letterSpacing: -3, lineHeight: 1, wordBreak: 'keep-all' }}>
              {numStr}
            </div>
          );
        })()}
        <div style={{ fontSize: 14, fontWeight: 400, color: '#6b7280', marginTop: 6 }}>
          tokens consumed by @{username || 'developer'}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: '#e5e5e5', margin: '0 0 18px' }} />

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 40, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{streakDays}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('analytics.shareStreak')}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{usageStats.total.costIncomplete ? '≥' : ''}${usageStats.total.cost.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('analytics.shareTotalCost')}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{formatTokens(totalTokens)}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('analytics.shareTotalTokens')}
          </div>
        </div>
      </div>

      {/* Models section */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 10, fontWeight: 500, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 }}>
          {t('analytics.shareTopModels')}
        </div>
        <DataInkModelBar byModel={rangeModelData} />
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: '#e5e5e5', margin: '0 0 18px' }} />

      {/* Activity section */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 500, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 }}>
          {t('analytics.share30dActivity')}
        </div>
        <DataInkActivity dailyActivities={dailyActivities} timeRange={timeRange} />
      </div>

      {/* Footer */}
      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>
          <span style={{ color: '#3730a3', fontWeight: 600 }}>@{username || 'developer'}</span>
          {' '}
          {timeRange === 'day' ? 'daily' : timeRange === 'week' ? 'weekly' : 'monthly'} report
        </div>
        <div style={{ border: '1.5px solid #e5e5e5', borderRadius: 4, padding: 4 }}>
          <QRCodeSVG value={GITHUB_URL} size={44} level="M" bgColor="transparent" fgColor="#3730a3" />
        </div>
      </div>
    </div>
  );
}
