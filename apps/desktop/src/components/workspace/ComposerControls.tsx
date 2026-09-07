import { useState, useEffect, useMemo } from 'react';
import {
  Check,
  ChevronDown,
  Gauge,
  Lock,
  Search,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldOff,
} from '@/lib/lucide-react';
import { ModelIcon } from '@/components/history/ModelIcon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import type { Environment } from '@/store';
import { resolveEnvironmentIconHint } from '@/components/workspace/sessionTreeIcons';
import { filterRuntimeEnvironments } from '@/lib/enabledEnvironments';
import {
  getWorkspacePermissionModeDisplayName,
  normalizeWorkspacePermissionModeName,
  type WorkspacePermissionModeName,
} from '@/components/workspace/workspacePermissionModes';

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const normalizePermissionModeName = normalizeWorkspacePermissionModeName;

const CLAUDE_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORT_LEVELS: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const EFFORT_I18N_KEYS: Record<EffortLevel, string> = {
  minimal: 'workspace.effortMinimal',
  low: 'workspace.effortLow',
  medium: 'workspace.effortMedium',
  high: 'workspace.effortHigh',
  xhigh: 'workspace.effortXhigh',
  max: 'workspace.effortMax',
};

function getModeIcon(mode: WorkspacePermissionModeName): typeof Shield {
  const iconMap: Record<WorkspacePermissionModeName, typeof Shield> = {
    yolo: ShieldOff,
    dev: ShieldCheck,
    readonly: ShieldBan,
    safe: ShieldAlert,
    ci: ShieldCheck,
    audit: Search,
  };
  return iconMap[mode] || Shield;
}

function isRiskyPermissionMode(mode: WorkspacePermissionModeName) {
  return mode === 'yolo';
}

/** Aggregated main model behind the environment's "opus" tier — the card's primary line. */
function environmentOpusModelLabel(environment: Environment): string {
  return environment.defaultOpusModel || environment.runtimeModel || 'opus';
}

/**
 * Discrete effort slider, styled after the reference: a continuous pill track
 * (solid primary fill + neutral rest), small stop dots visible only on the
 * unfilled portion, and an oversized white circular thumb. The painted track
 * is inset by half the thumb width so fill edge, stop dots and thumb stops all
 * land on the same positions. Current value is shown beside the section label.
 */
function EffortSlider({
  levels,
  value,
  onChange,
  ariaLabel,
}: {
  levels: EffortLevel[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  ariaLabel: string;
}) {
  const lastIndex = levels.length - 1;
  const activeIndex = Math.max(0, levels.indexOf(value));
  const fillPct = lastIndex === 0 ? 100 : (activeIndex / lastIndex) * 100;

  return (
    <div className="select-none pt-1 pb-3.5">
      <div className="relative flex h-7 items-center">
        <div className="pointer-events-none absolute inset-x-[13px] h-3 rounded-full bg-foreground/[0.16]">
          {levels.slice(1).map((level, index) => (
            <span
              key={level}
              className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/50"
              style={{ left: `${((index + 1) / lastIndex) * 100}%` }}
            />
          ))}
          <div
            className="absolute left-0 top-0 h-3 rounded-full bg-primary"
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={lastIndex}
          step={1}
          value={activeIndex}
          aria-label={ariaLabel}
          onChange={(event) => onChange(levels[Number(event.target.value)])}
          className={cn(
            'relative h-7 w-full cursor-grab appearance-none bg-transparent outline-none',
            'active:cursor-grabbing',
            '[&::-webkit-slider-thumb]:h-[26px] [&::-webkit-slider-thumb]:w-[26px] [&::-webkit-slider-thumb]:appearance-none',
            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
            '[&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.25),0_0_1px_rgba(0,0,0,0.15)]',
            '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100',
            '[&:active::-webkit-slider-thumb]:scale-110',
            '[&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-primary/40',
            '[&::-moz-range-thumb]:h-[26px] [&::-moz-range-thumb]:w-[26px] [&::-moz-range-thumb]:appearance-none',
            '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-white',
          )}
        />
      </div>
    </div>
  );
}

export function providerDisplayName(client: string) {
  if (client === 'codex') return 'Codex';
  if (client === 'opencode') return 'OpenCode';
  return 'Claude';
}

function EnvironmentLobeIcon({ hint, size = 14 }: { hint?: string; size?: number }) {
  return <ModelIcon model={hint} size={size} className="shrink-0" disableContrastBg />;
}

export interface ComposerControlsProps {
  provider: string;
  envName: string;
  permMode: WorkspacePermissionModeName;
  effort: EffortLevel;
  environments: Environment[];
  /** null = legacy all-enabled; string[] = explicit enable list */
  enabledEnvironments?: string[] | null;
  /** Exact routed-history resumes keep their frozen main environment. */
  environmentLocked?: boolean;
  onEnvChange: (envName: string) => void;
  onPermModeChange: (mode: PermissionModeName) => void;
  onEffortChange: (effort: EffortLevel) => void;
}

export function ComposerControls({
  provider,
  envName,
  permMode,
  effort,
  environments,
  enabledEnvironments = null,
  environmentLocked = false,
  onEnvChange,
  onPermModeChange,
  onEffortChange,
}: ComposerControlsProps) {
  const { t } = useLocale();
  const normalizedPermMode = normalizeWorkspacePermissionModeName(permMode);
  const [permissionPreviewMode, setPermissionPreviewMode] = useState<WorkspacePermissionModeName>(
    normalizedPermMode,
  );
  const [permissionSelectOpen, setPermissionSelectOpen] = useState(false);
  const [envEffortOpen, setEnvEffortOpen] = useState(false);

  useEffect(() => {
    if (!permissionSelectOpen) {
      setPermissionPreviewMode(normalizedPermMode);
    }
  }, [normalizedPermMode, permissionSelectOpen]);

  const permissionModes = useMemo(
    () => Object.keys(PERMISSION_PRESETS) as PermissionModeName[],
    [],
  );

  const selectableEnvironments = useMemo(
    () => filterRuntimeEnvironments(environments, enabledEnvironments, { currentEnv: envName }),
    [enabledEnvironments, envName, environments],
  );

  /** Two-level menu: level 1 groups every environment by its aggregated opus model. */
  const groupedEnvironments = useMemo(() => {
    const byModel = new Map<string, Environment[]>();
    for (const environment of selectableEnvironments) {
      const model = environmentOpusModelLabel(environment);
      const bucket = byModel.get(model);
      if (bucket) {
        bucket.push(environment);
      } else {
        byModel.set(model, [environment]);
      }
    }
    return [...byModel.entries()].map(([model, envs]) => ({ model, envs }));
  }, [selectableEnvironments]);

  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const currentEnvironment = environments.find((e) => e.name === envName);
  const currentEnvironmentIconHint = resolveEnvironmentIconHint(currentEnvironment);
  const currentModel = currentEnvironment ? environmentOpusModelLabel(currentEnvironment) : null;

  // Each time the popover opens, expand the group holding the current environment.
  useEffect(() => {
    if (envEffortOpen) {
      setExpandedModel(currentModel);
    }
  }, [envEffortOpen]);
  const isCodexProvider = provider === 'codex';
  const isEnvironmentLocked = isCodexProvider || environmentLocked;
  const environmentLockedBadge = isCodexProvider
    ? t('workspace.codexModelSelectorDisabledBadge')
    : t('workspace.historyRouterEnvLockedBadge');
  const environmentLockedHint = isCodexProvider
    ? t('workspace.codexModelSelectorDisabledHint')
    : t('workspace.historyRouterEnvLockedHint');
  const permissionPreview = {
    desc: t(`environments.permMode_${permissionPreviewMode}_desc`),
    detail: t(`environments.permMode_${permissionPreviewMode}_detail`),
  };

  const effortLevels = isCodexProvider ? CODEX_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Popover open={envEffortOpen} onOpenChange={setEnvEffortOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 min-w-0 max-w-full items-center gap-2 rounded-xl px-2.5 text-[12px] text-foreground',
              'cursor-pointer outline-none transition-all duration-150',
              'hover:bg-white/[0.06] focus:ring-2 focus:ring-primary/30',
              'max-[760px]:px-1.5',
            )}
          >
            <span
              className={cn(
                'flex min-w-0 items-center gap-2',
                isEnvironmentLocked && 'text-muted-foreground/65',
              )}
            >
              <span className={cn('flex shrink-0', isEnvironmentLocked && 'opacity-45 grayscale')}>
                <EnvironmentLobeIcon hint={currentEnvironmentIconHint} />
              </span>
              <span className="min-w-0 max-w-[120px] truncate max-[760px]:hidden">{envName}</span>
              {isEnvironmentLocked && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                      <Lock className="h-2.5 w-2.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px] text-[12px] leading-5">
                    {environmentLockedHint}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
            <span className="text-muted-foreground/60 max-[760px]:hidden">·</span>
            <Gauge className="h-3 w-3 shrink-0 text-muted-foreground max-[760px]:hidden" />
            <span className="shrink-0 whitespace-nowrap text-muted-foreground max-[760px]:hidden">{t(EFFORT_I18N_KEYS[effort])}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-auto min-w-[300px] max-h-[min(400px,var(--radix-popover-content-available-height))] flex flex-col rounded-xl border border-border/40 bg-popover p-0 shadow-md"
        >
          <div className="shrink-0 p-1.5 pb-0">
            <div className="flex items-center justify-between gap-3 px-2 py-1.5">
              <span className="text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
                {t('workspace.effortLabel')}
              </span>
              <span className="text-2xs font-medium normal-case tracking-normal text-primary">
                {t(EFFORT_I18N_KEYS[effort])}
              </span>
            </div>
            <div className="px-2">
              <EffortSlider
                levels={effortLevels}
                value={effort}
                onChange={onEffortChange}
                ariaLabel={t('workspace.effortLabel')}
              />
            </div>
            <div className="mx-2 my-1.5 h-px border-t border-border/50" />
            <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
              <span>{t('workspace.environmentLabel')}</span>
              {isEnvironmentLocked && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 normal-case tracking-normal text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" />
                  {environmentLockedBadge}
                </span>
              )}
            </div>
            {isEnvironmentLocked && (
              <p className="mx-2 mb-2 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                {environmentLockedHint}
              </p>
            )}
          </div>
          <ScrollArea
            type="always"
            data-ccem-composer-environment-scroll
            className="min-h-0 max-h-[260px]"
            viewportClassName="pr-1"
          >
            <div className="flex flex-col gap-1 p-1.5 pt-0 pr-2">
              {groupedEnvironments.map((group) => {
                const isExpanded = expandedModel === group.model;
                const isCurrentGroup = currentModel === group.model;
                const groupIconEnv = group.envs.find((e) => e.name === envName) || group.envs[0];
                return (
                  <div key={group.model} className="flex flex-col gap-1">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-left outline-none',
                        'cursor-pointer transition-colors',
                        'border-transparent hover:border-border/60 hover:bg-white/[0.05]',
                        isCurrentGroup && 'border-primary/50 bg-primary/[0.06]',
                        isEnvironmentLocked && 'opacity-80',
                      )}
                      onClick={() => setExpandedModel(isExpanded ? null : group.model)}
                    >
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-background/60',
                          isEnvironmentLocked && 'opacity-60 grayscale',
                        )}
                      >
                        <EnvironmentLobeIcon
                          hint={resolveEnvironmentIconHint(groupIconEnv)}
                          size={14}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium leading-4 text-foreground">
                          {group.model}
                        </span>
                        {isCurrentGroup && (
                          <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                            {envName}
                          </span>
                        )}
                      </span>
                      {group.envs.length > 1 && (
                        <span className="shrink-0 rounded-full border border-border/50 bg-muted/30 px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                          {group.envs.length}
                        </span>
                      )}
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
                          isExpanded && 'rotate-180',
                        )}
                      />
                    </button>
                    {isExpanded && (
                      <div className="ml-12 flex flex-col gap-0.5 border-l border-border/50 pl-2.5 pr-1">
                        {group.envs.map((environment) => (
                          <button
                            key={environment.name}
                            type="button"
                            disabled={isEnvironmentLocked}
                            aria-disabled={isEnvironmentLocked}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] outline-none',
                              'transition-colors',
                              isEnvironmentLocked
                                ? 'cursor-not-allowed text-muted-foreground/45'
                                : 'cursor-pointer glass-dropdown-item',
                              !isEnvironmentLocked && environment.name === envName && 'text-primary',
                            )}
                            onClick={() => {
                              if (isEnvironmentLocked) {
                                return;
                              }
                              onEnvChange(environment.name);
                              setEnvEffortOpen(false);
                            }}
                          >
                            <span className="flex-1 truncate text-left">{environment.name}</span>
                            {environment.name === envName && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <Select
        value={normalizedPermMode}
        open={permissionSelectOpen}
        onOpenChange={(open) => {
          setPermissionSelectOpen(open);
          if (open) {
            setPermissionPreviewMode(normalizedPermMode);
          }
        }}
        onValueChange={(value) => {
          const mode = value as PermissionModeName;
          onPermModeChange(mode);
          setPermissionPreviewMode(mode);
        }}
      >
        <SelectTrigger
          variant="plain"
          className={cn(
            'h-8 w-auto min-w-[112px] shrink-0 rounded-xl px-2.5 text-[12px] text-foreground',
            'max-[760px]:min-w-0 max-[760px]:px-1.5',
            isRiskyPermissionMode(normalizedPermMode) && 'text-destructive',
          )}
        >
          {(() => {
            const ModeIcon = getModeIcon(normalizedPermMode);
            return (
              <span className="flex min-w-0 items-center gap-2">
                <ModeIcon
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground',
                    isRiskyPermissionMode(normalizedPermMode) && 'text-destructive',
                  )}
                />
                <span className="truncate max-[760px]:hidden">
                  {getWorkspacePermissionModeDisplayName(normalizedPermMode)}
                </span>
              </span>
            );
          })()}
        </SelectTrigger>
        <SelectContent
          align="start"
          className="overflow-visible"
          viewportClassName="w-auto min-w-0 p-0"
        >
          <div className="flex items-stretch gap-3 p-1.5">
            <div className="min-w-[220px]">
              {permissionModes.map((mode) => (
                <SelectItem
                  key={mode}
                  value={mode}
                  className={cn(
                    'min-w-[220px]',
                    isRiskyPermissionMode(mode) && 'text-destructive focus:text-destructive',
                  )}
                  onFocus={() => setPermissionPreviewMode(mode)}
                  onPointerMove={() => setPermissionPreviewMode(mode)}
                >
                  {getWorkspacePermissionModeDisplayName(mode)}
                </SelectItem>
              ))}
            </div>
            <div className="w-px self-stretch bg-border/80" />
            <div className="flex w-[248px] flex-col justify-center px-3 py-2 text-left">
              <div
                className={cn(
                  'flex items-center gap-2 text-foreground',
                  isRiskyPermissionMode(permissionPreviewMode) && 'text-destructive',
                )}
              >
                {(() => {
                  const ModeIcon = getModeIcon(permissionPreviewMode);
                  return (
                    <ModeIcon
                      className={cn(
                        'h-4 w-4 shrink-0 text-muted-foreground',
                        isRiskyPermissionMode(permissionPreviewMode) && 'text-destructive',
                      )}
                    />
                  );
                })()}
                <span className="text-[15px] font-semibold">
                  {getWorkspacePermissionModeDisplayName(permissionPreviewMode)}
                </span>
              </div>
              <p
                className={cn(
                  'mt-3 text-[12px] font-medium leading-5 text-foreground/88',
                  isRiskyPermissionMode(permissionPreviewMode) && 'text-destructive/90',
                )}
              >
                {permissionPreview.desc}
              </p>
              <p
                className={cn(
                  'mt-2 text-[11px] leading-5 text-muted-foreground',
                  isRiskyPermissionMode(permissionPreviewMode) && 'text-destructive/75',
                )}
              >
                {permissionPreview.detail}
              </p>
            </div>
          </div>
        </SelectContent>
      </Select>
    </div>
  );
}
