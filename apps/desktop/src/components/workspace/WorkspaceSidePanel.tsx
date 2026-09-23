import { createContext, useCallback, useContext, useMemo, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';
import { Bot, FileText, Globe, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';

export type WorkspaceSideTab = 'browser' | 'files' | 'agents';
interface SidePanelSelection {
  tab: WorkspaceSideTab | null;
  filePath?: string;
  revision: number;
}
export interface WorkspaceSidePanelController extends SidePanelSelection {
  ownerKey: string;
  target: HTMLDivElement | null;
  setTarget: (element: HTMLDivElement | null) => void;
  open: (tab: WorkspaceSideTab, filePath?: string, owner?: string) => () => void;
  revealBrowser: (owner: string) => () => void;
  close: () => void;
}
export const WorkspaceSidePanelContext = createContext<WorkspaceSidePanelController | null>(null);
export const useWorkspaceSidePanel = () => useContext(WorkspaceSidePanelContext);

export function useWorkspaceSidePanelController(ownerKey: string, browserVisible: boolean): WorkspaceSidePanelController {
  const [selections, setSelections] = useState<Record<string, SidePanelSelection>>({});
  const selectionsRef = useRef(selections);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const selection = selections[ownerKey];
  const tab = selection ? selection.tab : browserVisible ? 'browser' : null;
  const open = useCallback((nextTab: WorkspaceSideTab, filePath?: string, owner = ownerKey) => {
    const previous = selectionsRef.current[owner];
    const next = { tab: nextTab, filePath: filePath ?? previous?.filePath, revision: (previous?.revision ?? 0) + 1 };
    selectionsRef.current = { ...selectionsRef.current, [owner]: next };
    setSelections(selectionsRef.current);
    // Native browser activation may roll back only the selection it installed.
    return () => {
      if (selectionsRef.current[owner] !== next) return;
      const restored = { ...selectionsRef.current };
      if (previous) restored[owner] = previous;
      else delete restored[owner];
      selectionsRef.current = restored;
      setSelections(restored);
    };
  }, [ownerKey]);
  const revealBrowser = useCallback((owner: string) => {
    // Concurrent native requests share the first automatic selection/rollback.
    // Manual open() calls still install a fresh selection to fence that rollback.
    if (selectionsRef.current[owner]?.tab === 'browser') return () => {};
    return open('browser', undefined, owner);
  }, [open]);
  const close = useCallback(() => {
    const previous = selectionsRef.current[ownerKey];
    selectionsRef.current = { ...selectionsRef.current, [ownerKey]: { ...previous, tab: null, revision: (previous?.revision ?? 0) + 1 } };
    setSelections(selectionsRef.current);
  }, [ownerKey]);
  return useMemo(() => ({
    ownerKey, tab, filePath: selection?.filePath, revision: selection?.revision ?? 0,
    target, setTarget, open, revealBrowser, close,
  }), [ownerKey, tab, selection, target, open, revealBrowser, close]);
}

export function WorkspaceSidePanel({ controller, width, onResizeStart, onSelectBrowser, children }: {
  controller: WorkspaceSidePanelController;
  width: number;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onSelectBrowser: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <aside
      data-ccem-workspace-side-panel={controller.tab ?? 'closed'}
      className={cn('workspace-browser-panel relative min-h-0 shrink-0 flex-col overflow-hidden', controller.tab ? 'flex' : 'hidden')}
      style={{ flex: `0 0 ${width}%`, maxWidth: '60%', minWidth: 360 }}
    >
      <div data-ccem-side-panel-resize-handle className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none" onPointerDown={onResizeStart} />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/45 px-3">
        <Tabs value={controller.tab ?? 'browser'} onValueChange={(tab) => {
          if (tab === 'browser') onSelectBrowser();
          else controller.open(tab as WorkspaceSideTab);
        }} className="min-w-0 flex-1">
          <TabsList aria-label={t('workspace.sidePanelTitle')} className="h-8 bg-transparent p-0">
            <TabsTrigger value="browser" className="gap-1.5 px-2.5 text-xs"><Globe className="h-3.5 w-3.5" />{t('workspace.sidePanelBrowser')}</TabsTrigger>
            <TabsTrigger value="files" className="gap-1.5 px-2.5 text-xs"><FileText className="h-3.5 w-3.5" />{t('workspace.sidePanelFiles')}</TabsTrigger>
            <TabsTrigger value="agents" className="gap-1.5 px-2.5 text-xs"><Bot className="h-3.5 w-3.5" />{t('workspace.reviewSubagents')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('workspace.sidePanelClose')} onClick={controller.close}><X className="h-4 w-4" /></Button>
      </div>
      <div ref={controller.setTarget} data-ccem-side-panel-content role="region" aria-label={t(controller.tab === 'agents' ? 'workspace.reviewSubagents' : 'workspace.sidePanelFiles')} className={cn('min-h-0 flex-1 flex-col', controller.tab === 'files' || controller.tab === 'agents' ? 'flex' : 'hidden')} />
      {children}
    </aside>
  );
}
