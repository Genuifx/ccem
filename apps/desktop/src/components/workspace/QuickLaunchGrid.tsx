import { useRef, useState } from 'react';
import { Play, Plus, Star, ArrowRight, Code2, Sparkles, Clock } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLongPress } from '@/hooks/useLongPress';
import { useLocale } from '@/locales';
import { getProjectName, formatRelativeTime } from '@/lib/utils';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { AllProjectsModal } from './AllProjectsModal';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { shallow } from 'zustand/shallow';

interface QuickLaunchGridProps {
  onLaunch: (dir: string) => void;
}

const PROJECT_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-6)',
  'var(--primary)',
];

interface FavoriteCardProps {
  project: { path: string; name: string };
  color: string;
  onLaunch: (path: string) => void;
  onRemove: (path: string) => void;
}

function FavoriteCard({ project, color, onLaunch, onRemove }: FavoriteCardProps) {
  const [progress, setProgress] = useState(0);
  const [removing, setRemoving] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);

  const { handlers, firedRef } = useLongPress({
    duration: 600,
    onLongPress: () => {
      setRemoving(true);
      setTimeout(() => onRemove(project.path), 250);
    },
    onProgress: setProgress,
    onCancel: () => setProgress(0),
  });

  const handleClick = () => {
    if (firedRef.current) return;
    const card = cardRef.current;
    if (card && !shouldReduceMotion()) {
      gsap.timeline({ defaults: { overwrite: 'auto' } })
        .to(card, {
          scale: 0.985,
          duration: ccemMotion.duration.quick / 2,
          ease: 'power2.out',
        })
        .to(card, {
          scale: 1,
          duration: ccemMotion.duration.quick,
          ease: ccemMotion.ease.standard,
          onComplete: () => clearMotionProps(card),
        });
    }
    onLaunch(project.path);
  };

  const pressing = progress > 0 && !removing;

  useGSAP(() => {
    const card = cardRef.current;
    if (!card || !removing) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(card);
      return;
    }

    gsap.to(card, {
      autoAlpha: 0,
      y: -5,
      scale: 0.96,
      duration: ccemMotion.duration.base,
      ease: ccemMotion.ease.soft,
      overwrite: 'auto',
    });
  }, { scope: cardRef, dependencies: [removing] });

  return (
    <button
      ref={cardRef}
      data-quick-launch-card
      onClick={handleClick}
      {...handlers}
      className={cn(
        'group relative glass-subtle rounded-xl p-3 text-left transition-all duration-200 hover:bg-white/[0.06] hover:scale-[1.01] active:scale-[0.99] overflow-hidden select-none',
        removing && 'card-removing pointer-events-none',
      )}
      style={{ '--project-color': color } as React.CSSProperties}
      title={project.path}
    >
      {/* Left accent bar */}
      <div
        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full opacity-60 group-hover:opacity-100 transition-opacity"
        style={{ background: `hsl(${color})` }}
      />

      {/* Ambient glow on hover */}
      <div
        className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full opacity-0 group-hover:opacity-[0.08] transition-opacity blur-xl pointer-events-none"
        style={{ background: `hsl(${color})` }}
      />

      {/* Destructive overlay during long-press */}
      {pressing && (
        <div
          className="absolute inset-0 rounded-xl pointer-events-none transition-opacity"
          style={{
            background: `hsl(var(--destructive) / ${progress * 0.08})`,
          }}
        />
      )}

      <div className="relative flex items-start gap-3">
        {/* Icon */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-110"
          style={{ background: `hsl(${color} / 0.12)` }}
        >
          <Code2
            className="w-3.5 h-3.5"
            style={{ color: `hsl(${color})` }}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate mb-0.5">
            {project.name}
          </div>
          <div className="text-2xs text-muted-foreground/50 truncate font-mono">
            {project.path.split('/').slice(-2).join('/')}
          </div>
        </div>
      </div>

      {/* Hover play overlay — hidden during long-press */}
      {!pressing && (
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 bg-black/10 backdrop-blur-[2px] rounded-xl">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center shadow-lg"
            style={{
              background: `hsl(${color} / 0.9)`,
              boxShadow: `0 0 16px hsl(${color} / 0.4)`,
            }}
          >
            <Play className="w-3.5 h-3.5 text-white ml-0.5" />
          </div>
        </div>
      )}

      {/* Bottom progress bar during long-press */}
      {pressing && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${progress * 100}%`,
              background: `hsl(var(--destructive))`,
              boxShadow: `0 0 8px hsl(var(--destructive) / 0.6)`,
              transition: 'width 16ms linear',
            }}
          />
        </div>
      )}
    </button>
  );
}

export function QuickLaunchGrid({ onLaunch }: QuickLaunchGridProps) {
  const { t } = useLocale();
  const gridMotionRef = useRef<HTMLDivElement>(null);
  const { favorites, recent, setSelectedWorkingDir } = useAppStore(
    (state) => ({
      favorites: state.favorites,
      recent: state.recent,
      setSelectedWorkingDir: state.setSelectedWorkingDir,
    }),
    shallow
  );
  const { openDirectoryPicker, addFavoriteProject, removeFavoriteProject } = useTauriCommands();
  const [modalOpen, setModalOpen] = useState(false);

  const handleLaunch = (path: string) => {
    setSelectedWorkingDir(path);
    onLaunch(path);
  };

  const handleAddFavorite = async () => {
    const path = await openDirectoryPicker();
    if (path) {
      const name = getProjectName(path);
      await addFavoriteProject(path, name);
    }
  };

  const handleRemoveFavorite = async (path: string) => {
    await removeFavoriteProject(path);
    toast.success(t('workspace.favoriteRemoved'));
  };

  // Recent projects not already in favorites, max 4
  const favPaths = new Set(favorites.map(f => f.path));
  const recentFiltered = recent.filter(r => !favPaths.has(r.path)).slice(0, 4);

  // Show max 6 favorites
  const visibleFavorites = favorites.slice(0, 6);
  const favoriteMotionKey = visibleFavorites.map((project) => project.path).join('\u0000');
  const recentMotionKey = recentFiltered.map((project) => project.path).join('\u0000');

  useGSAP(() => {
    const root = gridMotionRef.current;
    if (!root) {
      return;
    }

    const cards = gsap.utils.toArray<HTMLElement>(
      '[data-quick-launch-card], [data-quick-launch-recent], [data-quick-launch-empty]',
      root
    );
    if (cards.length === 0) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(cards);
      return;
    }

    gsap.fromTo(
      cards,
      { autoAlpha: 0, y: 8, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(cards),
      }
    );
  }, { scope: gridMotionRef, dependencies: [favoriteMotionKey, recentMotionKey] });

  return (
    <>
      <div ref={gridMotionRef} className="flex flex-col glass-card glass-noise rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Star className="w-3.5 h-3.5 text-primary/60" />
            <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest">
              {t('workspace.favorites')}
            </h3>
            {visibleFavorites.length > 0 && (
              <span className="text-2xs font-semibold bg-primary/[0.12] text-primary px-2 py-0.5 rounded-full tabular-nums">
                {favorites.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-2xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
              onClick={handleAddFavorite}
            >
              <Plus className="w-3 h-3" />
              {t('workspace.addFavorite')}
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 p-3 overflow-y-auto flex flex-col">
          {visibleFavorites.length === 0 ? (
            <button
              data-quick-launch-empty
              onClick={handleAddFavorite}
              className="w-full h-full min-h-[140px] rounded-xl glass-ghost-card flex flex-col items-center justify-center gap-2.5 text-muted-foreground hover:text-foreground transition-all"
            >
              <div className="w-10 h-10 rounded-xl bg-primary/[0.08] flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-primary/60" />
              </div>
              <div className="text-center">
                <div className="text-sm font-medium">{t('workspace.addFirstFavorite')}</div>
                <div className="text-2xs text-muted-foreground/60 mt-1">
                  {t('workspace.quickAccessHint')}
                </div>
              </div>
            </button>
          ) : (
            <div className={cn(
              'grid gap-2.5',
              visibleFavorites.length >= 4 ? 'grid-cols-2' : 'grid-cols-1'
            )}>
              {visibleFavorites.map((project, i) => (
                <FavoriteCard
                  key={project.path}
                  project={project}
                  color={PROJECT_COLORS[i % PROJECT_COLORS.length]}
                  onLaunch={handleLaunch}
                  onRemove={handleRemoveFavorite}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer with recent projects */}
        {recentFiltered.length > 0 && (
          <div className="border-t border-white/[0.06] px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="text-2xs text-muted-foreground/50 uppercase tracking-widest flex-shrink-0 font-medium">
                {t('workspace.recentHistory')}
              </span>
              <div className="flex-1 flex items-center gap-2 overflow-x-auto scrollbar-hide">
                {recentFiltered.map((project) => (
                  <button
                    key={project.path}
                    data-quick-launch-recent
                    onClick={() => handleLaunch(project.path)}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs whitespace-nowrap',
                      'text-muted-foreground/60 hover:text-foreground',
                      'hover:bg-white/[0.04] transition-all flex-shrink-0'
                    )}
                  >
                    <Clock className="w-3 h-3 opacity-50" />
                    <span className="truncate max-w-[80px]">{getProjectName(project.path)}</span>
                    <span className="text-2xs opacity-40">{formatRelativeTime(project.lastUsed, t)}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-1 text-2xs text-primary/60 hover:text-primary transition-colors flex-shrink-0 font-medium"
              >
                {t('workspace.viewAll')}
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* View all when no recent */}
        {recentFiltered.length === 0 && visibleFavorites.length > 0 && (
          <div className="border-t border-white/[0.06] px-4 py-2.5 flex justify-end">
            <button
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1 text-2xs text-primary/60 hover:text-primary transition-colors font-medium"
            >
              {t('workspace.viewAll')}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      <AllProjectsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onLaunch={handleLaunch}
      />
    </>
  );
}
