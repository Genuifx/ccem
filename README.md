<p align="center">
  <img src="./logo.png" alt="CCEM Logo" width="160" />
</p>

<h1 align="center">CCEM</h1>
<p align="center"><strong>One control center for Claude Code, Codex, OpenCode and every model behind them.</strong></p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ccem"><img src="https://img.shields.io/npm/v/ccem.svg" alt="npm version" /></a>
  <a href="https://github.com/Genuifx/ccem/stargazers"><img src="https://img.shields.io/github/stars/Genuifx/ccem" alt="GitHub stars" /></a>
  <a href="https://github.com/Genuifx/ccem/releases"><img src="https://img.shields.io/github/v/release/Genuifx/ccem" alt="GitHub release" /></a>
  <a href="https://github.com/Genuifx/ccem/actions/workflows/release-desktop.yml"><img src="https://github.com/Genuifx/ccem/actions/workflows/release-desktop.yml/badge.svg" alt="Release Desktop" /></a>
  <a href="https://deepwiki.com/Genuifx/ccem"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license: Apache 2.0" /></a>
  <a href="https://github.com/Genuifx/ccem/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

> **🖼️ IMAGE PLACEHOLDER 1 — Hero shot** (replaces `screenshots/shots.webp`)
>
> **Suggested file:** `screenshots/hero.webp` · 2400×1500 · light theme on a soft macOS wallpaper
>
> **Shows:** The CCEM Desktop main window, front and center, on the **Workspace** page. Glass sidebar on the left (Workspace, Sessions, Environments, Skills, History, Cron, Chat Apps, Analytics, Proxy Debug, Settings). The center shows a live Claude session with a short streamed transcript: a user prompt, an assistant reply with a tool call card (for example an `Edit` on `src/app.ts`) and a todo checklist. The composer at the bottom shows the **Claude / Codex / OpenCode** agent switcher, an environment chip (for example `KIMI`), a permission chip (`dev`), an effort selector and a **Dynamic routing** chip. The **side panel** on the right is open on the **Browser** tab and shows a localhost page. In the lower-right corner of the desktop, outside the window, the **Desktop Cat** sits with two small session bubbles stacked beside it.
>
> **Caption:** *Pick a model, pick an agent, ship. CCEM Desktop in action.*

---

## Table of Contents

- [Why ccem](#why-ccem)
- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Desktop App](#desktop-app)
- [External Control: JSON-RPC, Deeplinks & CLI](#external-control-json-rpc-deeplinks--cli)
- [How ccem Compares](#how-ccem-compares)
- [Data Storage](#data-storage)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

---

## Why ccem

Claude Code is great. Using it seriously every day is where things get messy.

- **Model sprawl.** KIMI for frontend, DeepSeek for scripts, GLM for refactors, a local Ollama model on the plane. Each switch means hand-`export`ing env vars, and eight terminal tabs later nobody knows which tab talks to which provider.
- **Permission fatigue.** Clicking *Approve* 200 times a day wears you out. `--dangerously-skip-permissions` feels like a bad idea next to your `.env`.
- **No idea what you spent.** Claude Code, Codex and OpenCode each keep their own logs. Nothing adds them up.
- **You're away from your desk.** You're out getting coffee, a test is red, and your laptop is at home.
- **The work that should run itself.** Nightly test runs, a Monday PR sweep, a changelog every Friday, with the results sent to your phone.

**ccem handles all of it.** It's a free, open-source CLI plus a native Tauri desktop app that switches models in one keystroke, sets permissions with one word, routes subagents to cheaper models, tracks every token, runs cron jobs, and lets you continue a session from Telegram, WeChat, WeCom or Feishu.

---

## Highlights

| | CLI | Desktop |
|---|:---:|:---:|
| **11 provider presets** (GLM, KIMI, DeepSeek, Qwen/Bailian, MiniMax, MiMo, OpenRouter, Ollama, …) with Opus / Sonnet / Haiku tier mapping | ✅ | ✅ |
| **6 permission modes**: `yolo` · `dev` · `readonly` · `safe` · `ci` · `audit` | ✅ | ✅ |
| **Usage & cost analytics** with a calendar heatmap | ✅ | ✅ Claude + Codex + OpenCode |
| **Skill installer**: 20 curated presets + any GitHub URL | ✅ | ✅ Streaming search |
| **Encrypted team config sharing** (`ccem load`) | ✅ | ✅ |
| **DeepSeek Harness (`dsh`)**: run a ccem environment through DeepSeek's agent harness | ✅ `ccem dsh` | ✅ History source |
| **tmux-backed sessions**: list and attach from any terminal | ✅ `ccem sessions` / `attach` | ✅ |
| **Cron automation**: create, list, delete, trigger | ✅ | ✅ Scheduler, templates, AI generation, run history |
| **Drive Desktop from scripts**: sessions, input, events, routing | ✅ `ccem desktop …` | ✅ 20-method JSON-RPC |
| **Three agents in one workspace**: Claude Code, Codex, OpenCode | — | ✅ |
| **Per-subagent model routing** through a local routing proxy | — | ✅ |
| **Built-in browser side panel** the agent can drive, with you able to pause it | — | ✅ |
| **Fork a session from any turn** and **rewind to file checkpoints** | — | ✅ |
| **Session Review**: diffs, todos, artifacts, subagent traces | — | ✅ |
| **Chat bots**: Hermes-powered WeCom & Feishu, plus Telegram / WeChat / WeCom bridges | — | ✅ |
| **Desktop Cat**: an always-on-top companion that stacks your running and finished sessions | — | ✅ |
| **Tray cockpit**, **Proxy Debug**, **share posters**, **auto-update** | — | ✅ |

The CLI and Desktop read the same config file (`~/.ccem/config.json`), so an environment you add in one shows up in the other immediately.

---

## Quick Start

### CLI: 30 seconds, no install

```bash
npx ccem              # Interactive menu
```

Or install it globally:

```bash
npm install -g ccem
ccem add kimi         # Name it, pick the KIMI preset, paste your key
ccem use kimi         # Switch to it
ccem dev              # Launch Claude Code in "dev" permission mode
```

### Desktop

Download from [GitHub Releases](https://github.com/Genuifx/ccem/releases):

- **macOS**: `.dmg` for Apple Silicon (`aarch64`) and Intel (`x86_64`)
- **Windows**: `.exe` installer (x64)

Open it, add an environment, pick **Claude**, **Codex** or **OpenCode**, describe your task, and press <kbd>Cmd</kbd>+<kbd>Enter</kbd>.

---

# CLI

Everything you need from the terminal: environments, permissions, usage, skills, cron, DeepSeek Harness, tmux sessions, and remote control of a running Desktop app.

## Install

```bash
npm install -g ccem
# or: pnpm add -g ccem
# or just: npx ccem
```

> **🖼️ IMAGE PLACEHOLDER 2 — CLI interactive menu** (replaces `screenshots/cli-index.webp`)
>
> **Suggested file:** `screenshots/cli-menu.webp` · terminal at ~120×36, dark theme, a readable monospace font
>
> **Shows:** Running `ccem` with no arguments. At the top, the ASCII/pixel CCEM logo. Under it, a status line with the current environment (for example `KIMI`) and the permission mode (`dev`). Then the Ink-rendered interactive menu with the cursor on an item such as *Switch environment*, and other items visible (add environment, permission modes, usage, skills, etc.). Optionally, a second pane or inset shows `ccem ls` output: a cli-table3 table listing 4–5 environments with names, base URLs and models, the active one highlighted.
>
> **Caption:** *`npx ccem`: everything one keystroke away.*

## Environment Management

```bash
ccem              # Interactive menu
ccem add kimi     # Name an environment, then choose a preset or enter settings
ccem use kimi     # Switch environment
ccem ls           # List all environments
ccem current      # Show active environment
ccem env          # Print export commands (pipe-friendly)
ccem env --json   # Same, as JSON
ccem run <cmd>    # Run any command with the env vars injected
ccem del <name>   # Delete
ccem rename <a> <b>
ccem cp <src> <dst>
```

### Built-in Presets

Each preset fills in the base URL and maps Claude Code's **Opus / Sonnet / Haiku** tiers to that provider's models (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `…_SONNET_MODEL`, `…_HAIKU_MODEL`), with `ANTHROPIC_MODEL=opus`. Claude Code's `/model` picker and its subagents then use the right model for each tier.

| Preset | Base URL | Opus tier | Sonnet tier | Haiku tier |
|---|---|---|---|---|
| GLM (Zhipu) | `https://open.bigmodel.cn/api/anthropic` | glm-5.3[1m] | glm-5.3[1m] | glm-5.3-flash |
| KIMI (Moonshot) | `https://api.moonshot.cn/anthropic` | kimi-k3[1m] | kimi-k3[1m] | kimi-k2.7-code |
| Kimi Code Plan | `https://api.kimi.com/coding/` | kimi-for-coding | kimi-for-coding | kimi-for-coding |
| MiniMax | `https://api.minimax.cn/anthropic` | MiniMax-M3[1m] | MiniMax-M3[1m] | MiniMax-M3[1m] |
| DeepSeek | `https://api.deepseek.com/anthropic` | deepseek-v4-pro[1m] | deepseek-v4-pro[1m] | deepseek-v4-flash |
| Bailian (Aliyun) | `https://dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-max | qwen3.7-max | qwen3.6-flash |
| Bailian Coding Plan | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-plus | qwen3.7-plus | qwen3.7-plus |
| OpenRouter | `https://openrouter.ai/api` | anthropic/claude-opus-5 | anthropic/claude-sonnet-5 | anthropic/claude-haiku-4.5 |
| Ollama (local) | `http://localhost:11434` | gemma4:31b | gemma4:26b | gemma4:e4b |
| MiMo (Xiaomi) | `https://api.xiaomimimo.com/anthropic` | mimo-v2.5-pro | mimo-v2.5-pro | mimo-v2.5 |
| MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/anthropic` | mimo-v2.5-pro | mimo-v2.5-pro | mimo-v2.5-pro |

Any other Anthropic-compatible endpoint works too: just enter the base URL, key and models yourself. API keys are encrypted at rest.

### Shell Integration

`ccem use` can't change the env vars of the shell you're already in. Either prefix commands with `ccem run`, or add this to `~/.zshrc`:

```bash
ccem() {
  command ccem "$@"
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    if [[ "$1" == "use" || -z "$1" ]]; then
      eval "$(command ccem env)"
    fi
  fi
  return $exit_code
}
```

Then `source ~/.zshrc`.

## Permission Modes

Six presets that sit between "approve everything" and "approve nothing".

| Mode | What it allows | Use it for |
|---|---|---|
| **yolo** | Everything | Your own project, full trust |
| **dev** | Normal development, sensitive files blocked | Daily work |
| **readonly** | Reading only | Code review, learning a codebase |
| **safe** | Restricted network and writes | Unfamiliar or untrusted repos |
| **ci** | A CI-friendly tool set | Automation pipelines |
| **audit** | Read and search only | Security audits |

```bash
ccem yolo | dev | readonly | safe | ci | audit   # Apply temporarily; reverted when Claude Code exits
ccem setup perms --dev                            # Write it into the project's .claude/settings.json
ccem setup default-mode --dev                     # Make it the default
ccem --mode                                       # Show the current mode
ccem --list-modes                                 # Show all modes
```

## Usage Analytics

```bash
ccem usage          # Interactive view with a calendar heatmap
ccem usage --json   # Machine-readable
```

ccem parses Claude Code's JSONL logs under `~/.claude/projects/` and calculates tokens and cost from cached LiteLLM model prices.

## Skill Management

```bash
ccem skill add              # Interactive picker (Tab switches groups)
ccem skill add <name>       # Install a preset
ccem skill add <github-url> # Install from any GitHub repo or subfolder
ccem skill ls               # List installed skills
ccem skill rm <name>        # Remove
```

**Official presets (16):** frontend-design, skill-creator, web-artifacts-builder, canvas-design, algorithmic-art, theme-factory, mcp-builder, webapp-testing, pdf, docx, pptx, xlsx, brand-guidelines, doc-coauthoring, internal-comms, slack-gif-creator

**Curated community skills:** superpowers, ui-ux-pro-max, Humanizer-zh, skill-writer

ccem also ships skills that teach Claude Code to use ccem itself:

```bash
ccem setup cron       # Installs the ccem-cron skill: Claude can schedule tasks for you
ccem setup bot-bind   # Installs the ccem-bot-bind skill: Claude can attach a session to a chat bot
```

## DeepSeek Harness (`dsh`)

Run a ccem environment through **DeepSeek Harness**, a separate agent runtime. ccem converts your environment into a dsh provider config, mapping the Opus/Sonnet/Haiku tiers to models, so the same keys work in both runtimes.

```bash
ccem dsh doctor                       # Offline readiness check: binary, versions, config
ccem dsh inspect --env deepseek       # Preview the dsh provider config (secrets redacted)
ccem dsh run --tier sonnet "fix the flaky test in auth.spec.ts"
```

`run` accepts `--env`, `--tier opus|sonnet|haiku`, `--model`, `--cwd` and `--permission read-only|workspace-write|danger-full-access`. Desktop release builds bundle dsh, and its sessions appear in the History page under **DeepSeek**.

## tmux Sessions

When tmux is installed, interactive sessions run inside tmux, so you can pick them up from any terminal:

```bash
ccem sessions         # List tmux-backed interactive sessions
ccem attach [id]      # Attach to one in your terminal
```

## Team Config Sharing

Distribute API configurations to your team over an encrypted channel:

```bash
ccem load https://your-server.com/api/env --key YOUR_KEY --secret YOUR_SECRET
# or keep secrets out of shell history:
echo '{"key":"…","secret":"…"}' | ccem load https://your-server.com/api/env --credentials-stdin
```

A ready-to-deploy server lives in [`server/`](./server). It uses AES-256-GCM authenticated envelopes and rate limiting, and ships with an example config and a PM2 ecosystem file.

## Scheduled Tasks from the CLI

```bash
ccem cron create --name weekday-review --schedule '0 9 * * 1-5' \
  --prompt 'Inspect this project and summarize issues that need attention' \
  --execution-profile conservative --disabled --json
ccem cron list --json
ccem cron trigger weekday-review      # Run it now via the running Desktop app
ccem cron delete weekday-review
ccem cron notification-targets        # Show where results can be delivered
```

Other options: `--working-dir`, `--env-name`, `--max-budget-usd`, `--allowed-tools`, `--disallowed-tools`, `--timeout-secs`, `--template-id`, `--from-json`, and `--wecom-result` / `--wecom-bot-id` / `--wecom-peer-id` to send results to WeCom. Scheduled runs fire from the Desktop scheduler. The CLI writes the task record, and `trigger` asks the running Desktop to run it.

## Drive Desktop from the CLI

With the Desktop app running:

```bash
ccem desktop health --json
ccem desktop create --env kimi --perm dev --json      # Start a workspace session
ccem desktop sessions --cwd . --status running --json
ccem desktop status <runtimeId> --json
ccem desktop events <runtimeId> --since 0 --limit 50 --json
ccem desktop send <runtimeId> --text "now add tests"   # Send input, idempotent with --message-id
ccem desktop routes <runtimeId> --set Explore=glm      # Re-bind a routing key mid-session
ccem desktop open 'ccem://workspace/session?…'         # Focus a session in Desktop
```

## CLI Command Reference

<details>
<summary><b>All commands</b></summary>

| Command | Description |
|---|---|
| `ccem` | Interactive menu |
| `ccem ls` / `use <name>` / `add <name>` / `del <name>` | List, switch, add, delete environments |
| `ccem rename <a> <b>` / `cp <src> <dst>` | Rename / copy an environment |
| `ccem current` | Show active environment |
| `ccem env [--json]` | Print env vars |
| `ccem run <cmd>` | Run a command with env vars injected |
| `ccem load <url>` | Load encrypted remote config |
| `ccem yolo/dev/readonly/safe/ci/audit` | Launch Claude Code with a permission mode |
| `ccem --mode` / `--list-modes` | Current mode / all modes |
| `ccem setup perms --<mode>` / `--reset` | Write project permissions |
| `ccem setup default-mode --<mode>` | Set the default mode |
| `ccem setup init [--chrome]` | Initialize Claude Code (skip onboarding, disable telemetry; optionally add chrome-devtools MCP) |
| `ccem setup migrate [--clean] [--force]` | Migrate legacy config |
| `ccem setup cron` / `setup bot-bind` | Install the ccem-cron / ccem-bot-bind skills |
| `ccem usage [--json]` | Usage stats |
| `ccem skill add/ls/rm` | Skill management |
| `ccem dsh run/inspect/doctor` | DeepSeek Harness integration |
| `ccem sessions` / `attach [id]` | tmux-backed interactive sessions |
| `ccem bot-bind` | Bind the current session to a chat-bot target |
| `ccem cron create/list/delete/trigger/notification-targets` | Scheduled tasks |
| `ccem desktop health/create/sessions/status/events/send/routes/open` | Control a running Desktop app |

</details>

---

# Desktop App

A native app built on **Tauri 2** (a Rust backend and a React frontend, not an Electron wrapper) for **macOS** and **Windows**. Everything the CLI does, plus a full workspace for running agents.

## Workspace: Claude Code, Codex & OpenCode in One Place

> **🖼️ IMAGE PLACEHOLDER 3 — Workspace with composer & side panel** (replaces `screenshots/sessions.webp`)
>
> **Suggested file:** `screenshots/workspace.webp` · 2400×1500 · dark theme
>
> **Shows:** The Workspace page with a project list on the left and several sessions grouped under one project, with status dots for running, waiting for approval and done. In the center, an active Claude session's transcript with a hover menu on one turn showing **"Fork a session from this turn"**. The composer at the bottom has a `$skill` token, an `@src/auth.ts` file chip, a pasted image thumbnail, the **Claude / Codex / OpenCode** switcher, an environment chip, a permission chip and the **Effort** dropdown open (Minimal → Max). The side panel on the right is open on the **Browser** tab with a URL bar, back/forward/reload, and an amber **"Agent controlling"** pill with a **Pause Agent control** button.
>
> **Caption:** *Three agents, one composer, a browser the agent can drive.*

The Workspace isn't just a launcher. It's where you start, steer and review agent runs.

- **Three agents**: start a **Claude Code**, **Codex** or **OpenCode** session from the same composer. Claude and Codex run in the native GUI. OpenCode sessions open in OpenCode Web.
- **A detailed composer**: `$skill` tokens, `/slash` commands (scanned from your installed Claude Code commands and `.claude/commands/`), `@file` mentions, image and file drops, and model, provider and effort selectors.
- **Fork from any turn**: branch a new Claude session that keeps the full context up to that turn, leaving the original unchanged.
- **File checkpoints & rewind**: restore the working tree to any Claude file checkpoint from the transcript.
- **Built-in browser side panel**: an embedded browser with **isolated login profiles**, so your own Chrome data stays untouched. The agent can drive it. You can pause it, take over, and review its screenshots, console logs and an action audit trail.
- **Global search (<kbd>Cmd</kbd>+<kbd>K</kbd>)**: search every project and past conversation.
- **Hand off to a bot**: attach a running session to a paired chat bot. Hermes decides which updates are worth sending, and replies from chat continue the session.

## Per-Subagent Model Routing

> **🖼️ IMAGE PLACEHOLDER 4 — Model routing popover**
>
> **Suggested file:** `screenshots/routing.webp` · 1600×1000 · light theme, cropped to the composer area
>
> **Shows:** The **Dynamic routing** popover open above the composer. At the top, a **Route profile** selector showing "Budget chores". Below it, **Bindings by type**: *Main thread → KIMI*, *Explore → GLM*, *Background tasks → DeepSeek*, *Other agents → Follow default*. Under that, an **Allow agent self re-routing** toggle and an **Agent may reroute to** list with 3 envs checked. Footer buttons: **Apply changes** and **Save as my default**. Optionally, an inset of the session's usage panel with the **Sub-route usage (Router-observed)** breakdown.
>
> **Caption:** *Keep the main thread on your best model and send busywork to cheaper ones.*

Why pay top-model prices for `grep`? Turn on **Dynamic routing** for a Claude session and ccem runs it through a local routing proxy (bound to `127.0.0.1`) that splits the work across environments:

- Bind **subagent types** (for example `Explore`) and **background tasks** to different environments. The main thread follows the composer's environment.
- Save reusable **route profiles**, or generate them from templates: **Budget chores** (send Explore and the background model to a cheaper environment) or **Specialty split** (bind one subagent type to a specialist).
- Optionally let the agent **re-route itself** to an allow-listed environment.
- Change bindings mid-session. Changes apply from the next request.
- See which environment handled what in the session's **routed usage** breakdown.

Routing is opt-in for each session, and sessions that don't use it run direct.

## Sessions & Session Review

> **🖼️ IMAGE PLACEHOLDER 5 — Session Review drawer**
>
> **Suggested file:** `screenshots/session-review.webp` · 2400×1500 · dark theme
>
> **Shows:** The **Session Review** drawer open over a finished session. The header shows a **Task progress · 5/6** bar, the environment and the Git branch. The left column has sections **Changed files** (4 files with +/- counts), **Subagents** (two entries) and **Artifacts** (an HTML report and a PNG). The right pane shows the selected file's diff with green and red lines and an **Open in editor** button. A **Failed tools** chip shows one failure.
>
> **Caption:** *Know exactly what the agent did before you merge.*

- Grid or list view of every session, showing project, environment, permission mode, agent and where it was started (Desktop, CLI, chat bot or cron).
- **Session Review**: a todo progress snapshot, changed files from Git and the SDK with inline diffs, generated artifacts (HTML, images, reports), failed tool calls, and a trace of each subagent.
- **Interactive events** for tmux sessions: structured tool prompts, plan reviews and terminal approvals.
- Desktop notifications when a task completes or fails, or when a plan, question or permission prompt needs you.

## Remote Control: Chat Bots

> **🖼️ IMAGE PLACEHOLDER 6 — Chat Apps / Hermes bots** (replaces `screenshots/telegram.webp`)
>
> **Suggested file:** `screenshots/chat-bots.webp` · composite: desktop window on the left (60%), phone frame on the right (40%)
>
> **Shows:** *Left:* the **Chat Apps** page with the **Bots** panel showing the **Hermes chat component** with its version and **Your bots**: a **WeCom** bot ("Account paired · Access to 2 workspaces") and a **Feishu** bot. A collapsed **Other connection methods** row is visible below. *Right:* a phone showing a Feishu or WeCom chat in which the user asks "run the tests in ccem-web and fix failures", and the bot replies with a task card showing the session status, then a short summary of the result.
>
> **Caption:** *Your agents, reachable from the chat app you already use.*

Continue workspace tasks from your phone, using **any API key you've configured** rather than only an Anthropic subscription.

**Hermes bots (WeCom & Feishu).** Desktop installs and manages the **Hermes** chat component for you. Scan a QR code to create a bot (or connect an existing one), pair your chat account, then choose which workspaces each bot can reach. Bots can run in **CCEM sessions only** mode, which limits them to ccem session tools in authorized workspaces, or **Full Hermes** mode with web access, skills, memory, local files and commands. Pick the API environment Hermes uses for conversation, and have cron results sent to your chat.

**Other connection methods.** The original bridges are still available:

- **Telegram**: Forum Topics, with each topic bound to a project directory, environment and permission mode. One topic, one long-lived session.
- **WeChat (Weixin)**: private-chat bridge with QR login, a user allowlist, and `/approve` / `/deny` for permission prompts.
- **WeCom**: multi-bot bridge with admin/user separation, group chats and `@mention` triggering.

Remote control works best with tmux installed (resume and multi-terminal workflows).

## Cron: Scheduled Automation

> **🖼️ IMAGE PLACEHOLDER 7 — Cron Tasks page** (replaces `screenshots/cron.webp`)
>
> **Suggested file:** `screenshots/cron.webp` · 2400×1500 · light theme
>
> **Shows:** The **Cron Tasks** page. Left: a list of 4 tasks (for example "Nightly tests · `0 2 * * *`", "Weekday PR review · `0 9 * * 1-5`") with enable toggles and **next run** times. Right: the create/edit form with the **Quick Templates** row (PR Review, Test Runner, Doc Generation, Security Audit, Changelog), a natural-language **AI generate** input, the cron expression, the working directory, the **Execution Profile** segmented control (Conservative / Standard / Autonomous) with its description, and a **Budget Cap** field. Bottom: **Run history** with ✓/✗ status, duration and a **Retry** button on a failed run.
>
> **Caption:** *Set it once and wake up to finished work.*

- **Five-field cron** expressions on local time, with a preview of upcoming runs.
- **Quick templates**: PR Review, Test Runner, Doc Generation, Security Audit, Changelog.
- **AI generation**: describe the job in plain language and get a cron expression and prompt back.
- **Execution profiles**:
  - **Conservative**: read, search, edit and write only, with a lower budget and no shell or web.
  - **Standard**: adds Bash and web tools.
  - **Autonomous**: a higher budget and bypassed permissions, for trusted tasks only.
- A per-task **budget cap**, tool allow/deny lists and a timeout.
- **Run history** with status, duration and logs, plus one-click retry.
- **Result notifications** to Telegram, WeCom or Hermes bots.

Scheduled runs need the Desktop app running.

## Analytics: Claude + Codex + OpenCode

> **🖼️ IMAGE PLACEHOLDER 8 — Analytics & share poster** (replaces `screenshots/analytics.webp`)
>
> **Suggested file:** `screenshots/analytics.webp` · 2400×1500 · dark theme
>
> **Shows:** The **Analytics** page with a source switcher at the top (All / Claude / Codex / OpenCode) and stat cards for tokens, cost, **Streak** and week-over-week trend arrows. Below them, a GitHub-style **Activity Heatmap (Calendar)** and a stacked token/cost trend chart by model. Overlaid on the right, the **Share Poster** dialog showing a poster preview in the **Terminal** style with a "Gold Coder" rank badge, and style tabs Classic / Terminal / Data Ink.
>
> **Caption:** *Every token across every agent in one view, ready to share.*

- A daily activity heatmap, token and cost trends by model, and streaks and week-over-week trends.
- Switch between **All, Claude, Codex or OpenCode** in one click.
- **Share posters** in three styles (Classic, Terminal, Data Ink), with ranks from Bronze to Legendary Coder.

Costs come from the usage records ccem can read and known model prices. Where a price is missing, ccem shows the known cost and a count of unpriced tokens instead of guessing. Treat these figures as an estimate, not a provider bill.

## Desktop Cat & Tray Cockpit

> **🖼️ IMAGE PLACEHOLDER 9 — Desktop Cat + Tray Cockpit**
>
> **Suggested file:** `screenshots/cat-and-tray.webp` · 1800×1100 · macOS desktop with a plain wallpaper and no main window
>
> **Shows:** *Top right:* the menu-bar **Tray Cockpit** dropped down, showing Env and Perm chips, **Tokens Today** and **Cost Today**, a **Token Trend** chart with Hour/Day tabs, a **Model Type Split** bar, **Active Projects** with status dots, **Scheduled Tasks**, a health row (tmux ok · bridge online · cron ok · version) and launch buttons (Workspace, Sessions, Diagnostics). *Bottom right:* the always-on-top **Desktop Cat** with three stacked session bubbles beside it: two running sessions (spinner) and one with an unread "completed" badge.
>
> **Caption:** *Glance at the menu bar or the cat to see what your agents are doing.*

- **Desktop Cat** (Settings → Desktop Cat): an always-on-top companion with your running sessions and unread finished sessions stacked beside it. Click one to jump straight to it.
- **Tray Cockpit**: a menu-bar mini dashboard showing the current env and permission mode, today's tokens and cost, an hourly or daily trend, the split by model type, active projects, upcoming cron tasks, health checks (tmux, bridge, cron, version) and quick-launch buttons.

## Also in the Box

- **Conversation History**: one place to browse Claude, Codex, OpenCode and DeepSeek Harness conversations, grouped by project, with `/compact` boundaries respected and continue-from-history support.
- **Proxy Debug**: a live request list (method, URL, status, size) with a JSON and SSE-aware detail viewer, and separate upstream URLs for Claude and Codex.
- **Environments & Skills**: visual versions of the CLI features, with one-click presets, remote config sync and streaming skill search.
- **Auto-update**: background downloads on **stable** or **beta** channels, then restart when it's ready.
- **Settings**: light, dark or system theme. Chinese or English. Default permission mode and working directory. Terminal choice: Terminal.app, iTerm2 or Ghostty. Launch at login. Notifications. An AI-enhancement environment. Dependency checks for the ccem CLI, `claude`, `codex`, OpenCode and tmux.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Cmd</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Workspace, Sessions, Environments, Skills, History, Cron, Chat Apps, Analytics, Proxy Debug |
| <kbd>Cmd</kbd>+<kbd>Enter</kbd> / <kbd>Cmd</kbd>+<kbd>N</kbd> | Launch session |
| <kbd>Cmd</kbd>+<kbd>K</kbd> | Global search |
| <kbd>Cmd</kbd>+<kbd>,</kbd> | Settings |
| <kbd>Cmd</kbd>+<kbd>Q</kbd> | Quit |

---

## External Control: JSON-RPC, Deeplinks & CLI

While Desktop is running, it serves a **token-authenticated JSON-RPC endpoint on `127.0.0.1`**. Its address and token are written to a local control descriptor (`~/.ccem/control.json`; override with `CCEM_CONTROL_FILE`). Scripts, bots and other tools can start and steer sessions through it. The `ccem desktop …` and `ccem cron trigger` commands use the same endpoint.

<details>
<summary><b>All 20 methods</b></summary>

| Area | Methods |
|---|---|
| Health | `ccem.health` |
| Workspace sessions | `ccem.workspace.createSession`, `listSessions`, `getSession`, `getEvents`, `sendInput`, `openSession`, `restartDirect` |
| Session routing | `ccem.workspace.getRouter`, `ccem.workspace.updateRouter` |
| Router | `ccem.router.status`, `ccem.router.getSettings`, `ccem.router.updateSettings` |
| Remote | `ccem.remote.getEvents` |
| Cron | `ccem.cron.list`, `ccem.cron.trigger`, `ccem.cron.notificationTargets` |
| Environments | `ccem.environment.references`, `ccem.environment.rename`, `ccem.environment.delete` |

</details>

**Deeplinks.** `ccem://workspace/session?…` links open and focus a specific session in Desktop, from a chat message, a notification or `ccem desktop open`.

---

## How ccem Compares

| | ccem | Vanilla Claude Code |
|---|---|---|
| Multi-provider switching | 11 presets with tier mapping, CLI + GUI | Manual `export` |
| Permission presets | 6 modes | Built-in modes, configured manually |
| Agents | Claude Code, Codex, OpenCode (+ DeepSeek Harness via CLI) | Claude Code |
| Per-subagent model routing | Local routing proxy, profiles, templates | — |
| Remote control | Hermes WeCom/Feishu, Telegram, WeChat, WeCom | — |
| Scheduled automation | Cron with templates, profiles and budgets | — |
| Unified usage analytics | Claude + Codex + OpenCode | — |
| Session review, fork & rewind | Diffs, todos, artifacts, subagent traces | Partial (CLI rewind) |
| External API | 20-method JSON-RPC + `ccem://` deeplinks | — |
| Price | Free & open source | Free CLI |

---

## Data Storage

| Path | Contents |
|---|---|
| `~/.ccem/config.json` | Environments (API keys encrypted) and settings, shared by CLI and Desktop |
| `~/.ccem/cron-tasks.json` | Scheduled tasks |
| `~/.ccem/usage-cache.json` | Usage cache |
| `~/.ccem/model-prices.json` | Model price cache |
| `~/.ccem/control.json` | Local JSON-RPC endpoint descriptor (while Desktop runs) |
| `.claude/settings.json` | Project permission config |
| `~/.claude/skills/`, `.claude/skills/` | Installed skills |

---

## Tech Stack

```
apps/cli/          CLI: Commander + Inquirer + Ink (React for the terminal)
apps/desktop/      Desktop: Tauri 2 + Rust backend + React 18 frontend
packages/core/     Shared presets, types, encryption, routing (Node + browser builds)
server/            Remote config server (Express)
```

A pnpm workspaces monorepo. **Frontend**: Vite, Tailwind CSS, Zustand, shadcn/ui, Recharts, GSAP. **Backend**: Rust on Tauri 2, with macOS window vibrancy. **i18n**: Chinese and English.

Architecture notes for contributors: [Desktop Backend](docs/architecture/desktop-backend.md) · [Desktop Frontend](docs/architecture/desktop-frontend.md) · [Design System](docs/architecture/design-system.md)

---

## Contributing

Issues and PRs are welcome!

```bash
pnpm install
pnpm --filter @ccem/core build   # Build core first
pnpm run dev                     # Dev mode for all packages
pnpm verify                      # Full local CI gate
```

For Desktop, run `cd apps/desktop && pnpm tauri:dev`. See [CLAUDE.md](./CLAUDE.md) for the dev-instance rules.

## License

Apache License 2.0. See [LICENSE](./LICENSE) for the full text.
