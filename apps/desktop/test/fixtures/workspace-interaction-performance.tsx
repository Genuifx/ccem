// Real production session/composer/transcript. Only IPC responses are synthetic.
// No provider calls, user sessions, visual-effect substitutions or timer acceleration.
import React, { useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorkspaceNativeSessionView } from '@/components/workspace/WorkspaceNativeSessionView';
import { WorkspaceSidePanelContext, useWorkspaceSidePanelController } from '@/components/workspace/WorkspaceSidePanel';
import { WorkspaceFileLinkContext } from '@/components/workspace/WorkspaceFileLinkContext';
import { LocaleProvider } from '@/locales';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearPerfLog, getPerfEvents } from '@/lib/perf-log';
import type { NativeSessionSummary, SessionEventRecord } from '@/lib/tauri-ipc';

type Payload = SessionEventRecord['payload'];
type Sample = { kind: string; ms: number; detail?: string };
const EMPTY = [];
const NOOP = () => {};
const LETTERS = ['A', 'B', 'C'];
const PREFIX = 'workspace-interaction-performance-';
const ROUNDS = 120;
const round = (value: number) => Math.round(value * 100) / 100;
const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, meanMs: round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
    p50Ms: round(sorted[Math.floor((sorted.length - 1) * 0.50)] ?? 0),
    p95Ms: round(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0) };
}

function record(runtimeId: string, seq: number, payload: Payload): SessionEventRecord {
  return { runtime_id: runtimeId, seq,
    occurred_at: new Date(Date.UTC(2026, 9, 11) + seq * 240).toISOString(), payload };
}

function seed(runtimeId: string, letter: string) {
  const events: SessionEventRecord[] = [];
  const append = (payload: Payload) => events.push(record(runtimeId, events.length + 1, payload));
  for (let index = 1; index <= ROUNDS; index++) {
    append({ type: 'user_prompt', text: `会话 ${letter} · 第 ${index} 轮：检查任务队列和渲染路径，保留交互效果，并说明验证结果。`, image_count: 0 });
    append({ type: 'lifecycle', stage: 'turn_started', detail: '' });
    append({ type: 'assistant_chunk', text: `正在检查第 ${index} 个模块的状态更新。先核对消息引用、滚动位置与输入草稿，再验证异步返回不会覆盖新的用户操作。\n\n本轮覆盖普通文本、中文内容和可展开的工具记录，继续观察会话切换时的行为。` });
    for (const [toolIndex, rawName] of ['Read', 'Bash'].entries()) {
      const toolId = `${runtimeId}-turn-${index}-tool-${toolIndex}`;
      append({ type: 'tool_use_started', tool_use_id: toolId, raw_name: rawName,
        input_summary: toolIndex === 0 ? `src/queue/module-${index}.ts` : `pnpm test -- module-${index}`,
        needs_response: false,
        category: toolIndex === 0 ? { category: 'file_op', raw_name: rawName } : { category: 'execution', raw_name: rawName } });
      append({ type: 'tool_use_completed', tool_use_id: toolId, raw_name: rawName,
        result_summary: `第 ${index} 轮：${rawName} 完成，12 项验证通过。`,
        result_content: `Fixture ${letter}/${index}\n${Array.from({ length: 12 }, (_, row) => `✓ case ${row + 1}: preserved queue and draft state`).join('\n')}`,
        success: true });
    }
    const code = index % 3 === 0
      ? '\n\n```typescript\nexport function applyQueue(previous: readonly Task[], update: Task) {\n  const index = previous.findIndex(task => task.id === update.id);\n  if (index < 0) return [...previous, update];\n  if (previous[index] === update) return previous;\n  return previous.map((task, position) => position === index ? update : task);\n}\n```' : '';
    append({ type: 'assistant_chunk', text: `检查完成：第 **${index}** 轮保留了原有任务顺序，更新只影响需要变化的内容。\n\n- 草稿和滚动位置保持稳定。\n- 工具详情可以展开、选择和复制。\n- 同步结果与最新操作一致。${code}\n\nPERF_END_${letter}_${index}` });
    append({ type: 'lifecycle', stage: 'turn_completed', detail: '' });
  }
  return events;
}

export function mountInteractionPerformanceFixture(container: HTMLElement, build: { variant: string; revision: string }) {
  let epoch = 1;
  let active = 'A';
  let streamTimer: number | null = null;
  let streamRuntime: string | null = null;
  let nextListener = 1;
  let capture = false;
  let captureGeneration = 0;
  let captureStarted = 0;
  let captureEnded: number | null = null;
  let label = '';
  let frameId = 0;
  let previousFrame: number | null = null;
  let beforeInputAt: number | null = null;
  let metrics = freshMetrics();
  let setSelected: (letter: string) => void = NOOP;
  let setSessions: React.Dispatch<React.SetStateAction<NativeSessionSummary[]>> = NOOP;
  let setEpoch: React.Dispatch<React.SetStateAction<number>> = NOOP;
  let setStreamFlag: React.Dispatch<React.SetStateAction<boolean>> = NOOP;
  const errors: string[] = [];
  const records = new Map<string, SessionEventRecord[]>();
  const summaries = new Map<string, NativeSessionSummary>();
  const ipcCounts: Record<string, number> = {};
  const blockedCommands: string[] = [];
  const openedFiles: Array<{ ownerKey: string; path: string }> = [];
  let currentOwnerKey = '';
  const editorStyles = new WeakSet<CSSStyleDeclaration>();
  const editors = new WeakSet<Element>();
  const restoreAccessors: Array<() => void> = [];
  const previousInvoke = (globalThis as any).__workspaceInteractionInvoke;
  const previousProbe = (globalThis as any).__workspaceInteractionProbe;

  function freshMetrics() {
    return { renders: {} as Record<string, number>, renderScopes: {} as Record<string, Record<string, number>>,
      frames: [] as number[], samples: [] as Sample[], heightWrites: 0, heightAutoWrites: 0,
      scrollHeightReads: 0, inputEvents: 0, keyEvents: 0, generatedChunks: 0,
      trustedInputs: 0, syntheticInputs: 0, longTasks: [] as number[] };
  }

  function runtimeId(letter: string) { return `${PREFIX}${epoch}-${letter}`; }
  function pane(letter = active) { return container.querySelector<HTMLElement>(`[data-perf-session="${letter}"]`); }
  function editor(letter = active) { return pane(letter)?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null; }
  function viewport(letter = active) { return pane(letter)?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null; }
  function registerEditors() {
    container.querySelectorAll<HTMLElement>('[contenteditable="true"]').forEach((element) => {
      editorStyles.add(element.style);
      editors.add(element);
    });
  }
  function afterPaint(kind: string, started: number, detail?: string) {
    const generation = captureGeneration;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (capture && generation === captureGeneration && metrics.samples.length < 10000) {
        metrics.samples.push({ kind, ms: performance.now() - started, detail });
      }
    }));
  }

  function wrapAccessor(prototype: object, property: string, kind: 'height' | 'scrollHeight') {
    let owner: any = prototype;
    while (owner && !Object.getOwnPropertyDescriptor(owner, property)) owner = Object.getPrototypeOf(owner);
    if (!owner) return false;
    const descriptor = Object.getOwnPropertyDescriptor(owner, property)!;
    if (!descriptor.configurable) return false;
    Object.defineProperty(owner, property, {
      ...descriptor,
      ...(descriptor.set ? { set(this: CSSStyleDeclaration, value: string) {
        if (capture && kind === 'height' && editorStyles.has(this)) {
          metrics.heightWrites++;
          if (value === 'auto') metrics.heightAutoWrites++;
        }
        descriptor.set!.call(this, value);
      } } : {}),
      ...(descriptor.get ? { get(this: Element) {
        if (capture && kind === 'scrollHeight' && editors.has(this)) metrics.scrollHeightReads++;
        return descriptor.get!.call(this);
      } } : {}),
    });
    restoreAccessors.push(() => Object.defineProperty(owner, property, descriptor));
    return true;
  }
  const accessorSupport = {
    height: wrapAccessor(window.CSSStyleDeclaration.prototype, 'height', 'height'),
    scrollHeight: wrapAccessor(window.Element.prototype, 'scrollHeight', 'scrollHeight'),
  };
  (globalThis as any).__workspaceInteractionProbe = {
    render(name: string, scope: string) {
      if (!capture) return;
      metrics.renders[name] = (metrics.renders[name] ?? 0) + 1;
      const scopes = metrics.renderScopes[name] ?? (metrics.renderScopes[name] = {});
      scopes[scope] = (scopes[scope] ?? 0) + 1;
    },
  };

  function createSessions() {
    records.clear();
    summaries.clear();
    return LETTERS.map((letter) => {
      const id = runtimeId(letter);
      const events = seed(id, letter);
      records.set(id, events);
      const summary = {
        runtime_id: id, provider: 'claude', transport: 'native', provider_session_id: id,
        env_name: 'isolated-performance-fixture', project_dir: '/synthetic-performance-fixture',
        perm_mode: 'yolo', runtime_perm_mode: 'bypassPermissions', model: 'fixture', effort: 'high',
        status: 'ready', is_active: true, background_tasks: [], last_event_seq: events.length,
      } as unknown as NativeSessionSummary;
      summaries.set(id, summary);
      return summary;
    });
  }

  const onSessionUpdate = (summary: NativeSessionSummary) => setSessions((previous) => {
    const index = previous.findIndex((item) => item.runtime_id === summary.runtime_id);
    if (index < 0 || JSON.stringify(previous[index]) === JSON.stringify(summary)) return previous;
    const next = [...previous];
    next[index] = summary;
    return next;
  });

  (globalThis as any).__workspaceInteractionInvoke = async (command: string, args: any = {}) => {
    ipcCounts[command] = (ipcCounts[command] ?? 0) + 1;
    const events = records.get(args.runtimeId) ?? [];
    if (command === 'get_native_session_events') {
      const available = events.filter((event) => event.seq > (args.sinceSeq ?? 0));
      const result = available.slice(-Math.max(1, args.limit ?? available.length));
      return { events: result, source_available: true, gap_detected: false,
        oldest_available_seq: events[0]?.seq ?? null, newest_available_seq: events.at(-1)?.seq ?? null,
        truncated: result.length < available.length };
    }
    if (command === 'get_native_session_event_page') {
      const end = args.snapshotNewestSeq ?? events.at(-1)?.seq ?? 0;
      const eligible = events.filter((event) => event.seq > (args.afterSeq ?? 0) && event.seq <= end);
      const result = eligible.slice(0, args.limit ?? 500);
      return { events: result, source_available: true, gap_detected: false, decode_failure_count: 0,
        oversized_event_count: 0, oldest_available_seq: events[0]?.seq ?? null,
        snapshot_newest_seq: end || null, next_cursor: result.at(-1)?.seq ?? args.afterSeq ?? null,
        has_more: eligible.length > result.length };
    }
    if (command === 'get_native_session_summary') {
      const summary = summaries.get(args.runtimeId);
      return summary ? { ...summary, last_event_seq: events.length } : null;
    }
    if (command === 'get_workspace_git_snapshot') return { is_repo: false, files: [], dirty_count: 0 };
    if (command === 'get_settings') return { language: 'zh' };
    if (command === 'hermes_action' && args.action === 'sessionBinding') {
      return { binding: null, bindingValid: false, deliveryStatus: null, targets: [], models: [], defaultModelEnv: '' };
    }
    if (command === 'plugin:event|listen') return nextListener++;
    if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null;
    if (command === 'plugin:window|is_focused') return true;
    if (/^(get_|list_|search_|query_)/.test(command)) return [];
    // All imported IPC is intercepted. Never fall through to user/native state.
    blockedCommands.push(command);
    throw new Error(`Fixture blocked native mutation: ${command}`);
  };

  function append(id: string, payload: Payload) {
    const events = records.get(id)!;
    events.push(record(id, events.length + 1, payload));
  }
  function setStatus(id: string, status: 'ready' | 'processing') {
    const next = { ...summaries.get(id)!, status };
    summaries.set(id, next);
    onSessionUpdate(next);
  }
  function stopStream() {
    if (streamTimer !== null) window.clearInterval(streamTimer);
    streamTimer = null;
    if (streamRuntime) {
      append(streamRuntime, { type: 'lifecycle', stage: 'turn_completed', detail: '' });
      setStatus(streamRuntime, 'ready');
    }
    streamRuntime = null;
    setStreamFlag(false);
  }
  function startStream(options: { chunks?: number; intervalMs?: number } = {}) {
    stopStream();
    const id = runtimeId(active);
    streamRuntime = id;
    append(id, { type: 'user_prompt', text: '持续输出性能测试：输入框保留为未发送草稿。', image_count: 0 });
    append(id, { type: 'lifecycle', stage: 'turn_started', detail: '' });
    setStatus(id, 'processing');
    let index = 0;
    setStreamFlag(true);
    streamTimer = window.setInterval(() => {
      index++;
      append(id, { type: 'assistant_chunk', text: `片段 ${String(index).padStart(3, '0')}：实时更新并保留历史记录。${index % 8 === 0 ? '\n\n' : ' '}` });
      if (capture) metrics.generatedChunks++;
      if (index >= (options.chunks ?? 200)) stopStream();
    }, options.intervalMs ?? 40);
  }

  function frame(now: number) {
    if (capture && previousFrame !== null && metrics.frames.length < 30000) metrics.frames.push(now - previousFrame);
    previousFrame = now;
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);
  const longTaskObserver = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver((list) => {
      if (capture) for (const item of list.getEntries()) metrics.longTasks.push(item.duration);
    }) : null;
  longTaskObserver?.observe({ entryTypes: ['longtask'] });

  function onKey(event: KeyboardEvent) {
    if (!event.target || !(event.target as Element).closest('[contenteditable="true"]')) return;
    registerEditors();
    if (capture) { metrics.keyEvents++; afterPaint('keypressTwoRaf', performance.now(), event.key); }
  }
  function onBeforeInput(event: Event) {
    if ((event.target as Element)?.closest('[contenteditable="true"]')) beforeInputAt = performance.now();
  }
  function onInput(event: Event) {
    if (!(event.target as Element)?.closest('[contenteditable="true"]')) return;
    if (capture) {
      metrics.inputEvents++;
      if (event.isTrusted) metrics.trustedInputs++; else metrics.syntheticInputs++;
      afterPaint('inputTwoRaf', beforeInputAt ?? performance.now());
    }
    beforeInputAt = null;
  }
  let scrollFramePending = false;
  function onScroll(event: Event) {
    if (!capture || scrollFramePending || !(event.target as Element)?.matches('[data-radix-scroll-area-viewport]')) return;
    scrollFramePending = true;
    afterPaint('scrollTwoRaf', performance.now());
    requestAnimationFrame(() => { scrollFramePending = false; });
  }
  function onError(event: ErrorEvent) { errors.push(event.message); }
  function onRejection(event: PromiseRejectionEvent) { errors.push(String(event.reason)); }
  container.addEventListener('keydown', onKey, true);
  container.addEventListener('beforeinput', onBeforeInput, true);
  container.addEventListener('input', onInput, true);
  container.addEventListener('scroll', onScroll, true);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  function resetMetrics(nextLabel = 'manual') {
    assertBoundedViewport();
    registerEditors();
    capture = false;
    captureGeneration++;
    metrics = freshMetrics();
    previousFrame = null;
    captureStarted = performance.now();
    captureEnded = null;
    label = nextLabel;
    clearPerfLog();
    capture = true;
  }
  function geometry(letter: string) {
    const panel = pane(letter)!;
    const view = viewport(letter);
    const input = editor(letter);
    const box = view?.getBoundingClientRect();
    const visibleItems = view && box ? [...view.querySelectorAll<HTMLElement>('[data-transcript-item-key]')]
      .filter((item) => { const rect = item.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; }) : [];
    const anchor = visibleItems.find((item) => item.getBoundingClientRect().top >= (box?.top ?? 0)) ?? visibleItems[0];
    const inputBox = input?.getBoundingClientRect();
    return { runtimeId: runtimeId(letter), visible: letter === active, domNodes: panel.querySelectorAll('*').length,
      transcriptRows: panel.querySelectorAll('[data-transcript-item-key]').length,
      toolGroups: panel.querySelectorAll('.workspace-tool-digest-virtualized').length,
      openGroups: panel.querySelectorAll('.workspace-tool-digest-virtualized button[aria-expanded="true"]').length,
      scrollTop: round(view?.scrollTop ?? 0), scrollHeight: round(view?.scrollHeight ?? 0), viewportHeight: round(view?.clientHeight ?? 0),
      topSpacerHeight: round(panel.querySelector('[data-workspace-transcript-top-spacer]')?.getBoundingClientRect().height ?? 0),
      anchor: anchor ? { key: anchor.dataset.transcriptItemKey, offset: round(anchor.getBoundingClientRect().top - box!.top) } : null,
      editor: input ? { text: input.innerText ?? input.textContent, height: round(inputBox?.height ?? 0), width: round(inputBox?.width ?? 0),
        inlineHeight: input.style.height, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight,
        focused: document.activeElement === input } : null };
  }
  function diagnostics() {
    const timings = Object.fromEntries([...new Set(metrics.samples.map((item) => item.kind))]
      .map((kind) => [kind, distribution(metrics.samples.filter((item) => item.kind === kind).map((item) => item.ms))]));
    return { build, workload: { sessions: 3, turnsPerSession: ROUNDS, streamChunks: 200, streamIntervalMs: 40 },
      label, capturing: capture, durationMs: round((captureEnded ?? performance.now()) - captureStarted), active,
      streaming: streamTimer !== null, events: Object.fromEntries(LETTERS.map((letter) => [letter, records.get(runtimeId(letter))?.length])),
      renders: { ...metrics.renders }, renderScopes: JSON.parse(JSON.stringify(metrics.renderScopes)),
      timings, frames: { ...distribution(metrics.frames), over25Ms: metrics.frames.filter((value) => value > 25).length,
        over50Ms: metrics.frames.filter((value) => value > 50).length, over100Ms: metrics.frames.filter((value) => value > 100).length },
      editorCounters: { supported: accessorSupport, heightWrites: metrics.heightWrites, heightAutoWrites: metrics.heightAutoWrites,
        scrollHeightReads: metrics.scrollHeightReads, keyEvents: metrics.keyEvents, inputEvents: metrics.inputEvents,
        trustedInputs: metrics.trustedInputs, syntheticInputs: metrics.syntheticInputs },
      generatedChunks: metrics.generatedChunks, longTasks: { supported: !!longTaskObserver, ...distribution(metrics.longTasks) },
      selection: window.getSelection()?.toString() ?? '', sessions: Object.fromEntries(LETTERS.map((letter) => [letter, geometry(letter)])),
      ipcCounts: { ...ipcCounts }, blockedCommands: [...blockedCommands], errors: [...errors],
      contexts: { sidePanelOwner: currentOwnerKey, openedFiles: [...openedFiles] },
      layout: layoutBounds(),
      nativeTranscriptMarks: getPerfEvents().filter((event) => event.name.startsWith('nativeTranscript.')).slice(-30),
      environment: { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, devicePixelRatio,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, visibility: document.visibilityState },
      caveat: 'Synthetic IPC in a real production UI. Two-rAF is a presentation proxy, not hardware paint or MacBook Air proof.' };
  }
  function finishMetrics() {
    capture = false;
    captureEnded = performance.now();
    return diagnostics();
  }
  function switchTo(letter: string) {
    if (!LETTERS.includes(letter) || active === letter) return;
    const started = performance.now();
    const from = active;
    active = letter;
    setSelected(letter);
    if (capture) afterPaint('switchTwoRaf', started, `${from}->${letter}`);
  }

  function Fixture() {
    const [selected, updateSelected] = useState('A');
    const [sessions, updateSessions] = useState(createSessions);
    const [generation, updateEpoch] = useState(epoch);
    const [streaming, updateStreaming] = useState(false);
    const workingDir = '/synthetic-performance-fixture';
    const sidePanel = useWorkspaceSidePanelController(`${runtimeId(selected)}:${workingDir}`, false);
    const fileLinkTarget = useMemo(() => ({
      workingDir,
      openFile: (path: string) => {
        openedFiles.push({ ownerKey: sidePanel.ownerKey, path });
        sidePanel.open('files', path);
      },
    }), [workingDir, sidePanel.ownerKey, sidePanel.open]);
    currentOwnerKey = sidePanel.ownerKey;
    setSelected = updateSelected;
    setSessions = updateSessions;
    setEpoch = updateEpoch;
    setStreamFlag = updateStreaming;
    useLayoutEffect(registerEditors, [generation, selected]);
    return <LocaleProvider><TooltipProvider>
      <WorkspaceSidePanelContext.Provider value={sidePanel}>
      <WorkspaceFileLinkContext.Provider value={fileLinkTarget}>
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <div className="flex shrink-0 items-center gap-3 border-b border-border p-3 pt-10 text-xs">
          <span className="font-medium">交互性能 · {build.variant}</span>
          {LETTERS.map((letter) => <button key={letter} type="button" data-testid={`perf-session-${letter}`}
            aria-pressed={selected === letter} className="rounded-md border border-border px-3 py-2"
            onClick={() => switchTo(letter)}>会话 {letter}</button>)}
          <button type="button" data-testid="perf-start-stream" className="rounded-md border border-border px-3 py-2"
            onClick={() => startStream()} disabled={streaming}>开始 200 片段</button>
          <button type="button" data-testid="perf-stop-stream" className="rounded-md border border-border px-3 py-2"
            onClick={stopStream}>停止输出</button>
          <button type="button" data-testid="perf-reset-metrics" className="rounded-md border border-border px-3 py-2"
            onClick={() => resetMetrics()}>开始计量</button>
          <button type="button" data-testid="perf-finish-metrics" className="rounded-md border border-border px-3 py-2"
            onClick={finishMetrics}>结束计量</button>
        </div>
        <div data-perf-live-region className="relative min-h-0 flex-1 overflow-hidden">
          {sessions.map((session, index) => <div key={`${generation}-${LETTERS[index]}`}
            data-perf-session={LETTERS[index]} className="absolute inset-0 min-h-0"
            style={{ display: selected === LETTERS[index] ? 'block' : 'none' }}>
            <WorkspaceNativeSessionView session={session} isVisible={selected === LETTERS[index]}
              seedMessages={EMPTY} installedSkills={EMPTY} workspaceCommands={EMPTY}
              initialPrompt={null} initialImages={null} initialAnnotations={null}
              onSessionUpdate={onSessionUpdate} onStartNew={NOOP} />
          </div>)}
        </div>
      </div>
      </WorkspaceFileLinkContext.Provider>
      </WorkspaceSidePanelContext.Provider>
    </TooltipProvider></LocaleProvider>;
  }
  const root = createRoot(container);
  flushSync(() => root.render(<Fixture />));

  function layoutBounds() {
    const region = container.querySelector<HTMLElement>('[data-perf-live-region]')!;
    const panel = pane()!;
    const view = viewport();
    const regionHeight = region.getBoundingClientRect().height;
    const paneHeight = panel.getBoundingClientRect().height;
    const viewportHeight = view?.clientHeight ?? 0;
    return { regionHeight: round(regionHeight), paneHeight: round(paneHeight), viewportHeight,
      pageHeight: document.documentElement.scrollHeight, windowHeight: innerHeight,
      valid: viewportHeight > 0 && viewportHeight <= innerHeight
        && regionHeight <= innerHeight && Math.abs(paneHeight - regionHeight) <= 1 };
  }
  function assertBoundedViewport() {
    const bounds = layoutBounds();
    if (!bounds.valid) throw new Error(`Invalid performance fixture layout: ${JSON.stringify(bounds)}`);
  }

  async function waitUntil(check: () => boolean, timeout = 10000) {
    const started = performance.now();
    while (!check()) {
      if (performance.now() - started > timeout) throw new Error('Performance fixture timed out waiting for rendered state');
      await delay(25);
    }
  }
  async function warmup() {
    for (const letter of LETTERS) {
      container.querySelector<HTMLButtonElement>(`[data-testid="perf-session-${letter}"]`)!.click();
      await waitUntil(() => Boolean(pane(letter)?.textContent?.includes(`PERF_END_${letter}_${ROUNDS}`)));
      await delay(750);
    }
    container.querySelector<HTMLButtonElement>('[data-testid="perf-session-A"]')!.click();
    await delay(1000);
    registerEditors();
    assertBoundedViewport();
    return diagnostics();
  }
  return {
    diagnostics, resetMetrics, finishMetrics, warmup, startStream, stopStream, layoutBounds,
    selectors: { editor: '[data-perf-session="A"] [contenteditable="true"]',
      viewport: '[data-perf-session="A"] [data-radix-scroll-area-viewport]' },
    reset() {
      capture = false;
      stopStream();
      epoch++;
      active = 'A';
      flushSync(() => { setEpoch(epoch); setSessions(createSessions()); setSelected('A'); });
      errors.length = 0;
      blockedCommands.length = 0;
      openedFiles.length = 0;
      for (const key of Object.keys(ipcCounts)) delete ipcCounts[key];
      return warmup();
    },
    // This helper drives DOM buttons only. Native gestures are separately required.
    async benchmarkSwitches(count = 18, intervalMs = 120) {
      resetMetrics('warm-session-switches');
      for (let index = 0; index < count; index++) {
        const letter = LETTERS[(index + 1) % LETTERS.length];
        container.querySelector<HTMLButtonElement>(`[data-testid="perf-session-${letter}"]`)!.click();
        await delay(intervalMs);
      }
      await delay(200);
      return finishMetrics();
    },
    async benchmarkStream(options: { chunks?: number; intervalMs?: number } = {}) {
      resetMetrics('stream-only');
      startStream(options);
      await waitUntil(() => streamTimer === null, 30000);
      await delay(1000);
      return finishMetrics();
    },
    unmount() {
      capture = false;
      stopStream();
      flushSync(() => root.unmount());
      cancelAnimationFrame(frameId);
      longTaskObserver?.disconnect();
      restoreAccessors.reverse().forEach((restore) => restore());
      container.removeEventListener('keydown', onKey, true);
      container.removeEventListener('beforeinput', onBeforeInput, true);
      container.removeEventListener('input', onInput, true);
      container.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      (globalThis as any).__workspaceInteractionInvoke = previousInvoke;
      (globalThis as any).__workspaceInteractionProbe = previousProbe;
    },
  };
}
