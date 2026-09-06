// Real Composer, isolated fake IPC. No runtime/session/user data mutations.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { WorkspaceSessionComposer } from '../../src/components/workspace/WorkspaceSessionComposer';
import { LocaleProvider } from '../../src/locales';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { Toaster } from 'sonner';
import '../../src/index.css';
const state = {
  reads: [] as string[], handoffs: [] as unknown[], submissions: [] as unknown[],
  emptyText: false, failRead: false, failSend: false, canSend: true, readDelay: 0,
};
Object.assign(window, { sessionReferenceFixture: state });
const fixtureInvoke = async (command: string, args: any = {}) => {
  if (command === 'list_workspace_session_references') return [
    { runtime_id: 'native-design', title: '设计方案', provider: 'claude', can_send: state.canSend },
    { runtime_id: 'native-review', title: '代码审查', provider: 'claude', can_send: false },
  ];
  if (command === 'read_workspace_session_reference') {
    state.reads.push(args.runtimeId);
    if (state.readDelay) await new Promise((resolve) => setTimeout(resolve, state.readDelay));
    if (state.failRead) throw Error('history unavailable');
    return { runtime_id: args.runtimeId, title: '设计方案', text_available: !state.emptyText, text: state.emptyText ? '' : 'User: 引用不应该发送消息。\nAssistant: 默认参考上下文，明确交接才发送。', truncated: true };
  }
  if (command === 'send_workspace_session_handoff') {
    state.handoffs.push(args);
    if (state.failSend) throw Error('unconfirmed');
    return null;
  }
  if (command === 'get_settings') return { language: 'zh' };
  return null;
};
if (!(window as any).__TAURI_INTERNALS__) {
  mockWindows('main');
  mockIPC(fixtureInvoke, { shouldMockEvents: true });
}
const fixtureClient = {
  list: (workingDir: string, currentRuntimeId?: string | null) => fixtureInvoke('list_workspace_session_references', { workingDir, currentRuntimeId }),
  read: (workingDir: string, runtimeId: string) => fixtureInvoke('read_workspace_session_reference', { workingDir, runtimeId }),
  send: (args: any) => fixtureInvoke('send_workspace_session_handoff', args),
};
function Fixture() {
  const [value, setValue] = useState('');
  const [revision, setRevision] = useState(0);
  return <LocaleProvider><TooltipProvider><main className="mx-auto max-w-3xl p-6" style={{ marginTop: 340 }}>
    <h1 className="mb-6 text-xl">会话引用与交接 · 行为夹具</h1>
    <WorkspaceSessionComposer key={revision} value={value} onValueChange={setValue}
      onSubmit={(payload) => { state.submissions.push(payload); return true; }}
      placeholder="输入 @ 引用会话或文件" canSubmit={Boolean(value.trim())} submitLabel="发送当前消息"
      sessionReferencesClient={fixtureClient as any} provider="claude" currentRuntimeId="native-current" workingDir="/fixture/project"
      searchWorkspaceFiles={async () => [{ path: '/fixture/project/README.md', relative_path: 'README.md', name: 'README.md', is_dir: false }]} />
    <button data-restore-draft onClick={() => setRevision((v) => v + 1)}>重新挂载草稿</button>
    <output data-persisted-draft>{value}</output>
  </main><Toaster /></TooltipProvider></LocaleProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
