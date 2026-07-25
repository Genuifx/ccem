import { Clock, FolderOpen, Minus, X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { cn, getProjectName } from '@/lib/utils';
import type { TmuxAttachTerminalInfo, TmuxAttachTerminalType } from '@/lib/tauri-ipc';
import { useLocale } from '../../locales';
import type { Session } from '@/store';
import { OpenInTerminalPopoverButton } from './OpenInTerminalPopoverButton';
import { getSessionTerminalActions } from './sessionTerminalActions';

interface SessionListProps {
  sessions: Session[];
  terminalOptions?: TmuxAttachTerminalInfo[];
  selectedEmbeddedSessionId?: string | null;
  onSelectEmbedded?: (id: string) => void;
  onMenuIntent?: () => void;
  onFocus: (id: string) => void;
  onOpenInTerminal: (id: string, terminalType?: TmuxAttachTerminalType) => void;
  onMinimize: (id: string) => void;
  onClose: (id: string) => void;
  confirmingId?: string | null;
  onCancelClose?: () => void;
  onConfirmClose?: (id: string) => void;
}

export function SessionList({
  sessions,
  terminalOptions,
  selectedEmbeddedSessionId,
  onSelectEmbedded,
  onMenuIntent,
  onFocus,
  onOpenInTerminal,
  onMinimize,
  onClose,
  confirmingId,
  onCancelClose,
  onConfirmClose,
}: SessionListProps) {
  const { t } = useLocale();

  const getStatusDot = (status: Session['status']) => {
    switch (status) {
      case 'running':
        return { className: 'w-2.5 h-2.5 rounded-full inline-block bg-success status-running status-glow-success' };
      case 'error':
        return { className: 'w-2.5 h-2.5 rounded-full inline-block bg-destructive status-error status-glow-destructive' };
      case 'interrupted':
        return { className: 'w-2.5 h-2.5 rounded-full inline-block bg-warning status-glow-warning' };
      case 'idle':
        return { className: 'w-2.5 h-2.5 rounded-full inline-block bg-warning status-glow-warning' };
      case 'stopped':
      default:
        return { className: 'w-2.5 h-2.5 rounded-full inline-block bg-muted-foreground/40' };
    }
  };

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

  return (
    <div className="space-y-1.5">
      {sessions.map((session) => {
        const dot = getStatusDot(session.status);
        const isEmbedded = session.terminalType === 'embedded';
        const isSelectableEmbedded = isEmbedded && Boolean(onSelectEmbedded);
        const isSelectedEmbedded = isSelectableEmbedded && session.id === selectedEmbeddedSessionId;
        const showPermMode = session.client !== 'opencode' && !!session.permMode && session.permMode !== 'n/a';
        return (
          <div
            key={session.id}
            data-testid="session-card"
            data-session-motion-card
            data-session-id={session.id}
            data-client={session.client}
            className={cn(
              'flex items-center gap-4 p-3 rounded-lg glass-subtle glass-ghost-hover transition-all duration-150',
              isSelectedEmbedded && 'ring-1 ring-cyan-300/40 bg-cyan-300/[0.05]'
            )}
          >
            <span className={dot.className} />

            {isEmbedded ? (
              <div
                role={isSelectableEmbedded ? 'button' : undefined}
                tabIndex={isSelectableEmbedded ? 0 : undefined}
                onClick={isSelectableEmbedded ? () => onSelectEmbedded?.(session.id) : undefined}
                onKeyDown={isSelectableEmbedded
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectEmbedded?.(session.id);
                      }
                    }
                  : undefined}
                className={cn(
                  'flex-1 min-w-0 rounded-lg text-left',
                  isSelectableEmbedded && 'transition-colors hover:bg-cyan-300/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40'
                )}
                title={isSelectableEmbedded ? t('sessions.selectInEmbeddedTerminal') : undefined}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-foreground">
                    {getProjectName(session.workingDir)}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 glass-subtle rounded-md font-medium">
                    {session.envName}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 glass-subtle rounded-md font-medium uppercase tracking-wide">
                    embedded
                  </span>
                  {showPermMode && (
                    <span className="text-xs px-1.5 py-0.5 glass-subtle rounded-md font-medium">
                      {session.permMode}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground/80">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDuration(session.startedAt)}
                  </span>
                  <span className="flex items-center gap-1 truncate">
                    <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate" title={`${session.workingDir}${session.pid ? ` · PID: ${session.pid}` : ''}`}>
                      {session.workingDir}
                    </span>
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-foreground">
                    {getProjectName(session.workingDir)}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 glass-subtle rounded-md font-medium">
                    {session.envName}
                  </span>
                  {showPermMode && (
                    <span className="text-xs px-1.5 py-0.5 glass-subtle rounded-md font-medium">
                      {session.permMode}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground/80">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDuration(session.startedAt)}
                  </span>
                  <span className="flex items-center gap-1 truncate">
                    <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate" title={`${session.workingDir}${session.pid ? ` · PID: ${session.pid}` : ''}`}>
                      {session.workingDir}
                    </span>
                  </span>
                </div>
              </div>
            )}

            {confirmingId === session.id ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-sm text-destructive font-medium">{t('sessions.confirmTerminate')}</span>
                <Button variant="ghost" size="sm" onClick={onCancelClose} className="glass-ghost-hover">{t('common.cancel')}</Button>
                <Button size="sm" onClick={() => onConfirmClose?.(session.id)} className="glass-btn-destructive">{t('sessions.terminate')}</Button>
              </div>
            ) : (
              <div className="flex gap-2 flex-shrink-0" onClick={(event) => event.stopPropagation()}>
                {(() => {
                  const actions = getSessionTerminalActions({
                    session: {
                      status: session.status,
                      terminalType: session.terminalType,
                      windowId: session.windowId,
                      tmuxTarget: session.tmuxTarget,
                    },
                  });
                  return (
                    <>
                      {actions.canFocusExistingTerminal && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onFocus(session.id)}
                          disabled={!actions.isRunning}
                          className="glass-btn-outline"
                        >
                          {t('sessions.focus')}
                        </Button>
                      )}
                      {actions.canOpenInTerminal && (
                        <OpenInTerminalPopoverButton
                          sessionId={session.id}
                          terminals={terminalOptions}
                          disabled={!actions.isRunning}
                          className="glass-btn-outline justify-between"
                          onMenuIntent={onMenuIntent}
                          onOpenInTerminal={onOpenInTerminal}
                        />
                      )}
                    </>
                  );
                })()}
                {!isEmbedded && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onMinimize(session.id)}
                    disabled={session.status !== 'running'}
                    className="glass-btn-outline"
                  >
                    <Minus className="w-4 h-4" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onClose(session.id)}
                  className="glass-btn-close"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
