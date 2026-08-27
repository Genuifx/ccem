import { useEffect, useMemo, useState } from 'react';
import { Plus, Shield, ShieldCheck, ShieldOff, ShieldAlert, ShieldBan, Search, LayoutGrid, List } from '@/lib/lucide-react';
import { ErrorBanner } from '@/components/ui/EmptyState';
import { EnvList } from '@/components/environments';
import { EnvironmentsRouterRules } from '@/components/EnvironmentsRouterRules';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '../locales';
import { EnvironmentsSkeleton } from '@/components/ui/skeleton-states';
import { isEnvironmentEnabled } from '@/lib/enabledEnvironments';
import { ModelIcon } from '@/components/history/ModelIcon';
import { shallow } from 'zustand/shallow';

interface EnvironmentsProps {
  onAddEnv?: () => void;
  onEditEnv?: (name: string) => void;
  onCopyEnv?: (name: string) => void;
  onDeleteEnv?: (name: string) => void;
}

export function Environments({ onAddEnv, onEditEnv, onCopyEnv, onDeleteEnv }: EnvironmentsProps) {
  const { environments, permissionMode, defaultMode, setPermissionMode, setDefaultMode, isLoadingEnvs, error, enabledEnvironments } = useAppStore(
    (state) => ({
      environments: state.environments,
      permissionMode: state.permissionMode,
      defaultMode: state.defaultMode,
      setPermissionMode: state.setPermissionMode,
      setDefaultMode: state.setDefaultMode,
      isLoadingEnvs: state.isLoadingEnvs,
      error: state.error,
      enabledEnvironments: state.enabledEnvironments,
    }),
    shallow
  );
  const { t } = useLocale();
  const { loadEnvironments } = useTauriCommands();

  // View mode state with localStorage persistence
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    () => (localStorage.getItem('ccem-env-view-mode') as 'grid' | 'list') || 'grid'
  );

  // FTUE: read flag synchronously at mount
  const [hasAddedEnvs, setHasAddedEnvs] = useState(
    () => localStorage.getItem('ccem-ftue-envs-added') === 'true'
  );

  // Persist view mode to localStorage
  useEffect(() => {
    localStorage.setItem('ccem-env-view-mode', viewMode);
  }, [viewMode]);

  // FTUE: set flag when environments.length > 1
  useEffect(() => {
    if (environments.length > 1 && !hasAddedEnvs) {
      localStorage.setItem('ccem-ftue-envs-added', 'true');
      setHasAddedEnvs(true);
    }
  }, [environments.length, hasAddedEnvs]);

  // Whether to show the ghost card
  const showGhostCard = !hasAddedEnvs && environments.length <= 1;

  const enabledSummary = useMemo(() => {
    if (enabledEnvironments == null) {
      return {
        mode: 'legacy' as const,
        count: environments.length,
        items: environments,
      };
    }
    const items = environments.filter((env) =>
      isEnvironmentEnabled(env.name, enabledEnvironments),
    );
    return {
      mode: 'managed' as const,
      count: items.length,
      items,
    };
  }, [enabledEnvironments, environments]);

  // Show skeleton when environments are loading
  if (isLoadingEnvs) {
    return <EnvironmentsSkeleton />;
  }

  return (
    <div className="page-transition-enter w-full">
      {/* Error banner */}
      {error && error.includes('environment') && (
        <ErrorBanner
          message={t('environments.failedToLoad')}
          onRetry={loadEnvironments}
          retryLabel={t('common.retry')}
        />
      )}

      {/* Enabled environments overview — keep above the full card grid */}
      <section className="mb-4 rounded-xl border border-border-subtle bg-surface-raised/40 px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-foreground tracking-[-0.28px]">
              {t('environments.enabledEnvs')}
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
              {t('environments.enabledEnvsHint')}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border-subtle bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {enabledSummary.mode === 'legacy'
              ? t('environments.allEnabledLegacy')
              : t('environments.enabledCount').replace('{count}', String(enabledSummary.count))}
          </span>
        </div>

        {enabledSummary.items.length === 0 ? (
          <p className="text-[12px] text-muted-foreground py-1">
            {t('environments.enabledSectionEmpty')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {enabledSummary.items.map((env) => (
              <button
                key={env.name}
                type="button"
                onClick={() => onEditEnv?.(env.name)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-background px-2 py-0.5 text-[11px] text-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
                title={env.name}
              >
                <ModelIcon
                  model={env.defaultOpusModel || 'opus'}
                  size={11}
                />
                <span className="truncate max-w-[8.5rem]">{env.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Environment list section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[17px] font-semibold text-foreground tracking-[-0.37px]">
            {t('environments.configuredEnvs')}
          </h2>
          <div className="flex items-center gap-3">
            {/* View Mode Toggle */}
            <div className="flex items-center gap-0.5 p-[3px] rounded-full border border-border-subtle bg-surface-raised/50">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`h-7 w-7 rounded-full flex items-center justify-center transition-all duration-150 ${
                  viewMode === 'grid'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('environments.viewGrid')}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`h-7 w-7 rounded-full flex items-center justify-center transition-all duration-150 ${
                  viewMode === 'list'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('environments.viewList')}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* Add button — pill style */}
            <button
              type="button"
              onClick={() => onAddEnv?.()}
              className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-primary text-primary-foreground text-sm font-medium tracking-[-0.22px] transition-transform active:scale-95 hover:bg-primary-hover"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('environments.addEnv')}
            </button>
          </div>
        </div>

        <EnvList
          onEdit={onEditEnv}
          onCopy={onCopyEnv}
          onDelete={onDeleteEnv}
          viewMode={viewMode}
        />

        {/* FTUE: Ghost card for adding first environment */}
        {showGhostCard && (
          <button
            type="button"
            className="w-full mt-4 rounded-2xl border border-dashed border-border p-8 flex flex-col items-center justify-center cursor-pointer gap-2 group transition-colors hover:border-primary/40 hover:bg-primary/[0.02]"
            onClick={() => onAddEnv?.()}
          >
            <Plus className="w-5 h-5 text-muted-foreground/50 group-hover:text-primary/60 transition-colors" />
            <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
              {t('environments.addEnv')}
            </span>
            <span className="text-xs text-muted-foreground/60">
              {t('environments.ghostCardHint')}
            </span>
          </button>
        )}
      </section>

      {/* Permission Mode Section — surface color change as divider */}
      <section className="rounded-2xl bg-surface-raised/50 border border-border-subtle p-6">
        <div className="mb-5">
          <h2 className="text-[17px] font-semibold text-foreground tracking-[-0.37px] mb-1">
            {t('environments.permissionMode')}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('environments.userLevelHint')}
          </p>
        </div>

        {/* Permission Mode Chips — configurator-option-chip style */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
          {Object.entries(PERMISSION_PRESETS).map(([key]) => {
            const isActive = (defaultMode || permissionMode) === key;
            const ModeIcon = getModeIcon(key as PermissionModeName);
            const displayName = MODE_DISPLAY_NAMES[key as PermissionModeName] || key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  const mode = key as PermissionModeName;
                  setDefaultMode(mode);
                  setPermissionMode(mode);
                }}
                className={`text-left px-4 py-3 rounded-xl cursor-pointer border transition-all duration-150 active:scale-[0.97] ${
                  isActive
                    ? 'border-primary/60 bg-primary/[0.04] shadow-sm'
                    : 'border-border-subtle bg-background hover:border-border hover:bg-surface-raised/30'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <ModeIcon className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`text-sm font-semibold tracking-[-0.22px] ${isActive ? 'text-primary' : 'text-foreground'}`}>
                    {displayName}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/50 ml-auto">
                    {key}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 pl-6">
                  {t(`environments.permMode_${key}_desc`)}
                </p>
                {isActive && (
                  <p className="text-[11px] text-muted-foreground/70 leading-relaxed border-t border-border-subtle pt-2 mt-2 pl-6">
                    {t(`environments.permMode_${key}_detail`)}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Default routing rules + profile management (CCEM Router) */}
      <EnvironmentsRouterRules envNames={environments.map((e) => e.name)} />
    </div>
  );
}

const MODE_DISPLAY_NAMES: Record<PermissionModeName, string> = {
  yolo: 'YOLO',
  dev: 'Developer',
  readonly: 'Read Only',
  safe: 'Safe',
  ci: 'CI / CD',
  audit: 'Audit',
};

function getModeIcon(mode: PermissionModeName): typeof Shield {
  const iconMap: Record<PermissionModeName, typeof Shield> = {
    yolo: ShieldOff,
    dev: ShieldCheck,
    readonly: ShieldBan,
    safe: ShieldAlert,
    ci: ShieldCheck,
    audit: Search,
  };
  return iconMap[mode] || Shield;
}
