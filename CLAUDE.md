# CLAUDE.md

Claude Code Environment Manager (ccem) — monorepo for CLI + Tauri desktop app, managing multiple API configurations for Claude Code.

## Quick Start

```bash
pnpm install                        # Install all dependencies
pnpm --filter @ccem/core build      # Must build core first (desktop depends on it)
pnpm run build                      # Build everything
pnpm run dev                        # Dev mode for all (parallel)
pnpm test                           # Run all tests (vitest)
pnpm verify                         # Full CI gate: test + build + cargo test
```

```bash
# Desktop app
cd apps/desktop && pnpm tauri:dev             # Isolated dev app identity + locked Cargo graph
cd apps/desktop && pnpm tauri build           # Production build (dmg/app)

# CLI only
pnpm --filter @ccem/cli build
pnpm --filter @ccem/cli test
pnpm --filter @ccem/cli test -- --run src/__tests__/usage.test.ts  # single test
```

## Desktop Self-Test Lockfile Rule

Use `cd apps/desktop && pnpm tauri:dev` for desktop self-tests. This script applies `src-tauri/tauri.dev.conf.json`, so the development app uses the distinct `CCEM Desktop Dev` product name and `com.ccem.desktop.dev` bundle identifier. It also passes `--locked` to Cargo, so a Tauri dev run cannot silently rewrite `apps/desktop/src-tauri/Cargo.lock`.

The canonical dev stack is currently single-owner across all linked worktrees: Vite uses `127.0.0.1:1421` with `strictPort`, debug builds share `~/.ccem/desktop-app-dev.lock`, and every worktree uses `com.ccem.desktop.dev`. Before starting it, run `lsof -nP -iTCP:1421 -sTCP:LISTEN` and `lsof -nP ~/.ccem/desktop-app-dev.lock`. If another task or worktree owns either resource, do not start another stack and do not terminate, kill, `pkill`, `killall`, clean the port, or delete the lock. Continue non-app verification, retry after the owner exits, or report the desktop self-test as a specific coverage gap. Treat `EADDRINUSE` and `Another CCEM Desktop process is already running` as ownership conflicts, not permission to clean up another task.

A task may reuse or stop only the dev stack that it spawned in the same worktree and still owns. Record its PID/worktree and stop that exact process only. Changing just the Vite port is insufficient for parallel operation; the instance lock, application identity, MCP/control endpoint, and shared runtime data must also be isolated.

The installed release is outside the self-test process boundary. Agents must not quit, terminate, or kill `/Applications/CCEM Desktop.app` to make a development app easier to target. If automation sees multiple apps, target `com.ccem.desktop.dev`, the exact development app path, or the Tauri MCP port; otherwise stop and report the targeting failure without disturbing the release app.

If that command fails because the lockfile needs to change, inspect the dependency or version change instead of dropping `--locked`. For an intentional lock update, run `cd apps/desktop/src-tauri && cargo generate-lockfile --offline`, review the diff, and commit `apps/desktop/src-tauri/Cargo.lock` with the related change. For verification-only noise, restore the lockfile before worktree cleanup.

## Monorepo Structure

```
packages/core/     @ccem/core — shared types, presets, encryption
                   Two entry points: index.js (Node) and browser.js (no Node crypto)
apps/cli/          ccem CLI — commander + inquirer + ink
apps/desktop/      Tauri 2.0 desktop app
  src/             React 18 frontend (Vite, Tailwind, Zustand, shadcn/ui)
  src-tauri/src/   Rust backend (26 modules, 90+ Tauri commands)
docs/plans/        Design documents (25 dated specs)
docs/architecture/ Detailed reference docs (see below)
```

## Architecture Reference (read on demand)

- **[Desktop Backend](docs/architecture/desktop-backend.md)** — Rust module map, 8 managed state managers, 3 session types, all IPC commands
- **[Desktop Frontend](docs/architecture/desktop-frontend.md)** — React pages, Zustand store, IPC bridge, startup data flow, component organization
- **[Design System](docs/architecture/design-system.md)** — Glassmorphism theme, CSS tokens, glass utility classes, UI rules

## Key Constraints

- Desktop imports `@ccem/core/browser` — if import fails, run `pnpm --filter @ccem/core build`
- Config stored at `~/.ccem/config.json`, shared between CLI and desktop
- API keys encrypted with AES-256-CBC before storage
- i18n: default language is Chinese (`zh`), all strings via `t('namespace.key')`
- Icons: Hugeicons only (via `lucide-react` compatibility adapter), no emoji
- No ESLint/Prettier — no formatting enforcement via config files
- File size gate: 1000-line max per new file (exemptions in `docs/file-size-exemptions.md`)

## Environment Variables Managed

`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`

## Permission Modes

yolo (unrestricted) / dev (standard) / readonly / safe (conservative) / ci / audit (read-only analysis)
