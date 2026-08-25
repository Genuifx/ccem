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

/* ── Activity block characters ── */

const BLOCK_CHARS = ['░', '▂', '▄', '▆', '█'];

function levelToBlock(level: number): string {
  return BLOCK_CHARS[Math.min(level, 4)];
}

/* ── Terminal Model Bar (ASCII block style) ── */

function TerminalModelBar({ byModel }: { byModel: PosterCardProps['rangeModelData'] }) {
  const models = Object.entries(byModel)
    .map(([name, usage]) => ({ name, tokens: sumTokens(usage) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4);

  if (models.length === 0) return null;

  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  const barWidth = 16;

  return (
    <div>
      {models.map((m) => {
        const pct = Math.round((m.tokens / total) * 100);
        const filled = Math.round((pct / 100) * barWidth);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
        return (
          <div
            key={m.name}
            style={{
              fontSize: 11,
              margin: '5px 0',
              color: '#2aaa2a',
              whiteSpace: 'pre',
            }}
          >
            <span style={{ color: '#33ff33' }}>{bar}</span>
            {' '}
            {shortenModel(m.name).padEnd(10).slice(0, 10)}
            {' '}
            {String(pct).padStart(3)}%
          </div>
        );
      })}
    </div>
  );
}

/* ── Main Terminal Poster ── */

export function PosterCardTerminal({
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

  // Get activity for block display
  const activitySlice = timeRange === 'day'
    ? dailyActivities.slice(-1)
    : timeRange === 'week'
      ? dailyActivities.slice(-7)
      : dailyActivities.slice(-30);

  const activityBlocks = activitySlice.map((a) => levelToBlock(a.level)).join('');

  const dividerSingle = '────────────────────────────────────────';
  const dividerTop = '╔══════════════════════════════════════╗';
  const dividerBottom = '╚══════════════════════════════════════╝';

  const baseStyle: React.CSSProperties = {
    width: POSTER_W,
    height: POSTER_H,
    background: '#0a0a0a',
    padding: '28px 36px 24px',
    fontFamily: "'JetBrains Mono', monospace",
    color: '#33ff33',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  };

  const scanlineOverlay: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 255, 0, 0.008) 2px, rgba(0, 255, 0, 0.008) 4px)`,
    pointerEvents: 'none',
  };

  const dividerStyle: React.CSSProperties = {
    color: '#1a5c1a',
    fontSize: 12,
    textAlign: 'center',
    margin: '8px 0',
    letterSpacing: '-0.5px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={baseStyle}>
      {/* CRT scanline overlay */}
      <div style={scanlineOverlay} />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 6, color: '#33ff33' }}>
            C C E M
          </div>
        </div>

        {/* Top border */}
        <div style={{ ...dividerStyle, color: '#2a7a2a' }}>{dividerTop}</div>

        {/* Meta line */}
        <div style={{ fontSize: 11, color: '#1a8c1a', display: 'flex', justifyContent: 'space-between', margin: '4px 0' }}>
          <span>@{username || 'developer'}</span>
          <span>{dateRange}</span>
        </div>

        <div style={dividerStyle}>{dividerSingle}</div>

        {/* Hero section */}
        <div style={{ textAlign: 'center', margin: '14px 0' }}>
          <div style={{ fontSize: 10, color: '#1a8c1a', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>
            {t(timeRange === 'day' ? 'analytics.shareDayTokens' : timeRange === 'month' ? 'analytics.shareMonthTokens' : 'analytics.shareWeekTokens')}
          </div>
          <div style={{ fontSize: 36, fontWeight: 700, color: '#33ff33', textShadow: '0 0 10px rgba(51, 255, 51, 0.3)', letterSpacing: -1 }}>
            {formatLargeNumber(rangeTokens)}
          </div>
          <div style={{ fontSize: 12, color: '#1a8c1a', marginTop: 4 }}>
            tokens consumed
          </div>
        </div>

        <div style={dividerStyle}>{dividerSingle.slice(0, 22)}</div>

        {/* Stats block */}
        <div style={{ margin: '10px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '5px 0', color: '#2aaa2a' }}>
            <span>STREAK</span>
            <span style={{ color: '#33ff33' }}>{streakDays} days</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '5px 0', color: '#2aaa2a' }}>
            <span>COST</span>
            <span style={{ color: '#33ff33' }}>{usageStats.total.costIncomplete ? '≥' : ''}${usageStats.total.cost.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '5px 0', color: '#2aaa2a' }}>
            <span>TOTAL</span>
            <span style={{ color: '#33ff33' }}>{formatTokens(totalTokens)}</span>
          </div>
        </div>

        <div style={dividerStyle}>{dividerSingle}</div>

        {/* Models section */}
        <div style={{ margin: '6px 0' }}>
          <TerminalModelBar byModel={rangeModelData} />
        </div>

        <div style={dividerStyle}>{dividerSingle}</div>

        {/* Activity section */}
        <div style={{ margin: '12px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: '#1a8c1a', letterSpacing: 2, marginBottom: 8 }}>
            {t('analytics.share30dActivity')}
          </div>
          <div style={{ fontSize: 24, letterSpacing: 8, color: '#33ff33', textShadow: '0 0 6px rgba(51, 255, 51, 0.2)' }}>
            {activityBlocks || '░░░░░░░'}
          </div>
        </div>

        {/* Bottom border */}
        <div style={{ ...dividerStyle, color: '#2a7a2a' }}>{dividerBottom}</div>

        {/* Footer */}
        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ padding: 4, border: '1px solid #1a5c1a' }}>
            <QRCodeSVG value={GITHUB_URL} size={48} level="M" bgColor="transparent" fgColor="#33ff33" />
          </div>
          <div style={{ fontSize: 9, color: '#1a5c1a', textAlign: 'right', lineHeight: 1.6 }}>
            GENERATED BY CCEM<br />
            claude-code-env-manager
          </div>
        </div>
      </div>
    </div>
  );
}
