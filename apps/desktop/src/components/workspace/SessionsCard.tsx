import { useEffect, useCallback } from 'react';
import { Terminal, Moon } from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import type { Session } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useSessionUpdatedEvent, useTaskCompletedEvent, useTaskErrorEvent, useSessionInterruptedEvent } from '@/hooks/useTauriEvents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';

interface SessionsCardProps {
  onStopAll?: () => void;
}

export function SessionsCard({ onStopAll }: SessionsCardProps) {
  const sessions = useAppStore((state) => state.sessions);
  const { loadSessions, deleteSession, focusSession, closeSession, minimizeSession } = useTauriCommands();
  const { t } = useLocale();

  // Load sessions on mount
  useEffect(() => {
    loadSessions().catch((err) => {
      console.error('Failed to load sessions:', err);
    });
  }, [loadSessions]);

  // Handle session lifecycle events from backend — reload full list for reliability
  const handleSessionLifecycleEvent = useCallback(
    () => {
      loadSessions().catch((err) => {
        console.error('Failed to reload sessions:', err);
      });
    },
    [loadSessions]
  );

  // Listen to all session lifecycle events
  useSessionUpdatedEvent(handleSessionLifecycleEvent);
  useTaskCompletedEvent(handleSessionLifecycleEvent);
  useTaskErrorEvent(handleSessionLifecycleEvent);
  useSessionInterruptedEvent(handleSessionLifecycleEvent);

  // Handle focus session
  const handleFocusSession = async (sessionId: string) => {
    await focusSession(sessionId);
  };

  // Handle minimize session
  const handleMinimizeSession = async (sessionId: string) => {
    await minimizeSession(sessionId);
  };

  // Handle close session (terminal window)
  const handleCloseSession = async (sessionId: string) => {
    await closeSession(sessionId);
  };

  // Handle remove session
  const handleRemoveSession = async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      console.error('Failed to remove session:', err);
    }
  };

  // Handle stop all sessions
  const handleStopAll = async () => {
    const runningSessions = sessions.filter((s) => s.status === 'running');
    for (const session of runningSessions) {
      try {
        await closeSession(session.id);
      } catch (err) {
        console.error(`Failed to close session ${session.id}:`, err);
      }
    }
    onStopAll?.();
  };

  const runningSessions = sessions.filter((s) => s.status === 'running');

  return (
    <div className="relative bg-card rounded-2xl border border-border p-6 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute bottom-0 left-0 w-32 h-32 bg-gradient-to-tr from-chart-3/10 to-chart-4/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Terminal className="w-4 h-4 text-primary" />
          </div>
          <h3 className="font-semibold text-foreground">{t('workspace.runningSessions')}</h3>
        </div>
        {runningSessions.length > 0 && (
          <span className="text-xs font-medium bg-primary/10 text-primary px-2.5 py-1 rounded-full">
            {runningSessions.length} {t('workspace.sessionsRunning')}
          </span>
        )}
      </div>

      {/* Sessions list */}
      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
            <Moon className="w-5 h-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm text-muted-foreground">{t('sessions.noActiveSessions')}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{t('sessions.detectionNote')}</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[200px] overflow-y-auto">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              onFocus={() => handleFocusSession(session.id)}
              onMinimize={() => handleMinimizeSession(session.id)}
              onClose={() => handleCloseSession(session.id)}
              onRemove={() => handleRemoveSession(session.id)}
            />
          ))}
        </div>
      )}

      {/* Stop all button */}
      {runningSessions.length > 0 && (
        <Button
          variant="outline"
          className="w-full mt-4 border-destructive/30 text-destructive hover:bg-destructive/10"
          onClick={handleStopAll}
        >
          {t('sessions.closeAll')}
        </Button>
      )}
    </div>
  );
}

interface SessionItemProps {
  session: Session;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onRemove: () => void;
}

function SessionItem({ session, onFocus, onMinimize, onClose, onRemove }: SessionItemProps) {
  const startTime = new Date(session.startedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const statusConfig = {
    running: { color: 'bg-primary', label: 'Running' },
    idle: { color: 'bg-chart-5', label: 'Idle' },
    stopped: { color: 'bg-muted-foreground', label: 'Stopped' },
    interrupted: { color: 'bg-chart-5', label: 'Interrupted' },
    error: { color: 'bg-destructive', label: 'Error' },
  };

  const status = statusConfig[session.status] || statusConfig.stopped;
  const isEmbedded = session.terminalType === 'embedded';

  // Get short working dir name
  const workingDirName = session.workingDir.split('/').pop() || session.workingDir;

  return (
    <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-border/50 hover:border-border transition-colors group">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={cn(
          'w-2 h-2 rounded-full flex-shrink-0',
          status.color,
          session.status === 'running' && 'animate-pulse'
        )} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-foreground truncate">
            {session.envName}
            {isEmbedded && (
              <span className="ml-2 inline-flex items-center rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-cyan-500">
                embedded
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {startTime} · {workingDirName}
          </div>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {session.status === 'running' ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-primary hover:text-primary hover:bg-primary/10"
              onClick={onFocus}
              title="Focus"
            >
              Focus
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={onMinimize}
              disabled={isEmbedded}
              title="Minimize"
            >
              Min
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onClose}
              title="Close"
            >
              Close
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
