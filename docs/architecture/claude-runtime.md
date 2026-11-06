# Claude Code runtime selection

Desktop stores the source preference under `~/.ccem/runtimes/claude/preference.json`.
The default `auto` selects a compatible system installation, then an already
installed recommended runtime. `system` and `managed` are strict selections.
Status queries never download. The user explicitly starts a download from agent
settings or the setup dialog shown after a rejected launch. Installation never
resends a message or retries login.

The embedded `apps/desktop/src-tauri/resources/claude-runtime-manifest.json` pins
the native packages shipped with the locked Claude Agent SDK. Compatibility
requires a stable version at least the manifest minimum, the same major version,
and the CLI options required for streaming sessions. Probes have deadlines and
perform no model requests. The floor deliberately follows the SDK's bundled
Claude version; it is a tested integration baseline rather than a claim that all
older versions are broken.

Downloads default to the official npm registry. Agent settings and the setup
dialog allow choosing npm, npmmirror, or a custom HTTPS npm-compatible registry.
This separate preference lives in `~/.ccem/runtimes/claude/registry.json`; it does
not modify npm configuration or change which runtime launches. Custom URLs may
include a registry path prefix, but not credentials, query strings or fragments.
Private registries requiring authentication are not supported.

Each installation captures its registry before downloading. Changing the source
is disabled during installation; after a failure or cancellation, users can
choose another registry and retry. There is no automatic fallback to a different
registry. HTTPS CDN redirects are bounded and validated before each request.
The package path, exact version, archive size and SHA-512 digest always come from
the embedded manifest, never from the selected registry. A mirror that changes
the package bytes is rejected. The installer extracts only the expected regular files,
preserves the upstream license, checks the original binary's size and SHA-256,
and checks version/capabilities before activation. macOS requirements are checked
separately from the Desktop application's minimum OS. Unsupported managed
platforms can still use a compatible system installation.

Version directories are immutable. Repair installs a fresh generation and
atomically updates `active.json`; existing directories remain available. Native
session records capture the executable path, and reconnection validates that
same path instead of consulting the current preference. Managed processes have
self-updates disabled. Login, native chat, auxiliary queries, terminal, tmux,
headless, skills and cron launches use the same selection policy. Profile
isolation and credentials remain separate from binary selection.

An application upgrade with a different recommended manifest currently rejects
a cold resume pinned to the previous managed version; it does not silently
change that session's executable. Historical manifest support is required before
supporting that cross-version continuation.

## Updating the recommendation

After deliberately upgrading and installing the locked SDK dependencies, run:

```sh
node apps/desktop/scripts/update-claude-runtime-manifest.mjs
node apps/desktop/scripts/update-claude-runtime-manifest.mjs --check
```

Review the exact package URLs, lockfile integrity, executable digests, OS floor
and SDK/Claude versions. Sidecar preparation rejects a manifest that has drifted
from the installed SDK or dependency lock. It also checks generated terminal
permission arguments against the core permission presets.

For isolated desktop self-tests only, debug builds accept absolute
`CCEM_CLAUDE_RUNTIME_ROOT` and a `CCEM_CLAUDE_SYSTEM_PATH` discovery override.
Release builds ignore both. These overrides do not change the download source
or disable integrity validation.

## Unattended task readiness

Cron checks project trust in the isolated Claude profile before launching a task.
It does not silently inherit trust from `~/.claude.json`. Existing tasks whose
isolated project is untrusted now fail with an actionable `CCEM_PREFLIGHT` error
instead of continuing after Claude ignores project permissions.

In the task editor, **Check runtime** inspects the selected working directory
(including `~/...`). **Trust this project** is an explicit, initially unselected
choice. Recovery updates only that project entry; it does not copy official
credentials or unrelated settings. Selected personal skills can be imported from
`~/.claude/skills`, or materialized from existing isolated-profile links. Imports
are independent copies, preserve references/scripts, and never overwrite an
existing real skill directory. Nested links are rejected. Backups are retained
under `~/.ccem/agents/claude/.profile-repair-backups/`. Source updates are not
synchronized automatically. Avoid editing Claude configuration concurrently with
recovery; changed configuration detected during repair is rejected.

Tasks can optionally declare `requiredSkills` (CLI create: `--required-skills`,
comma-separated; JSON: string array). Use the skill's command name, including its
plugin prefix when applicable. If dependencies are declared or personal skill
links exist, cron initializes the selected Claude runtime with the same cwd and
environment and checks its discovered commands. This probe sends no user/model
request and disables hooks. Working links remain supported; unrelated linked
skills are not treated as required dependencies. Prompt text is not parsed to
infer requirements, so existing tasks should declare any skills they depend on.

Profile access is bounded to 30 seconds and Claude discovery to 15 seconds, both
within the task's total timeout. A failed/timed-out preflight does not start the
actual task. Availability checks cannot prove the business result of a prompt;
the existing run status still reflects the process exit code.

Focused verification:

```sh
node --test apps/desktop/src-tauri/resources/claude-profile-repair.test.cjs
# from apps/desktop/src-tauri
cargo test --locked cron:: -- --test-threads=1
# from apps/cli
pnpm exec vitest run src/__tests__/cron.test.ts
```
