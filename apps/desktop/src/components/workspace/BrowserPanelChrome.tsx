import type { FormEventHandler, ReactNode, RefObject } from 'react';
import {
  Bot,
  ExternalLink,
  Globe,
  LoaderCircle,
  PanelTopClose,
  UserRound,
  X,
} from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  BrowserSurfaceRecoveryState,
  BrowserSurfaceSnapshot,
} from '@/lib/browserSurfaceIpc';

type BrowserPanelLifecycle = NonNullable<BrowserSurfaceSnapshot['lifecycle']>;
type LoginControlAction = 'handoff' | 'takeover';

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
  effectiveUrl: string | null;
  popupActive: boolean;
  isUrlEditing: boolean;
  urlInputRef: RefObject<HTMLInputElement>;
  urlInput: string;
  displayUrl: string;
  sessionStatus: 'running' | 'closing' | 'cleanup_required';
  control: BrowserSurfaceSnapshot['control'];
  paused: boolean;
  isLoginControlBusy: boolean;
  canHandoffAgent: boolean;
  t: (key: string) => string;
  onOpenExternal: () => void;
  onLoginControl: (action: LoginControlAction) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUrlInputChange: (value: string) => void;
  onCancelUrlEditing: () => void;
  onStartUrlEditing: () => void;
}

export function BrowserPanelNavigation({
  effectiveUrl,
  popupActive,
  isUrlEditing,
  urlInputRef,
  urlInput,
  displayUrl,
  sessionStatus,
  control,
  paused,
  isLoginControlBusy,
  canHandoffAgent,
  t,
  onOpenExternal,
  onLoginControl,
  onSubmit,
  onUrlInputChange,
  onCancelUrlEditing,
  onStartUrlEditing,
}: BrowserPanelNavigationProps) {
  const effectiveControl = control === 'agent'
    ? 'agent'
    : control === 'paused' || paused
      ? 'paused'
      : 'user';
  const agentHasControl = effectiveControl === 'agent';
  const needsTakeover = effectiveControl !== 'user';
  const controlLabel = needsTakeover
    ? t('loginBrowserControl.takeover')
    : t('loginBrowserControl.handoffAgent');
  const controlDisabled = sessionStatus !== 'running'
    || isLoginControlBusy
    || (!needsTakeover && (popupActive || !canHandoffAgent));

  return (
    <div data-ccem-browser-navigation="true" className="flex h-11 shrink-0 items-center gap-1 border-b border-border/45 px-3">
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-ccem-browser-control-toggle="true"
              data-ccem-browser-control-state={effectiveControl}
              aria-label={controlLabel}
              aria-pressed={agentHasControl}
              disabled={controlDisabled}
              onClick={() => onLoginControl(needsTakeover ? 'takeover' : 'handoff')}
              className={agentHasControl
                ? 'h-8 w-8 rounded-full bg-amber-500/12 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300'
                : 'h-8 w-8 rounded-full'}
            >
              {needsTakeover
                ? <UserRound className="h-4 w-4" />
                : <Bot className="h-4 w-4" />}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{controlLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

interface BrowserPanelTabStripProps {
  panelTitle: string;
  sessionStatus: 'running' | 'closing' | 'cleanup_required';
  recoveryStates: BrowserSurfaceRecoveryState[];
  popupActive: boolean;
  lifecycle: BrowserPanelLifecycle;
  spinnerActive: boolean;
  isPopupCloseBusy: boolean;
  isClosingSurface: boolean;
  t: (key: string) => string;
  onClosePopup: () => void;
  onClose: () => void;
}

export function BrowserPanelTabStrip({
  panelTitle,
  sessionStatus,
  recoveryStates,
  popupActive,
  lifecycle,
  spinnerActive,
  isPopupCloseBusy,
  isClosingSurface,
  t,
  onClosePopup,
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
      {recoveryStates.length > 0 ? (
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
      ) : lifecycle === 'failed' || lifecycle === 'closed' ? (
        <span className="text-[11px] font-medium text-destructive">
          {t('workspace.browserCrashed')}
        </span>
      ) : null}
      {spinnerActive ? (
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {popupActive ? (
        <BrowserToolButton
          label={t('workspace.browserPopupClose')}
          onClick={onClosePopup}
          disabled={isPopupCloseBusy || sessionStatus !== 'running'}
        >
          <PanelTopClose className="h-4 w-4" />
        </BrowserToolButton>
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
