import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { WorkspaceNativeSessionView } from '../../src/components/workspace/WorkspaceNativeSessionView';
import { LocaleProvider } from '../../src/locales';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import type { NativeSessionSummary } from '../../src/lib/tauri-ipc';

const endpoint = `http://127.0.0.1:${new URLSearchParams(location.search).get('port')}`;
if (!(window as any).__TAURI_INTERNALS__) {
  mockWindows('main');
  mockIPC(() => null, { shouldMockEvents: true });
}
Object.assign(globalThis, { __planContentInvoke: async (command: string, args: unknown) => {
  const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args }) });
  const value = await result.json();
  if (!result.ok) throw new Error(value.error);
  return value;
} });
async function mount() {
  const fixture = await fetch(endpoint).then(res => res.json());
  const session: NativeSessionSummary = {
    runtime_id: fixture.runtimeId, provider: 'claude', transport: 'stdio' as any,
    project_dir: fixture.workingDir, env_name: 'fixture', perm_mode: 'dev', status: 'processing', is_active: true,
    created_at: fixture.occurred_at, updated_at: fixture.occurred_at, can_handoff_to_terminal: false,
  };
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider><TooltipProvider><main className="flex h-screen flex-col bg-background text-foreground">
      <div className="shrink-0 border-b p-2 text-xs">Plan E2E · 生产 helper + 实际会话界面 · 确定性 SDK 夹具</div>
      <div className="min-h-0 flex-1"><WorkspaceNativeSessionView session={session} onStartNew={() => {}} /></div>
    </main></TooltipProvider></LocaleProvider>,
  );
}
void mount();
