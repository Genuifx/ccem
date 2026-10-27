import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppWindow, Check, ChevronDown, Code, ExternalLink, FileText, FolderOpen, Globe, Image } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import {
  rankOpenApps,
  readRememberedOpenApp,
  rememberOpenApp,
  type WorkspaceOpenApp,
  type WorkspaceOpenAppKind,
} from './workspaceOpenWith';

const KIND_ICON: Record<WorkspaceOpenAppKind, typeof Code> = {
  editor: Code,
  browser: Globe,
  viewer: Image,
  markdown: FileText,
};

function AppIcon({ app, className }: { app: WorkspaceOpenApp; className: string }) {
  if (app.icon) return <img src={app.icon} alt="" draggable={false} className={cn(className, 'object-contain')} />;
  const Icon = KIND_ICON[app.kind];
  return <Icon className={cn(className, 'text-muted-foreground')} />;
}

// Installed apps rarely change while the app runs; probe once per launch.
let installedAppsRequest: Promise<WorkspaceOpenApp[]> | null = null;
function loadInstalledApps() {
  installedAppsRequest ??= invoke<WorkspaceOpenApp[]>('list_workspace_open_apps').then((apps) => (Array.isArray(apps) ? apps : [])).catch(() => {
    installedAppsRequest = null;
    return [];
  });
  return installedAppsRequest;
}

export function WorkspaceOpenWithButton({ path, compact, onOpen }: {
  path: string;
  compact?: boolean;
  /** `appId` undefined opens with the system default handler. */
  onOpen: (appId?: string) => void;
}) {
  const { t } = useLocale();
  const [apps, setApps] = useState<WorkspaceOpenApp[]>([]);
  const [rememberedId, setRememberedId] = useState(() => readRememberedOpenApp(path));
  useEffect(() => {
    let cancelled = false;
    void loadInstalledApps().then((next) => { if (!cancelled) setApps(next); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setRememberedId(readRememberedOpenApp(path)); }, [path]);
  const { primary, suggested, others } = useMemo(() => rankOpenApps(path, apps, rememberedId), [path, apps, rememberedId]);

  const primaryLabel = primary ? t('workspace.openWithApp', { app: primary.name }) : t('workspace.openWithDefault');
  const choose = (app: WorkspaceOpenApp) => {
    rememberOpenApp(path, app.id);
    setRememberedId(app.id);
    onOpen(app.id);
  };
  const appItem = (app: WorkspaceOpenApp) => (
    <DropdownMenuItem key={app.id} className="gap-2 py-1.5 text-xs" onSelect={() => choose(app)}>
      <AppIcon app={app} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{app.name}</span>
      {app.id === primary?.id ? <Check className="h-3 w-3 shrink-0 text-primary" /> : null}
    </DropdownMenuItem>
  );

  return (
    <div data-ccem-open-with className="flex h-7 shrink-0 items-center rounded-full border border-border-subtle/60 bg-background/60">
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-full gap-1 rounded-l-full rounded-r-none px-2.5 text-[10px] font-medium', compact && 'w-7 px-0')}
        aria-label={primaryLabel}
        title={primaryLabel}
        onClick={() => onOpen(primary?.id)}
      >
        {primary?.icon ? <AppIcon app={primary} className="h-3.5 w-3.5" /> : <ExternalLink className="h-3 w-3" />}
        {compact ? null : <span>{t('workspace.changesOpen')}</span>}
      </Button>
      <span className="h-3.5 w-px bg-border-subtle/70" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-6 rounded-l-none rounded-r-full"
            aria-label={t('workspace.openWithChoose')}
            title={t('workspace.openWithChoose')}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {suggested.length > 0 ? (
            <>
              <DropdownMenuLabel className="px-2.5 py-1 text-[10px] font-medium text-muted-foreground">{t('workspace.openWithSuggested')}</DropdownMenuLabel>
              {suggested.map(appItem)}
            </>
          ) : null}
          {others.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2 py-1.5 text-xs">
                <AppWindow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {t('workspace.openWithOther')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">{others.map(appItem)}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {suggested.length > 0 || others.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem className="gap-2 py-1.5 text-xs" onSelect={() => onOpen('default')}>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t('workspace.openWithDefault')}
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 py-1.5 text-xs" onSelect={() => onOpen('reveal')}>
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t('workspace.openWithReveal')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
