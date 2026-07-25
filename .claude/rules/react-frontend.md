---
paths:
  - "apps/desktop/src/**/*.tsx"
  - "apps/desktop/src/**/*.ts"
---

# React Frontend Rules

## Data flow

All backend communication goes through `useTauriCommands` hook → `invoke()` → Rust backend. Never call `invoke()` directly from components.

## State management

Use the Zustand store (`src/store/index.ts`). Every mutation follows: call IPC → re-fetch full list → update store. No optimistic updates.

## i18n

All user-facing strings must use `t('namespace.key')`. Never hardcode Chinese or English text. When adding new strings:
1. Add key to both `src/locales/zh.json` and `src/locales/en.json`
2. CI will fail if keys are inconsistent between locale files

## Design system

- Use color tokens (`text-primary`, `bg-surface-raised`) — never hardcoded Tailwind colors like `text-emerald-600`
- Hugeicons only (import surface stays `lucide-react` via adapter), no emoji in UI
- Glass surfaces include `glass-noise` for grain texture
- New cards use `glass-card glass-noise`
- Glass borders use `--glass-border-light` (white) — never gray Tailwind border classes
- See `docs/architecture/design-system.md` for full token reference

## Loading states

Use per-domain skeleton components from `src/components/ui/skeleton-states.tsx`. Never use spinners.

## New pages

New pages must be `lazy()`-loaded in `App.tsx` with `Suspense` fallback.
