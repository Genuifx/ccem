import { Star, Clock, Monitor, Brain, RefreshCw, FolderOpen, Play, X, Plus } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { getProjectName, truncatePath, formatRelativeTime } from '@/lib/utils';
import { shallow } from 'zustand/shallow';

interface ProjectListProps {
  onLaunch: (workingDir: string) => void;
}

export function ProjectList({ onLaunch }: ProjectListProps) {
  const { favorites, recent, vscodeProjects, jetbrainsProjects, setSelectedWorkingDir } = useAppStore(
    (state) => ({
      favorites: state.favorites,
      recent: state.recent,
      vscodeProjects: state.vscodeProjects,
      jetbrainsProjects: state.jetbrainsProjects,
      setSelectedWorkingDir: state.setSelectedWorkingDir,
    }),
    shallow
  );
  const {
    addFavoriteProject,
    removeFavoriteProject,
    openDirectoryPicker,
    syncVSCodeProjects,
    syncJetBrainsProjects
  } = useTauriCommands();
  const { t } = useLocale();

  const handleAddFavorite = async () => {
    const path = await openDirectoryPicker();
    if (path) {
      const name = getProjectName(path);
      await addFavoriteProject(path, name);
    }
  };

  const handleLaunch = (path: string) => {
    setSelectedWorkingDir(path);
    onLaunch(path);
  };

  const handleAddToFavorites = async (path: string) => {
    const name = getProjectName(path);
    await addFavoriteProject(path, name);
  };

  // Check if path is already in favorites
  const isFavorite = (path: string) => favorites.some(f => f.path === path);

  return (
    <div className="space-y-6">
      {/* Favorites Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Star className="w-4 h-4 text-primary" /> {t('workspace.favorites')}
          </h3>
          <Button variant="ghost" size="sm" onClick={handleAddFavorite}>
            <Plus className="w-3.5 h-3.5 mr-1" /> {t('common.save')}
          </Button>
        </div>
        {favorites.length === 0 ? (
          <p className="text-sm text-muted-foreground/70 py-2">{t('sessions.noActiveSessions')}</p>
        ) : (
          <div className="space-y-2">
            {favorites.map((project) => (
              <div
                key={project.path}
                className="flex items-center justify-between p-3 glass-list-item rounded-lg"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FolderOpen className="w-5 h-5 text-primary/60 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {project.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {truncatePath(project.path)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 text-primary hover:text-primary hover:bg-primary/[0.08]"
                    onClick={() => handleLaunch(project.path)}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 text-muted-foreground hover:text-destructive hover:bg-destructive/[0.08]"
                    onClick={() => removeFavoriteProject(project.path)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Section */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-muted-foreground" /> {t('workspace.recentHistory')}
        </h3>
        <div className="space-y-2">
          {recent.map((project) => (
            <div
              key={project.path}
              className="flex items-center justify-between p-3 glass-list-item rounded-lg"
            >
              <div className="flex items-center gap-3 min-w-0">
                <FolderOpen className="w-5 h-5 text-muted-foreground/60 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-foreground truncate">
                    {getProjectName(project.path)}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {truncatePath(project.path)}
                    {' · '}
                    <span className="text-primary">{formatRelativeTime(project.lastUsed, t)}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 text-primary hover:text-primary hover:bg-primary/[0.08]"
                  onClick={() => handleLaunch(project.path)}
                >
                  <Play className="w-3.5 h-3.5" />
                </Button>
                {!isFavorite(project.path) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 text-muted-foreground hover:text-primary hover:bg-primary/[0.08]"
                    onClick={() => handleAddToFavorites(project.path)}
                  >
                    <Star className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
          {/* "+ Add" card */}
          <button
            className="flex items-center justify-center gap-2 p-3 w-full rounded-lg glass-add-btn text-muted-foreground"
            onClick={handleAddFavorite}
          >
            <Plus className="w-4 h-4" />
            <span className="text-sm font-medium">{t('environments.addEnv')}</span>
          </button>
        </div>
      </div>

      {/* VS Code Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Monitor className="w-4 h-4 text-muted-foreground" /> VS Code
          </h3>
          <Button variant="ghost" size="sm" onClick={syncVSCodeProjects}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> {t('workspace.syncProjects')}
          </Button>
        </div>
        {vscodeProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground/70 py-2">{t('workspace.syncHintVSCode')}</p>
        ) : (
          <div className="space-y-2">
            {vscodeProjects.map((project) => (
              <div
                key={project.path}
                className="flex items-center justify-between p-3 glass-list-item rounded-lg"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FolderOpen className="w-5 h-5 text-muted-foreground/60 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {getProjectName(project.path)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {truncatePath(project.path)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 text-primary hover:text-primary hover:bg-primary/[0.08]"
                    onClick={() => handleLaunch(project.path)}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </Button>
                  {!isFavorite(project.path) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 text-muted-foreground hover:text-primary hover:bg-primary/[0.08]"
                      onClick={() => handleAddToFavorites(project.path)}
                    >
                      <Star className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* JetBrains Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Brain className="w-4 h-4 text-muted-foreground" /> JetBrains
          </h3>
          <Button variant="ghost" size="sm" onClick={syncJetBrainsProjects}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> {t('workspace.syncProjects')}
          </Button>
        </div>
        {jetbrainsProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground/70 py-2">{t('workspace.syncHintJetBrains')}</p>
        ) : (
          <div className="space-y-2">
            {jetbrainsProjects.map((project) => (
              <div
                key={project.path}
                className="flex items-center justify-between p-3 glass-list-item rounded-lg"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FolderOpen className="w-5 h-5 text-muted-foreground/60 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {getProjectName(project.path)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      <span className="text-chart-5">{project.ide}</span>
                      {' · '}
                      {truncatePath(project.path)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 text-primary hover:text-primary hover:bg-primary/[0.08]"
                    onClick={() => handleLaunch(project.path)}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </Button>
                  {!isFavorite(project.path) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 text-muted-foreground hover:text-primary hover:bg-primary/[0.08]"
                      onClick={() => handleAddToFavorites(project.path)}
                    >
                      <Star className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
