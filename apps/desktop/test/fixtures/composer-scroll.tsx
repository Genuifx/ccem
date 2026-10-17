// Production Composer, PromptArea, TriggerPopover and CSS with synthetic IPC.
// All actions are recorded locally; no runtime or user account is contacted.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { WorkspaceSessionComposer } from '../../src/components/workspace/WorkspaceSessionComposer';
import { LocaleProvider } from '../../src/locales';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { Button } from '../../src/components/ui/button';
import '../../src/index.css';

const proof = { answers: 0, flushed: 0, removed: [] as string[] };
Object.assign(window, { composerScrollFixture: proof });
mockWindows('main');
mockIPC(async (command) => {
  if (command === 'get_settings') return { language: 'en' };
  if (command === 'list_workspace_session_references') return [];
  return null;
}, { shouldMockEvents: true });
const scenarios = ['trigger', 'question', 'queue', 'trigger-queue', 'question-queue', 'all'];

function Composer({ scenario }: { scenario: string }) {
  const [value, setValue] = useState('');
  const question = scenario.includes('question') || scenario === 'all';
  const queue = scenario.includes('queue') || scenario === 'all';
  return <WorkspaceSessionComposer value={value} onValueChange={setValue}
    onSubmit={() => true} canSubmit={Boolean(value.trim())} submitLabel="Send message"
    placeholder="Type @file to show suggestions" provider="claude" workingDir="/fixture/project"
    searchWorkspaceFiles={async (_dir, _query, limit) => Array.from({ length: Math.min(limit ?? 8, 8) }, (_, i) => ({
      path: `/fixture/project/src/file-0${i}.tsx`, relative_path: `src/file-0${i}.tsx`, name: `file-0${i}.tsx`, is_dir: false,
    }))}
    aboveComposer={question ? <section data-scroll-question>
      <h2>Long question</h2>
      {Array.from({ length: 24 }, (_, i) => <p key={i} style={{ padding: '5px 0' }}>Question detail {i + 1}</p>)}
      <Button onClick={() => { proof.answers++; }}>Submit answer</Button>
    </section> : null}
    queuedMessages={queue ? Array.from({ length: 3 }, (_, i) => ({
      id: `queue-${i}`, text: `Queued message ${i + 1}`, displayText: `Queued message ${i + 1}`,
      deliveryState: 'pending' as const, removable: true, flushable: true,
    })) : []}
    queueCanFlush onFlushQueuedMessages={() => { proof.flushed++; }}
    onRemoveQueuedMessage={(id) => { proof.removed.push(id); }} />;
}

function Fixture() {
  const [scenario, setScenario] = useState('trigger');
  return <LocaleProvider><TooltipProvider><main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav style={{ padding: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {scenarios.map(name => <button key={name} data-scenario={name} onClick={() => setScenario(name)}>{name}</button>)}
    </nav>
    <p style={{ padding: 16 }}>Synthetic content · real Composer scrolling and actions</p>
    <div style={{ flex: 1, minHeight: 0 }} />
    <Composer key={scenario} scenario={scenario} />
  </main></TooltipProvider></LocaleProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
