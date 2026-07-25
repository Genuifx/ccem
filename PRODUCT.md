# Design Context

## Users

**Mixed audience with different needs:**
- **Indie developers**: Using ccem as their daily driver, switching between models frequently throughout the workday
- **Power users**: Running multiple sessions simultaneously, leveraging remote control (Telegram/WeChat), cron tasks, and advanced features
- **Teams**: Coordinating shared API configurations, managing costs together

**Context of use**: A professional tool that developers keep open all day, switching between quick glances (checking session status, usage stats) and deep focus (reading conversation history, debugging API requests, configuring environments).

## Brand Personality

**Professional, reliable, efficient**

This is a serious tool for serious work. It should feel:
- **Professional**: Polished, native-feeling, worthy of being in a developer's daily toolkit
- **Reliable**: Stable, predictable, trustworthy - no gimmicks or unnecessary flourishes
- **Efficient**: Fast to scan, easy to navigate, respects the user's time and attention

## Aesthetic Direction

**Contextual glassmorphism** - inspired by macOS System Settings, Raycast, and Arc Browser.

The key insight: these apps don't use glassmorphism everywhere. They use it **strategically**:
- **Glass for chrome**: Sidebar, headers, modals, overlays - surfaces that frame content but aren't the content itself
- **Solid for content**: Reading areas, data tables, conversation history, forms - anywhere information density matters

### Why This Works

Glassmorphism creates **spatial hierarchy** - it signals "this is navigation/chrome" vs "this is content." When everything is glass, nothing stands out. When glass is reserved for framing elements, it creates clear visual zones.

**Current implementation** (keep this approach):
- ✅ Sidebar: Glass (provides ambient, non-intrusive navigation)
- ✅ Modals/overlays: Glass (floats above content, clearly temporary)
- ✅ Dashboard cards: Light glass (quick-glance metrics, not dense reading)
- ✅ Conversation history: Solid warm surfaces (Medium-style reading cards for long-form content)
- ✅ Forms/settings: Solid surfaces (clarity for input fields and configuration)

### Theme Strategy

- **Dark mode**: Flat, solid surfaces with subtle borders (current implementation is correct)
  - Glassmorphism in dark mode can feel gimmicky and reduce contrast
  - Solid surfaces with warm neutrals (30° hue) feel professional and reduce eye strain
  - Reserve glass for modals/overlays only in dark mode
  
- **Light mode**: Selective glassmorphism (current implementation is correct)
  - Glass for sidebar and chrome (ambient orbs provide color behind the blur)
  - Solid warm paper surfaces for reading areas (40° hue, Medium-style)
  - Higher contrast, better for daytime use

## Design Principles

### 1. Clarity Over Decoration
Information density wins. If glassmorphism reduces readability, use solid surfaces. The tool's value is in managing complexity - the UI should reduce cognitive load, not add to it.

### 2. Contextual Aesthetics
Match the visual treatment to the content type:
- **Navigation/chrome**: Glass (spatial framing)
- **Quick-glance metrics**: Light glass (dashboard cards, stat cards)
- **Dense information**: Solid surfaces (tables, lists, forms)
- **Reading content**: Warm solid surfaces (conversation history, documentation)

### 3. Native macOS Feel
Inspired by macOS System Settings and Sequoia design language:
- Subtle, not showy
- Warm neutrals (not cold grays)
- Refined details (proper shadows, borders, spacing)
- Respects system preferences (light/dark mode, reduced motion)

### 4. Professional Restraint
Avoid AI design tells:
- ❌ No gradient text (use solid colors for text)
- ❌ No colored side-stripe borders on cards (use full borders or background tints)
- ❌ No sparklines as decoration
- ❌ No glowing accents everywhere
- ✅ Use color purposefully and sparingly
- ✅ Let typography and spacing create hierarchy

### 5. Efficient Scanning
Developers need to quickly assess state:
- Clear visual hierarchy (size, weight, color)
- Consistent patterns (same information in same places)
- Meaningful color (status indicators, not decoration)
- Generous whitespace (breathing room between dense sections)

## Colors

**Current palette** (keep this):
- **Primary**: System Blue `hsl(211 100% 50%)` - familiar, professional, accessible
- **Neutrals**: Warm gray scale (30° hue) - reduces eye strain, feels refined
- **Semantic colors**: Standard success/warning/destructive/info

**Usage**:
- Use color tokens (`text-primary`, `bg-surface-raised`) - never hardcoded Tailwind colors
- Tint neutrals toward the warm 30° hue for cohesion
- Reserve bright colors for status and actions, not decoration

## Typography

**Current fonts** (keep this):
- **UI**: Inter - clean, professional, excellent at small sizes
- **Code/data**: JetBrains Mono - readable, distinctive, proper ligatures

**Hierarchy**:
- Use weight and size for hierarchy, not color alone
- Tabular numbers for metrics and data
- Generous line-height for reading content (1.6-1.7)
- Tighter line-height for UI labels (1.4-1.5)

## Accessibility

- WCAG AA minimum for all text
- Respect `prefers-reduced-motion` (already implemented)
- Keyboard navigation for all interactive elements
- Clear focus indicators
- Sufficient color contrast (especially in glassmorphism areas)

## Anti-References

**Avoid these AI design tells:**
- Generic admin dashboards with identical card grids
- Cyan-on-dark color schemes
- Purple-to-blue gradients everywhere
- Neon accents on dark backgrounds
- Gradient text for emphasis
- Side-stripe borders on every card
- Sparklines as decoration
- Hero metric layouts (big number, small label, gradient accent)

**Avoid these patterns:**
- Everything centered (use left-aligned layouts for content)
- Same padding everywhere (vary spacing for rhythm)
- Cards nested in cards (flatten the hierarchy)
- Modals for everything (prefer inline editing when possible)

## Implementation Notes

- **i18n**: All strings via `t('namespace.key')` - Chinese default, English supported
- **Icons**: Hugeicons only (via `lucide-react` compatibility adapter), no emoji
- **State management**: Zustand store, no optimistic updates
- **Loading states**: Skeleton components, no spinners
- **Design tokens**: Use CSS custom properties, consumed via Tailwind config
