# Design System — Frosted Glass / macOS Sequoia

CSS custom properties defined in `apps/desktop/src/index.css`.

## Colors

- Primary: System Blue `hsl(211 100% 50%)`
- Neutrals: cool gray-blue scale (`222` hue family)
- All colors HSL in `:root` (dark) and `.light` blocks
- Consumed via Tailwind config extensions
- Fonts: Inter (UI) + JetBrains Mono (code)
- `prefers-reduced-motion` disables all animations globally

## Glassmorphism Architecture (3 layers)

1. **Ambient layer** (`ambient-bg` in `AppLayout.tsx`): 4 colored gradient orbs (`position: fixed; inset: 0`) drifting behind all panels — `backdrop-filter: blur()` needs colorful content behind it
2. **Glass panels**: heavy blur (44–56px) + high saturate (200–220%) + translucent backgrounds (opacity 0.42–0.48)
3. **Noise texture** (`glass-noise`): SVG fractal noise overlay with `mix-blend-mode: overlay`

**Critical**: Light mode needs ~2-3x higher `--ambient-opacity` than dark mode (0.35 vs 0.18). Panel `--glass-bg-opacity` must stay <=0.48.

## Glass CSS Utility Classes

| Class | Use | Blur |
|-------|-----|------|
| `glass-sidebar` | SideRail (heaviest frost) | 56px / 220% |
| `glass-header` | PageHeader bar | 44px / 200% |
| `glass-card` | Content cards (hover lift) | 44px / 200% |
| `glass` | Generic glass panel | 44px / 200% |
| `glass-subtle` | Secondary surfaces | 16px / 170% |
| `frosted-panel` | Modals, overlays | 48px / 220% |
| `glass-noise` | Add for grain texture | -- |
| `stat-card` | Dashboard metric cards | 44px / 200% |
| `glass-shimmer` | Ambient light sweep | -- |

## Token Groups

**Surfaces** (5-level): `--surface-sunken` -> `--surface` -> `--surface-raised` -> `--surface-overlay` -> `--surface-peak`

**Borders** (3-level): `--border-subtle` -> `--border` -> `--border-strong`

**Shadows**: `shadow-elevation-1` through `shadow-elevation-4`, `shadow-glass`, `shadow-glass-hover`

**Glass tokens**: `--glass-blur`, `--glass-saturate`, `--glass-bg-opacity`, `--glass-inset-opacity`, `--glass-noise-opacity`

**Ambient orbs**: `--ambient-1` (blue), `--ambient-2` (purple), `--ambient-3` (teal), `--ambient-opacity`

**Motion**: `--duration-instant` (80ms), `--duration-fast` (150ms), `--duration-base` (250ms), `--duration-slow` (400ms), `--duration-extended` (800ms)

**Custom**: `text-2xs` (0.625rem), `spacing-13` (3.25rem), `spacing-18` (4.5rem)

## UI Rules

- Use color tokens (`text-primary`, `bg-surface-raised`) — never hardcoded Tailwind colors
- Hugeicons only (via `lucide-react` compatibility adapter in `apps/desktop/src/lib/lucide-react.tsx`), no emoji
- All strings via `t()`, never hardcoded text
- All glass surfaces include `glass-noise` for grain
- New cards use `glass-card glass-noise`
- Glass borders use `--glass-border-light` (white at 45% opacity) — never gray Tailwind borders
