import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Brain,
  ChevronDown,
  Gauge,
  Lock,
  Search,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldOff,
  Zap,
} from '@/lib/lucide-react';
import { ModelIcon } from '@/components/history/ModelIcon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

const EFFORT_THUMB_SIZE = 26;
const EFFORT_THUMB_HALF = EFFORT_THUMB_SIZE / 2;
/** Springy ease with slight overshoot — the "silky snap" feel of the reference. */
const EFFORT_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/**
 * Discrete effort slider mixing the white-balance and brightness-slider
 * idioms: a full-range primary gradient pill where the adjusted portion
 * (left of the thumb) renders at full strength and the remainder is washed
 * out, a hollow white ring thumb that lets the bright→dim transition show
 * through, semantic end icons (Zap = fast/shallow, Brain = deep reasoning),
 * and per-stop labels below (active stop highlighted, click to jump). Drag
 * follows the pointer with zero latency; release / click / keyboard moves
 * animate with a springy transition. Transitions live in inline styles so
 * twMerge can't collapse competing `transition-*` classes.
 */
function EffortSlider({
  levels,
  labels,
  value,
  onChange,
  ariaLabel,
}: {
  levels: EffortLevel[];
  /** Translated short label per level, aligned with `levels`. */
  labels: string[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  ariaLabel: string;
}) {
  const lastIndex = levels.length - 1;
  const activeIndex = Math.max(0, levels.indexOf(value));
  /** Pinned at the ceiling — drives the restrained sheen sweep + glow boost. */
  const atMax = lastIndex > 0 && activeIndex === lastIndex;
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const isDragging = dragFraction !== null;
  const thumbFraction = isDragging
    ? dragFraction!
    : lastIndex === 0 ? 0 : activeIndex / lastIndex;
  const pct = `${thumbFraction * 100}%`;

  const fractionFromPointer = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const travel = Math.max(1, rect.width - EFFORT_THUMB_SIZE);
    return Math.min(1, Math.max(0, (clientX - rect.left - EFFORT_THUMB_HALF) / travel));
  };

  const commitFraction = (fraction: number) => {
    const index = Math.round(fraction * lastIndex);
    if (levels[index] !== value) {
      onChange(levels[index]);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragFraction(fractionFromPointer(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const fraction = fractionFromPointer(event.clientX);
    setDragFraction(fraction);
    commitFraction(fraction);
  };

  const endDrag = () => {
    if (!isDragging) return;
    commitFraction(dragFraction!);
    setDragFraction(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keep the surrounding dropdown menu from hijacking arrow-key navigation.
    event.stopPropagation();
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = activeIndex - 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = activeIndex + 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = lastIndex;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(lastIndex, Math.max(0, next));
    if (clamped !== activeIndex) onChange(levels[clamped]);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={lastIndex}
      aria-valuenow={activeIndex}
      aria-valuetext={labels[activeIndex] ?? levels[activeIndex]}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex w-full touch-none select-none items-start gap-1 outline-none',
        'cursor-grab active:cursor-grabbing',
        'focus-visible:ring-2 focus-visible:ring-primary/30 rounded-lg',
      )}
    >
      {/* Semantic end icons (brightness-slider style): fast/shallow → deep
          reasoning. Pointer math clamps out-of-track clicks, so tapping an
          icon jumps straight to that extreme. */}
      <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground/55">
        <Zap className="h-3 w-3" />
      </span>
      <div ref={trackRef} className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative flex h-7 items-center">
          {/* Unadjusted remainder: the same primary ramp, washed out. */}
          <div
            className="pointer-events-none absolute inset-x-[13px] h-3 rounded-full"
            style={{
              backgroundImage: [
                'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0) 55%)',
                'linear-gradient(90deg, hsl(var(--primary) / 0.10), hsl(var(--primary) / 0.16) 55%, hsl(var(--primary) / 0.26))',
              ].join(', '),
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.08)',
            }}
          />
          {/* Adjusted portion: full-strength gradient clipped at the thumb
              center — the straight cut edge shows through the hollow ring and
              reads as the position marker. The element's own rounded-full
              keeps the left end capped. */}
          <div
            className="pointer-events-none absolute inset-x-[13px] h-3 rounded-full"
            style={{
              backgroundImage: [
                'linear-gradient(180deg, rgba(255,255,255,0.30), rgba(255,255,255,0) 55%)',
                'linear-gradient(90deg, hsl(var(--primary) / 0.35), hsl(var(--primary) / 0.7) 55%, hsl(var(--primary)))',
              ].join(', '),
              clipPath: `inset(0 ${(1 - thumbFraction) * 100}% 0 0)`,
              boxShadow: isDragging || atMax
                ? '0 0 12px hsl(var(--primary-glow) / 0.5), 0 0 3px hsl(var(--primary-glow) / 0.35)'
                : '0 0 8px hsl(var(--primary-glow) / 0.35), 0 0 2px hsl(var(--primary-glow) / 0.25)',
              transition: isDragging
                ? 'box-shadow 150ms ease'
                : `clip-path 260ms ${EFFORT_SPRING}, box-shadow 150ms ease`,
            }}
          />
          {/* Max-level sheen: one slow highlight sweep across the gradient,
              then a rest. Rendered only while pinned at the top level. */}
          {atMax && (
            <div className="pointer-events-none absolute inset-x-[13px] h-3 overflow-hidden rounded-full">
              <div className="effort-sheen absolute inset-y-0 w-1/3" />
            </div>
          )}
          {/* Hollow ring thumb: the bright→dim transition shows through the
              ring; white stroke plus a hairline dark edge keeps it readable on
              the washed-out end. */}
          <div className="pointer-events-none absolute inset-x-[13px] top-1/2">
            <div
              className={cn(
                'absolute top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                'border-[3px] border-white',
                isDragging ? 'scale-110 bg-white/20' : 'hover:scale-105',
              )}
              style={{
                left: pct,
                boxShadow: isDragging
                  ? '0 2px 8px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(0,0,0,0.12), inset 0 0 0 0.5px rgba(0,0,0,0.15)'
                  : '0 1px 4px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(0,0,0,0.1), inset 0 0 0 0.5px rgba(0,0,0,0.12)',
                transition: isDragging
                  ? 'transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease'
                  : `left 260ms ${EFFORT_SPRING}, transform 260ms ${EFFORT_SPRING}, box-shadow 150ms ease, background-color 150ms ease`,
              }}
            />
          </div>
        </div>
        {/* Stop labels — clicking one jumps via the root pointer handler. */}
        <div className="relative mx-[13px] mt-0.5 h-4">
          {levels.map((level, index) => (
            <span
              key={level}
              className={cn(
                'absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-4 tabular-nums transition-colors duration-150',
                index === activeIndex ? 'font-medium text-primary' : 'text-muted-foreground/60',
              )}
              style={{ left: `${(lastIndex === 0 ? 0 : index / lastIndex) * 100}%` }}
            >
              {labels[index] ?? level}
            </span>
          ))}
        </div>
      </div>
      <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground/55">
        <Brain className="h-3 w-3" />
      </span>
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

  const currentEnvironment = environments.find((e) => e.name === envName);
  const currentEnvironmentIconHint = resolveEnvironmentIconHint(currentEnvironment);
  const currentModel = currentEnvironment ? environmentOpusModelLabel(currentEnvironment) : null;
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
      <DropdownMenu modal={false} open={envEffortOpen} onOpenChange={setEnvEffortOpen}>
        <DropdownMenuTrigger asChild>
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
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[340px] p-0"
        >
          <div className="px-3 pt-2.5 pb-1">
            <div className="px-0.5 leading-4 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
              {t('workspace.effortLabel')}
            </div>
            <EffortSlider
              levels={effortLevels}
              labels={effortLevels.map((level) => t(EFFORT_I18N_KEYS[level]))}
              value={effort}
              onChange={onEffortChange}
              ariaLabel={t('workspace.effortLabel')}
            />
          </div>
          <DropdownMenuSeparator className="my-1" />
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
            <span>{t('workspace.environmentLabel')}</span>
            {isEnvironmentLocked && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 normal-case tracking-normal text-muted-foreground">
                <Lock className="h-2.5 w-2.5" />
                {environmentLockedBadge}
              </span>
            )}
          </div>
          {isEnvironmentLocked && (
            <p className="mx-2.5 mb-1.5 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
              {environmentLockedHint}
            </p>
          )}
          <ScrollArea
            type="always"
            data-ccem-composer-environment-scroll
            className="min-h-0 max-h-[300px]"
            viewportClassName="pr-1"
          >
            <div className="pb-1.5 pr-1">
              {groupedEnvironments.map((group) => {
                const isCurrentGroup = currentModel === group.model;
                const groupIconEnv = group.envs.find((e) => e.name === envName) || group.envs[0];
                return (
                  <DropdownMenuSub key={group.model}>
                    <DropdownMenuSubTrigger
                      className={cn(
                        'h-9 cursor-pointer gap-2.5 rounded-lg px-2.5 text-[12.5px] leading-none',
                        'text-foreground/85 transition-colors',
                        'focus:bg-white/[0.05] data-[highlighted]:bg-white/[0.05]',
                        'data-[state=open]:bg-white/[0.08]',
                        isCurrentGroup && 'bg-primary/[0.07] data-[highlighted]:bg-primary/[0.1]',
                        isEnvironmentLocked && 'opacity-70',
                      )}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        <EnvironmentLobeIcon
                          hint={resolveEnvironmentIconHint(groupIconEnv)}
                          size={16}
                        />
                      </span>
                      <span
                        className={cn(
                          'min-w-0 max-w-[170px] truncate',
                          isCurrentGroup && 'font-medium text-primary',
                        )}
                      >
                        {group.model}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      sideOffset={8}
                      className="min-w-[200px] max-w-[260px] rounded-xl frosted-panel glass-noise shadow-dialog p-1"
                    >
                      {group.envs.map((environment) => {
                        // Model lineup under the env name: opus · sonnet · haiku,
                        // deduped (sonnet often aliases opus) and skipping gaps.
                        const modelLine = [
                          environment.defaultOpusModel,
                          environment.defaultSonnetModel,
                          environment.defaultHaikuModel,
                        ]
                          .filter((model, index, all): model is string => !!model && all.indexOf(model) === index)
                          .join(' · ');
                        const isActiveEnv = environment.name === envName;
                        return (
                          <DropdownMenuItem
                            key={environment.name}
                            disabled={isEnvironmentLocked}
                            onSelect={() => {
                              onEnvChange(environment.name);
                            }}
                            className={cn(
                              'h-auto items-start gap-2 rounded-lg px-2 py-1.5 text-[12.5px]',
                              isActiveEnv && 'bg-primary/[0.08] focus:bg-primary/[0.12] hover:bg-primary/[0.12]',
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  'block truncate leading-4',
                                  isActiveEnv && 'font-medium text-primary',
                                )}
                              >
                                {environment.name}
                              </span>
                              {modelLine && (
                                <span
                                  className={cn(
                                    'mt-0.5 block truncate text-[10px] leading-3',
                                    isActiveEnv ? 'text-primary/60' : 'text-muted-foreground/65',
                                  )}
                                >
                                  {modelLine}
                                </span>
                              )}
                            </span>
                            {isActiveEnv && (
                              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                            )}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
            </div>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>

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
