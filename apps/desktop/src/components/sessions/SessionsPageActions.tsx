import { FolderOpen, Globe, LayoutGrid, List, Plus, Shield } from '@/lib/lucide-react';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageActionsSlot } from '@/components/layout';
import { getEnvColorVar } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { ArrangeLayout } from '@/store';
import { SessionLauncherPopover } from './SessionLauncherPopover';

type SessionsViewMode = 'card' | 'list';

interface EnvironmentOption {
  name: string;
}

interface SessionsPageActionsProps {
  effectiveViewMode: SessionsViewMode;
  hasUnifiedOnlyInView: boolean;
  currentEnv: string;
  environments: EnvironmentOption[];
  permissionMode: PermissionModeName;
  launchDirDisplay: string;
  isLaunching: boolean;
  launched: boolean;
  launcherOpen: boolean;
  isMultiLaunching: boolean;
  onViewModeChange: (mode: SessionsViewMode) => void;
  onEnvironmentChange: (envName: string) => void | Promise<void>;
  onPermissionModeChange: (mode: PermissionModeName) => void;
  onOpenProjectPicker: () => void;
  onLaunchClick: () => void | Promise<void>;
  onLauncherOpenChange: (open: boolean) => void;
  onLaunchMulti: (dirs: string[], layout: ArrangeLayout) => void | Promise<void>;
  onBrowseAndLaunch: () => Promise<void>;
}

export function SessionsPageActions({
  effectiveViewMode,
  hasUnifiedOnlyInView,
  currentEnv,
  environments,
  permissionMode,
  launchDirDisplay,
  isLaunching,
  launched,
  launcherOpen,
  isMultiLaunching,
  onViewModeChange,
  onEnvironmentChange,
  onPermissionModeChange,
  onOpenProjectPicker,
  onLaunchClick,
  onLauncherOpenChange,
  onLaunchMulti,
  onBrowseAndLaunch,
}: SessionsPageActionsProps) {
  const { t } = useLocale();

  return (
    <PageActionsSlot>
      <div className="flex items-center gap-2">
        <div className="hidden lg:flex items-center gap-0.5 p-0.5 rounded-full bg-[hsl(var(--surface-raised))] border border-[hsl(var(--border-subtle))]">
          <button
            type="button"
            onClick={() => onViewModeChange('card')}
            className={`h-7 w-7 rounded-full flex items-center justify-center transition-all duration-150 ${
              effectiveViewMode === 'card'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('list')}
            disabled={hasUnifiedOnlyInView}
            className={`h-7 w-7 rounded-full flex items-center justify-center transition-all duration-150 ${
              effectiveViewMode === 'list'
                ? 'bg-primary/10 text-primary'
                : hasUnifiedOnlyInView
                  ? 'text-muted-foreground/30 cursor-not-allowed'
                  : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        <Select value={currentEnv} onValueChange={onEnvironmentChange}>
          <SelectTrigger variant="badge" badgeColor={getEnvColorVar(currentEnv)} className="hover:bg-[hsl(var(--surface-raised))] max-w-[140px]">
            <Globe className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {environments.map(env => (
              <SelectItem key={env.name} value={env.name}>{env.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={permissionMode} onValueChange={(v) => onPermissionModeChange(v as PermissionModeName)}>
          <SelectTrigger variant="badge" badgeColor="var(--chart-4)" className="hover:bg-[hsl(var(--surface-raised))] max-w-[140px]">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {Object.keys(PERMISSION_PRESETS).map((mode) => (
              <SelectItem key={mode} value={mode}>{mode}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={onOpenProjectPicker}
          className="rounded-full border border-[hsl(var(--border-subtle))] px-3 py-2 text-[13px] hover:bg-[hsl(var(--surface-raised))] active:scale-95 transition-all flex items-center gap-1.5"
          title={launchDirDisplay || t('workspace.selectDir')}
        >
          <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="hidden xl:inline font-mono text-xs max-w-[100px] truncate text-muted-foreground">
            {launchDirDisplay || t('workspace.selectDir')}
          </span>
        </button>

        <button
          type="button"
          onClick={onLaunchClick}
          disabled={isLaunching}
          className={`bg-primary text-white rounded-full px-3 sm:px-4 py-2 text-[14px] font-medium hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-1.5${isLaunching ? ' opacity-70 cursor-not-allowed' : launched ? ' opacity-90' : ''}`}
          title={t('sessions.newSession')}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{isLaunching ? t('sessions.launching') : t('sessions.newSession')}</span>
        </button>

        <SessionLauncherPopover
          open={launcherOpen}
          onOpenChange={onLauncherOpenChange}
          onLaunchMulti={onLaunchMulti}
          onBrowseAndLaunch={onBrowseAndLaunch}
          isLaunching={isMultiLaunching || isLaunching}
          trigger={
            <button
              type="button"
              className="hidden xl:flex rounded-full border border-[hsl(var(--border-subtle))] px-3 py-2 text-[13px] hover:bg-[hsl(var(--surface-raised))] active:scale-95 transition-all items-center gap-1.5"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {t('sessions.multiLaunch')}
            </button>
          }
        />
      </div>
    </PageActionsSlot>
  );
}
