import { ReactNode } from 'react';
import { Home } from '@/lib/lucide-react';
import { SideRail } from './SideRail';
import { MacFullscreenWindowControls } from './MacFullscreenWindowControls';
import { GlobalUpdateIndicator } from '@/components/app-update/GlobalUpdateIndicator';
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { useLocale } from '@/locales';

interface AppLayoutProps {
  children: ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  onTabPrefetch?: (tab: string) => void;
  pageActions?: ReactNode;
  fullBleed?: boolean;
}

export function AppLayout({
  children,
  activeTab,
  onTabChange,
  onTabPrefetch,
  pageActions,
  fullBleed = false,
}: AppLayoutProps) {
  return (
    <SidebarProvider className="h-screen flex overflow-hidden relative" data-active-tab={activeTab}>
      <MacFullscreenWindowControls />
      <AppLayoutBody
        activeTab={activeTab}
        onTabChange={onTabChange}
        onTabPrefetch={onTabPrefetch}
        pageActions={pageActions}
        fullBleed={fullBleed}
      >
        {children}
      </AppLayoutBody>
    </SidebarProvider>
  );
}

function AppLayoutBody({
  children,
  activeTab,
  onTabChange,
  onTabPrefetch,
  pageActions,
  fullBleed = false,
}: AppLayoutProps) {
  const { t } = useLocale();
  const { open, state } = useSidebar();
  const isWorkspace = activeTab === 'workspace';
  const sidebarToggleLabel = state === 'collapsed' ? t('sideRail.expand') : t('sideRail.collapse');
  const showWorkspaceShortcut = state === 'collapsed' && !isWorkspace;
  const titleKeyMap: Record<string, string> = {
    'proxy-debug': 'sideRail.proxyDebug',
    'chat-app': 'sideRail.chatApp',
  };
  const pageTitleKey = titleKeyMap[activeTab] || `sideRail.${activeTab}`;
  const pageTitle = isWorkspace ? undefined : (t(pageTitleKey) || t('sideRail.workspace'));

  const subtitleKeyMap: Record<string, string> = {
    workspace: 'workspace.subtitle',
    environments: 'environments.description',
    skills: 'skills.subtitle',
    history: 'history.subtitle',
    analytics: 'analytics.subtitle',
    cron: 'cron.subtitle',
    'chat-app': 'chatApp.subtitle',
    'proxy-debug': 'proxyDebug.subtitle',
    settings: 'settings.subtitle',
  };
  const subtitle = subtitleKeyMap[activeTab] && !isWorkspace ? t(subtitleKeyMap[activeTab]) : undefined;

  return (
    <>
      <AppSidebarToggleAnchor label={sidebarToggleLabel} />
      {showWorkspaceShortcut ? (
        <CollapsedWorkspaceShortcut
          label={t('sideRail.backToWorkspace')}
          onClick={() => onTabChange('workspace')}
          onPrefetch={() => onTabPrefetch?.('workspace')}
        />
      ) : null}
      <GlobalUpdateIndicator />

      <Sidebar>
        {open && (
          <SideRail activeTab={activeTab} onTabChange={onTabChange} onTabPrefetch={onTabPrefetch} glassMuted={false} />
        )}
      </Sidebar>

      {/* Main content area — semi-transparent so ambient orbs bleed through glass panels */}
      <SidebarInset className="app-content-shell flex-1 flex flex-col min-w-0 relative z-10 overflow-hidden">
        {/* Ambient background — lives inside content area only */}
        <div className="ambient-bg" aria-hidden="true">
          <div className="ambient-orb-3" />
          <div className="ambient-orb-4" />
        </div>

        {/* Titlebar spacer + page title — also serves as drag region for non-workspace pages */}
        {!isWorkspace && (
          <div data-tauri-drag-region className="app-titlebar-row h-12 shrink-0 flex items-center gap-3 relative z-10">
            <div className="flex items-baseline gap-3 min-w-0">
              {pageTitle && (
                <h1 className="text-lg font-semibold text-foreground truncate">{pageTitle}</h1>
              )}
              {subtitle && (
                <span className="text-sm text-muted-foreground truncate">{subtitle}</span>
              )}
            </div>
            {pageActions && (
              <div className="flex items-center gap-3 ml-auto relative z-[110]">
                {pageActions}
              </div>
            )}
            <div id="page-actions-slot" className="flex items-center gap-2.5 ml-auto relative z-[110] empty:hidden" />
          </div>
        )}
        <main
          className={fullBleed
            ? 'scroll-glass-root flex-1 overflow-hidden relative z-10'
            : 'scroll-glass-root flex-1 overflow-y-auto px-8 py-4 relative z-10'}
        >
          <div className={fullBleed ? 'w-full h-full' : 'w-full min-w-0'}>
            {children}
          </div>
        </main>
      </SidebarInset>
    </>
  );
}

function CollapsedWorkspaceShortcut({
  label,
  onClick,
  onPrefetch,
}: {
  label: string;
  onClick: () => void;
  onPrefetch?: () => void;
}) {
  return (
    <div className="app-workspace-shortcut-anchor absolute z-[122]">
      <button
        type="button"
        data-testid="collapsed-workspace-shortcut"
        aria-label={label}
        title={label}
        onClick={onClick}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-none bg-transparent p-0 text-muted-foreground/75 shadow-none transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96] active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Home className="h-[15px] w-[15px]" />
        <span className="sr-only">{label}</span>
      </button>
    </div>
  );
}

function AppSidebarToggleAnchor({ label }: { label: string }) {
  return (
    <div className="app-sidebar-toggle-anchor absolute z-[120]">
      <SidebarTrigger
        aria-label={label}
        title={`${label} (⌘B)`}
      />
    </div>
  );
}
