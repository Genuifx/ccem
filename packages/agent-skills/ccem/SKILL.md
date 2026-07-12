---
name: ccem
description: Use when the user asks an agent to operate CCEM or CCEM Desktop, including creating workspace sessions, opening or inspecting ccem:// session links, monitoring task progress, scheduling CCEM cron work, or using bot binding flows. Prefer structured `ccem ... --json` commands.
---

# CCEM

Use CCEM as the local control plane for Codex, Claude Code, and related desktop workflows. Prefer the `ccem` CLI JSON wrappers over direct files or ad hoc HTTP calls.

## Desktop Session Control

Start every desktop-control workflow by checking the live desktop bridge:

```bash
ccem desktop health --json
```

If `ccem desktop health` reports a stale descriptor, use the CLI message as
the source of truth and do not inspect `~/.ccem/control.json` yourself. A
dead-pid descriptor at the default path is removed automatically; restart CCEM
Desktop and rerun the command. If the message says the endpoint refused the
connection or timed out while the publishing process is still running, restart
CCEM Desktop so it republishes a fresh endpoint.

### Development builds and the control descriptor

`pnpm tauri dev` (and other debug builds) does **not** publish the global
`~/.ccem/control.json` descriptor by default, so `ccem desktop health` from
another terminal will keep using the last release app's descriptor. Run the
dev build with the opt-in flag when you need the CLI/skill to talk to it:

```bash
CCEM_DESKTOP_PUBLISH_CONTROL_DESCRIPTOR=1 pnpm tauri dev
```

Release builds always publish the descriptor. Do not edit or read
`~/.ccem/control.json` directly — let the CLI wrapper negotiate the
descriptor for you.

If it is healthy, create sessions through the desktop CLI wrapper:

```bash
ccem desktop create --provider codex --cwd /absolute/project/path --prompt "Task to run" --perm dev --effort low --open true --json
```

Use absolute working directories. Preserve the returned `runtimeId`, `sessionId`, and `ccem://` link when reporting progress or sending follow-up input.

Common follow-up commands:

```bash
ccem desktop sessions --json
ccem desktop status <runtimeId> --json
ccem desktop events <runtimeId> --json
ccem desktop send <runtimeId> --text "Follow-up instruction" --json
ccem desktop open <ccem://session-link> --json
```

When the user gives a `ccem://` link, use the desktop CLI wrapper to open or inspect it. Do not try to parse provider history directories yourself unless the wrapper reports that the desktop bridge is unavailable.

## Cron And Scheduled Work

Use the installed `ccem cron` contract and structured output for scheduled work:

```bash
ccem cron --help
ccem cron list --json
```

The current agent-facing CLI supports `list`, `create`, and `delete`. It does not expose an `update`, `edit`, or `runs` command.

Read task IDs and complete task configuration from the array returned by `ccem cron list --json`. Resolve an exact task ID before changing an existing task.

For creation, run `ccem cron create --help`, resolve natural-language schedules to explicit five-field cron expressions, and use the supported options or JSON input:

```bash
ccem cron create --from-json @task.json --json
```

For deletion, confirm the exact task and use its ID:

```bash
ccem cron delete "<taskId>" --json
```

For an update request, first read the task with `ccem cron list --json`. If desktop UI control is available, use CCEM Desktop's Cron page to edit the exact task in place, then read the task list again to verify the stored result. Otherwise explain the CLI limitation and ask whether the user wants to update it in Desktop or replace it. Replacement creates a new task ID and does not preserve the old task's run-history association.

After every create, edit, replacement, or delete, rerun `ccem cron list --json` and report the actual stored task state.

## Bot Binding

For Telegram, WeCom, Weixin, or other bot-bound sessions, use the `ccem bot-bind` CLI flow when available. Do not invent peer IDs or binding IDs. Query existing bindings first, then act on the exact IDs returned by CCEM.

## Safety Rules

- Do not read or write ~/.ccem/control.json directly.
- Do not call CCEM's loopback HTTP port yourself.
- Do not embed, log, or copy desktop control tokens.
- Do not edit CCEM config, cron, or session stores by hand unless the user explicitly asks for recovery work and the CLI path cannot do it.
- Ask before destructive session actions when the target session is ambiguous.

## Response Shape

When you start work through CCEM, report:

- The provider and absolute working directory.
- The returned runtime or session ID.
- The current status command you will use for follow-up.
- The `ccem://` link when CCEM returns one.
