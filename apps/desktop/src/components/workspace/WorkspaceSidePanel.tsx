import { createContext, useCallback, useContext, useMemo, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';
import { Bot, FileDiff, FolderSearch, Globe, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';

export type WorkspaceSideTab = 'browser' | 'changes' | 'browse' | 'agents';
export type WorkspaceSideFileMode = 'preview' | 'source' | 'diff';

export function isFileTab(tab: WorkspaceSideTab | null): tab is 'changes' | 'browse' {
  return tab === 'changes' || tab === 'browse';
}

interface SidePanelSelection {
  tab: WorkspaceSideTab | null;
  filePath?: string;
  fileMode?: WorkspaceSideFileMode;
  /** Per-tab requested file, so switching tabs never re-opens another tab's file. */
  filePaths?: Partial<Record<WorkspaceSideTab, string>>;
  fileModes?: Partial<Record<WorkspaceSideTab, WorkspaceSideFileMode>>;
  revision: number;
}
export interface WorkspaceSidePanelController extends SidePanelSelection {
  ownerKey: string;
  target: HTMLDivElement | null;
  setTarget: (element: HTMLDivElement | null) => void;
  open: (tab: WorkspaceSideTab, filePath?: string, owner?: string, fileMode?: WorkspaceSideFileMode) => () => void;
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
  const open = useCallback((nextTab: WorkspaceSideTab, filePath?: string, owner = ownerKey, fileMode?: WorkspaceSideFileMode) => {
    const previous = selectionsRef.current[owner];
    const filePaths = { ...(previous?.filePaths ?? {}) };
    const fileModes = { ...(previous?.fileModes ?? {}) };
    if (filePath !== undefined) {
      filePaths[nextTab] = filePath;
      if (fileMode !== undefined) fileModes[nextTab] = fileMode;
      else delete fileModes[nextTab];
    }
    // A requested file belongs to the tab it opened in. Switching tabs restores
    // that tab's own file instead of re-opening the other tab's selection.
    const next = {
      tab: nextTab,
      filePath: filePaths[nextTab],
      fileMode: filePaths[nextTab] !== undefined ? fileModes[nextTab] : undefined,
      filePaths,
      fileModes,
      revision: (previous?.revision ?? 0) + 1,
    };
    selectionsRef.current = { ...selectionsRef.current, [owner]: next };
    setSelections(selectionsRef.current);
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
    if (selectionsRef.current[owner]?.tab === 'browser') return () => {};
    return open('browser', undefined, owner);
  }, [open]);
  const close = useCallback(() => {
    const previous = selectionsRef.current[ownerKey];
    selectionsRef.current = { ...selectionsRef.current, [ownerKey]: { ...previous, tab: null, revision: (previous?.revision ?? 0) + 1 } };
    setSelections(selectionsRef.current);
  }, [ownerKey]);
  return useMemo(() => ({
    ownerKey, tab, filePath: selection?.filePath, fileMode: selection?.fileMode, revision: selection?.revision ?? 0,
    target, setTarget, open, revealBrowser, close,
  }), [ownerKey, tab, selection, target, open, revealBrowser, close]);
}

export function WorkspaceSidePanel({ controller, width, onResizeStart, onSelectBrowser, changeCount, children }: {
  controller: WorkspaceSidePanelController;
  width: number;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onSelectBrowser: () => void;
  changeCount?: number;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const tabs: { key: WorkspaceSideTab; icon: typeof Globe; label: string; count?: number }[] = [
    { key: 'browser', icon: Globe, label: t('workspace.sidePanelBrowser') },
    { key: 'changes', icon: FileDiff, label: t('workspace.sidePanelChanges'), count: changeCount },
    { key: 'browse', icon: FolderSearch, label: t('workspace.scopeBrowseShort') },
    { key: 'agents', icon: Bot, label: t('workspace.sidePanelAgents') },
  ];
  return (
    <aside
      data-ccem-workspace-side-panel={controller.tab ?? 'closed'}
      className={cn('workspace-browser-panel relative min-h-0 shrink-0 flex-col overflow-hidden', controller.tab ? 'flex' : 'hidden')}
      style={{ flex: `0 0 ${width}%`, maxWidth: '60%', minWidth: 360 }}
    >
      <div data-ccem-side-panel-resize-handle className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none" onPointerDown={onResizeStart} />
      <div className="workspace-browser-chrome flex h-9 shrink-0 items-center border-b border-border/45 px-1">
        <div className="flex min-w-0 flex-1 items-center" role="tablist" aria-label={t('workspace.sidePanelTitle')}>
          {tabs.map(({ key, icon: Icon, label, count }) => (
            <button
              key={key}
              role="tab"
              aria-selected={controller.tab === key}
              onClick={() => {
                if (key === 'browser') onSelectBrowser();
                else controller.open(key);
              }}
              className={cn(
                'inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-2xs font-medium transition-colors',
                controller.tab === key
                  ? 'bg-muted/60 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
              {count !== undefined && count > 0 && (
                <span className="ml-0.5 rounded-full bg-muted/60 px-1 text-[9px] leading-4 tabular-nums opacity-80">{count}</span>
              )}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('workspace.sidePanelClose')} onClick={controller.close}><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div ref={controller.setTarget} data-ccem-side-panel-content role="region" aria-label={t(controller.tab === 'agents' ? 'workspace.reviewSubagents' : 'workspace.sidePanelFiles')} className={cn('min-h-0 flex-1 flex-col', isFileTab(controller.tab) || controller.tab === 'agents' ? 'flex' : 'hidden')} />
      {children}
    </aside>
  );
}
