# Desktop Backend (Rust / Tauri)

Source: `apps/desktop/src-tauri/src/`

## Module Map

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `main.rs` | ~2600 | All `#[tauri::command]` handlers + app bootstrap, 90+ commands |
| `runtime.rs` | ~2400 | `HeadlessRuntimeManager` — `claude -p` subprocess with stream-json |
| `proxy_debug.rs` | ~2300 | Local HTTP proxy for API traffic recording |
| `history.rs` | ~1700 | Claude/Codex history projection from `~/.claude/*` and `~/.codex/{sessions,session_index,state_*.sqlite}`, `/compact` segmentation |
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
