import type { FormEventHandler, ReactNode, RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Copy,
  ExternalLink,
  FileImage,
  FileJson,
  Files,
  Globe,
  LoaderCircle,
  PanelTopClose,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
  X,
} from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { BrowserInfo, BrowserRecentActivity } from '@/lib/tauri-ipc';
import type {
  BrowserSurfaceRecoveryState,
  BrowserSurfaceSnapshot,
} from '@/lib/browserSurfaceIpc';

type BrowserPanelLifecycle = NonNullable<BrowserInfo['lifecycle']>
  | NonNullable<BrowserSurfaceSnapshot['lifecycle']>;

type LoginControlAction = 'handoff' | 'pause' | 'takeover';

const recoveryStateTranslationKeys: Record<BrowserSurfaceRecoveryState, string> = {
  retained_live_host: 'workspace.browserRecoveryRetainedLiveHost',
  retained_inspection_unknown: 'workspace.browserRecoveryInspectionUnknown',
  retained_profile_lock: 'workspace.browserRecoveryProfileLock',
  retained_unknown_or_external_owner: 'workspace.browserRecoveryUnknownOwner',
  retained_profile_unavailable: 'workspace.browserRecoveryProfileUnavailable',
  recovered_launch_pending: 'workspace.browserRecoveryLaunchRecovered',
  recovered_runtime_owned: 'workspace.browserRecoveryRuntimeRecovered',
  removed_finished_record: 'workspace.browserRecoveryRecordCleared',
  renderer_process_terminated: 'workspace.browserRecoveryRendererStopped',
};

function formatArtifactBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${Math.round(byteSize / 1024)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrowserToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

interface BrowserPanelNavigationProps {
  backend: 'preview' | 'login';
  isBusy: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  effectiveUrl: string | null;
  popupActive: boolean;
  isUrlEditing: boolean;
  urlInputRef: RefObject<HTMLInputElement>;
  urlInput: string;
  displayUrl: string;
  t: (key: string) => string;
  onBrowserCommand: (command: 'browser_back' | 'browser_forward' | 'browser_reload') => void;
  onOpenExternal: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUrlInputChange: (value: string) => void;
  onCancelUrlEditing: () => void;
  onStartUrlEditing: () => void;
}

export function BrowserPanelNavigation({
  backend,
  isBusy,
  canGoBack,
  canGoForward,
  effectiveUrl,
  popupActive,
  isUrlEditing,
  urlInputRef,
  urlInput,
  displayUrl,
  t,
  onBrowserCommand,
  onOpenExternal,
  onSubmit,
  onUrlInputChange,
  onCancelUrlEditing,
  onStartUrlEditing,
}: BrowserPanelNavigationProps) {
  return (
    <div data-ccem-browser-navigation="true" className="flex h-11 shrink-0 items-center gap-1 border-b border-border/45 px-3">
      <BrowserToolButton
        label={t('workspace.browserBack')}
        onClick={() => onBrowserCommand('browser_back')}
        disabled={backend === 'login' || isBusy || !canGoBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </BrowserToolButton>
      <BrowserToolButton
        label={t('workspace.browserForward')}
        onClick={() => onBrowserCommand('browser_forward')}
        disabled={backend === 'login' || isBusy || !canGoForward}
      >
        <ArrowRight className="h-4 w-4" />
      </BrowserToolButton>
      <BrowserToolButton
        label={t('workspace.browserReload')}
        onClick={() => onBrowserCommand('browser_reload')}
        disabled={backend === 'login' || isBusy}
      >
        <RefreshCw className={isBusy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
      </BrowserToolButton>
      <BrowserToolButton
        label={t('workspace.browserOpenExternal')}
        onClick={onOpenExternal}
        disabled={!effectiveUrl}
      >
        <ExternalLink className="h-4 w-4" />
      </BrowserToolButton>
      <form className="ml-2 min-w-0 flex-1" onSubmit={onSubmit}>
        {isUrlEditing ? (
          <Input
            ref={urlInputRef}
            data-ccem-browser-url-input="true"
            aria-label={t('workspace.browserUrl')}
            value={urlInput}
            onChange={(event) => onUrlInputChange(event.target.value)}
            onBlur={onCancelUrlEditing}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelUrlEditing();
              }
            }}
            className="h-8 min-w-0 rounded-md border-border/60 bg-muted/20 px-2 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring"
            disabled={popupActive}
          />
        ) : (
          <button
            type="button"
            data-ccem-browser-url-display="true"
            aria-label={t('workspace.browserUrl')}
            title={displayUrl}
            className="flex h-8 w-full min-w-0 items-center rounded-md px-2 text-left text-xs text-muted-foreground transition hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onStartUrlEditing}
            disabled={popupActive}
          >
            <span className="truncate">{displayUrl}</span>
          </button>
        )}
      </form>
    </div>
  );
}

interface BrowserPanelTabStripProps {
  backend: 'preview' | 'login';
  panelTitle: string;
  sessionStatus: 'running' | 'closing' | 'cleanup_required';
  recoveryStates: BrowserSurfaceRecoveryState[];
  popupActive: boolean;
  lifecycle: BrowserPanelLifecycle;
  control: BrowserInfo['control'];
  paused: boolean;
  recentActivity: BrowserRecentActivity;
  recentActivityCount: number;
  browserAgentControllingLabel: string;
  browserRecentArtifactsLabel: string;
  spinnerActive: boolean;
  isPauseBusy: boolean;
  isLoginControlBusy: boolean;
  canHandoffAgent: boolean;
  isPopupCloseBusy: boolean;
  isClosingSurface: boolean;
  t: (key: string) => string;
  onRefreshRecentActivity: () => void;
  onCopyActivityPath: (path: string) => void;
  onToggleAgentControl: () => void;
  onClosePopup: () => void;
  onLoginControl: (action: LoginControlAction) => void;
  onClose: () => void;
}

export function BrowserPanelTabStrip({
  backend,
  panelTitle,
  sessionStatus,
  recoveryStates,
  popupActive,
  lifecycle,
  control,
  paused,
  recentActivity,
  recentActivityCount,
  browserAgentControllingLabel,
  browserRecentArtifactsLabel,
  spinnerActive,
  isPauseBusy,
  isLoginControlBusy,
  canHandoffAgent,
  isPopupCloseBusy,
  isClosingSurface,
  t,
  onRefreshRecentActivity,
  onCopyActivityPath,
  onToggleAgentControl,
  onClosePopup,
  onLoginControl,
  onClose,
}: BrowserPanelTabStripProps) {
  const recoveryNeedsAttention = recoveryStates.some((state) => (
    state.startsWith('retained_') || state === 'renderer_process_terminated'
  ));
  const recoveryLabel = recoveryStates
    .map((state) => t(recoveryStateTranslationKeys[state]))
    .join(', ');
  return (
    <>
      <div className="flex h-7 min-w-0 max-w-[220px] items-center gap-2 rounded-md bg-muted/45 px-2.5 text-xs font-medium text-foreground">
        <Globe className="h-4 w-4" />
        <span className="truncate">{panelTitle}</span>
      </div>
      <div className="min-w-0 flex-1" />
      {backend === 'login' && recoveryStates.length > 0 ? (
        <span
          data-ccem-browser-recovery-status={recoveryNeedsAttention ? 'attention' : 'recovered'}
          className={recoveryNeedsAttention
            ? 'max-w-56 truncate text-[11px] font-medium text-destructive'
            : 'max-w-56 truncate text-[11px] font-medium text-primary'}
          title={recoveryLabel}
        >
          {t(recoveryNeedsAttention
            ? 'workspace.browserRecoveryAttention'
            : 'workspace.browserRecoveryRecovered').replace('{state}', recoveryLabel)}
        </span>
      ) : null}
      {sessionStatus === 'cleanup_required' ? (
        <span className="text-[11px] font-medium text-destructive">
          {t('loginBrowserControl.owner_danger')}
        </span>
      ) : popupActive ? (
        <span className="text-[11px] font-medium text-primary">
          {t('workspace.browserPopupActive')}
        </span>
      ) : lifecycle === 'crashed' || lifecycle === 'failed' || lifecycle === 'closed' ? (
        <span className="text-[11px] font-medium text-destructive">
          {t('workspace.browserCrashed')}
        </span>
      ) : control === 'agent' ? (
        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {browserAgentControllingLabel}
        </span>
      ) : paused ? (
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('workspace.browserAgentPaused')}
        </span>
      ) : null}
      {backend === 'preview' ? (
        <Popover onOpenChange={(open) => {
          if (open) onRefreshRecentActivity();
        }}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0"
              aria-label={browserRecentArtifactsLabel}
              title={browserRecentArtifactsLabel}
            >
              <Files className="h-4 w-4" />
              {recentActivityCount > 0 ? (
                <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground">
                  {Math.min(recentActivityCount, 9)}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" className="w-80 p-2">
            <div className="px-2 py-1.5 text-xs font-semibold text-foreground">
              {browserRecentArtifactsLabel}
            </div>
            {recentActivityCount === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('workspace.browserNoArtifacts')}
              </div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {recentActivity.artifacts.map((artifact) => {
                  const ArtifactIcon = artifact.kind === 'screenshot' ? FileImage : FileJson;
                  return (
                    <button
                      key={artifact.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                      title={artifact.path}
                      onClick={() => onCopyActivityPath(artifact.path)}
                    >
                      <ArtifactIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {artifact.file_name}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {formatArtifactBytes(artifact.byte_size)}
                        </span>
                      </span>
                      <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  );
                })}
                {recentActivity.console_log_path ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    title={recentActivity.console_log_path}
                    onClick={() => onCopyActivityPath(recentActivity.console_log_path!)}
                  >
                    <ScrollText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {t('workspace.browserConsoleLog')}
                    </span>
                    <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
                {recentActivity.audit_log_path ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    title={recentActivity.audit_log_path}
                    onClick={() => onCopyActivityPath(recentActivity.audit_log_path!)}
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {t('workspace.browserAuditLog')}
                    </span>
                    <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
      {spinnerActive ? (
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {backend === 'preview' ? (
        <BrowserToolButton
          label={paused ? t('workspace.browserResumeAgent') : t('workspace.browserPauseAgent')}
          onClick={onToggleAgentControl}
          disabled={isPauseBusy || lifecycle === 'crashed'}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </BrowserToolButton>
      ) : null}
      {backend === 'login' && popupActive ? (
        <BrowserToolButton
          label={t('workspace.browserPopupClose')}
          onClick={onClosePopup}
          disabled={isPopupCloseBusy || sessionStatus !== 'running'}
        >
          <PanelTopClose className="h-4 w-4" />
        </BrowserToolButton>
      ) : null}
      {backend === 'login' && sessionStatus === 'running' ? (
        control === 'agent' ? (
          <>
            <BrowserToolButton
              label={t('loginBrowserControl.pauseAgent')}
              onClick={() => onLoginControl('pause')}
              disabled={isLoginControlBusy}
            >
              <Pause className="h-4 w-4" />
            </BrowserToolButton>
            <BrowserToolButton
              label={t('loginBrowserControl.takeover')}
              onClick={() => onLoginControl('takeover')}
              disabled={isLoginControlBusy}
            >
              <UserRound className="h-4 w-4" />
            </BrowserToolButton>
          </>
        ) : (
          <>
            <BrowserToolButton
              label={paused
                ? t('loginBrowserControl.resumeAgent')
                : t('loginBrowserControl.handoffAgent')}
              onClick={() => onLoginControl('handoff')}
              disabled={isLoginControlBusy || popupActive || !canHandoffAgent}
            >
              {paused ? <Play className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
            </BrowserToolButton>
            {paused ? (
              <BrowserToolButton
                label={t('loginBrowserControl.takeover')}
                onClick={() => onLoginControl('takeover')}
                disabled={isLoginControlBusy}
              >
                <UserRound className="h-4 w-4" />
              </BrowserToolButton>
            ) : null}
          </>
        )
      ) : null}
      <BrowserToolButton
        label={t('loginBrowserControl.closeBrowser')}
        onClick={onClose}
        disabled={isClosingSurface}
      >
        <X className="h-4 w-4" />
      </BrowserToolButton>
    </>
  );
}
