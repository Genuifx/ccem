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

Use `cd apps/desktop && pnpm tauri:dev` for desktop self-tests. The worktree-aware launcher merges `src-tauri/tauri.dev.conf.json` with a generated config and derives a distinct Vite port, product name/bundle identifier, Rust lock, and 100-port MCP block from the absolute worktree path. It also passes `--locked` to Cargo, so a dev run cannot silently rewrite `apps/desktop/src-tauri/Cargo.lock`.

Different worktrees may run concurrently. Startup prints an ignored `.artifacts/tauri-dev/` manifest containing the exact `launcherPid`, `identifier`, and `mcpPort`; use those values to target the instance. The same worktree remains single-owner and a duplicate start reports its live PID. Stop only the process launched by the current task, via its original terminal or exact `launcherPid`; never use `pkill`, `killall`, port cleanup, lock deletion, or an installed-app quit. A collision is evidence to inspect, not permission to kill another task.

Named dev instances disable automatic shared background services by default: runtime cleanup/reconciliation, proxy boot, system autostart sync, session monitoring, cron, bot request watching, and chat bridge auto-start. Use `CCEM_DESKTOP_DEV_BACKGROUND_SERVICES=1 pnpm tauri:dev` only for a targeted single-owner test. The launcher does not clone `~/.ccem`; manual settings/config/session writes remain shared and concurrent tests that mutate the same records must still be coordinated.

The installed release is outside the self-test process boundary. Agents must not quit, terminate, or kill `/Applications/CCEM Desktop.app` to make a development app easier to target. If automation sees multiple apps, target the exact generated bundle identifier or Tauri MCP port from the manifest; otherwise stop and report the targeting failure without disturbing the release app.

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
