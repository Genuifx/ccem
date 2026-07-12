# ccem

## 2.53.0

### Minor Changes

- Release v2.53.0: environment copy/enablement feature, provider history hardening, and file-size exemption updates.

## 2.52.1

### Patch Changes

- Align Desktop release versions and validate them before publishing updater manifests.

## 2.50.0

### Minor Changes

- Dialog enter animations, cron page motion jitter fix, workspace env capsule alignment, media preview in workspace review, and browser tools CSP fix.

## 2.49.0

### Minor Changes

- Release v2.49.0 — fix desktop browser URL panic

## 2.47.0

### Minor Changes

- ### Desktop UI fixes

  - Auto-scroll thinking panels during streaming in the workspace transcript view.
  - Hide env text below 880px width to keep the header readable on small screens.
  - Optimize status strip layout for narrow viewports.
  - Align the restore-point dialog with the glass design system.

## 2.46.0

### Minor Changes

- Stabilize ProjectTree session ordering and decoration polling performance.

## 2.45.0

### Minor Changes

- Release v2.45.0

  - feat(desktop): add tray analytics controls
  - fix(desktop): reduce workspace composer typing work
  - fix(desktop): make tray cockpit panel opaque
  - docs: rewrite README with landing-page structure and feature documentation

## 2.44.0

### Minor Changes

- Add tray cockpit UI with GSAP motion, anchor to status item, surface pending permission approvals, and polish tray cockpit status surface.

## 2.43.0

### Minor Changes

- Restore project-backed Workspace history sessions and titles after sidebar performance optimization.

## 2.42.0

### Minor Changes

- Aggregate release shipping GSAP-driven motion prototypes and stabilizing WeCom bot binding progress streaming.

  - **feat(desktop):** add GSAP motion prototypes
  - **fix(desktop):** stabilize WeCom binding progress stream

## 2.41.0

### Minor Changes

- Stabilize live workspace transcript rendering by keeping streaming message and tool rows eagerly painted, preventing browser estimated-height corrections from making active sessions flicker or jump.

## 2.40.1

### Patch Changes

- Improve WeCom bot binding output relay and route handling.

## 2.40.0

### Minor Changes

- Aggregate release covering desktop stability and diagnostics work since v2.39.1:

  - **feat(desktop):** add Doctor perf smoke diagnostics
  - **fix(desktop):** prevent concurrent app instances
  - **fix(desktop):** stabilize tmux session target healthcheck
  - **chore(desktop):** satisfy rust clippy gate, add session launch diagnostics
  - **docs(desktop):** add external control research

## 2.39.1

### Patch Changes

- Fix desktop Sessions page new session launch so the top-level New Session button always starts the Claude runtime instead of inheriting an unrelated workspace client selection.

## 2.39.0

### Minor Changes

- Workspace performance and native handoff stabilization: squeezed workspace hot paths, stabilized native workspace handoff, and hardened project tree refresh.

## 2.38.0

### Minor Changes

- Bug fixes since v2.37.0: i18n relative time strings, workspace composer input persistence, external terminal working_dir quoting, workspace terminal permission handoff, and composer editor clear-after-send.

## 2.37.0

### Minor Changes

- Minor release v2.37.0 — checkpoint restore UI, security hardening, and session history improvements.

  - feat(desktop): add Claude file checkpoint restore UI
  - fix(desktop): harden checkpoint restore flow
  - fix(desktop): load workspace history from native events
  - fix(desktop): stabilize composer trailing newline caret
  - fix(desktop): encrypt weixin bot token storage
  - fix(desktop): redact telegram transport tokens
  - fix(desktop): hide opencode config from terminal command
  - fix(desktop): avoid remote load credential argv
  - fix(desktop): harden opencode secret env file creation
  - fix(desktop): cfg-gate opencode secret env file helpers
  - fix(desktop): reject invalid cron expressions

## 2.36.0

### Minor Changes

- Minor release with workspace usage stats refresh on streak capsule click, session count relocation, dark mode visual polish, and native claude runtime retention while idle.

## 2.34.0

### Minor Changes

- v2.34.0 release

  Highlights since v2.33.0:

  - fix(desktop): harden session persistence with atomic save and cleanup

## 2.33.0

### Minor Changes

- v2.33.0 release

  Highlights since v2.32.0:

  - fix(core): fail closed on malformed v2 ciphertext
  - fix(desktop): fail closed on install key IO errors
  - fix(server): make trust proxy explicit for remote config

## 2.32.0

### Minor Changes

- v2.32.0 release

  Highlights since v2.31.0:

  - feat(workspace): hide project session count by default, reveal on hover
  - feat(desktop): craft workspace sidebar buttons
  - fix(desktop): wire About buttons to Tauri shell open
  - fix(server): include remote config in workspace gates
  - fix(server): harden remote config auth
  - fix(desktop): fail closed on local decrypt errors
  - fix(desktop): preserve runtime permission on native handoff
  - refactor(desktop): split sessions page actions

## 2.31.0

### Minor Changes

- Minor release bundling desktop session-launch fixes, CLI skill hardening, and proxy performance work since v2.30.0.

  - fix(desktop): pass tmux environment into session launches
  - fix(desktop): surface duplicate session launches
  - fix(desktop): bound external control socket reads
  - perf(desktop): page proxy debug traffic from index
  - fix(cli): constrain skill removal paths
  - fix(cli): harden skill install commands
  - chore(ci): gate high production advisories

## 2.30.0

### Minor Changes

- External control hardening, authenticated remote envelope, and proxy debug redaction.

  - **external-control**: validate cwd and permission_mode schema; harden CLI/HTTP boundaries; document dev-build descriptor opt-in (`CCEM_DESKTOP_PUBLISH_CONTROL_DESCRIPTOR=1`)
  - **remote**: add authenticated v2 encryption envelope; fail closed on malformed v2 envelope
  - **proxy-debug**: redact sensitive data at all egress points (response body spool, prompt preview, truncated/incomplete responses, error temp files)
  - **workspace**: confine review file opens to project dir; gate unix-only symlink tests for Windows CI
  - **server**: remove tracked remote credentials

## 2.29.0

### Minor Changes

- Minor release with desktop diagnostics and performance improvements:

  - feat(desktop): add perf log capture + export in Settings
  - feat(desktop): add doctor diagnostics export
  - fix(desktop): restore session row context menu behavior
  - chore(desktop): address review (typo, refresh interval, fallback)

## 2.27.0

### Minor Changes

- Minor release v2.27.0 — desktop UX hardening, wecom cron delivery, and token crypto upgrade.

  - feat(crypto): upgrade token encryption to install-bound AES-256-GCM
  - feat(workspace): add collapse button next to Load More in project tree
  - feat(desktop): add cron wecom notification controls
  - feat(desktop): send cron results to wecom
  - fix(desktop): stabilize external actions hover menu and popover flicker
  - fix(desktop): prevent leaked Tauri listeners on fast unmount
  - fix(desktop): relay bound sessions to wecom
  - fix(desktop): stabilize composer image previews
  - fix(remote): separate access key from encryption secret
  - fix(runtime): clean up Codex image temp files after turn end
  - fix(runtime): respect network permission in Codex sandbox policy
  - style(desktop): apply rustfmt to tauri sources

## 2.26.0

### Minor Changes

- Desktop workspace v2.26.0: WeCom task and session bot binding with streamlined external actions, workspace model guidance queue, clickable transcript markdown image lightbox, selected-skill composer attachment fix, macOS traffic light alignment with tightened titlebar fold, narrow-window status strip adaptation, and Windows helper PATH preservation.

## 2.25.0

### Minor Changes

- Desktop workspace UX overhaul: command-palette search, drag-to-reorder pinned sessions, transcript image thumbnails with lightbox, media file preview in workspace review drawer, and a fix to ensure all pinned sessions render without inner scroll.

## 2.24.0

### Minor Changes

- Release v2.24.0: workspace composer image preview, Cmd+K global search, workspace hover actions, skill scanning hardening, and cron session environment fix.

## 2.21.0

### Minor Changes

- Release v2.21.0: add structured cron task commands to the CLI, ship workspace transcript message polish (copy button, timestamp, meta hover), stabilize macOS traffic light positioning, set the workspace font baseline to 14px, and harden the sessions page lifecycle (small-screen fit, launch button state, interactive session cleanup, tmux terminal handoff).

## 2.20.0

### Minor Changes

- - feat(desktop): add collapsed workspace shortcut
  - fix(desktop): detect codex app bundle cli
  - fix(cli): normalize Claude allow tool rules and allowed tools wildcard compatibility

## 2.19.0

### Minor Changes

- Release v2.19.0: subagent personas in review drawer, workspace prompt image rendering, macOS traffic lights alignment fix, workspace cron command fixes.

## 2.18.0

### Minor Changes

- Add workspace cron slash command support and stabilize Codex SDK sessions.

## 2.17.0

### Minor Changes

- Release desktop updates for sub-agent review output, workspace handoff behavior, and WeCom panel flow improvements.

## 2.16.0

### Minor Changes

- Release Windows desktop support, including Windows CI coverage and installer packaging.

## 2.15.0

### Minor Changes

- Stabilize native Claude prompt handoff after ready-state restarts so desktop messages are not dropped while a session is thinking.

## 2.14.0

### Minor Changes

- Release workspace runtime interruption, session history cleanup, and desktop workflow fixes.

## 2.13.0

### Minor Changes

- Add the live session review drawer, workspace audit evidence, and WeCom bot bridge updates.

## 2.12.0

### Minor Changes

- Add the desktop pet companion with session notifications and production hardening.

## 2.11.0

### Minor Changes

- Add a global desktop update status control so update progress is surfaced consistently.

## 2.10.0

### Minor Changes

- Release desktop workspace and analytics improvements, including generated session titles, runtime error visibility, IME submit handling, titlebar alignment, and refined usage summaries.

## 2.9.0

### Minor Changes

- Stabilize native desktop session continuation after completed Claude turns and recover reclaimed native sessions for resume.

## 2.8.1

### Patch Changes

- Recover native session continuation after the runtime helper exits.

## 2.8.0

### Minor Changes

- Enable npm trusted publishing for CLI releases.

## 2.7.0

### Minor Changes

- Align Claude Plan mode tool gating with Claude Agent SDK behavior.

## 2.6.0

### Minor Changes

- Ship desktop workspace polish for native zoom shortcuts, session stability, and project tree session annotations.

## 2.5.0

### Minor Changes

- Refine the desktop glass redesign with responsive analytics summary, compact usage heatmap, and titlebar-aligned session controls.

## 2.4.0

### Minor Changes

- Show live context window usage in desktop workspace sessions.

## 2.3.1

### Patch Changes

- fix(desktop): soften workspace code theme

## 2.3.0

### Minor Changes

- Add fresh session notification dot and fix IME composing check

## 2.2.0

### Minor Changes

- Add workspace skills support and Escape key to abort running sessions

## 2.1.2

### Patch Changes

- a0c42cf: Allow the desktop workspace Terminal action to launch a new session from an empty composer, and avoid passing `ANTHROPIC_API_KEY` when a managed `ANTHROPIC_AUTH_TOKEN` is present.

## 2.1.1

### Patch Changes

- 361776b: Check desktop updates from the signed updater manifest instead of the GitHub Releases API.

## 2.1.0

### Minor Changes

- Ship desktop workspace runtime stability improvements, including Claude plan review controls, non-interactive key handling, safer terminal attach validation, and cold-start workspace session refresh fixes.

## 2.0.0

### Patch Changes

- b8bf1ca: prepare build for next generation
- ea9fc00: Run CI and release workflows on Node 22 for pnpm compatibility.
- ec6e06b: Fix Desktop tmux detection for macOS GUI launches that do not inherit the user's shell PATH.
- f910708: Improve workspace history, session title handling, and desktop dashboard polish.
- 2da23d7: Add a cold-start splash screen and settle native interactive prompt replies.
- b56be3e: Ship the GitHub release backed desktop updater in the next beta.
- f740ecb: Use an Intel macOS runner for desktop x64 release builds.
- 17d40c2: Fix desktop release notes generation in GitHub Actions.
- 75dd7fc: Ship the redesigned workspace native sessions, live tool call rendering fixes, and supporting desktop workflow polish in the next beta release.
- 096b967: Prefer the newest installed Claude CLI when launching desktop native workspace sessions.
- 8386b41: Trigger the next beta release for the latest CLI and Desktop changes.
- dcd99b3: Ship the workspace/history view split and the new minimal workspace transcript in the next beta release.
- ad30d8a: Prepare next beta release for ccem.
- 6597b73: Persist interactive prompt replies and keep workspace transcript order stable.
- c37d7cd: Improve desktop glass rendering stability and overall UI responsiveness on macOS.
- 7824155: Stabilize live workspace transcript ordering, streaming thinking reduction, image prompts, and process duration display.
- 323e4fd: Ship the next beta with OpenCode desktop integration and the latest desktop runtime improvements.
- c0702d8: Fix production desktop native session creation by resolving the packaged native runtime helper resource path.
- 6f6a50e: Fix production desktop native workspace chat handling when helper output arrives as JSONL chunks or reports startup errors.
- fd4d862: Fix production desktop native Claude sessions by passing the user's shell PATH to the native runtime helper.
- 26edd77: Improve desktop performance, reduce unnecessary re-renders, and remove the window blur fallback on focus changes.
- 9dc7194: Publish a clean beta release after fixing the GLM preset test expectation.
- 24ced8a: Update GitHub Actions pnpm setup runtime for Node 24 compatibility.
- 65e42f8: Release the desktop AskUserQuestion parity work, including multi-select answers, inline custom feedback, and structured prompt submission.
- 3c15af8: Add Wechat support though official channel.
- ecd8156: Release the sidebar collapse, window control spacing, and titlebar toggle polish in the next beta.
- 3450b0c: Release the workspace session icon upgrade, loading indicators, provenance tracking, and fullscreen window chrome fixes in the next beta.
- 5a8ab6e: Stabilize native workspace session terminal handling and clean up orphaned CCEM tmux sessions on startup.
- 22a3a4e: Release the workspace scroll, fullscreen chrome alignment, and compose header polish in the next beta.
- d885099: Stabilize workspace transcript rendering and native session replay.

## 2.0.0-beta.35

### Patch Changes

- Release the workspace scroll, fullscreen chrome alignment, and compose header polish in the next beta.

## 2.0.0-beta.34

### Patch Changes

- Ship the GitHub release backed desktop updater in the next beta.

## 2.0.0-beta.33

### Patch Changes

- Add a cold-start splash screen and settle native interactive prompt replies.

## 2.0.0-beta.32

### Patch Changes

- Persist interactive prompt replies and keep workspace transcript order stable.

## 2.0.0-beta.31

### Patch Changes

- Stabilize workspace transcript rendering and native session replay.

## 2.0.0-beta.30

### Patch Changes

- Stabilize live workspace transcript ordering, streaming thinking reduction, image prompts, and process duration display.

## 2.0.0-beta.29

### Patch Changes

- Run CI and release workflows on Node 22 for pnpm compatibility.

## 2.0.0-beta.28

### Patch Changes

- Update GitHub Actions pnpm setup runtime for Node 24 compatibility.

## 2.0.0-beta.26

### Patch Changes

- Stabilize native workspace session terminal handling and clean up orphaned CCEM tmux sessions on startup.

## 2.0.0-beta.25

### Patch Changes

- Fix production desktop native Claude sessions by passing the user's shell PATH to the native runtime helper.

## 2.0.0-beta.24

### Patch Changes

- Fix production desktop native workspace chat handling when helper output arrives as JSONL chunks or reports startup errors.

## 2.0.0-beta.23

### Patch Changes

- Use an Intel macOS runner for desktop x64 release builds.

## 2.0.0-beta.22

### Patch Changes

- Prefer the newest installed Claude CLI when launching desktop native workspace sessions.

## 2.0.0-beta.21

### Patch Changes

- Fix production desktop native session creation by resolving the packaged native runtime helper resource path.

## 2.0.0-beta.20

### Patch Changes

- Release the desktop AskUserQuestion parity work, including multi-select answers, inline custom feedback, and structured prompt submission.

## 2.0.0-beta.19

### Patch Changes

- Ship the redesigned workspace native sessions, live tool call rendering fixes, and supporting desktop workflow polish in the next beta release.

## 2.0.0-beta.18

### Patch Changes

- Release the workspace session icon upgrade, loading indicators, provenance tracking, and fullscreen window chrome fixes in the next beta.

## 2.0.0-beta.17

### Patch Changes

- Ship the workspace/history view split and the new minimal workspace transcript in the next beta release.

## 2.0.0-beta.16

### Patch Changes

- Release the sidebar collapse, window control spacing, and titlebar toggle polish in the next beta.

## 2.0.0-beta.15

### Patch Changes

- Ship the next beta with OpenCode desktop integration and the latest desktop runtime improvements.

## 2.0.0-beta.14

### Patch Changes

- Release the desktop analytics parsing, dev startup, and build verification fixes.

## 2.0.0-beta.13

### Patch Changes

- Publish a clean beta release after fixing the GLM preset test expectation.

## 2.0.0-beta.12

### Patch Changes

- Trigger the next beta release for the latest CLI and Desktop changes.

## 2.0.0-beta.11

### Patch Changes

- Fix desktop release notes generation in GitHub Actions.

## 2.0.0-beta.10

### Patch Changes

- Improve workspace history, session title handling, and desktop dashboard polish.

## 2.0.0-beta.9

### Patch Changes

- Improve desktop glass rendering stability and overall UI responsiveness on macOS.

## 2.0.0-beta.8

### Patch Changes

- Add Wechat support though official channel.

## 2.0.0-beta.7

### Patch Changes

- Fix Desktop tmux detection for macOS GUI launches that do not inherit the user's shell PATH.

## 2.0.0-beta.6

### Patch Changes

- Improve desktop performance, reduce unnecessary re-renders, and remove the window blur fallback on focus changes.

## 2.0.0-beta.5

### Patch Changes

- prepare build for next generation

## 2.0.0-beta.4

### Patch Changes

- Prepare next beta release for ccem.
