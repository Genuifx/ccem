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

  const currentEnvironment = environments.find((e) => e.name === envName);
  const currentEnvironmentIconHint = resolveEnvironmentIconHint(currentEnvironment);
  const isCodexProvider = provider === 'codex';
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
                isCodexProvider && 'text-muted-foreground/65',
              )}
            >
              <span className={cn('flex shrink-0', isCodexProvider && 'opacity-45 grayscale')}>
                <EnvironmentLobeIcon hint={currentEnvironmentIconHint} />
              </span>
              <span className="min-w-0 max-w-[120px] truncate max-[760px]:hidden">{envName}</span>
              {isCodexProvider && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                      <Lock className="h-2.5 w-2.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px] text-[12px] leading-5">
                    {t('workspace.codexModelSelectorDisabledHint')}
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
          className="w-auto min-w-[220px] max-h-[min(400px,var(--radix-popover-content-available-height))] flex flex-col rounded-xl border border-border/40 bg-popover p-0 shadow-md"
        >
          <div className="shrink-0 p-1.5 pb-0">
            <div className="px-2 py-1.5 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
              {t('workspace.effortLabel')}
            </div>
            {effortLevels.map((level) => (
              <button
                key={level}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none',
                  'cursor-pointer transition-colors',
                  'glass-dropdown-item',
                  level === effort && 'text-primary',
                )}
                onClick={() => {
                  onEffortChange(level);
                  setEnvEffortOpen(false);
                }}
              >
                <span className="flex-1 text-left">{t(EFFORT_I18N_KEYS[level])}</span>
                {level === effort && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            ))}
            <div className="mx-2 my-1.5 h-px border-t border-border/50" />
            <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
              <span>{t('workspace.environmentLabel')}</span>
              {isCodexProvider && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 normal-case tracking-normal text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" />
                  {t('workspace.codexModelSelectorDisabledBadge')}
                </span>
              )}
            </div>
            {isCodexProvider && (
              <p className="mx-2 mb-2 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                {t('workspace.codexModelSelectorDisabledHint')}
              </p>
            )}
          </div>
          <ScrollArea
            type="always"
            data-ccem-composer-environment-scroll
            className="min-h-0 max-h-[200px]"
            viewportClassName="pr-1"
          >
            <div className="p-1.5 pt-0 pr-2">
              {selectableEnvironments.map((environment) => (
                <button
                  key={environment.name}
                  type="button"
                  disabled={isCodexProvider}
                  aria-disabled={isCodexProvider}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none',
                    'transition-colors',
                    isCodexProvider
                      ? 'cursor-not-allowed text-muted-foreground/45 opacity-55'
                      : 'cursor-pointer glass-dropdown-item',
                    !isCodexProvider && environment.name === envName && 'text-primary',
                  )}
                  onClick={() => {
                    if (isCodexProvider) {
                      return;
                    }
                    onEnvChange(environment.name);
                    setEnvEffortOpen(false);
                  }}
                >
                  <EnvironmentLobeIcon
                    hint={resolveEnvironmentIconHint(environment)}
                    size={13}
                  />
                  <span className="flex-1 text-left">{environment.name}</span>
                  {environment.name === envName && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              ))}
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
