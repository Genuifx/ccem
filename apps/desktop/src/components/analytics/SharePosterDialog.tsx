import { useEffect, useId, useRef, useState } from 'react';
import { domToPng } from 'modern-screenshot';
import { QRCodeSVG } from 'qrcode.react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Download, Loader2, Moon, Sun, Terminal, BookOpen } from '@/lib/lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import { formatTokens } from '@/lib/utils';
import type { DailyActivity, ModelBreakdownHistory, TokenUsage, TokenUsageWithCost, UsageStats } from '@/types/analytics';
import { PosterCardTerminal } from './PosterCardTerminal';
import { PosterCardDataInk } from './PosterCardDataInk';
import type { PosterStyle } from './poster-types';

/* ── Types ── */

interface SharePosterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usageStats: UsageStats;
  dailyActivities: DailyActivity[];
  streakDays: number;
}

type PosterTheme = 'dark' | 'light';
type TimeRange = 'day' | 'week' | 'month';

interface ThemeColors {
  bg: string;
  glowA: string;
  glowB: string;
  text: string;
  textSub: string;
  textMuted: string;
  labelColor: string;
  divider: string;
  cardBg: string;
  cardBorder: string;
  footerBorder: string;
  heroGlow: string;
  qrBg: string;
  qrFg: string;
  avatarTextColor: string;
  accentBrand: string;
  sparkStroke: string;
  sparkFillFrom: string;
  waveBase: [number, number, number]; // rgb
  waveHighGradTop: string;
}

interface PosterCardProps {
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

/* ── Constants ── */

const GITHUB_URL = 'https://github.com/Genuifx/claude-code-env-manager';
const POSTER_W = 440;
const POSTER_H = 720;
const PREVIEW_SCALE_CAP = 0.78;

const THEMES: Record<PosterTheme, ThemeColors> = {
  dark: {
    bg: '#070c18',
    glowA: 'rgba(56,189,248,0.10)',
    glowB: 'rgba(167,139,250,0.08)',
    text: '#f8fafc',
    textSub: '#e2e8f0',
    textMuted: 'rgba(148,163,184,0.55)',
    labelColor: 'rgba(148,163,184,0.55)',
    divider: 'linear-gradient(90deg, transparent, rgba(56,189,248,0.25) 20%, rgba(167,139,250,0.25) 80%, transparent)',
    cardBg: 'rgba(15,23,42,0.55)',
    cardBorder: 'rgba(255,255,255,0.05)',
    footerBorder: 'rgba(255,255,255,0.05)',
    heroGlow: 'rgba(56,189,248,0.12)',
    qrBg: 'rgba(255,255,255,0.94)',
    qrFg: '#0f172a',
    avatarTextColor: '#070c18',
    accentBrand: '#38bdf8',
    sparkStroke: '#38bdf8',
    sparkFillFrom: '#38bdf8',
    waveBase: [56, 189, 248],
    waveHighGradTop: '#7dd3fc',
  },
  light: {
    bg: '#f8fafc',
    glowA: 'rgba(56,189,248,0.12)',
    glowB: 'rgba(167,139,250,0.10)',
    text: '#0f172a',
    textSub: '#1e293b',
    textMuted: 'rgba(71,85,105,0.65)',
    labelColor: 'rgba(71,85,105,0.6)',
    divider: 'linear-gradient(90deg, transparent, rgba(56,189,248,0.2) 20%, rgba(167,139,250,0.2) 80%, transparent)',
    cardBg: 'rgba(241,245,249,0.7)',
    cardBorder: 'rgba(0,0,0,0.06)',
    footerBorder: 'rgba(0,0,0,0.06)',
    heroGlow: 'rgba(56,189,248,0.08)',
    qrBg: '#ffffff',
    qrFg: '#0f172a',
    avatarTextColor: '#ffffff',
    accentBrand: '#0284c7',
    sparkStroke: '#0284c7',
    sparkFillFrom: '#0ea5e9',
    waveBase: [14, 165, 233],
    waveHighGradTop: '#38bdf8',
  },
};

const ACCENT_COLORS = {
  dark: ['#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6'],
  light: ['#0284c7', '#7c3aed', '#059669', '#ea580c', '#db2777'],
};

/* ── Color Temperature ── */

type ColorTemp = 'frost' | 'nebula' | 'blaze';

interface TempColors {
  accent: string;
  accentLight: string;
  waveBase: [number, number, number];
  glowA: string;
  glowB: string;
  heroGlow: string;
  heroGradient: string;
  avatarGradient: string;
  divider: string;
}

const COLOR_TEMPS: Record<ColorTemp, Record<PosterTheme, TempColors>> = {
  frost: {
    dark: {
      accent: '#38bdf8',
      accentLight: '#7dd3fc',
      waveBase: [56, 189, 248],
      glowA: 'rgba(56,189,248,0.10)',
      glowB: 'rgba(167,139,250,0.08)',
      heroGlow: 'rgba(56,189,248,0.12)',
      heroGradient: 'linear-gradient(135deg, #f8fafc 10%, #38bdf8 55%, #a78bfa 100%)',
      avatarGradient: 'linear-gradient(135deg, #38bdf8, #a78bfa)',
      divider: 'linear-gradient(90deg, transparent, rgba(56,189,248,0.25) 20%, rgba(167,139,250,0.25) 80%, transparent)',
    },
    light: {
      accent: '#0284c7',
      accentLight: '#38bdf8',
      waveBase: [14, 165, 233],
      glowA: 'rgba(56,189,248,0.12)',
      glowB: 'rgba(167,139,250,0.10)',
      heroGlow: 'rgba(56,189,248,0.08)',
      heroGradient: 'linear-gradient(135deg, #0f172a 10%, #0284c7 55%, #7c3aed 100%)',
      avatarGradient: 'linear-gradient(135deg, #0ea5e9, #7c3aed)',
      divider: 'linear-gradient(90deg, transparent, rgba(56,189,248,0.2) 20%, rgba(167,139,250,0.2) 80%, transparent)',
    },
  },
  nebula: {
    dark: {
      accent: '#a78bfa',
      accentLight: '#c4b5fd',
      waveBase: [167, 139, 250],
      glowA: 'rgba(167,139,250,0.12)',
      glowB: 'rgba(236,72,153,0.08)',
      heroGlow: 'rgba(167,139,250,0.14)',
      heroGradient: 'linear-gradient(135deg, #f8fafc 10%, #a78bfa 55%, #ec4899 100%)',
      avatarGradient: 'linear-gradient(135deg, #a78bfa, #ec4899)',
      divider: 'linear-gradient(90deg, transparent, rgba(167,139,250,0.25) 20%, rgba(236,72,153,0.25) 80%, transparent)',
    },
    light: {
      accent: '#7c3aed',
      accentLight: '#a78bfa',
      waveBase: [124, 58, 237],
      glowA: 'rgba(124,58,237,0.12)',
      glowB: 'rgba(219,39,119,0.10)',
      heroGlow: 'rgba(124,58,237,0.10)',
      heroGradient: 'linear-gradient(135deg, #0f172a 10%, #7c3aed 55%, #db2777 100%)',
      avatarGradient: 'linear-gradient(135deg, #7c3aed, #db2777)',
      divider: 'linear-gradient(90deg, transparent, rgba(124,58,237,0.2) 20%, rgba(219,39,119,0.2) 80%, transparent)',
    },
  },
  blaze: {
    dark: {
      accent: '#f97316',
      accentLight: '#fdba74',
      waveBase: [249, 115, 22],
      glowA: 'rgba(249,115,22,0.12)',
      glowB: 'rgba(239,68,68,0.08)',
      heroGlow: 'rgba(249,115,22,0.14)',
      heroGradient: 'linear-gradient(135deg, #f8fafc 10%, #f97316 55%, #ef4444 100%)',
      avatarGradient: 'linear-gradient(135deg, #f97316, #ef4444)',
      divider: 'linear-gradient(90deg, transparent, rgba(249,115,22,0.25) 20%, rgba(239,68,68,0.25) 80%, transparent)',
    },
    light: {
      accent: '#ea580c',
      accentLight: '#f97316',
      waveBase: [234, 88, 12],
      glowA: 'rgba(234,88,12,0.12)',
      glowB: 'rgba(220,38,38,0.10)',
      heroGlow: 'rgba(234,88,12,0.10)',
      heroGradient: 'linear-gradient(135deg, #0f172a 10%, #ea580c 55%, #dc2626 100%)',
      avatarGradient: 'linear-gradient(135deg, #ea580c, #dc2626)',
      divider: 'linear-gradient(90deg, transparent, rgba(234,88,12,0.2) 20%, rgba(220,38,38,0.2) 80%, transparent)',
    },
  },
};

const TEMP_THRESHOLDS: Record<TimeRange, { nebula: number; blaze: number }> = {
  day:   { nebula: 30_000_000,  blaze: 200_000_000 },
  week:  { nebula: 210_000_000, blaze: 1_400_000_000 },
  month: { nebula: 900_000_000, blaze: 6_000_000_000 },
};

function getColorTemp(rangeTokens: number, timeRange: TimeRange): ColorTemp {
  const t = TEMP_THRESHOLDS[timeRange];
  if (rangeTokens >= t.blaze) return 'blaze';
  if (rangeTokens >= t.nebula) return 'nebula';
  return 'frost';
}

/* ── Rank Badge ── */

interface RankInfo {
  key: string;
  labelKey: string;
  color: string;
  gradient?: string;
}

function getRank(streakDays: number): RankInfo | null {
  if (streakDays <= 0) return null;
  if (streakDays <= 3) return { key: 'bronze', labelKey: 'analytics.posterRankBronze', color: '#cd7f32' };
  if (streakDays <= 7) return { key: 'silver', labelKey: 'analytics.posterRankSilver', color: '#94a3b8' };
  if (streakDays <= 14) return { key: 'gold', labelKey: 'analytics.posterRankGold', color: '#eab308' };
  if (streakDays <= 30) return { key: 'diamond', labelKey: 'analytics.posterRankDiamond', color: '#22d3ee' };
  return { key: 'legendary', labelKey: 'analytics.posterRankLegendary', color: '#d946ef', gradient: 'linear-gradient(90deg, #f472b6, #a78bfa, #38bdf8)' };
}

/* ── Helpers ── */

function sumTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function buildPosterFileName(timeRange: TimeRange) {
  const rangeLabel = { day: 'daily', week: 'weekly', month: 'monthly' }[timeRange];
  return `ccem-${rangeLabel}-${new Date().toISOString().slice(0, 10)}.png`;
}

function formatPosterRange(dailyActivities: DailyActivity[], timeRange: TimeRange): string {
  const formatDate = (value: string) => {
    const date = new Date(value);
    return `${date.getMonth() + 1}.${date.getDate()}`;
  };

  // 日本月：从本月1号到今天
  if (timeRange === 'month') {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const rangeData = dailyActivities.filter(a => new Date(a.date) >= startOfMonth);
    if (rangeData.length > 0) {
      return `${formatDate(rangeData[0].date)} – ${formatDate(rangeData[rangeData.length - 1].date)}`;
    }
    return `${startOfMonth.getMonth() + 1}.1 – ${now.getMonth() + 1}.${now.getDate()}`;
  }

  // 日：今天
  if (timeRange === 'day') {
    const today = new Date().toISOString().slice(0, 10);
    const todayActivity = dailyActivities.find(a => a.date === today);
    if (todayActivity) {
      return formatDate(todayActivity.date);
    }
    const now = new Date();
    return `${now.getMonth() + 1}.${now.getDate()}`;
  }

  // 周：最近7天
  const rangeData = dailyActivities.slice(-7);
  if (rangeData.length > 0) {
    return `${formatDate(rangeData[0].date)} – ${formatDate(rangeData[rangeData.length - 1].date)}`;
  }
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return `${start.getMonth() + 1}.${start.getDate()} – ${end.getMonth() + 1}.${end.getDate()}`;
}

function getRangeTokens(usageStats: UsageStats, timeRange: TimeRange): number {
  if (timeRange === 'day') {
    return sumTokens(usageStats.today);
  } else if (timeRange === 'week') {
    return sumTokens(usageStats.week);
  } else {
    return sumTokens(usageStats.month);
  }
}

function getRangeLabelTokensKey(timeRange: TimeRange): string {
  if (timeRange === 'day') return 'analytics.shareDayTokens';
  if (timeRange === 'month') return 'analytics.shareMonthTokens';
  return 'analytics.shareWeekTokens';
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function formatLargeNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function shortenModel(name: string) {
  return name
    .replace('claude-', '')
    .replace('anthropic/', '')
    .replace('-latest', '')
    .replace('-20250', '');
}

/* ── Model Breakdown Helpers ── */

function createEmptyUsage(): TokenUsageWithCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
  };
}

function addUsage(a: TokenUsageWithCost, b: TokenUsageWithCost): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheCreationTokens += b.cacheCreationTokens;
  a.cost += b.cost;
}

function aggregateTodayData(breakdown: ModelBreakdownHistory): Record<string, TokenUsageWithCost> {
  const today = new Date().toISOString().slice(0, 10);
  const result: Record<string, TokenUsageWithCost> = {};

  Object.entries(breakdown).forEach(([key, usage]) => {
    if (key.startsWith(today)) {
      Object.entries(usage).forEach(([model, tokens]) => {
        if (!result[model]) result[model] = createEmptyUsage();
        addUsage(result[model], tokens);
      });
    }
  });

  return result;
}

function aggregateRecentDays(
  breakdown: ModelBreakdownHistory,
  days: number,
): Record<string, TokenUsageWithCost> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);

  const result: Record<string, TokenUsageWithCost> = {};

  Object.entries(breakdown).forEach(([key, usage]) => {
    // Only aggregate day-granularity keys (YYYY-MM-DD format)
    if (!key.match(/^\d{4}-\d{2}-\d{2}$/)) return;

    const keyDate = new Date(key);
    if (keyDate >= cutoff) {
      Object.entries(usage).forEach(([model, tokens]) => {
        if (!result[model]) result[model] = createEmptyUsage();
        addUsage(result[model], tokens);
      });
    }
  });

  return result;
}

function aggregateMonthDays(
  breakdown: ModelBreakdownHistory,
  now: Date,
): Record<string, TokenUsageWithCost> {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const result: Record<string, TokenUsageWithCost> = {};

  Object.entries(breakdown).forEach(([key, usage]) => {
    // Only aggregate day-granularity keys (YYYY-MM-DD format)
    if (!key.match(/^\d{4}-\d{2}-\d{2}$/)) return;

    const keyDate = new Date(key);
    if (keyDate >= startOfMonth && keyDate <= now) {
      Object.entries(usage).forEach(([model, tokens]) => {
        if (!result[model]) result[model] = createEmptyUsage();
        addUsage(result[model], tokens);
      });
    }
  });

  return result;
}

/* ── Activity Waveform (Canvas) ── */

function PosterWaveform({ activities, colors }: { activities: DailyActivity[]; colors: ThemeColors }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const last30 = activities.slice(-30);
  const bars = last30.length > 0 ? last30 : Array.from({ length: 30 }, () => ({ level: 0 as const }));

  const barW = 10;
  const gap = 2;
  const totalW = bars.length * barW + (bars.length - 1) * gap + 8;
  const totalH = 54;
  const dpr = 3;
  const heights = [5, 14, 24, 38, 50];
  const [r, g, b] = colors.waveBase;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, totalW, totalH);

    const alphas = [0.15, 0.35, 0.58, 0.80, 1.0];

    bars.forEach((activity, i) => {
      const level = 'level' in activity ? activity.level : 0;
      const h = heights[level];
      const x = 4 + i * (barW + gap);
      const y = totalH - h;
      const rad = Math.min(3, h / 2);
      const isHigh = level >= 3;

      if (isHigh) {
        ctx.save();
        ctx.shadowColor = `rgba(${r},${g},${b},0.45)`;
        ctx.shadowBlur = 8;
        ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
        roundRect(ctx, x, y, barW, h, rad);
        ctx.fill();
        ctx.restore();
      }

      if (isHigh) {
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, colors.waveHighGradTop);
        grad.addColorStop(1, `rgba(${r},${g},${b},${alphas[level]})`);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = `rgba(${r},${g},${b},${alphas[level]})`;
      }

      roundRect(ctx, x, y, barW, h, rad);
      ctx.fill();
    });
  }, [bars, colors]);

  return <canvas ref={canvasRef} style={{ width: totalW, height: totalH, display: 'block' }} />;
}

/* ── Hourly Sparkline (for Day view) ── */

function PosterHourlySparkline({ hourlyHistory, idPrefix, colors }: { hourlyHistory: UsageStats['hourlyHistory']; idPrefix: string; colors: ThemeColors }) {

  // 获取今天的小时数据 (YYYY-MM-DDTHH 格式)
  const today = new Date().toISOString().slice(0, 10);
  const hourlyData: { hour: number; tokens: number }[] = [];

  for (let h = 0; h < 24; h++) {
    const key = `${today}T${h.toString().padStart(2, '0')}`;
    const usage = hourlyHistory[key];
    hourlyData.push({
      hour: h,
      tokens: usage ? sumTokens(usage) : 0,
    });
  }

  // 只显示有数据的小时段
  const nonZeroData = hourlyData.filter(d => d.tokens > 0);
  if (nonZeroData.length === 0) return null;

  const maxTokens = Math.max(...hourlyData.map(d => d.tokens), 1);
  const w = 384;
  const h = 76;
  const padY = 4;
  const chartH = h - padY * 2;
  const gradId = `${idPrefix}-hourly-spark-grad`;
  const glowId = `${idPrefix}-hourly-spark-glow`;

  // 使用24小时数据点
  const points = hourlyData.map((d, i) => ({
    x: (i / 23) * w,
    y: padY + chartH - (d.tokens / maxTokens) * chartH,
  }));

  const bezier = points.reduce((acc, pt, i, arr) => {
    if (i === 0) return `M${pt.x},${pt.y}`;
    const prev = arr[i - 1];
    const cpx1 = prev.x + (pt.x - prev.x) * 0.4;
    const cpx2 = pt.x - (pt.x - prev.x) * 0.4;
    return `${acc} C${cpx1},${prev.y} ${cpx2},${pt.y} ${pt.x},${pt.y}`;
  }, '');

  const area = `${bezier} L${points[points.length - 1].x},${h} L${points[0].x},${h} Z`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.sparkFillFrom} stopOpacity={0.28} />
          <stop offset="100%" stopColor={colors.sparkFillFrom} stopOpacity={0.02} />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={bezier} fill="none" stroke={colors.sparkStroke} strokeWidth={2} filter={`url(#${glowId})`} />
    </svg>
  );
}

/* ── Sparkline (for Week/Month view) ── */

function PosterSparkline({ activities, idPrefix, colors, timeRange }: { activities: DailyActivity[]; idPrefix: string; colors: ThemeColors; timeRange: TimeRange }) {
  // 周：最近7天，月：本月数据（从1号到今天）
  let rangeData: DailyActivity[] = [];

  if (timeRange === 'month') {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    rangeData = activities.filter(a => new Date(a.date) >= startOfMonth);
  } else {
    // week
    rangeData = activities.slice(-7);
  }

  if (rangeData.length === 0) return null;

  const maxTokens = Math.max(...rangeData.map((a) => a.tokens), 1);
  const w = 384;
  const h = 76;
  const padY = 4;
  const chartH = h - padY * 2;
  const gradId = `${idPrefix}-spark-grad`;
  const glowId = `${idPrefix}-spark-glow`;

  const points = rangeData.map((a, i) => ({
    x: (i / Math.max(rangeData.length - 1, 1)) * w,
    y: padY + chartH - (a.tokens / maxTokens) * chartH,
  }));

  const bezier = points.reduce((acc, pt, i, arr) => {
    if (i === 0) return `M${pt.x},${pt.y}`;
    const prev = arr[i - 1];
    const cpx1 = prev.x + (pt.x - prev.x) * 0.4;
    const cpx2 = pt.x - (pt.x - prev.x) * 0.4;
    return `${acc} C${cpx1},${prev.y} ${cpx2},${pt.y} ${pt.x},${pt.y}`;
  }, '');

  const area = `${bezier} L${points[points.length - 1].x},${h} L${points[0].x},${h} Z`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.sparkFillFrom} stopOpacity={0.28} />
          <stop offset="100%" stopColor={colors.sparkFillFrom} stopOpacity={0.02} />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={bezier} fill="none" stroke={colors.sparkStroke} strokeWidth={2} filter={`url(#${glowId})`} />
    </svg>
  );
}

/* ── Segmented Model Bar ── */

function PosterModelBar({ byModel, colors, accents }: { byModel: UsageStats['byModel']; colors: ThemeColors; accents: string[] }) {
  const { t } = useLocale();
  const models = Object.entries(byModel)
    .map(([name, usage]) => ({ name, tokens: sumTokens(usage) }))
    .sort((a, b) => b.tokens - a.tokens);

  if (models.length === 0) {
    return (
      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
        {t('analytics.shareNoModelData')}
      </div>
    );
  }

  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  const topModels = models.slice(0, 4);
  const otherTokens = models.slice(4).reduce((sum, m) => sum + m.tokens, 0);
  const segments = otherTokens > 0 ? [...topModels, { name: `+${models.length - 4}`, tokens: otherTokens }] : topModels;

  return (
    <div>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', gap: 2 }}>
        {segments.map((seg, i) => {
          const pct = (seg.tokens / total) * 100;
          const color = accents[i % accents.length];
          return (
            <div
              key={seg.name}
              style={{
                width: `${Math.max(pct, 2)}%`,
                height: '100%',
                background: color,
                filter: `drop-shadow(0 0 6px ${color}44)`,
              }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {segments.map((seg, i) => {
          const color = accents[i % accents.length];
          const pct = Math.round((seg.tokens / total) * 100);
          return (
            <div key={seg.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: colors.textMuted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {shortenModel(seg.name)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                  color,
                  marginLeft: 'auto',
                  flexShrink: 0,
                }}
              >
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Poster Card ── */

function PosterCard({
  chartIdPrefix,
  dailyActivities,
  dateRange,
  osInfo,
  streakDays,
  totalTokens,
  theme,
  timeRange,
  usageStats,
  username,
  rangeTokens,
  rangeModelData,
}: PosterCardProps) {
  const { t } = useLocale();
  const baseTc = THEMES[theme];

  // Color temperature & rank
  const temp = getColorTemp(rangeTokens, timeRange);
  const tempColors = COLOR_TEMPS[temp][theme];
  const rank = getRank(streakDays);

  // Merge base theme with color temp overrides
  const tc: ThemeColors = {
    ...baseTc,
    glowA: tempColors.glowA,
    glowB: tempColors.glowB,
    heroGlow: tempColors.heroGlow,
    divider: tempColors.divider,
    accentBrand: tempColors.accent,
    sparkStroke: tempColors.accent,
    sparkFillFrom: tempColors.accent,
    waveBase: tempColors.waveBase,
    waveHighGradTop: tempColors.accentLight,
  };

  // Replace first accent color with temp accent
  const baseAccents = ACCENT_COLORS[theme];
  const accents = [tempColors.accent, ...baseAccents.slice(1)];

  const sectionLabel = {
    fontSize: 10,
    fontWeight: 600 as const,
    color: tc.labelColor,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    fontFamily: "'JetBrains Mono', monospace",
    marginBottom: 10,
  };

  return (
    <div
      style={{
        width: POSTER_W,
        height: POSTER_H,
        position: 'relative',
        overflow: 'hidden',
        background: tc.bg,
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
        color: tc.textSub,
      }}
    >
     {/* Background glows */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(500px circle at 15% 18%, ${tc.glowA}, transparent 70%), radial-gradient(400px circle at 85% 82%, ${tc.glowB}, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '24px 28px 20px',
        }}
      >
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                flexShrink: 0,
                borderRadius: '50%',
                background: tempColors.avatarGradient,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: tc.avatarTextColor,
              }}
            >
              {(username || 'D')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: tc.text,
                    letterSpacing: '0.02em',
                  }}
                >
                  {username || 'developer'}
                </span>
                {rank && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '1px 6px',
                      borderRadius: 8,
                      fontSize: 9,
                      fontWeight: 600,
                      fontFamily: "'JetBrains Mono', monospace",
                      letterSpacing: '0.02em',
                      color: rank.gradient ? '#f8fafc' : rank.color,
                      background: rank.gradient
                        ? rank.gradient
                        : `${rank.color}18`,
                      border: rank.gradient
                        ? 'none'
                        : `1px solid ${rank.color}40`,
                      lineHeight: '16px',
                    }}
                  >
                    {t(rank.labelKey)}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: tc.textMuted,
                  fontFamily: "'JetBrains Mono', monospace",
                  whiteSpace: 'nowrap',
                }}
              >
                {osInfo} · {dateRange}
              </div>
            </div>
          </div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              color: tc.accentBrand,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
            }}
          >
            CCEM
          </div>
        </div>

        {/* Gradient divider */}
        <div style={{ height: 1, margin: '14px 0 20px', background: tc.divider }} />

        {/* ── Hero Number ── */}
        <div style={{ position: 'relative', textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 280,
              height: 80,
              background: `radial-gradient(circle, ${tc.heroGlow}, transparent 70%)`,
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'relative',
              fontSize: 36,
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '-0.02em',
              background: tempColors.heroGradient,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1.1,
            }}
          >
            {formatLargeNumber(rangeTokens)}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              color: tc.textMuted,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.08em',
            }}
          >
            {t(getRangeLabelTokensKey(timeRange))}
          </div>
        </div>

        {/* ── Activity Waveform ── */}
        <div style={{ marginBottom: 22 }}>
          <div style={sectionLabel}>{t('analytics.share30dActivity')}</div>
          <PosterWaveform activities={dailyActivities} colors={tc} />
        </div>

        {/* ── Three Stat Cards ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
          {[
            { color: accents[0], value: `$${usageStats.total.cost.toFixed(2)}`, label: t('analytics.shareTotalCost') },
            { color: accents[1], value: `${streakDays}`, label: t('analytics.shareStreak') },
            { color: accents[2], value: formatTokens(totalTokens), label: t('analytics.shareTotalTokens') },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                flex: 1,
                padding: '12px 10px 10px',
                borderRadius: 12,
                background: tc.cardBg,
                border: `1px solid ${tc.cardBorder}`,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '15%',
                  right: '15%',
                  height: 2,
                  borderRadius: '0 0 2px 2px',
                  background: stat.color,
                  filter: `drop-shadow(0 0 8px ${stat.color}55)`,
                }}
              />
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: stat.color,
                  letterSpacing: '-0.01em',
                }}
              >
                {stat.value}
              </div>
              <div style={{ marginTop: 3, fontSize: 9, color: tc.textMuted, letterSpacing: '0.03em' }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Sparkline ── */}
        <div style={{ marginBottom: 22 }}>
          <div style={sectionLabel}>
            {timeRange === 'day' ? t('analytics.share24hTokens') : timeRange === 'month' ? t('analytics.shareMonthTokensLabel') : t('analytics.share7dTokens')}
          </div>
          {timeRange === 'day' ? (
            <PosterHourlySparkline hourlyHistory={usageStats.hourlyHistory} idPrefix={chartIdPrefix} colors={tc} />
          ) : (
            <PosterSparkline activities={dailyActivities} idPrefix={chartIdPrefix} colors={tc} timeRange={timeRange} />
          )}
        </div>

        {/* ── Model Bar ── */}
        <div style={{ marginBottom: 'auto' }}>
          <div style={sectionLabel}>{t('analytics.shareTopModels')}</div>
          <PosterModelBar byModel={rangeModelData} colors={tc} accents={accents} />
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            paddingTop: 14,
            borderTop: `1px solid ${tc.footerBorder}`,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme === 'dark' ? `${tempColors.accent}bf` : tc.accentBrand,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.06em',
              }}
            >
              {t('analytics.sharePoweredBy')}
            </div>
            <div
              style={{
                marginTop: 3,
                fontSize: 9,
                color: tc.textMuted,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              github.com/Genuifx/claude-code-env-manager
            </div>
          </div>
          <div style={{ padding: 4, borderRadius: 8, background: tc.qrBg }}>
            <QRCodeSVG value={GITHUB_URL} size={48} level="M" bgColor="transparent" fgColor={tc.qrFg} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Dialog ── */

export function SharePosterDialog({
  open,
  onOpenChange,
  usageStats,
  dailyActivities,
  streakDays,
}: SharePosterDialogProps) {
  const { t } = useLocale();
  const exportPosterRef = useRef<HTMLDivElement>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);
  const [pendingAction, setPendingAction] = useState<'copy' | 'save' | null>(null);
  const [previewScale, setPreviewScale] = useState(PREVIEW_SCALE_CAP);
  const [username, setUsername] = useState('');
  const [osInfo, setOsInfo] = useState('');
  const [posterTheme, setPosterTheme] = useState<PosterTheme>(() =>
    document.documentElement.classList.contains('light') ? 'light' : 'dark',
  );
  const [timeRange, setTimeRange] = useState<TimeRange>('week');
  const [posterStyle, setPosterStyle] = useState<PosterStyle>('classic');
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownHistory | null>(null);
  const previewId = useId().replace(/:/g, '');
  const exportId = useId().replace(/:/g, '');

  const totalTokens = sumTokens(usageStats.total);
  const rangeTokens = getRangeTokens(usageStats, timeRange);
  const dateRange = formatPosterRange(dailyActivities, timeRange);

  // Fetch model breakdown data when timeRange changes
  useEffect(() => {
    if (!open) return;

    const granularity = timeRange === 'day' ? 'hour' : 'day';
    invoke<ModelBreakdownHistory>('get_usage_model_breakdown', {
      granularity,
      source: null,
    }).then(setModelBreakdown).catch(() => setModelBreakdown(null));
  }, [open, timeRange]);

  // Compute model data for the selected time range
  const getRangeModelData = (): Record<string, TokenUsageWithCost> => {
    if (!modelBreakdown) return usageStats.byModel;

    const now = new Date();

    if (timeRange === 'day') {
      // Today's data (hour granularity, aggregate to day)
      return aggregateTodayData(modelBreakdown);
    } else if (timeRange === 'week') {
      // Last 7 days (day granularity)
      return aggregateRecentDays(modelBreakdown, 7);
    } else {
      // This month (day granularity, filter to current month)
      return aggregateMonthDays(modelBreakdown, now);
    }
  };

  const rangeModelData = getRangeModelData();

  useEffect(() => {
    if (!open) return;
    const ua = navigator.userAgent;
    if (ua.includes('Mac')) setOsInfo('macOS');
    else if (ua.includes('Windows')) setOsInfo('Windows');
    else if (ua.includes('Linux')) setOsInfo('Linux');
    else setOsInfo('Unknown OS');

    invoke<string>('get_system_username')
      .then(setUsername)
      .catch(() => setUsername('developer'));

    setPosterTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
  }, [open]);

  useEffect(() => {
    if (!open || !previewShellRef.current) return;
    const updateScale = () => {
      const containerWidth = previewShellRef.current?.clientWidth ?? POSTER_W;
      if (containerWidth <= 0) return;
      setPreviewScale(Math.min(PREVIEW_SCALE_CAP, containerWidth / POSTER_W));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(previewShellRef.current);
    return () => observer.disconnect();
  }, [open]);

  const getPosterBgColor = () => {
    if (posterStyle === 'terminal') return '#0a0a0a';
    if (posterStyle === 'dataink') return '#faf9f7';
    return THEMES[posterTheme].bg;
  };

  const buildPosterDataUrl = async () => {
    if (!exportPosterRef.current) throw new Error(t('analytics.shareGenerateFailed'));
    if (document.fonts?.ready) await document.fonts.ready;
    return domToPng(exportPosterRef.current, {
      backgroundColor: getPosterBgColor(),
      scale: 3,
    });
  };

  const handleSave = async () => {
    setPendingAction('save');
    try {
      const dataUrl = await buildPosterDataUrl();
      const saved = await invoke<boolean>('save_image_dialog', {
        base64Png: dataUrl.split(',')[1],
        defaultName: buildPosterFileName(timeRange),
      });
      if (saved) toast.success(t('analytics.shareSaved'));
    } catch (error) {
      toast.error(t('analytics.shareSaveFailed').replace('{error}', String(error)));
    } finally {
      setPendingAction(null);
    }
  };

  const handleCopy = async () => {
    setPendingAction('copy');
    try {
      const dataUrl = await buildPosterDataUrl();
      const base64Png = dataUrl.split(',')[1];
      try {
        await invoke('copy_image_to_clipboard', { base64Png });
      } catch (nativeError) {
        if (!navigator.clipboard?.write || !window.ClipboardItem) throw nativeError;
        const blob = await dataUrlToBlob(dataUrl);
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      }
      toast.success(t('analytics.shareCopied'));
    } catch (error) {
      toast.error(t('analytics.shareCopyFailed').replace('{error}', String(error)));
    } finally {
      setPendingAction(null);
    }
  };

  const isBusy = pendingAction !== null;

  const posterProps = {
    dailyActivities,
    dateRange,
    osInfo,
    streakDays,
    totalTokens,
    theme: posterTheme,
    timeRange,
    usageStats,
    username,
    rangeTokens,
    rangeModelData,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-auto max-w-[560px] flex-col gap-0 overflow-visible border-none bg-transparent p-0 shadow-none sm:rounded-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('analytics.sharePoster')}</DialogTitle>
          <DialogDescription>{t('analytics.shareDialogHint')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div ref={previewShellRef} className="flex justify-center">
            <div
              style={{
                height: POSTER_H * previewScale,
                width: POSTER_W * previewScale,
                borderRadius: 16,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: POSTER_H,
                  width: POSTER_W,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                }}
              >
                {posterStyle === 'terminal' ? (
                  <PosterCardTerminal chartIdPrefix={`preview-${previewId}`} {...posterProps} />
                ) : posterStyle === 'dataink' ? (
                  <PosterCardDataInk chartIdPrefix={`preview-${previewId}`} {...posterProps} />
                ) : (
                  <PosterCard chartIdPrefix={`preview-${previewId}`} {...posterProps} />
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
          {/* Theme Toggle - only for classic style */}
          {posterStyle === 'classic' && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-full border-white/10 bg-white/5 text-white/80 backdrop-blur-sm hover:bg-white/10"
              onClick={() => setPosterTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            >
              {posterTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          )}

          {/* Style Toggle */}
          <div className="flex items-center rounded-full border border-white/10 bg-white/5 p-0.5 backdrop-blur-sm">
            {(['classic', 'terminal', 'dataink'] as PosterStyle[]).map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => setPosterStyle(style)}
                className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-all ${
                  posterStyle === style
                    ? 'bg-primary text-primary-foreground'
                    : 'text-white/60 hover:text-white/80'
                }`}
              >
                {style === 'terminal' && <Terminal className="h-3 w-3" />}
                {style === 'dataink' && <BookOpen className="h-3 w-3" />}
                {t(`analytics.posterStyle${style.charAt(0).toUpperCase() + style.slice(1)}` as any)}
              </button>
            ))}
          </div>

          {/* Time Range Toggle */}
          <div className="flex items-center rounded-full border border-white/10 bg-white/5 p-0.5 backdrop-blur-sm">
            {(['day', 'week', 'month'] as TimeRange[]).map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setTimeRange(range)}
                className={`h-7 rounded-full px-3 text-xs font-medium transition-all ${
                  timeRange === range
                    ? 'bg-primary text-primary-foreground'
                    : 'text-white/60 hover:text-white/80'
                }`}
              >
                {range === 'day' ? t('analytics.timeRangeDay') : range === 'week' ? t('analytics.timeRangeWeek') : t('analytics.timeRangeMonth')}
              </button>
            ))}
          </div>

          {/* Copy & Save Button Group */}
          <div className="flex items-center overflow-hidden rounded-full border border-white/10 bg-white/5 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={isBusy}
              className="flex h-9 items-center gap-1.5 border-r border-white/10 px-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {pendingAction === 'copy' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('analytics.shareCopying')}</>
              ) : (
                <><Copy className="h-3.5 w-3.5" />{t('analytics.shareCopyImage')}</>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isBusy}
              className="flex h-9 items-center gap-1.5 px-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {pendingAction === 'save' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('analytics.shareSaving')}</>
              ) : (
                <><Download className="h-3.5 w-3.5" />{t('analytics.shareSaveImage')}</>
              )}
            </button>
          </div>
        </div>

        <div aria-hidden="true" className="pointer-events-none fixed left-[-10000px] top-0">
          <div ref={exportPosterRef}>
            {posterStyle === 'terminal' ? (
              <PosterCardTerminal chartIdPrefix={`export-${exportId}`} {...posterProps} />
            ) : posterStyle === 'dataink' ? (
              <PosterCardDataInk chartIdPrefix={`export-${exportId}`} {...posterProps} />
            ) : (
              <PosterCard chartIdPrefix={`export-${exportId}`} {...posterProps} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
