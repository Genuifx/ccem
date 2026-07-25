import { useState } from 'react';
import { Check, Copy, Link2, Play, Star, X, RefreshCw, Plus, Code2 } from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BindToTelegramDialog } from '@/components/telegram/BindToTelegramDialog';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { copyBindCommand } from '@/lib/telegram-utils';
import { getProjectName, truncatePath, formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { shallow } from 'zustand/shallow';

interface AllProjectsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (dir: string) => void;
}

type Tab = 'favorites' | 'recent' | 'vscode' | 'jetbrains';

export function AllProjectsModal({ open, onOpenChange, onLaunch }: AllProjectsModalProps) {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState<Tab>('favorites');
  const {
    favorites,
    recent,
    vscodeProjects,
    jetbrainsProjects,
    currentEnv,
    permissionMode,
  } = useAppStore(
    (state) => ({
      favorites: state.favorites,
      recent: state.recent,
      vscodeProjects: state.vscodeProjects,
      jetbrainsProjects: state.jetbrainsProjects,
      currentEnv: state.currentEnv,
      permissionMode: state.permissionMode,
    }),
    shallow
  );
  const {
    addFavoriteProject,
    removeFavoriteProject,
    openDirectoryPicker,
    syncVSCodeProjects,
    syncJetBrainsProjects,
  } = useTauriCommands();
  const [syncing, setSyncing] = useState<'vscode' | 'jetbrains' | null>(null);

  if (!open) return null;

  const isFavorite = (path: string) => favorites.some(f => f.path === path);

  const handleAddFavorite = async () => {
    const path = await openDirectoryPicker();
    if (path) {
      await addFavoriteProject(path, getProjectName(path));
    }
  };

  const handleSync = async (type: 'vscode' | 'jetbrains') => {
    setSyncing(type);
    try {
      if (type === 'vscode') await syncVSCodeProjects();
      else await syncJetBrainsProjects();
    } finally {
      setSyncing(null);
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'favorites', label: t('workspace.tabFavorites') },
    { key: 'recent', label: t('workspace.tabRecent') },
    { key: 'vscode', label: t('workspace.tabVSCode') },
    { key: 'jetbrains', label: t('workspace.tabJetBrains') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />

      {/* Modal */}
      <div className="relative frosted-panel glass-noise rounded-2xl w-[540px] max-h-[500px] flex flex-col shadow-elevation-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-foreground tracking-wide">{t('workspace.allProjects')}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 text-muted-foreground/60 hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 px-5 py-2.5 border-b border-white/[0.06]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150',
                activeTab === tab.key
                  ? 'seg-active text-foreground'
                  : 'text-muted-foreground/70 seg-hover'
              )}
            >
              {tab.label}
            </button>
          ))}

          {/* Sync button for vscode/jetbrains tabs */}
          {(activeTab === 'vscode' || activeTab === 'jetbrains') && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-2xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
              onClick={() => handleSync(activeTab)}
              disabled={syncing !== null}
            >
              <RefreshCw className={cn('w-3 h-3', syncing === activeTab && 'animate-spin')} />
              {t('workspace.syncProjects')}
            </Button>
          )}

          {activeTab === 'favorites' && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-2xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
              onClick={handleAddFavorite}
            >
              <Plus className="w-3 h-3" />
              {t('workspace.addFavorite')}
            </Button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="space-y-0.5">
            {activeTab === 'favorites' && favorites.map((project) => (
              <ProjectRow
                key={project.path}
                name={project.name}
                path={project.path}
                onLaunch={() => { onLaunch(project.path); onOpenChange(false); }}
                trailing={
                  <>
                    <CopyBindActionButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    <BindProjectButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/[0.08]"
                      onClick={() => removeFavoriteProject(project.path)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </>
                }
              />
            ))}

            {activeTab === 'recent' && recent.map((project) => (
              <ProjectRow
                key={project.path}
                name={getProjectName(project.path)}
                path={project.path}
                subtitle={formatRelativeTime(project.lastUsed, t)}
                onLaunch={() => { onLaunch(project.path); onOpenChange(false); }}
                trailing={
                  <>
                    <CopyBindActionButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    <BindProjectButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    {!isFavorite(project.path) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7 text-muted-foreground/40 hover:text-primary hover:bg-primary/[0.08]"
                        onClick={() => addFavoriteProject(project.path, getProjectName(project.path))}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))}

            {activeTab === 'vscode' && vscodeProjects.map((project) => (
              <ProjectRow
                key={project.path}
                name={getProjectName(project.path)}
                path={project.path}
                onLaunch={() => { onLaunch(project.path); onOpenChange(false); }}
                trailing={
                  <>
                    <CopyBindActionButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    <BindProjectButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    {!isFavorite(project.path) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7 text-muted-foreground/40 hover:text-primary hover:bg-primary/[0.08]"
                        onClick={() => addFavoriteProject(project.path, getProjectName(project.path))}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))}

            {activeTab === 'jetbrains' && jetbrainsProjects.map((project) => (
              <ProjectRow
                key={project.path}
                name={getProjectName(project.path)}
                path={project.path}
                subtitle={project.ide}
                onLaunch={() => { onLaunch(project.path); onOpenChange(false); }}
                trailing={
                  <>
                    <CopyBindActionButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    <BindProjectButton
                      path={project.path}
                      envName={currentEnv}
                      permMode={permissionMode}
                    />
                    {!isFavorite(project.path) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7 text-muted-foreground/40 hover:text-primary hover:bg-primary/[0.08]"
                        onClick={() => addFavoriteProject(project.path, getProjectName(project.path))}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyBindActionButton({
  path,
  envName,
  permMode,
}: {
  path: string;
  envName?: string | null;
  permMode?: string | null;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyBindCommand(path, envName, permMode);
      setCopied(true);
      toast.success(t('telegram.bindCommandCopied'));
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast.error(t('telegram.bindCommandCopyFailed').replace('{error}', String(error)));
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="w-7 h-7 text-muted-foreground/40 hover:text-foreground hover:bg-white/[0.08]"
      onClick={handleCopy}
      title={t('telegram.copyBindCommand')}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </Button>
  );
}

function BindProjectButton({
  path,
  envName,
  permMode,
}: {
  path: string;
  envName?: string | null;
  permMode?: string | null;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="w-7 h-7 text-muted-foreground/40 hover:text-primary hover:bg-primary/[0.08]"
        onClick={() => setOpen(true)}
        title={t('telegram.bindToTopic')}
      >
        <Link2 className="w-3.5 h-3.5" />
      </Button>
      <BindToTelegramDialog
        open={open}
        onOpenChange={setOpen}
        initialProjectDir={path}
        initialEnvName={envName}
        initialPermMode={permMode}
      />
    </>
  );
}

function ProjectRow({
  name,
  path,
  subtitle,
  onLaunch,
  trailing,
}: {
  name: string;
  path: string;
  subtitle?: string;
  onLaunch: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between p-2.5 rounded-xl hover:bg-white/[0.04] transition-colors group">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-7 h-7 rounded-lg bg-white/[0.06] flex items-center justify-center flex-shrink-0 group-hover:bg-white/[0.10] transition-colors">
          <Code2 className="w-3.5 h-3.5 text-muted-foreground/60" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{name}</div>
          <div className="text-2xs text-muted-foreground/50 truncate">
            {truncatePath(path)}
            {subtitle && <> · <span className="text-primary/70">{subtitle}</span></>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="w-7 h-7 text-primary hover:text-primary hover:bg-primary/[0.08]"
          onClick={onLaunch}
        >
          <Play className="w-3.5 h-3.5" />
        </Button>
        {trailing}
      </div>
    </div>
  );
}
