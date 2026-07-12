# AGENTS.md

Codex Environment Manager (`ccem`) — monorepo for CLI + Tauri desktop app, managing multiple API configurations for Codex.

## How To Use This File

This file is intentionally split into three layers:

1. **Strategy philosophy**
   Calibrate how to think in this repo. Prefer thinking frameworks over brittle step-by-step scripts.
2. **Minimal complete toolset**
   Define the smallest reliable set of tools and workflows that closes the loop for real delivery.
3. **Necessary facts**
   Provide repo-specific technical facts, constraints, and commands. These are reasoning inputs, not substitutes for judgment.

Use this file to strengthen autonomous judgment, not to replace it. If the user explicitly asks for a different flow, the user request wins.

## 1. Strategy Philosophy

### Think in frameworks, not cargo-culted rules

- Do not optimize for “following the checklist”.
- Optimize for end-to-end closure: understand the task, isolate the change, implement it, verify it, and show evidence.
- Treat repo guidance as a decision framework. If a stronger, simpler path is clearly better for the current task, take it and explain why.

### Resist model inertia

- Do not stop at the first plausible answer, the first green build, or the first file that looks relevant.
- For non-trivial work, ask: what would make this feel genuinely closed-loop instead of merely edited?
- When a change touches app behavior, validate the real user flow instead of assuming code inspection is enough.

### Prefer proof over narration

- “Fixed” means commands ran or the flow was actually exercised.
- A summary without verification evidence is not a finished task.
- When the repo offers a direct validation path, prefer it over indirect confidence.

### Keep guidance abstract, keep facts concrete

- Strategy should stay high-level and reusable.
- Tooling guidance should describe capability boundaries, not micromanage every motion.
- Repo facts should be concrete and testable.

### Interaction design philosophy

For UI work, default to thinking about the user's primary task, primary path, and decision burden before adding explanatory copy.

- When the interface feels costly to understand, first solve it with information architecture, entry-point splitting, grouping, button naming, defaults, and progressive disclosure. Treat copy as the last tool, not the first.
- Long explanatory blocks usually mean the flow has not yet been absorbed into the structure. If the UI needs text like “do this here, go there for that,” default to restructuring the interaction first.
- Use explanatory copy only for necessary invisible boundaries: permissions, risks, external-system constraints, and irreversible consequences.
- Explanations may be layered: a short primary sentence, nearby hints, tooltips, popovers, empty states, and error messages. Do not pile every explanation onto the main surface.
- Before shipping UI, ask: if this explanation disappeared, would the interface become confusing? If yes, improve the structure before making the copy longer.

### Default delivery mindset for ccem

Unless the user explicitly asks for a tiny local tweak, read-only analysis, or a different process, treat implementation work in this repo as:

`isolate -> activate -> implement -> verify -> self-test -> summarize`

That loop is the default operating model for future runs in this repository.

## 2. Minimal Complete Toolset

This repo has a preferred minimal toolset for turning implementation into a closed loop.

### A. Isolation

For non-trivial changes, work in an isolated worktree from `main`.

- Branch naming default: `codex/<topic>`
- Worktree naming default: `.worktrees/<topic>`
- Example:

```bash
git worktree add -b codex/<topic> .worktrees/<topic> main
```

Do not land substantial work directly in a dirty `main` checkout unless the user explicitly asks for that.

### B. Execution mode

For planned implementation work, start by loading [$pua](/Users/wzt/.agents/skills/pua/SKILL.md).

- Use it as an execution style, not as decoration.
- Keep its verification-first and owner-style behavior through the task unless the user explicitly disables it.

### C. Build and test primitives

Use the repo’s native build/test commands as the default proof surface.

```bash
pnpm install
pnpm --filter @ccem/core build
pnpm test
pnpm verify
cd apps/desktop/src-tauri && cargo test --locked
```

Pick the smallest command set that actually verifies the changed surface area, but do not skip verification entirely.

### D. Desktop self-test

For desktop-, Tauri-, runtime-, history-, settings-, notifications-, or other app-facing changes, self-test through the running app before closing the task.

Minimum expected path:

1. Start the app with `cd apps/desktop && pnpm tauri:dev`
2. Connect via `tauri-mcp-server`
3. Drive the changed flow yourself
4. Check the actual rendered state, not just backend logs

Manual reasoning alone is not considered enough for app-facing changes when Tauri MCP can exercise the flow.

The `tauri:dev` script applies `src-tauri/tauri.dev.conf.json`, giving the development app its own `CCEM Desktop Dev` product name and `com.ccem.desktop.dev` bundle identifier. It also passes `--locked` to Cargo, so desktop self-tests cannot silently rewrite `apps/desktop/src-tauri/Cargo.lock`.

The installed release is outside the self-test process boundary. Agents must not quit, terminate, or kill `/Applications/CCEM Desktop.app` to disambiguate a development build. If desktop automation reports multiple matching apps, target the development app by its `com.ccem.desktop.dev` identifier, exact development app path, or Tauri MCP port. If none of those targets is available, stop the self-test and report the targeting failure instead of disturbing the release app.

If the locked self-test fails because the lockfile needs to change, do not remove `--locked` to get past the failure. Inspect the dependency or version change first. If the lock update is intentional, regenerate it explicitly with `cd apps/desktop/src-tauri && cargo generate-lockfile --offline`, review the diff, and include `apps/desktop/src-tauri/Cargo.lock` in the related commit. If the change is only verification noise from a local run, restore the lockfile before cleanup and re-check `git status --short -- apps/desktop/src-tauri/Cargo.lock`.

### E. Evidence retention

When visual or workflow evidence helps, save it under `.artifacts/`.

- Screenshots, notes, or other local proof can live there
- Leave artifacts untracked unless the user explicitly asks to commit them

### F. Commit message format

Use Conventional Commit style for all repo commits.

- Preferred format: `<type>(<scope>): <summary>`
- Desktop/Tauri/frontend work should usually use scope `desktop`
- Example: `fix(desktop): stabilize terminal tmux attach flow`
- If a commit is authored during the task and has not been pushed yet, fix the message before finishing the task if it does not follow this format

### Default implementation loop

When there is no strong reason to do otherwise, follow this default loop:

1. Create a worktree from `main`
2. Load [$pua](/Users/wzt/.agents/skills/pua/SKILL.md)
3. Implement in the worktree
4. Run the relevant build/test commands
5. Self-test with `tauri-mcp-server` for app-facing changes
6. Keep useful local evidence in `.artifacts/`
7. Merge back only after the worktree is clean and verified

## 3. Necessary Facts

### Quick Start

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
pnpm --filter @ccem/cli test -- --run src/__tests__/usage.test.ts
```

### Monorepo Structure

```text
packages/core/     @ccem/core — shared types, presets, encryption
                   Two entry points: index.js (Node) and browser.js (no Node crypto)
apps/cli/          ccem CLI — commander + inquirer + ink
apps/desktop/      Tauri 2.0 desktop app
  src/             React 18 frontend (Vite, Tailwind, Zustand, shadcn/ui)
  src-tauri/src/   Rust backend
docs/plans/        Design documents
docs/architecture/ Detailed reference docs
```

### Architecture References

- **[Desktop Backend](docs/architecture/desktop-backend.md)** — Rust module map, managed state, session types, IPC commands
- **[Desktop Frontend](docs/architecture/desktop-frontend.md)** — React pages, Zustand store, IPC bridge, startup data flow
- **[Design System](docs/architecture/design-system.md)** — Glassmorphism theme, CSS tokens, glass utility classes

### Key Constraints

- Desktop imports `@ccem/core/browser` — if import fails, run `pnpm --filter @ccem/core build`
- Config is stored at `~/.ccem/config.json`, shared between CLI and desktop
- API keys are encrypted with AES-256-CBC before storage
- i18n default language is Chinese (`zh`), and strings should go through `t('namespace.key')`
- Icons: Lucide React only
- No ESLint/Prettier config is enforced in-repo
- File size gate: 1000-line max per new file, with exemptions in `docs/file-size-exemptions.md`

### Environment Variables Managed

`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`

### Permission Modes

`yolo` (unrestricted) / `dev` (standard) / `readonly` / `safe` (conservative) / `ci` / `audit` (read-only analysis)
