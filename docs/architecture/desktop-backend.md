# Desktop Backend (Rust / Tauri)

Source: `apps/desktop/src-tauri/src/`

## Module Map

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `main.rs` | ~2600 | All `#[tauri::command]` handlers + app bootstrap, 90+ commands |
| `runtime.rs` | ~2400 | `HeadlessRuntimeManager` — `claude -p` subprocess with stream-json |
| `proxy_debug.rs` | ~2300 | Local HTTP proxy for API traffic recording |
| `agent_home.rs` / `agent_profile.rs` | — | CCEM-owned Claude/Codex state roots, one-time legacy snapshot, launch environment and independent login |
| `agent_plugins.rs` | — | Incremental import of official Claude plugins into the independent CCEM profile |
| `agent_plugin_links.rs` | — | Shared plugin code with independent CCEM installation records and runtime data |
| `history.rs` | ~1700 | Claude/Codex history projection from `~/.ccem/agents/{claude,codex}`, `/compact` segmentation |
| `terminal.rs` | ~1450 | Terminal detection (iTerm2/Terminal.app), launch/focus/close/arrange |
| `analytics.rs` | ~1400 | JSONL log parsing, incremental cache, LiteLLM pricing |
| `cron.rs` | ~1270 | Cron scheduler, task CRUD, run history, AI-generated task streaming |
| `tmux.rs` | ~950 | tmux session management (list/create/attach/kill) |
| `interactive_runtime.rs` | ~870 | `InteractiveRuntimeManager` — embedded terminal via tmux |
| `config.rs` | ~860 | Read/write `~/.ccem/config.json` + `~/.ccem/app-config.json` |
| `skills.rs` | ~820 | Streaming skill search, GitHub install/uninstall |
| `jsonl_watcher.rs` | ~760 | File watcher for live JSONL log updates |
| `session.rs` | ~520 | `SessionManager` — terminal-backed session persistence |
| `tray.rs` | ~470 | System tray with environment/permission quick-switch menus |
| `unified_runtime.rs` | — | `UnifiedSessionManager` — facade over headless + interactive |
| `unified_session.rs` | — | `UnifiedSessionInfo`, `RuntimeInput`, debug types |
| `event_bus.rs` | — | `ReplayBatch` — sequential event buffering for frontend polling |
| `event_dispatcher.rs` | — | `EventDispatcher` — fan-out events to Tauri frontend |
| `channel.rs` | — | `ChannelKind` — DesktopUI / Telegram / Weixin channel routing |
| `permission.rs` | — | Permission config read/write (shared format with CLI) |
| `crypto.rs` | — | AES-256-GCM `enc:v2` shared with the CLI; legacy AES-256-CBC is decrypt-only |
| `remote.rs` | — | Remote environment loading |
| `telegram/mod.rs` | — | Telegram Bot API bridge, forum topic binding |
| `telegram/channel.rs` | — | Telegram channel message routing |
| `weixin/mod.rs` | — | WeChat bridge, QR login |
| `weixin/channel.rs` | — | WeChat channel message routing |

## Claude plugin imports

Preparing the Claude profile imports newly observed plugin IDs from the official
`~/.claude` profile into `~/.ccem/agents/claude`. The CLI uses the matching importer
in `packages/core/src/agent-plugins.ts`. The two paths share the profile migration
lock and `.ccem-plugins-import-v1.json` ledger.

- Each plugin ID is observed once, across all initially installed scopes. Newly
  installed IDs are added automatically; CCEM disables and uninstalls stay local.
  Scope changes do not silently enable an existing plugin in another project.
- Import includes independent plugin files, required marketplace files and
  catalogue entries, registry paths, and missing plugin enablement settings.
  Existing CCEM entries win. Project/local installs retain their scope.
- The compatibility importer first preserves independent copies. The matching
  Rust/TypeScript link layer then adopts only unchanged imported copies. It keeps
  old paths for existing sessions and creates real CCEM version directories with
  direct code children symlinked to the official cache or local marketplace source.
  `.in_use`, `.orphaned_at`, and ownership markers stay local. Whole version/store
  symlinks are unsafe: the actual CLI writes bookkeeping into version roots.
- `.ccem-plugin-links-v1.json` records managed paths or a local-choice tombstone.
  Managed plugins follow official version/path changes; CCEM-owned updates or
  replaced code stop following. Local catalogue paths are rebased while catalogue
  files remain independent. Source paths escaping the store or exposing private
  data, official registry/catalogue files, or runtime markers are rejected.
  The launch environment pins `CLAUDE_CODE_PLUGIN_CACHE_DIR` and clears external
  seed/ZIP overrides.
- Official uninstall can retain cached files, so CCEM may keep using them until
  they are removed. Actual source edits/deletions affect shared code. This is file
  sharing, not synchronization of official enablement/uninstall state. Standard
  `CLAUDE_PLUGIN_DATA` remains private; arbitrary writes into shared code are shared.
- Credentials, plugin private data, other settings, and existing transcripts are
  not imported by this path. Metadata uses byte checks, atomic replacement, and
  first-write backups in `.ccem-plugins-backup-v1` and
  `.ccem-plugin-links-backup-v1`. A conflict defers the import
  without blocking an existing conversation; the next preparation can retry.
- Native Claude sessions check again before an idle prompt. Changed metadata or
  a shared-code file fingerprint (excluding runtime bookkeeping)
  refreshes SDK settings and plugins on the same query/session. Foreground or
  background work defers refresh until a later idle prompt. Terminal sessions
  get imports on their next launch; Claude's `/reload-plugins` can reload an
  already running terminal session after files have been imported.

Unchanged preparations perform no writes. Claude's cache lookup requires the
private registry version to match the wrapper directory name (including its
`.ccem-linked-<source hash>` suffix); the plugin's own manifest keeps its version.
Windows needs permission to create symlinks; failure preserves independent copies
and defers linking. Codex's optional isolation and project-local shared
instructions/files are unchanged.

## Managed State (Arc-wrapped in main)

- `SessionManager` — terminal sessions
- `InteractiveRuntimeManager` — embedded tmux sessions
- `HeadlessRuntimeManager` — headless `claude -p` sessions
- `EventDispatcher` — event fan-out
- `UnifiedSessionManager` — unified view of all session types
- `TelegramBridgeManager` — Telegram bot
- `WeixinBridgeManager` — WeChat bot
- `ProxyDebugManager` — API traffic proxy

## 3 Session Types

1. **Terminal-backed** (`session.rs`): spawns Claude Code in external terminal (iTerm2/Terminal.app)
2. **Interactive/tmux** (`interactive_runtime.rs`): embedded tmux session, full interactive Claude
3. **Headless** (`runtime.rs`): `claude -p --output-format stream-json`, no terminal UI

## Key IPC Commands

Environment CRUD: `get_environments`, `get_current_env`, `set_current_env`, `add_environment`, `update_environment`, `delete_environment`

App config: `get_app_config`, `add_favorite`, `remove_favorite`, `add_recent`, `save_settings`

Sessions: `launch_claude_code`, `list_sessions`, `stop_session`, `remove_session`, `focus_session`, `close_session`, `minimize_session`, `arrange_sessions`

Analytics: `get_usage_stats`, `get_usage_history`, `get_continuous_usage_days`

History: `get_conversation_history`, `get_conversation_messages`, `get_conversation_segments`

Skills: `search_skills_stream`, `list_installed_skills`, `install_skill`, `uninstall_skill`

Cron: `list_cron_tasks`, `add_cron_task`, `update_cron_task`, `delete_cron_task`, `toggle_cron_task`, `get_cron_task_runs`, `retry_cron_task`, `get_cron_run_detail`, `list_cron_templates`, `get_cron_next_runs`, `generate_cron_task_stream`

Terminal: `detect_terminals`, `get_preferred_terminal`, `set_preferred_terminal`

IDE: `sync_vscode_projects`, `sync_jetbrains_projects`, `open_directory_dialog`

## macOS Integration

- `titleBarStyle: "Overlay"` + `transparent: true` for custom title bar
- Traffic lights positioned at `(24, 20)` inset
- `NSVisualEffectMaterial::Sidebar` vibrancy via `window-vibrancy`
- `tauri-plugin-decorum` for window decoration
- `objc2`/`objc2-app-kit` for native clipboard
- `performance_mode = "reduced"` setting skips vibrancy, uses solid background

## Key Rust Dependencies

`tauri 2`, `serde/serde_json`, `chrono`, `reqwest`, `aes/cbc/scrypt`, `rand`, `base64`, `quick-xml`, `dirs`, `window-vibrancy`, `tauri-plugin-decorum`, `tauri-plugin-autostart`, `tauri-plugin-shell`, `tauri-plugin-mcp-bridge`
