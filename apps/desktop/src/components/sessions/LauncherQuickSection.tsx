import { useState } from 'react';
import { FolderOpen, Star, Clock, Check, Loader2, Columns2, LayoutGrid } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { LaunchButton } from '@/components/ui/LaunchButton';
import { useLocale } from '@/locales';
import { useAppStore, type ArrangeLayout } from '@/store';
import { shallow } from 'zustand/shallow';

interface LauncherQuickSectionProps {
  onLaunchMulti: (dirs: string[], layout: ArrangeLayout) => void;
  onBrowse: () => void;
  isLaunching: boolean;
}

export function LauncherQuickSection({ onLaunchMulti, onBrowse, isLaunching }: LauncherQuickSectionProps) {
  const { t } = useLocale();
  const { favorites, recent } = useAppStore(
    (state) => ({
      favorites: state.favorites,
      recent: state.recent,
    }),
    shallow
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Merge favorites + recent, dedup by path, favorites first, max 6
  const seen = new Set<string>();
  const projects: { path: string; name: string; isFavorite: boolean }[] = [];

  for (const fav of favorites) {
    if (!seen.has(fav.path)) {
      seen.add(fav.path);
      projects.push({ path: fav.path, name: fav.name, isFavorite: true });
    }
  }
  for (const rec of recent) {
    if (!seen.has(rec.path) && projects.length < 6) {
      seen.add(rec.path);
      const name = rec.path.split('/').pop() || rec.path;
      projects.push({ path: rec.path, name, isFavorite: false });
    }
  }

  const truncatePath = (path: string) =>
    path.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-2).join('/');

  const toggleSelect = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectedDirs = projects.filter(p => selected.has(p.path)).map(p => p.path);
  const count = selectedDirs.length;

  const handleLayoutLaunch = (layout: ArrangeLayout) => {
    if (count === 0 || isLaunching) return;
    const paneCount = layout === 'grid4' ? 4 : 2;
    // Fill panes: cycle through selected dirs to reach paneCount
    const dirs: string[] = [];
    for (let i = 0; i < paneCount; i++) {
      dirs.push(selectedDirs[i % count]);
    }
    onLaunchMulti(dirs, layout);
    setSelected(new Set());
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {count > 0
            ? t('sessions.selectDirs').replace('{count}', String(count))
            : t('sessions.quickLaunch')
          }
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onBrowse}
          disabled={isLaunching}
          className="text-2xs h-auto p-0"
        >
          <FolderOpen className="w-3 h-3" />
          {t('sessions.browseDir')}
        </Button>
      </div>

      {/* Project list */}
      {projects.length === 0 ? (
        <div className="py-6 text-center">
          <FolderOpen className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">{t('sessions.noRecentProjects')}</p>
        </div>
      ) : (
        <div className="space-y-0.5 -mx-1">
          {projects.map((project) => {
            const isSelected = selected.has(project.path);
            return (
              <button
                key={project.path}
                type="button"
                data-launcher-popover-row
                onClick={() => toggleSelect(project.path)}
                className={`
                  w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                  transition-all duration-150 cursor-pointer
                  ${isSelected
                    ? 'glass-subtle ring-1 ring-primary/40'
                    : 'glass-ghost-hover'
                  }
                `}
              >
                {/* Checkbox */}
                <div className={`
                  w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors
                  ${isSelected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'glass-checkbox-border'
                  }
                `}>
                  {isSelected && <Check className="w-2.5 h-2.5" />}
                </div>

                {/* Icon */}
                {project.isFavorite ? (
                  <Star className="w-3.5 h-3.5 text-warning shrink-0" />
                ) : (
                  <Clock className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                )}

                {/* Name + path stacked */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate leading-tight">
                    {project.name}
                  </div>
                  <div className="text-2xs text-muted-foreground/70 truncate leading-tight">
                    {truncatePath(project.path)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Action buttons — visible when 1+ selected */}
      {count >= 1 && (
        <div data-launcher-popover-action className="pt-3 glass-divider-top">
          {isLaunching ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground w-full justify-center py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('sessions.launching')}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-2xs text-muted-foreground">
                {t('sessions.launchCount').replace('{count}', String(count))}
              </p>
              <div className="flex gap-2">
                {/* Horizontal 2 button */}
                <LaunchButton
                  onClick={() => handleLayoutLaunch('horizontal2')}
                  size="sm"
                  className="flex-1"
                  icon={<Columns2 className="w-3.5 h-3.5" />}
                >
                  {t('sessions.layoutHorizontal2')}
                </LaunchButton>

                {/* Grid 4 button */}
                <LaunchButton
                  onClick={() => handleLayoutLaunch('grid4')}
                  size="sm"
                  className="flex-1"
                  icon={<LayoutGrid className="w-3.5 h-3.5" />}
                >
                  {t('sessions.layoutGrid4')}
                </LaunchButton>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
