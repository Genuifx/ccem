# Desktop Frontend (React + TypeScript)

Source: `apps/desktop/src/`

## Entry Flow

```
main.tsx → App.tsx (LocaleProvider + TooltipProvider + AppLayout + Suspense)
```

Tab-based routing (no React Router). `activeTab` state in `App.tsx`. Non-dashboard pages are `lazy()`-loaded. `useTransition` wraps tab switches. Prefetching on hover/keyboard via `prefetchTab()`.

## Pages

Dashboard, Sessions, Environments, Analytics, Skills, History, CronTasks, ChatApp, ProxyDebug, Settings

## State Management

Single Zustand store (`src/store/index.ts`) owns the active desktop state. Equality-guarded setters for environments and sessions prevent spurious re-renders.

Per-domain loading flags: `isLoadingEnvs`, `isLoadingSessions`, `isLoadingStats`, `isLoadingSkills`, `isLoadingSettings`

## IPC Bridge

`src/hooks/useTauriCommands.ts` (~1,079 lines) — the entire IPC layer. Wraps every `invoke()` call with:
- snake_case → camelCase response mapping
- Zustand store updates
- Error handling

Returns ~75 functions. Every mutation does a full re-fetch (no optimistic updates, no caching).

## Startup Data Flow

1. `refreshCriticalData()` — parallel: `loadEnvironments()` + `loadCurrentEnv()`
2. `scheduleAfterFirstPaint()` (220ms delay, 1200ms timeout) — `refreshDeferredData()`: `loadAppConfig()` + `loadSessions()` + `get_usage_stats`
3. On window `focus` (throttled 5s, 180ms debounce, `requestIdleCallback`): re-syncs envs + sessions

## Hook Layer

| Hook | Purpose |
|------|---------|
| `useTauriCommands` | All Tauri IPC calls |
| `useTauriEvents` | Backend → frontend event listeners |
| `useKeyboardShortcuts` | Global/page keyboard shortcut registry |
| `useCountUp` | `requestAnimationFrame` count-up animation |
| `useLongPress` | Long-press gesture detection |

## Keyboard Shortcuts

Global (App.tsx): Cmd+1–6 tabs, Cmd+Enter/N launch, Cmd+, settings
Page-specific: added via `useKeyboardShortcuts` in individual pages

## Component Organization

```
components/
  layout/        AppLayout, PageHeader, SideRail (72px nav)
  dashboard/     HeroMetricCard, LaunchStrip, LiveSessions, etc.
  sessions/      Embedded terminal panel, headless panel, recovery, etc.
  environments/  EnvList
  analytics/     TokenChart, HeatmapCalendar, DailyTokenBar, SharePosterDialog
  history/       MarkdownRenderer, MessageBubble, ModelIcon
  skills/        DiscoverTab, InstalledTab, SkillCard, InstallDialog
  cron/          AiCronPanel, CronEditor
  chat-app/      FeishuPanel, TelegramPanel, WeixinPanel
  projects/      ProjectList
  ui/            Primitive UI components (shadcn/ui pattern)
```

## UI State Patterns

- **Loading**: Per-domain skeleton components in `skeleton-states.tsx` (never spinners)
- **Empty**: Shared `EmptyState` component (muted icon + text + optional action)
- **Error**: Shared `ErrorBanner` component (inline banner with retry, `role="alert"`)
- **FTUE**: localStorage flags (`ccem-ftue-*`) drive amber dots and ghost cards

## i18n

`src/locales/index.tsx` — `LocaleProvider` + `useLocale()` hook. JSON files: `zh.json`, `en.json`. Default: Chinese. The provider hydrates from the backend-owned `DesktopSettings.language` and serializes user changes through the dedicated `save_language` command; generic `save_settings` never owns language. When an upgraded settings file has no language field, the provider migrates the legacy `ccem-locale` value once and removes that compatibility key only after the backend save succeeds. All strings go through `t('namespace.key')`.

## Lib Utilities

| File | Purpose |
|------|---------|
| `tauri-ipc.ts` | TypeScript types for all IPC types |
| `utils.ts` | `cn()` (clsx + tailwind-merge) |
| `idle.ts` | `scheduleAfterFirstPaint()` via `requestIdleCallback` |
| `performance.ts` | Dev-mode performance logging |
| `mockAnalytics.ts` | Mock data for dev mode |
