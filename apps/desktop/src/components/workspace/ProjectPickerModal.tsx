import { memo, useDeferredValue, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Star,
  Clock,
  FolderOpen,
  RefreshCw,
  Code2,
  Play,
  X,
  FolderSearch,
} from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { getProjectName, formatRelativeTime, cn } from '@/lib/utils';
import { shallow } from 'zustand/shallow';

interface ProjectPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectProject: (path: string) => void;
  onBrowseFolder: () => void;
}

type Tab = 'favorites' | 'recent' | 'vscode' | 'jetbrains';

// Deterministic color from path for project avatars
function pathHue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = path.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

type ProjectEntry = { path: string; name?: string; time?: string; ide?: string };

// Memoized row — won't re-render when sync state changes
const ProjectRow = memo(({ project, onSelect }: {
  project: ProjectEntry;
  onSelect: (path: string) => void;
}) => {
  const { t } = useLocale();
  const hue = pathHue(project.path);
  const displayName = project.name || getProjectName(project.path);
  const shortPath = project.path.replace(/^\/Users\/[^/]+/, '~');

  return (
    <div
      onClick={() => onSelect(project.path)}
      className="flex items-center justify-between p-2.5 rounded-xl hover:bg-white/[0.04] transition-colors group cursor-pointer"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `hsl(${hue} / 0.12)` }}
        >
          <Code2 className="w-3.5 h-3.5" style={{ color: `hsl(${hue})` }} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {displayName}
          </div>
          <div className="text-2xs text-muted-foreground/50 truncate font-mono">
            {shortPath.split('/').slice(-2).join('/')}
            {project.ide && (
              <span className="text-primary/70 ml-1.5 font-sans">
                · {project.ide}
              </span>
            )}
            {project.time && (
              <span className="text-muted-foreground/40 ml-1.5 font-sans">
                · {formatRelativeTime(project.time, t)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-primary hover:bg-primary/[0.08]">
          <Play className="w-3.5 h-3.5" />
        </div>
      </div>
    </div>
  );
});

export function ProjectPickerModal({
  open,
  onOpenChange,
  onSelectProject,
  onBrowseFolder,
}: ProjectPickerModalProps) {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState<Tab>('favorites');
  const renderedTab = useDeferredValue(activeTab);
  const { favorites, recent, vscodeProjects, jetbrainsProjects } = useAppStore(
    (state) => ({
      favorites: state.favorites,
      recent: state.recent,
      vscodeProjects: state.vscodeProjects,
      jetbrainsProjects: state.jetbrainsProjects,
    }),
    shallow,
  );
  const { syncVSCodeProjects, syncJetBrainsProjects } = useTauriCommands();
  const [syncing, setSyncing] = useState<'vscode' | 'jetbrains' | null>(null);

  const handleSync = async (type: 'vscode' | 'jetbrains') => {
    setSyncing(type);
    try {
      if (type === 'vscode') await syncVSCodeProjects();
      else await syncJetBrainsProjects();
    } finally {
      setSyncing(null);
    }
  };

  const tabs = useMemo(() => [
    { key: 'favorites' as Tab, label: t('projectPicker.favorites'), icon: <Star className="w-3.5 h-3.5" /> },
    { key: 'recent' as Tab, label: t('projectPicker.recent'), icon: <Clock className="w-3.5 h-3.5" /> },
    { key: 'vscode' as Tab, label: t('projectPicker.vscode'), icon: <Code2 className="w-3.5 h-3.5" /> },
    { key: 'jetbrains' as Tab, label: t('projectPicker.jetbrains'), icon: <Code2 className="w-3.5 h-3.5" /> },
  ], [t]);

  // Normalize per-tab data once per project-store update.
  const allTabData = useMemo(() => ({
    favorites: { items: favorites.map(f => ({ path: f.path, name: f.name })), emptyText: t('projectPicker.noFavorites') },
    recent: { items: recent.map(r => ({ path: r.path, time: r.lastUsed })), emptyText: t('projectPicker.noRecent') },
    vscode: { items: vscodeProjects.map(v => ({ path: v.path })), emptyText: t('projectPicker.noVSCode') },
    jetbrains: { items: jetbrainsProjects.map(j => ({ path: j.path, ide: j.ide })), emptyText: t('projectPicker.noJetBrains') },
  }), [favorites, recent, vscodeProjects, jetbrainsProjects, t]);

  const { items, emptyText } = allTabData[renderedTab];

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center opacity-100">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />

      {/* Modal panel */}
      <div
        className="relative rounded-2xl w-[600px] max-h-[540px] flex flex-col"
        style={{
          background: 'hsl(var(--glass-bg) / 0.94)',
          border: '1px solid hsl(var(--glass-border-light) / var(--glass-border-opacity))',
          boxShadow: `
            inset 0 1px 0 0 hsl(var(--glass-inset-highlight) / var(--glass-inset-opacity)),
            0 12px 40px hsl(var(--glass-shadow-base) / 0.25),
            0 4px 12px hsl(var(--glass-shadow-base) / 0.1)
          `,
        }}
      >
        {/* ---- Header ---- */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-foreground tracking-wide">
            {t('projectPicker.title')}
          </h2>
          <button
            onClick={() => onOpenChange(false)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ---- Tabs (segmented control) ---- */}
        <div className="flex items-center gap-0.5 px-5 py-2.5 border-b border-white/[0.06]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                if (activeTab === tab.key) {
                  return;
                }

                setActiveTab(tab.key);
              }}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 flex items-center gap-1.5',
                activeTab === tab.key
                  ? 'seg-active text-foreground'
                  : 'text-muted-foreground/70 seg-hover',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}

          {/* Sync action for IDE tabs */}
          {(activeTab === 'vscode' || activeTab === 'jetbrains') && (
            <button
              onClick={() => handleSync(activeTab)}
              disabled={syncing === activeTab}
              className="ml-auto h-6 text-2xs gap-1.5 text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors flex items-center disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3 h-3', syncing === activeTab && 'animate-spin')} />
              {t('workspace.syncProjects')}
            </button>
          )}
        </div>

        {/* ---- Content: render only the active panel to keep tab switches cheap ---- */}
        <div className="flex-1 overflow-y-auto p-3 min-h-0" style={{ contain: 'paint' }}>
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-10 h-10 rounded-full bg-muted/20 flex items-center justify-center mb-3">
                <FolderOpen className="w-4 h-4 text-muted-foreground/30" />
              </div>
              <p className="text-xs text-muted-foreground/50">{emptyText}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {items.map((project) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  onSelect={onSelectProject}
                />
              ))}
            </div>
          )}
        </div>

        {/* ---- Footer: Browse folder ---- */}
        <div className="px-5 py-3.5 border-t border-white/[0.06]">
          <button
            onClick={onBrowseFolder}
            className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.04] transition-colors"
          >
            <FolderSearch className="w-4 h-4" />
            <span>{t('projectPicker.browseFolder')}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
