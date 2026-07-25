// apps/desktop/src/components/sessions/SessionCard.tsx
import { Suspense, lazy, useEffect, useRef, useState, type ElementType } from 'react';
import {
  Check,
  Clock,
  Copy,
  FolderOpen,
  Link2,
  Minus,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Shield,
  SquareArrowOutUpRight,
  SquareTerminal,
  Target,
  X,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getRemotePlatformFromChannel, getRemotePlatformMeta } from '@/lib/remote-platforms';
import { copyBindCommand } from '@/lib/telegram-utils';
import { cn, getProjectName } from '@/lib/utils';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import type { TmuxAttachTerminalInfo, TmuxAttachTerminalType } from '@/lib/tauri-ipc';
import { useLocale } from '../../locales';
import type { Session, UnifiedSession, ChannelInfo } from '@/store';
import { OpenInTerminalPopoverButton } from './OpenInTerminalPopoverButton';
import { getSessionTerminalActions } from './sessionTerminalActions';
import { ModelIcon } from '../history/ModelIcon';

const LazyBindToChatDialog = lazy(async () =>
  import('@/components/chat/BindToChatDialog').then((module) => ({
    default: module.BindToChatDialog,
  }))
);

interface SessionCardProps {
  session: Session;
  unifiedSession?: UnifiedSession;
  terminalOptions?: TmuxAttachTerminalInfo[];
  selectedEmbedded?: boolean;
  onSelectEmbedded?: (id: string) => void;
  onMenuIntent?: () => void;
  onFocus: (id: string) => void;
  onOpenInTerminal: (id: string, terminalType?: TmuxAttachTerminalType) => void;
  onMinimize: (id: string) => void;
  onClose: (id: string) => void;
  onStop?: (id: string) => void;
  onRemove?: (id: string) => void;
  onDisconnectChannel?: (sessionId: string, channelKind: string) => void;
  confirmingClose?: boolean;
  onCancelClose?: () => void;
  onConfirmClose?: (id: string) => void;
}

// --- Apple-style icon button for card actions ---
function SessionActionIconButton({
  icon: Icon,
  onClick,
  tooltip,
  disabled,
  variant = 'ghost',
  className,
}: {
  icon: ElementType;
  onClick?: () => void;
  tooltip: string;
  disabled?: boolean;
  variant?: 'ghost' | 'destructive';
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'inline-flex items-center justify-center',
            'h-[34px] w-[34px] rounded-full',
            'transition-all duration-150',
            'active:scale-95',
            'disabled:opacity-40 disabled:pointer-events-none',
            variant === 'ghost' && 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--surface-raised))]',
            variant === 'destructive' && 'text-destructive/70 hover:text-destructive hover:bg-destructive/10',
            className
          )}
        >
          <Icon className="w-[15px] h-[15px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

// --- More actions dropdown ---
function SessionMoreActionsDropdown({
  bindCopied,
  copiedLabel,
  copyLabel,
  bindLabel,
  onCopyBind,
  onOpenBindDialog,
}: {
  bindCopied: boolean;
  copiedLabel: string;
  copyLabel: string;
  bindLabel: string;
  onCopyBind: () => void;
  onOpenBindDialog: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center',
            'h-[34px] w-[34px] rounded-full',
            'text-muted-foreground hover:text-foreground',
            'hover:bg-[hsl(var(--surface-raised))]',
            'transition-all duration-150 active:scale-95',
          )}
        >
          <MoreHorizontal className="w-[15px] h-[15px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onCopyBind}>
          {bindCopied ? (
            <>
              <Check className="w-4 h-4 mr-2 text-success" />
              {copiedLabel}
            </>
          ) : (
            <>
              <Copy className="w-4 h-4 mr-2" />
              {copyLabel}
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenBindDialog}>
          <Link2 className="w-4 h-4 mr-2" />
          {bindLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SessionCard({
  session,
  unifiedSession,
  terminalOptions,
  selectedEmbedded,
  onSelectEmbedded,
  onMenuIntent,
  onFocus,
  onOpenInTerminal,
  onMinimize,
  onClose,
  onStop,
  onRemove,
  onDisconnectChannel,
  confirmingClose,
  onCancelClose,
  onConfirmClose,
}: SessionCardProps) {
  const { t } = useLocale();
  const isEmbedded = session.terminalType === 'embedded';
  const [bindCopied, setBindCopied] = useState(false);
  const [bindDialogOpen, setBindDialogOpen] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hasHydratedStatusMotionRef = useRef(false);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  // --- Status indicator: minimal dot ---
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'running':
      case 'ready':
      case 'processing':
        return (
          <span className="relative flex items-center justify-center">
            <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-success/50 opacity-60" />
            <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-success" />
          </span>
        );
      case 'waiting_permission':
        return (
          <span className="relative flex items-center justify-center">
            <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-warning/50 opacity-60" />
            <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-warning" />
          </span>
        );
      case 'error':
        return <span className="inline-flex h-[7px] w-[7px] rounded-full bg-destructive" />;
      case 'initializing':
        return <span className="inline-flex h-[7px] w-[7px] rounded-full bg-primary animate-pulse" />;
      default:
        return <span className="inline-flex h-[7px] w-[7px] rounded-full bg-muted-foreground/30" />;
    }
  };

  const statusIndicator = unifiedSession
    ? getStatusIndicator(unifiedSession.status)
    : getStatusIndicator(session.status);
  const statusMotionKey = unifiedSession?.status ?? session.status;

  useGSAP(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    if (!hasHydratedStatusMotionRef.current) {
      hasHydratedStatusMotionRef.current = true;
      return;
    }

    const statusDot = card.querySelector<HTMLElement>('[data-session-status-dot]');
    const confirmActions = card.querySelector<HTMLElement>('[data-session-confirm-actions]');
    const targets = [statusDot, confirmingClose ? confirmActions : null].filter(
      (target): target is HTMLElement => !!target
    );
    if (targets.length === 0) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    gsap.fromTo(
      targets,
      { scale: 0.88, autoAlpha: 0.75 },
      {
        scale: 1,
        autoAlpha: 1,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(targets),
      }
    );
  }, { scope: cardRef, dependencies: [statusMotionKey, confirmingClose] });

  const formatDuration = (startedAt: Date) => {
    const now = new Date();
    const diff = now.getTime() - startedAt.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  };

  // --- Derive display values ---
  const projectDir = unifiedSession?.projectDir ?? session.workingDir;
  const envName = unifiedSession?.envName ?? session.envName;
  const permMode = unifiedSession?.permMode ?? session.permMode;
  const showPermMode = session.client !== 'opencode' && !!permMode && permMode !== 'n/a';
  const startedAt = unifiedSession ? new Date(unifiedSession.createdAt) : session.startedAt;
  const pid = unifiedSession?.pid ?? session.pid;
  const sessionId = unifiedSession?.id ?? session.id;
  const isHeadless = unifiedSession?.runtimeKind === 'headless';
  const allowChannelBinding = session.client !== 'opencode';
  const isRunning = unifiedSession
    ? ['running', 'ready', 'processing', 'waiting_permission', 'initializing'].includes(
        unifiedSession.status
      )
    : session.status === 'running';
  const cardIsSelectable = isEmbedded && !isHeadless && Boolean(onSelectEmbedded);

  // --- Handle copy bind command ---
  const handleCopyBind = async () => {
    try {
      await copyBindCommand(projectDir, envName, permMode);
      toast.success(t('telegram.bindCommandCopied'));
      setBindCopied(true);
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = setTimeout(() => {
        setBindCopied(false);
        copiedTimerRef.current = null;
      }, 1500);
    } catch (error) {
      toast.error(t('telegram.bindCommandCopyFailed').replace('{error}', String(error)));
    }
  };

  // --- Channel badges: small pill chips ---
  const renderChannelBadges = (channels: ChannelInfo[]) => {
    if (!channels || channels.length === 0) return null;

    return (
      <div className="flex items-center gap-1">
        {channels.map((ch, i) => {
          const isDesktop = ch.kind === 'desktop_ui';
          const remotePlatform = getRemotePlatformFromChannel(ch.rawKind ?? ch.kind);
          const remoteMeta = remotePlatform ? getRemotePlatformMeta(remotePlatform) : null;
          const Icon = isDesktop ? Monitor : remoteMeta?.icon ?? Monitor;
          const label = isDesktop
            ? t('sessions.channel_desktop')
            : remoteMeta
              ? t(remoteMeta.channelLabelKey)
              : ch.label || ch.kind;
          const canDisconnect = !isDesktop && onDisconnectChannel;

          return (
            <Tooltip key={`${ch.kind}-${i}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={canDisconnect ? () => onDisconnectChannel!(sessionId, ch.kind) : undefined}
                  className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5',
                    'rounded-full text-[11px] tracking-[-0.02em]',
                    'bg-[hsl(var(--surface-raised))] text-muted-foreground',
                    'transition-colors duration-150',
                    canDisconnect && 'hover:bg-destructive/10 hover:text-destructive cursor-pointer'
                  )}
                >
                  <Icon className="w-2.5 h-2.5" />
                  <span>{label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {canDisconnect ? `${label} - ${t('sessions.disconnectChannel')}` : label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  };

  // --- Action buttons based on session type ---
  const renderActions = () => {
    // Confirm close state
    if (confirmingClose) {
      return (
        <div data-session-confirm-actions className="flex items-center justify-between w-full">
          <span className="text-[13px] text-destructive font-medium tracking-[-0.02em]">
            {t('sessions.confirmTerminate')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancelClose}
              className="px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground rounded-full transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => onConfirmClose?.(sessionId)}
              className="px-3 py-1.5 text-[13px] font-medium text-white bg-destructive rounded-full transition-all active:scale-95"
            >
              {t('sessions.terminate')}
            </button>
          </div>
        </div>
      );
    }

    // Headless unified sessions
    if (isHeadless && unifiedSession) {
      return (
        <div className="flex items-center justify-between w-full" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            {isRunning && onStop && (
              <button
                type="button"
                onClick={() => onStop(sessionId)}
                disabled={!isRunning}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-warning hover:bg-warning/10 rounded-full transition-all active:scale-95 disabled:opacity-40"
              >
                <SquareArrowOutUpRight className="w-3.5 h-3.5" />
                {t('sessions.stop')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {allowChannelBinding && (
              <SessionMoreActionsDropdown
                bindCopied={bindCopied}
                copiedLabel={t('telegram.bindCopiedShort')}
                copyLabel={t('telegram.copyBindShort')}
                bindLabel={t('chat.bindToChannel')}
                onCopyBind={handleCopyBind}
                onOpenBindDialog={() => setBindDialogOpen(true)}
              />
            )}
            {onRemove && (
              <SessionActionIconButton
                icon={X}
                onClick={() => onRemove(sessionId)}
                tooltip={t('sessions.headlessRemove')}
                variant="destructive"
              />
            )}
          </div>
        </div>
      );
    }

    // Embedded sessions
    if (isEmbedded) {
      return (
        <div className="flex items-center justify-between w-full" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <OpenInTerminalPopoverButton
              sessionId={sessionId}
              terminals={terminalOptions}
              disabled={!isRunning}
              className="h-[30px] px-3 text-[13px] rounded-full border border-[hsl(var(--border-subtle))] hover:bg-[hsl(var(--surface-raised))] transition-all active:scale-95"
              onMenuIntent={onMenuIntent}
              onOpenInTerminal={onOpenInTerminal}
            />
          </div>
          <div className="flex items-center gap-0.5">
            {allowChannelBinding && (
              <SessionMoreActionsDropdown
                bindCopied={bindCopied}
                copiedLabel={t('telegram.bindCopiedShort')}
                copyLabel={t('telegram.copyBindShort')}
                bindLabel={t('chat.bindToChannel')}
                onCopyBind={handleCopyBind}
                onOpenBindDialog={() => setBindDialogOpen(true)}
              />
            )}
            <SessionActionIconButton icon={X} onClick={() => onClose(sessionId)} tooltip={t('workspace.close')} variant="destructive" />
          </div>
        </div>
      );
    }

    // Interactive sessions (both legacy and unified)
    const terminalActions = getSessionTerminalActions({
      session: {
        status: session.status,
        terminalType: session.terminalType,
        windowId: session.windowId,
        tmuxTarget: session.tmuxTarget,
      },
      unifiedSession: unifiedSession
        ? {
            runtimeKind: unifiedSession.runtimeKind,
            status: unifiedSession.status,
            tmuxTarget: unifiedSession.tmuxTarget,
          }
        : undefined,
    });

    return (
      <div className="flex items-center justify-between w-full" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          {terminalActions.canFocusExistingTerminal && (
            <SessionActionIconButton
              icon={Target}
              onClick={() => onFocus(sessionId)}
              tooltip={t('sessions.focus')}
              disabled={!terminalActions.isRunning}
            />
          )}
          {terminalActions.canOpenInTerminal && (
            <OpenInTerminalPopoverButton
              sessionId={sessionId}
              terminals={terminalOptions}
              disabled={!terminalActions.isRunning}
              className="h-[30px] px-3 text-[13px] rounded-full border border-[hsl(var(--border-subtle))] hover:bg-[hsl(var(--surface-raised))] transition-all active:scale-95"
              label={t('sessions.openInTerminal')}
              onMenuIntent={onMenuIntent}
              onOpenInTerminal={onOpenInTerminal}
            />
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {allowChannelBinding && (
            <SessionMoreActionsDropdown
              bindCopied={bindCopied}
              copiedLabel={t('telegram.bindCopiedShort')}
              copyLabel={t('telegram.copyBindShort')}
              bindLabel={t('chat.bindToChannel')}
              onCopyBind={handleCopyBind}
              onOpenBindDialog={() => setBindDialogOpen(true)}
            />
          )}
          {!isEmbedded && (
            <SessionActionIconButton
              icon={Minus}
              onClick={() => onMinimize(sessionId)}
              tooltip={t('sessions.minimizeAll')}
              disabled={!terminalActions.isRunning}
            />
          )}
          <SessionActionIconButton icon={X} onClick={() => onClose(sessionId)} tooltip={t('workspace.close')} variant="destructive" />
        </div>
      </div>
    );
  };

  // --- Source icon ---
  const getSourceIcon = () => {
    if (!unifiedSession) return isEmbedded ? PanelLeft : Monitor;
    const remoteMeta = (unifiedSession.source === 'telegram' || unifiedSession.source === 'weixin')
      ? getRemotePlatformMeta(unifiedSession.source)
      : null;
    if (remoteMeta) {
      return remoteMeta.icon;
    }
    switch (unifiedSession.source) {
      case 'desktop':
        return Monitor;
      case 'cron':
        return Clock;
      case 'cli':
        return SquareTerminal;
      default:
        return Monitor;
    }
  };

  const SourceIcon = getSourceIcon();
  const sourceLabel = (() => {
    if (!unifiedSession) {
      return isEmbedded ? 'Embedded' : 'Desktop';
    }
    if (unifiedSession.source === 'telegram' || unifiedSession.source === 'weixin') {
      return t(getRemotePlatformMeta(unifiedSession.source).sourceLabelKey);
    }
    return t(`sessions.source_${unifiedSession.source}`);
  })();

  // Check if source is already shown in channels
  const hasDesktopChannel = unifiedSession?.channels?.some(ch => ch.kind === 'desktop_ui');
  const shouldShowSource = !hasDesktopChannel || unifiedSession?.source !== 'desktop';

  return (
    <TooltipProvider>
      <>
        <div
          ref={cardRef}
          data-testid="session-card"
          data-session-motion-card
          data-session-id={sessionId}
          data-client={session.client}
          className={cn(
            // Apple utility card: solid surface, hairline border, generous radius
            'group relative overflow-hidden',
            'bg-card rounded-[18px]',
            'border border-[hsl(var(--border-subtle))]',
            'transition-all duration-200',
            'active:scale-[0.97]',
            cardIsSelectable && 'cursor-pointer',
            selectedEmbedded && 'ring-2 ring-primary/40 border-primary/40',
            // Subtle hover lift (no shadow — Apple doesn't shadow cards)
            'hover:border-[hsl(var(--border))]',
          )}
        >
          {/* Main content area */}
          <div
            className={cn(
              'px-5 pt-5 pb-4',
              cardIsSelectable && 'hover:bg-[hsl(var(--surface-raised))]/30 transition-colors'
            )}
            onClick={cardIsSelectable ? () => onSelectEmbedded?.(sessionId) : undefined}
          >
            {/* Header: status + project name + source/channels */}
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <span data-session-status-dot className="inline-flex items-center justify-center">
                  {statusIndicator}
                </span>
                <h3 className="font-semibold text-foreground truncate text-[15px] tracking-[-0.02em] leading-tight">
                  {getProjectName(projectDir)}
                </h3>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {shouldShowSource && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="inline-flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground/50 hover:text-foreground/70 hover:bg-[hsl(var(--surface-raised))] transition-colors cursor-default">
                        <SourceIcon className="w-3.5 h-3.5" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {sourceLabel}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>

            {/* Metadata row: env, perm, duration */}
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground tracking-[-0.01em]">
              <ModelIcon model={envName} size={12} />
              <span className="font-medium text-foreground/80">{envName}</span>

              {showPermMode && (
                <>
                  <span className="text-muted-foreground/25 select-none">·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-default">
                        <Shield className="w-3 h-3 text-muted-foreground/50" />
                        <span>{permMode}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {t('environments.permissionMode')}: {permMode}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}

              <span className="text-muted-foreground/25 select-none">·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDuration(startedAt)}
              </span>
            </div>

            {/* Path */}
            <div className="flex items-center gap-1.5 mt-2.5 text-[12px] text-muted-foreground/50 tracking-[-0.01em]">
              <FolderOpen className="w-3 h-3 flex-shrink-0" />
              <span className="truncate font-mono" title={`${projectDir}${pid ? ` · PID: ${pid}` : ''}`}>
                {projectDir}
              </span>
            </div>

            {/* Channel badges */}
            {unifiedSession && unifiedSession.channels.length > 0 && (
              <div className="mt-3">
                {renderChannelBadges(unifiedSession.channels)}
              </div>
            )}
          </div>

          {/* Actions footer — separated by hairline */}
          <div className="px-5 py-3 border-t border-[hsl(var(--border-subtle))]">
            {renderActions()}
          </div>
        </div>

        {allowChannelBinding && bindDialogOpen ? (
          <Suspense fallback={null}>
            <LazyBindToChatDialog
              open={bindDialogOpen}
              onOpenChange={setBindDialogOpen}
              initialProjectDir={projectDir}
              initialEnvName={envName}
              initialPermMode={permMode}
            />
          </Suspense>
        ) : null}
      </>
    </TooltipProvider>
  );
}
