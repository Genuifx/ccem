# File Size Exemptions

The file-size CI gate blocks new source files over 2000 lines unless they are documented here. Each exemption is existing technical debt that should be split incrementally rather than in a rushed CI fix.

- `apps/desktop/src-tauri/src/analytics.rs`: Analytics aggregation and reporting logic has not been split yet.
- `apps/desktop/test/browser-panel-lifecycle.test.mjs`: Existing browser panel lifecycle regression coverage keeps the full attach/detach event matrix in one test module.
- `apps/desktop/src-tauri/src/browser/login/cef/debug_smoke/runtime.rs`: The isolated Mock Keychain Mode 2 debug host keeps its multi-instance production-runtime scenario in one auditable harness while that gate is stabilized.
- `apps/desktop/src-tauri/src/config.rs`: Configuration migration, recovery, and runtime resolution still share one module.
- `apps/desktop/src-tauri/src/cron.rs`: Cron scheduling and execution orchestration is still a large legacy module.
- `apps/desktop/src-tauri/src/external_control.rs`: Desktop external-control server, descriptor publishing, security boundary checks, and unit coverage remain centralized during the control API hardening.
- `apps/desktop/src-tauri/src/history.rs`: History parsing and projection code is still coupled in one file.
- `apps/desktop/src-tauri/src/lib.rs`: Tauri command wiring and app bootstrap were mechanically moved from the former large binary entrypoint so Windows can expose the official CEF bootstrap client DLL; split this legacy orchestration incrementally after the bootstrap migration lands.
- `apps/desktop/src-tauri/src/native_event_log.rs`: Native event log persistence and attention-summary writes remain bundled while the native event pipeline is still converging.
- `apps/desktop/src-tauri/src/native_runtime.rs`: Native SDK runtime lifecycle, event replay, and helper orchestration are still centralized.
- `apps/desktop/src-tauri/src/proxy_debug.rs`: Proxy debug parsing and reduction logic still lives in one module.
- `apps/desktop/src-tauri/src/runtime.rs`: Runtime management remains a large central orchestrator.
- `apps/desktop/src-tauri/src/skills.rs`: Skill discovery, metadata parsing, provider-specific projection, install, uninstall, and curated metadata handling remain bundled in one backend module.
- `apps/desktop/src-tauri/src/telegram/mod.rs`: Telegram bot integration is currently a large monolith and needs phased extraction.
- `apps/desktop/src-tauri/src/terminal.rs`: Terminal management and adapter logic is still bundled together.
- `apps/desktop/src-tauri/src/tmux.rs`: tmux launch, status parsing, and recovery helpers are still bundled together.
- `apps/desktop/src-tauri/src/wecom/mod.rs`: WeCom bot bridge integration is currently a large module and needs phased extraction.
- `apps/desktop/src-tauri/src/weixin/mod.rs`: Weixin bridge integration remains a large monolith and needs phased extraction.
- `apps/desktop/src-tauri/resources/native-runtime-helper.mjs`: Generated bundled sidecar resource mirrors the native-runtime-helper build output and is not maintained as hand-written source.
- `apps/desktop/src-tauri/resources/dsh-history/lib/dsh-history-helper.mjs`: Generated DSH history sidecar resource mirrors the bundled helper build output and is not maintained as hand-written source.
- `apps/desktop/src/components/workspace/WorkspaceMessageBubble.tsx`: Workspace transcript rendering is still bundled with attachment, diff, and tool-call presentation during the workspace redesign.
- `apps/desktop/src/components/workspace/WorkspaceNativeSessionView.tsx`: Native workspace transcript, attention handling, and composer orchestration remain concentrated during the workspace redesign.
- `apps/desktop/src/pages/Workspace.tsx`: Workspace navigation, history, compose, and live-session coordination remain centralized during the workspace redesign.
- `packages/native-runtime-helper/src/index.ts`: Bundled helper protocol, Claude SDK bridge, and Codex SDK bridge are still packaged as one sidecar entrypoint.
- `packages/native-runtime-helper/test/claude-session-restart.test.mjs`: Existing restart and recovery integration scenarios share a large stateful fixture suite.
