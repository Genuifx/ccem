# File Size Exemptions

The file-size CI gate blocks new source files over 1000 lines unless they are documented here. Each exemption is existing technical debt that should be split incrementally rather than in a rushed CI fix.

- `apps/cli/src/index.ts`: Main CLI entrypoint still owns command registration and interactive flows.
- `apps/desktop/src-tauri/src/analytics.rs`: Analytics aggregation and reporting logic has not been split yet.
- `apps/desktop/src-tauri/src/browser.rs`: Managed Chromium browser lifecycle, session bootstrapping, and diagnostics remain centralized while the agent browser workbench is still iterating.
- `apps/desktop/src/pages/TrayCockpit.tsx`: Tray cockpit UI orchestration, diagnostics, and preview browser controls remain bundled while the tray surface is being iterated.
- `apps/desktop/src-tauri/src/config.rs`: Configuration migration, recovery, and runtime resolution still share one module.
- `apps/desktop/src-tauri/src/cron.rs`: Cron scheduling and execution orchestration is still a large legacy module.
- `apps/desktop/src-tauri/src/external_control.rs`: Desktop external-control server, descriptor publishing, security boundary checks, and unit coverage remain centralized during the control API hardening.
- `apps/desktop/src-tauri/src/history.rs`: History parsing and projection code is still coupled in one file.
- `apps/desktop/src-tauri/src/interactive_runtime.rs`: Interactive runtime capture, replay, and prompt monitoring remain centralized while terminal and native-session flows are still converging.
- `apps/desktop/src-tauri/src/main.rs`: Tauri command wiring and app bootstrap remain centralized in the entrypoint.
- `apps/desktop/src-tauri/src/native_runtime.rs`: Native SDK runtime lifecycle, event replay, and helper orchestration are still centralized.
- `apps/desktop/src-tauri/src/proxy_debug.rs`: Proxy debug parsing and reduction logic still lives in one module.
- `apps/desktop/src-tauri/src/runtime.rs`: Runtime management remains a large central orchestrator.
- `apps/desktop/src-tauri/src/skills.rs`: Skill discovery, metadata parsing, provider-specific projection, install, uninstall, and curated metadata handling remain bundled in one backend module.
- `apps/desktop/src-tauri/src/telegram/mod.rs`: Telegram bot integration is currently a large monolith and needs phased extraction.
- `apps/desktop/src-tauri/src/terminal.rs`: Terminal management and adapter logic is still bundled together.
- `apps/desktop/src-tauri/src/tmux.rs`: tmux launch, status parsing, and recovery helpers are still bundled together.
- `apps/desktop/src-tauri/src/wecom/mod.rs`: WeCom bot bridge integration is currently a large module and needs phased extraction.
- `apps/desktop/src-tauri/src/weixin/mod.rs`: Weixin bridge integration remains a large monolith and needs phased extraction.
- `apps/desktop/src/components/analytics/SharePosterDialog.tsx`: Share poster generation UI is still implemented in one large component.
- `apps/desktop/src/components/use-prompt-area.ts`: Vendored Prompt Area registry hook is kept intact while composer rich-input behavior is validated.
- `apps/desktop/src/components/workspace/WorkspaceReviewDrawer.tsx`: Workspace review drawer rendering remains concentrated while sub-agent execution details are being iterated.
- `apps/desktop/src/components/workspace/WorkspaceMessageBubble.tsx`: Workspace transcript rendering is still bundled with attachment, diff, and tool-call presentation during the workspace redesign.
- `apps/desktop/src/components/workspace/workspaceEventTranscript.ts`: Workspace event transcript projection remains concentrated while native/runtime event shapes are still being unified.
- `apps/desktop/src/components/workspace/ProjectTree.tsx`: Workspace project tree rendering and navigation state remain concentrated during the workspace redesign.
- `apps/desktop/src/components/workspace/WorkspaceSessionComposer.tsx`: Workspace composer state, image attachment handling, and model/provider controls remain concentrated during the workspace redesign.
- `apps/desktop/src/components/workspace/WorkspaceNativeSessionView.tsx`: Native workspace transcript, attention handling, and composer orchestration remain concentrated during the workspace redesign.
- `apps/desktop/src/pages/CronTasks.tsx`: Cron task list, run timeline, and editor orchestration are still centralized during the scheduler surface redesign.
- `apps/desktop/src/pages/Settings.tsx`: Desktop settings, agent skills, desktop control, and update controls remain centralized while those app surfaces are still being split.
- `apps/desktop/src/pages/Workspace.tsx`: Workspace navigation, history, compose, and live-session coordination remain centralized during the workspace redesign.
- `apps/desktop/src/hooks/useTauriCommands.ts`: Tauri IPC wrappers are still exposed from one large hook.
- `apps/desktop/src/lib/tauri-ipc.ts`: Frontend IPC payload types are still centralized while native session events and workspace commands continue to evolve together.
- `packages/native-runtime-helper/src/index.ts`: Bundled helper protocol, Claude SDK bridge, and Codex SDK bridge are still packaged as one sidecar entrypoint.
