// Used by the DOM regression and by the isolated Tauri WebView smoke test.
// Only IPC responses are simulated; the session view, poller and transcript
// rendering are the production components. No provider or user data is used.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorkspaceNativeSessionView } from '@/components/workspace/WorkspaceNativeSessionView';
import { LocaleProvider } from '@/locales';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPerfEvents } from '@/lib/perf-log';
import type { NativeSessionSummary, SessionEventRecord } from '@/lib/tauri-ipc';

const runtimeId = 'transcript-recovery-fixture';
const empty = [];
const noop = () => {};
const initial = {
  runtime_id: runtimeId, provider: 'claude', transport: 'native',
  provider_session_id: 'transcript-recovery-fixture',
  env_name: 'fixture', project_dir: '/transcript-recovery-fixture',
  perm_mode: 'yolo', runtime_perm_mode: 'bypassPermissions',
  model: 'fixture', effort: 'high', status: 'ready', is_active: true,
  background_tasks: [],
} as unknown as NativeSessionSummary;

function record(seq: number, payload: SessionEventRecord['payload']): SessionEventRecord {
  return { runtime_id: runtimeId, seq, occurred_at: '2026-09-21T00:00:00Z', payload };
}

export function mountRecoveryFixture(container: HTMLElement, options: { stallInitial?: boolean } = {}) {
  const state = {
    mode: (options.stallInitial ? 'once' : 'healthy') as 'healthy' | 'once' | 'always',
    stallInitial: options.stallInitial === true,
    pageCalls: 0,
    initialCalls: 0,
    maxPending: 0,
    pending: [] as Array<() => void>,
    requests: [] as Array<{ runtimeId: string; afterSeq: number | null }>,
    sends: 0,
    events: [
      record(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      record(2, { type: 'assistant_chunk', text: '正在整理清单。' }),
      record(3, { type: 'tool_use_started', tool_use_id: 'fixture-write', raw_name: 'Write',
        input_summary: '清单.md', needs_response: false,
        category: { category: 'file_op', raw_name: 'Write' } }),
      record(4, { type: 'tool_use_completed', tool_use_id: 'fixture-write', raw_name: 'Write',
        result_summary: '清单已写入', success: true }),
    ],
  };
  const internals = (window as any).__TAURI_INTERNALS__;
  const originalInvoke = internals.invoke;
  const page = (id: string, after: number | null, snapshot: number | null) => {
    const end = snapshot ?? (id === runtimeId ? state.events.length : 0);
    const events = id === runtimeId ? state.events.filter((event) => event.seq > (after ?? 0) && event.seq <= end) : [];
    return {
      events, source_available: true, gap_detected: false, decode_failure_count: 0,
      oversized_event_count: 0, oldest_available_seq: end ? 1 : null,
      snapshot_newest_seq: end || null, next_cursor: events.at(-1)?.seq ?? after, has_more: false,
    };
  };
  const maybeStall = (value: unknown) => {
    if (state.mode === 'healthy') return Promise.resolve(value);
    if (state.mode === 'once') state.mode = 'healthy';
    return new Promise((resolve) => {
      const release = () => {
        state.pending = state.pending.filter((item) => item !== release);
        resolve(value);
      };
      state.pending.push(release);
      state.maxPending = Math.max(state.maxPending, state.pending.length);
    });
  };
  const previousFixtureInvoke = (globalThis as any).__transcriptRecoveryInvoke;
  (globalThis as any).__transcriptRecoveryInvoke = (command: string, args: any = {}, options?: unknown) => {
    if (command.startsWith('plugin:')) return originalInvoke(command, args, options);
    const id = args.runtimeId;
    if (command === 'get_native_session_events') {
      state.initialCalls++;
      const result = page(id, null, null);
      const batch = { ...result, newest_available_seq: result.snapshot_newest_seq, truncated: false };
      return state.stallInitial && id === runtimeId ? maybeStall(batch) : Promise.resolve(batch);
    }
    if (command === 'get_native_session_event_page') {
      state.pageCalls++;
      state.requests.push({ runtimeId: id, afterSeq: args.afterSeq });
      const result = page(id, args.afterSeq, args.snapshotNewestSeq);
      return id === runtimeId ? maybeStall(result) : Promise.resolve(result);
    }
    if (command === 'get_native_session_summary') {
      return Promise.resolve({ ...initial, runtime_id: id, last_event_seq: id === runtimeId ? state.events.length : 0 });
    }
    if (command === 'get_workspace_git_snapshot') return Promise.resolve({ is_repo: false, files: [], dirty_count: 0 });
    if (command === 'send_native_session_input') {
      state.sends++;
      publish(`后续答复 ${state.sends} 已同步。`);
      return Promise.resolve();
    }
    return Promise.resolve([]);
  };

  function publish(text = '最终答复已同步，无需重启。') {
    state.events.push(record(state.events.length + 1, { type: 'assistant_chunk', text }));
    state.events.push(record(state.events.length + 1, { type: 'lifecycle', stage: 'turn_completed', detail: '' }));
  }
  let setVisibleRuntime: (value: string) => void;
  function Fixture() {
    const [active, setActive] = useState(runtimeId);
    const [session, setSession] = useState(initial);
    setVisibleRuntime = setActive;
    return <LocaleProvider><TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex gap-3 p-6 pt-10">
          <button data-testid="stall-once" onClick={() => { state.mode = 'once'; publish(); }}>单次读取挂起</button>
          <button data-testid="stall-always" onClick={() => { state.mode = 'always'; publish('持续故障后的答复。'); }}>持续读取挂起</button>
          <button data-testid="release" onClick={() => { state.mode = 'healthy'; state.pending[0]?.(); }}>恢复读取</button>
          <button data-testid="other-session" onClick={() => setActive(active === runtimeId ? 'other-fixture' : runtimeId)}>切换会话</button>
        </div>
        <div className="min-h-0 flex-1" style={{ display: active === runtimeId ? undefined : 'none' }}>
          <WorkspaceNativeSessionView session={session} isVisible={active === runtimeId}
            seedMessages={empty} installedSkills={empty} workspaceCommands={empty}
            initialPrompt={null} initialImages={null} initialAnnotations={null}
            onSessionUpdate={setSession} onStartNew={noop} />
        </div>
        <div className="min-h-0 flex-1" style={{ display: active === runtimeId ? 'none' : undefined }}>
          <WorkspaceNativeSessionView session={{ ...initial, runtime_id: 'other-fixture' }} isVisible={active !== runtimeId}
            seedMessages={empty} installedSkills={empty} workspaceCommands={empty}
            initialPrompt={null} initialImages={null} initialAnnotations={null}
            onSessionUpdate={noop} onStartNew={noop} />
        </div>
      </div>
    </TooltipProvider></LocaleProvider>;
  }
  const root = createRoot(container);
  flushSync(() => root.render(<Fixture />));
  return {
    state, publish,
    switchTo: (id: string) => flushSync(() => setVisibleRuntime(id)),
    diagnostics: () => getPerfEvents().filter((event) => event.name.startsWith('nativeTranscript.')),
    unmount: () => {
      flushSync(() => root.unmount());
      state.mode = 'healthy';
      for (const release of [...state.pending]) release();
      (globalThis as any).__transcriptRecoveryInvoke = previousFixtureInvoke;
    },
  };
}
