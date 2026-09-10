// Actual native session view and composer with synthetic IPC; never sends to a runtime.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { WorkspaceNativeSessionView } from '../../src/components/workspace/WorkspaceNativeSessionView';
import { LocaleProvider } from '../../src/locales';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import type { NativeSessionSummary, SessionEventRecord } from '../../src/lib/tauri-ipc';
import '../../src/index.css';

const state = { scenario: 'regular', calls: [] as { command: string; args: unknown }[] };
Object.assign(window, { attentionFixture: state });
const runtimeId = 'fixture-attention-layout';
const timestamp = '2026-09-10T00:00:00Z';
function events(): SessionEventRecord[] {
  const payloads: any[] = [
    { type: 'user_prompt', text: '检查 attention 布局', image_count: 0 },
    { type: 'assistant_chunk', text: Array.from({ length: 40 }, (_, i) => `Transcript 第 ${i + 1} 行：常规 attention 应占据布局空间。`).join('\n\n') },
  ];
  if (state.scenario === 'plan' || state.scenario === 'mixed') payloads.push({
    type: 'tool_use_started', tool_use_id: 'fixture-plan', raw_name: 'ExitPlanMode', needs_response: true,
    input_summary: '布局验证计划', category: { category: 'user_input', kind: 'plan_exit', raw_name: 'ExitPlanMode' },
    prompt: { prompt_type: 'plan_exit', allowed_prompts: ['继续执行'], plan_summary: '# 布局验证计划\n\n' + Array.from({ length: 18 }, (_, i) => `${i + 1}. 检查滚动区域与面板边界`).join('\n\n') },
  });
  return payloads.map((payload, index) => ({ runtime_id: runtimeId, seq: index + 1, occurred_at: timestamp, payload }));
}
mockWindows('main');
mockIPC(async (command, args) => {
  state.calls.push({ command, args });
  const records = events();
  if (command === 'get_settings') return { language: 'zh' };
  if (command === 'get_native_session_event_page') return { events: records, source_available: true, gap_detected: false, has_more: false, decode_failure_count: 0, oversized_event_count: 0, oldest_available_seq: 1, snapshot_newest_seq: records.length };
  if (command === 'get_native_session_events') return { events: records, source_available: true, gap_detected: false, oldest_available_seq: 1, newest_available_seq: records.length };
  if (command === 'get_native_session_input_queue') return ['regular', 'mixed', 'crowded'].includes(state.scenario)
    ? Array.from({ length: state.scenario === 'crowded' ? 20 : 1 }, (_, i) => ({ client_message_id: `fixture-queue-${i}`, display_text: i === 0 ? '一条排队中消息：检查 transcript 最后一行' : `排队消息 ${i + 1}`, images: [], delivery_state: 'pending' })) : [];
  if (command === 'get_session_subagents' || command === 'get_session_file_checkpoints' || command === 'list_workspace_session_references') return [];
  if (command === 'get_workspace_git_snapshot') return { is_git_repo: false, files: [] };
  if (command === 'get_native_session_usage') return null;
  return null;
}, { shouldMockEvents: true });
function Fixture() {
  const [scenario, setScenario] = useState('regular');
  state.scenario = scenario;
  const hasRegular = ['regular', 'mixed', 'crowded'].includes(scenario);
  const session: NativeSessionSummary = {
    runtime_id: runtimeId, provider: 'claude', transport: 'stdio' as any, project_dir: '/fixture/attention',
    env_name: 'fixture', perm_mode: 'dev', status: 'running', is_active: true,
    created_at: timestamp, updated_at: timestamp, can_handoff_to_terminal: false,
    background_tasks: hasRegular ? [{ task_id: 'fixture-task', description: '后台任务布局验证', status: 'running', started_at: timestamp, updated_at: timestamp }] : [],
  };
  return <LocaleProvider><TooltipProvider><main className="flex h-screen flex-col bg-background text-foreground">
    <nav className="relative z-50 flex shrink-0 gap-4 border-b bg-background p-2">
      {['none', 'regular', 'plan', 'mixed', 'crowded'].map((name) => <button key={name} data-scenario={name} onClick={() => setScenario(name)}>{name}</button>)}
      <span>合成数据 · 实际 WorkspaceNativeSessionView</span>
    </nav>
    <div className="min-h-0 flex-1"><WorkspaceNativeSessionView key={scenario} session={session} onStartNew={() => {}} /></div>
  </main></TooltipProvider></LocaleProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
