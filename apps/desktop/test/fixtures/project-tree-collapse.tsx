import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectTree } from '../../src/components/workspace/ProjectTree';
import { LocaleProvider } from '../../src/locales';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import type { HistorySessionItem } from '../../src/features/conversations/types';

const sessions: HistorySessionItem[] = Array.from({ length: 40 }, (_, index) => ({
  id: `collapse-${index}`,
  source: 'claude',
  display: `Conversation ${index}`,
  project: `/fixture/project-${Math.floor(index / 8)}`,
  projectName: `Project ${Math.floor(index / 8)}`,
  timestamp: Date.now() - index * 60_000,
}));

function Fixture() {
  const [collapsed, setCollapsed] = useState(
    new URLSearchParams(location.search).has('collapsed'),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  return (
    <LocaleProvider>
      <TooltipProvider>
        <main className="flex h-screen flex-col bg-background text-foreground">
          <div className="h-12 shrink-0" />
          <div className="h-full min-h-0">
            <div className="flex h-full flex-col">
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div className="mx-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  {/* Mirrors the workspace top-bar toggle that owns collapse. */}
                  <div className="h-8 shrink-0">
                    <button type="button" onClick={() => setCollapsed((value) => !value)}>
                      {collapsed ? '展开侧边栏' : '收起侧边栏'}
                    </button>
                  </div>
                  <div className="workspace-main-container flex min-h-0 min-w-0 flex-1 overflow-hidden">
                    <ProjectTree
                      sessions={sessions}
                      isLoading={false}
                      selectedKey={selectedKey}
                      onSelect={(session) => setSelectedKey(`${session.source}:${session.id}`)}
                      onRefresh={() => {}}
                      width={280}
                      collapsed={collapsed}
                    />
                    <output data-testid="selection">{selectedKey ?? 'No conversation selected'}</output>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </TooltipProvider>
    </LocaleProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
