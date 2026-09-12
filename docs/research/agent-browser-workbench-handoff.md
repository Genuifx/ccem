# CCEM Agent Browser Workbench Handoff

Date: 2026-07-09
Status: Product and architecture handoff
Owner surface: CCEM Desktop browser, external-control/MCP browser tools, future agent browser workbench

## Executive Decision

CCEM should not position this work as "building a browser". The product should be framed as an agent workbench for verifiable, auditable web work.

The near-term architecture should split browser responsibilities by trust level:

- Mode 1, Preview Browser: use the existing Tauri/system WebView path. This serves localhost, public pages, unauthenticated previews, screenshots, interaction snapshots, and console diagnostics.
- Mode 2, Secure Login Browser: plan a managed Chromium runtime, preferably sidecar Chrome for Testing or equivalent managed Chromium, for logged-in website workflows. This should use CCEM-owned profiles, not the user's Chrome profile.
- Mode 3, Real Chrome Takeover: keep out of CCEM's built-in short-term scope. Advanced users can connect Playwright, CDP, or Chrome-control MCPs themselves.

The short phrase to keep the team aligned:

> Tauri is the app shell. System WebView is the preview engine. Managed Chromium is the logged-in work engine.

## Non-Negotiable Product Boundaries

Do:

- Provide a visible browser surface for agent work.
- Persist Mode 2 login state in CCEM-owned, workspace-scoped profiles.
- Return stable artifact paths for screenshots, snapshots, console logs, and network logs.
- Treat page content as untrusted input.
- Keep all agent-facing browser tools behind CCEM policy, audit, and permission layers.
- Make browser runtime readiness visible before the user needs it.

Do not:

- Read or reuse the user's Chrome profile, cookies, history, extensions, saved passwords, or existing tabs.
- Bundle `browser-use` as the built-in path.
- Expose raw CDP, raw cookies, or arbitrary browser internals directly to agents.
- Fork Chromium or become a browser vendor.
- Depend on users waiting for a large runtime download at the moment they click "Login Browser".

## Why WebView Alone Is Not Enough

System WebView is a good fit for Mode 1 because it is already present, starts quickly, integrates naturally with Tauri, and keeps the CCEM package small.

System WebView is not a strong fit for Mode 2 because logged-in agent workflows need capabilities that are weak, inconsistent, or unavailable across WKWebView, WebView2, and WebKitGTK:

- Reliable trusted input. JS-synthesized events can produce `isTrusted=false` and fail on some sites.
- Full browser accessibility tree for robust element targeting.
- First-class network instrumentation without page-level monkey patching.
- Stable profile semantics across platforms.
- Better odds with OAuth, 2FA, passkeys, cross-origin iframes, downloads, uploads, and anti-bot checks.

The conclusion is not "throw away Tauri". The conclusion is "do not ask one WebView engine to serve every trust level".

## Runtime Strategy

### Mode 1: System WebView

Use Tauri/Wry WebView for preview and self-verification workflows.

Characteristics:

- Always available.
- No large runtime dependency.
- Fast startup.
- Best for local dev and unauthenticated pages.
- Ephemeral by default.
- Good enough for viewport screenshot, interaction snapshot, console diagnostics, and simple navigation.

Hard boundary:

- Mode 1 must not become the primary logged-in browser path.
- Mode 1 should not promise broad third-party login success.

### Mode 2: Managed Chromium Runtime

Use a CCEM-managed Chromium runtime for the secure login browser. The preferred implementation shape is a sidecar Chrome for Testing or equivalent managed Chromium runtime.

Important distinction:

- This is not user Chrome takeover.
- This is not reading the user's Chrome profile.
- This is not exposing CDP directly to the agent.
- This is a CCEM-owned browser runtime controlled through CCEM policy and tools.

Target runtime behavior:

- One CCEM-managed profile per workspace/profile id.
- Control via pipe or local private IPC, not an open debug TCP port.
- CDP used internally by CCEM capabilities.
- Agent sees semantic tools: open, navigate, click, type, screenshot, snapshot, read logs.
- Runtime version is pinned and upgraded by CCEM release policy.

### Runtime Distribution

Do not make the first Mode 2 click block on a large download.

Use a readiness model instead:

- Standard app: runtime not included in installer by default.
- Background prewarm: prepare the runtime after install, first launch, or explicit feature enablement.
- Visible status: show "Login Browser runtime: ready / preparing / missing / failed".
- First-use fallback: if runtime is not ready, offer Preview Browser or background preparation rather than a dead wait.
- Full or enterprise app: optionally include the runtime for offline or managed deployments.
- Settings surface: allow reinstall, update, reset, and delete runtime.

Open distribution questions:

- Which exact Chromium artifact is legally and operationally safest to distribute.
- How to verify signatures or checksums per platform.
- Whether standard, full, and enterprise packages should be separate release artifacts.
- Whether runtime update cadence follows every CCEM release or a separate background update channel.

## Core Architecture

The design should keep app shell, browser runtime, policy, artifacts, and MCP tools separable.

Suggested layers:

1. BrowserShell
   - Owns visible browser UI in CCEM.
   - Shows control state, runtime readiness, pause/takeover, and profile identity.

2. BrowserSessionRegistry
   - Source of truth for session metadata.
   - Tracks state: creating, ready, navigating, interactive, crashed, destroyed.
   - Stores current url, title, loading state, profile id, backend id, bounds, and timestamps.
   - Do not rely on immediate native WebView getters as the source of truth.

3. BrowserProfileManager
   - Owns profile descriptors.
   - Maps profile ids to WebView ephemeral state or Chromium user-data-dir.
   - Enforces workspace isolation and cleanup.

4. BrowserBackend
   - Semantic backend trait, not a mechanism trait.
   - Example operations: open, navigate, screenshot, snapshot, click, type, readConsoleLog, readNetworkLog.
   - Implementations:
     - WebViewPreviewBackend for Mode 1.
     - ChromiumLoginBackend for Mode 2.

5. BrowserCapabilityLayer
   - Provides stable capability contracts to MCP and desktop UI.
   - Handles capability downgrade and backend feature detection.
   - Returns artifacts by file path plus summaries.

6. BrowserPolicyLayer
   - Intercepts all agent-initiated actions.
   - Enforces origin authorization, profile boundaries, download/upload rules, cross-origin read/write restrictions, and pause state.

7. BrowserArtifactStore
   - Owns screenshot, snapshot, console log, network log, and audit file paths.
   - Handles retention, rotation, and workspace scoping.

8. BrowserAuditLog
   - Append-only trusted log from the Rust/backend side.
   - Records tool calls, navigation, profile changes, permission decisions, user confirmations, runtime starts/stops, crashes, and pauses.

9. MCP Tool Surface
   - Thin interface over capability and policy layers.
   - Never bypasses policy.
   - Never exposes raw backend handles to the agent.

## Capability Matrix

| Capability | Mode 1 WebView | Mode 2 Managed Chromium |
| --- | --- | --- |
| Open/navigate | Yes | Yes |
| URL/title metadata | Registry-owned, event-fed | Registry-owned, CDP/event-fed |
| Viewport screenshot | Yes | Yes |
| Full-page screenshot | Optional/later | Yes |
| Interaction snapshot | JS-derived | AX tree via Chromium, JS fallback |
| Console log | JS patch plus page errors | CDP Runtime plus fallback |
| Network log | Limited fetch/XHR/resource telemetry | CDP Network |
| Trusted input | Limited, likely synthetic | CDP input dispatch |
| Download control | Limited | First-class |
| File upload guard | UI/policy guarded | Policy plus browser control |
| Persistent login state | Not primary path | Yes, workspace-scoped |
| Anti-bot compatibility | Lower | Higher |

Mode 1 does not need to reach Mode 2 capability parity. Avoid writing two full browsers.

## Artifact and Log Contract

Agent tools should return paths and summaries, not large payloads.

Proposed workspace layout:

```text
<workspace>/.ccem/browser/
  profiles/
    <profileId>/
      metadata.json
  sessions/
    <sessionId>/
      artifacts/
        screenshot-<timestamp>.png
        snapshot-<timestamp>.json
      logs/
        console-<sessionId>.jsonl
        network-<sessionId>.jsonl
      audit/
        actions.jsonl
```

Console/network logs are diagnostic. Audit logs are trusted. Keep them physically and semantically separate.

P0 log rules:

- JSONL, one event per line.
- Rotation by file size and session count.
- Workspace total cap with LRU cleanup.
- Console logs can include level, message, timestamp, frame url, and source location when safe.
- Network logs default to metadata only: method, redacted URL, status, mime, duration, size.
- Response bodies are off by default.
- Request bodies are off by default.
- Header capture uses an allowlist. Never dump all headers.
- Cookies, Authorization, Set-Cookie, API keys, tokens, passwords, and OTP-like values must be redacted before disk.

## Snapshot Contract

Use the name "interaction snapshot" for the baseline artifact. Reserve "accessibility snapshot" for a true browser accessibility tree from a Chromium backend.

Interaction snapshot should include:

- Frame id and URL.
- Visible text blocks.
- Interactable element list.
- Stable CCEM element id.
- Role and name computed from DOM/ARIA where possible.
- Bounding rect.
- Disabled/hidden/focusable/editable state.
- Input type and current value when safe.
- Provenance marker: page content is untrusted.

Prompt injection handling:

- Page text is data, not instruction.
- Hidden text should be omitted by default and counted separately.
- Tool results should mark page-derived fields as untrusted.
- Policy must enforce origin and action boundaries regardless of page text.

## Security P0

These are not polish. They are table stakes for a logged-in agent browser.

- Origin authorization per workspace/profile.
- Page content provenance as untrusted.
- Prompt injection guardrails in tool results and agent prompts.
- Log redaction before writing to disk.
- No raw cookie access to agents.
- No raw CDP access to agents.
- Visible "CCEM is controlling this page" state.
- One-click pause/takeover.
- Append-only audit log for agent actions.
- Download default policy: block, prompt, or sandbox. No silent drive-by downloads.
- File upload policy: restrict file chooser access to workspace-approved paths.
- Cross-origin read-to-write chain confirmation for sensitive workflows.
- Runtime process cleanup: no orphan Chromium processes after CCEM exits or crashes.

Sensitive-action classification can start as P1 enhancement. It is useful, but it is not reliable enough to be the safety baseline because labels, languages, icons, iframes, and custom controls vary widely.

## Roadmap

### M0: Stabilize Current Browser Surface

Goal: stop known crashes and protect the current user path.

Required work:

- Land the existing WebView URL/metadata lifecycle crash fix before expanding browser features.
- Ensure `browser_open` does not synchronously trust native WebView URL getters immediately after creation.
- Make BrowserSessionRegistry the read path for current URL/title/session state.

Acceptance:

- Agent can call browser open/snapshot/screenshot through the desktop control path without crashing.
- Browser session metadata is available even when native runtime metadata is not ready.
- Regression test exists for "browser code does not call unsafe WebView URL getter on the hot path".

### M1: Preview Browser Workbench

Goal: agent can self-verify local and public web pages without login state.

Backend: Tauri/system WebView.

Core deliverables:

- Ephemeral profile model.
- BrowserSessionRegistry.
- Screenshot artifact.
- Interaction snapshot artifact.
- Console log capture and JSONL output.
- Artifact store with retention.
- MCP tools returning artifact paths and summaries.
- Basic visible browser panel state.

Acceptance:

- Agent can open a localhost app, capture a screenshot, capture an interaction snapshot, inspect console errors, and repeat after a code change.
- No login-state claim is made for this mode.
- WebView renderer/process termination is surfaced as a session state and does not crash the desktop app.

### M1.5: Managed Chromium Runtime Readiness

Goal: remove the riskiest unknowns before Mode 2 depends on them.

Backend: sidecar managed Chromium prototype.

Core deliverables:

- Runtime artifact selection and version pinning decision.
- Download/prewarm manager.
- Checksum/signature verification.
- Runtime status UI state.
- Launch via private pipe or equivalent secure local channel.
- Process lifecycle manager.
- Orphan cleanup on app exit/crash.
- Minimal CDP smoke: open page, screenshot, close.

Acceptance:

- Runtime can be prepared in the background without blocking Mode 1.
- User can see runtime readiness before attempting Mode 2.
- CCEM can launch and stop the runtime cleanly.
- No open debug TCP port is required.

### M2: Secure Login Browser

Goal: user can log into a site inside a CCEM-owned profile and let the agent operate that profile under policy.

Backend: managed Chromium.

Core deliverables:

- Persistent workspace-scoped profile.
- CDP-backed screenshot and AX snapshot.
- Trusted input path.
- CDP Network log with redaction.
- Origin authorization v1.
- Visible control overlay.
- One-click pause.
- Profile cleanup by workspace/profile.
- Download/upload policy hooks.

Acceptance:

- User logs into a representative app, restarts CCEM, and the login state remains inside the CCEM profile.
- Two workspaces do not share cookies or local storage.
- Network logs contain no Authorization, Cookie, Set-Cookie, token, password, or API key plaintext.
- Agent actions are blocked when target origin is not authorized.
- CCEM exit leaves no orphan browser runtime.

### M3: Trust Layer and Third-Party Hardening

Goal: expand from owned/staging sites to broader third-party logged-in workflows.

Core deliverables:

- Policy layer is an independent module and mandatory for every capability call.
- Audit log UI/export.
- Sensitive-action confirmation v1.
- Prompt injection red-team tests.
- Hidden text removal/provenance markers.
- Cross-origin read/write confirmation.
- Download sandbox.
- File upload workspace restriction.
- Runtime update policy and compatibility tests.

Acceptance:

- Red-team page with hidden instructions cannot expand origin authorization, exfiltrate workspace files, or bypass pause.
- Audit log can replay a session at the action level.
- Pause takes effect within one second for active agent action loops.
- Third-party failures are classified as runtime limitation, site policy, user auth, or CCEM bug.

## Issue Seeds

High-confidence first issues:

1. `fix(desktop): stabilize browser session metadata ownership`
   - Make Registry the source of truth.
   - Avoid immediate unsafe native URL reads.

2. `feat(desktop): add browser artifact store`
   - Paths, retention, JSON metadata, screenshot output.

3. `feat(desktop): add interaction snapshot artifact`
   - Structured element map with provenance.

4. `feat(desktop): write console diagnostics to JSONL`
   - File path output, rotation, summary.

5. `feat(desktop): add browser runtime readiness model`
   - States only at first: unavailable, preparing, ready, failed.

6. `spike(desktop): managed Chromium sidecar launch`
   - Download/prewarm omitted if necessary for spike.
   - Prove pipe-based launch, screenshot, shutdown, orphan cleanup.

7. `feat(desktop): add origin authorization policy`
   - Required before Mode 2 agent operation.

8. `feat(desktop): redact browser network logs before disk`
   - Must land with any network log collection.

## Open Questions

- Which managed Chromium artifact should be used for production distribution.
- Whether standard/full/enterprise packages should be separate release channels.
- Whether runtime prewarm should be opt-in, default-on idle background work, or triggered by first Mode 2 affordance.
- How to phrase runtime download to users without making CCEM feel incomplete.
- Whether Mode 2 UI should be an external managed window first, embedded later, or always external.
- How much OAuth/passkey support is realistic in the first public Mode 2 release.
- What telemetry is acceptable for runtime readiness, crash, and site compatibility.
- Whether enterprise users need an offline runtime installer.

## Handoff Notes for the Next Agent

- Start from current git status. The main checkout may be dirty with unrelated user changes.
- Do not treat WebView and Chromium as competing app shells. They are different browser backends under one CCEM shell.
- Do not make Mode 2 wait for a runtime download at the first moment of need. Design readiness and prewarm first.
- Do not promise "works on every logged-in site". Start with owned apps, staging apps, and normal SaaS, then expand.
- Do not weaken safety by moving high-risk browser power directly into agent tools.
- Keep behavior verification separate from release verification. For desktop/browser changes, use real app smoke through Tauri MCP or the strongest available runtime path.

## Current Product Narrative

CCEM Browser is an agent workbench that lets agents verify, debug, and operate web workflows with visible state, durable artifacts, and auditable control.

It has two built-in engines:

- A lightweight Preview Browser for immediate web verification.
- A Secure Login Browser for workspace-scoped logged-in workflows.

Advanced real Chrome takeover remains external through user-supplied MCPs.

