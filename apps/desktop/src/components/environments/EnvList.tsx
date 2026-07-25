import { useState } from 'react';
import { Copy, Edit2, Globe, Search, Trash2 } from '@/lib/lucide-react';
import { useAppStore, type Environment } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { ModelIcon } from '@/components/history/ModelIcon';
import { resolveEnvironmentIconHint } from '@/components/workspace/sessionTreeIcons';
import { Switch } from '@/components/ui/switch';
import {
  isEnvironmentEnabled,
  toggleEnabledEnvironment,
} from '@/lib/enabledEnvironments';
import { toast } from 'sonner';
import { shallow } from 'zustand/shallow';

function maskAuthToken(token?: string, notSet?: string): string {
  if (!token) return notSet || 'Not set';
  if (token.startsWith('enc:')) return '••••••••';
  if (token.length <= 7) return '****';
  return token.slice(0, 4) + '***' + token.slice(-3);
}

function extractDomain(url: string): string {
  if (!url) return 'api.anthropic.com';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

interface EnvListProps {
  onEdit?: (name: string) => void;
  onCopy?: (name: string) => void;
  onDelete?: (name: string) => void;
  viewMode?: 'grid' | 'list';
  /** When true, only show environments currently treated as enabled. */
  showEnabledOnly?: boolean;
}

export function EnvList({
  onEdit,
  onCopy,
  onDelete,
  viewMode = 'grid',
  showEnabledOnly = false,
}: EnvListProps) {
  const { environments, currentEnv, enabledEnvironments } = useAppStore(
    (state) => ({
      environments: state.environments,
      currentEnv: state.currentEnv,
      enabledEnvironments: state.enabledEnvironments,
    }),
    shallow
  );
  const { switchEnvironment, saveEnabledEnvironments } = useTauriCommands();
  const { t } = useLocale();
  const [filter, setFilter] = useState('');
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);

  if (environments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="w-12 h-12 rounded-xl border border-border-subtle bg-surface-raised flex items-center justify-center mb-3">
          <Globe className="w-6 h-6 text-muted-foreground/40" />
        </div>
        <h3 className="text-[15px] font-semibold text-foreground mb-1 tracking-[-0.22px]">
          {t('environments.noEnvTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('environments.noEnvHint')}</p>
      </div>
    );
  }

  const handleToggleEnabled = async (name: string) => {
    if (pendingToggle) return;
    setPendingToggle(name);
    try {
      const next = toggleEnabledEnvironment(
        name,
        enabledEnvironments,
        environments.map((env) => env.name),
      );
      await saveEnabledEnvironments(next);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setPendingToggle(null);
    }
  };

  // Filter environments by name or domain, optionally by enablement.
  const filtered = environments.filter((env) => {
    if (showEnabledOnly && !isEnvironmentEnabled(env.name, enabledEnvironments)) {
      return false;
    }
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      env.name.toLowerCase().includes(q) ||
      extractDomain(env.baseUrl).toLowerCase().includes(q)
    );
  });

  return (
    <div>
      {/* Search filter — show when 5+ environments */}
      {environments.length >= 5 && (
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('environments.searchPlaceholder') || '搜索环境...'}
            className="w-full h-8 pl-8 pr-3 rounded-lg border border-border-subtle bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/40 transition-colors"
          />
        </div>
      )}

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
          {filtered.map((env) => (
            <EnvGridCard
              key={env.name}
              name={env.name}
              env={env}
              isActive={env.name === currentEnv}
              isEnabled={isEnvironmentEnabled(env.name, enabledEnvironments)}
              isToggling={pendingToggle === env.name}
              onSelect={() => switchEnvironment(env.name)}
              onEdit={() => onEdit?.(env.name)}
              onCopy={() => onCopy?.(env.name)}
              onDelete={() => onDelete?.(env.name)}
              onToggleEnabled={() => void handleToggleEnabled(env.name)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((env) => (
            <EnvListCard
              key={env.name}
              name={env.name}
              env={env}
              isActive={env.name === currentEnv}
              isEnabled={isEnvironmentEnabled(env.name, enabledEnvironments)}
              isToggling={pendingToggle === env.name}
              onSelect={() => switchEnvironment(env.name)}
              onEdit={() => onEdit?.(env.name)}
              onCopy={() => onCopy?.(env.name)}
              onDelete={() => onDelete?.(env.name)}
              onToggleEnabled={() => void handleToggleEnabled(env.name)}
            />
          ))}
        </div>
      )}

      {filter && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t('common.noResults') || '没有匹配的环境'}
        </p>
      )}
    </div>
  );
}

interface EnvCardProps {
  name: string;
  env: Environment;
  isActive: boolean;
  isEnabled: boolean;
  isToggling: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
}

/**
 * Compact grid card — dense, scannable.
 * Management actions stay top-right; enable switch appears bottom-right on hover.
 */
function EnvGridCard({
  name,
  env,
  isActive,
  isEnabled,
  isToggling,
  onSelect,
  onEdit,
  onCopy,
  onDelete,
  onToggleEnabled,
}: EnvCardProps) {
  const { t } = useLocale();
  const iconHint = resolveEnvironmentIconHint(env) || env.defaultOpusModel || 'opus';
  const runtimeModel = env.runtimeModel || 'opus';

  return (
    <div
      className={cn(
        'group relative p-3 rounded-xl cursor-pointer border transition-all duration-150 active:scale-[0.97]',
        isActive
          ? 'border-primary/50 bg-primary/[0.03]'
          : 'border-border-subtle bg-surface-raised/60 hover:border-border hover:bg-surface-raised',
        !isEnabled && 'opacity-65',
      )}
      onClick={onSelect}
    >
      {/* Header: icon + name */}
      <div className="flex items-center gap-2 mb-2 pr-1">
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
          isActive
            ? 'bg-primary/10'
            : 'bg-background border border-border-subtle'
        )}>
          <ModelIcon model={iconHint} size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground truncate leading-tight">
            {name}
          </h3>
        </div>
        {isActive ? (
          <span className="flex h-2 w-2 shrink-0">
            <span className="inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
        ) : !isEnabled ? (
          <span className="shrink-0 rounded-full border border-border-subtle bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground group-hover:opacity-0 transition-opacity">
            {t('environments.disabledBadge')}
          </span>
        ) : null}
      </div>

      {/* Compact info */}
      <div className="space-y-0.5 text-[11px] text-muted-foreground pr-12">
        <p className="truncate">{extractDomain(env.baseUrl)}</p>
        <p className="truncate">
          <span className="text-muted-foreground/60">runtime:</span> {runtimeModel}
        </p>
      </div>

      {/* Management actions — top-right on hover */}
      <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
          title={t('environments.copyEnv')}
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Edit2 className="w-3 h-3" />
        </button>
        {name !== 'official' && (
          <button
            type="button"
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Enable switch — bottom-right on hover */}
      <div
        className="absolute bottom-2.5 right-2.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <Switch
          checked={isEnabled}
          disabled={isToggling}
          onCheckedChange={() => onToggleEnabled()}
          aria-label={isEnabled ? t('environments.disableEnv') : t('environments.enableEnv')}
          className="scale-90 origin-right"
        />
      </div>
    </div>
  );
}

/**
 * Compact list row — single line with key info.
 */
function EnvListCard({
  name,
  env,
  isActive,
  isEnabled,
  isToggling,
  onSelect,
  onEdit,
  onCopy,
  onDelete,
  onToggleEnabled,
}: EnvCardProps) {
  const { t } = useLocale();
  const runtimeModel = env.runtimeModel || 'opus';
  const iconHint = resolveEnvironmentIconHint(env) || env.defaultOpusModel || 'opus';

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer border transition-all duration-150 active:scale-[0.99]',
        isActive
          ? 'border-primary/50 bg-primary/[0.03]'
          : 'border-border-subtle bg-surface-raised/60 hover:border-border hover:bg-surface-raised',
        !isEnabled && 'opacity-65',
      )}
      onClick={onSelect}
    >
      {/* Icon */}
      <div className={cn(
        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
        isActive
          ? 'bg-primary/10'
          : 'bg-background border border-border-subtle'
      )}>
        <ModelIcon model={iconHint} size={16} />
      </div>

      {/* Name + domain */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <div className="min-w-0 flex-shrink-0" style={{ width: '120px' }}>
          <h3 className="text-[13px] font-semibold text-foreground truncate">{name}</h3>
        </div>
        <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">
          {extractDomain(env.baseUrl)}
        </span>
        <span className="text-[11px] text-muted-foreground truncate hidden lg:inline">
          runtime: {runtimeModel}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground/70 truncate hidden xl:inline">
          {maskAuthToken(env.authToken, t('environments.notSet'))}
        </span>
      </div>

      {/* Quiet disabled marker when not hovered */}
      {!isEnabled && (
        <span className="shrink-0 rounded-full border border-border-subtle bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground group-hover:hidden">
          {t('environments.disabledBadge')}
        </span>
      )}

      {/* Status */}
      {isActive && (
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="inline-flex rounded-full h-2 w-2 bg-primary"></span>
          <span className="text-[11px] font-medium text-primary hidden sm:inline">{t('environments.currentlyActive')}</span>
        </span>
      )}

      {/* Hover actions — management left, enable switch at the end (right) */}
      <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        {!isActive && (
          <button
            type="button"
            className="h-6 px-2 rounded-md text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
          >
            {t('environments.switchTo')}
          </button>
        )}
        <button
          type="button"
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
          title={t('environments.copyEnv')}
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Edit2 className="w-3 h-3" />
        </button>
        {name !== 'official' && (
          <button
            type="button"
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
        <div
          className="pl-1 border-l border-border-subtle"
          onClick={(e) => e.stopPropagation()}
        >
          <Switch
            checked={isEnabled}
            disabled={isToggling}
            onCheckedChange={() => onToggleEnabled()}
            aria-label={isEnabled ? t('environments.disableEnv') : t('environments.enableEnv')}
            className="scale-90"
          />
        </div>
      </div>
    </div>
  );
}
