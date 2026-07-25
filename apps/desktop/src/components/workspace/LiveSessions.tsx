import { Eye, X, LayoutGrid, Radio } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { cn, getProjectName } from '@/lib/utils';
import { shallow } from 'zustand/shallow';

interface LiveSessionsProps {
  onNavigate?: (tab: string) => void;
}

function getEnvDotColor(envName: string): string {
  const lower = envName.toLowerCase();
  if (lower === 'official') return 'bg-chart-1';
  if (lower.includes('glm')) return 'bg-chart-2';
  if (lower.includes('deepseek')) return 'bg-chart-3';
  if (lower.includes('kimi')) return 'bg-chart-4';
  if (lower.includes('minimax')) return 'bg-chart-5';
  return 'bg-primary';
}

export function LiveSessions({ onNavigate: _onNavigate }: LiveSessionsProps) {
  const { t } = useLocale();
  const { sessions } = useAppStore(
    (state) => ({ sessions: state.sessions }),
    shallow
  );
  const { focusSession, closeSession, arrangeSessions } = useTauriCommands();

  const runningSessions = sessions.filter(s => s.status === 'running');
  const arrangableSessions = runningSessions.filter((session) => session.terminalType !== 'embedded');

  if (runningSessions.length === 0) return null;

  const handleArrange = async () => {
    const ids = arrangableSessions.map(s => s.id);
    const layout = arrangableSessions.length <= 2 ? 'horizontal2' : arrangableSessions.length === 3 ? 'left_main3' : 'grid4';
    await arrangeSessions(ids, layout);
  };

  return (
    <div className="flex flex-col glass-card glass-noise rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <Radio className="w-3.5 h-3.5 text-success animate-pulse" />
          <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest">
            {t('workspace.liveSessions')}
          </h3>
          <span className="text-2xs font-semibold bg-success/[0.12] text-success px-2 py-0.5 rounded-full tabular-nums">
            {runningSessions.length}
          </span>
        </div>
        {arrangableSessions.length >= 2 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-2xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
            onClick={handleArrange}
          >
            <LayoutGrid className="w-3 h-3" />
            {t('workspace.arrangeWindows')}
          </Button>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-1.5">
          {runningSessions.map((session) => {
            const startTime = new Date(session.startedAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const workingDirName = session.workingDir.split('/').pop() || session.workingDir;

            return (
              <div
                key={session.id}
                className="flex items-center justify-between p-3 rounded-xl hover:bg-white/[0.04] transition-colors group"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className={cn('w-2 h-2 rounded-full flex-shrink-0 status-running', getEnvDotColor(session.envName))} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      <span className="flex items-center gap-1.5">
                        <span>{getProjectName(session.workingDir)}</span>
                        <span className="inline-flex items-center text-[9px] uppercase tracking-wide text-muted-foreground/80 rounded-md bg-white/[0.04] px-1.5 py-0.5">
                          {session.client === 'codex' ? 'Codex' : 'Claude'}
                        </span>
                        {session.terminalType === 'embedded' && (
                          <span className="inline-flex items-center text-[9px] uppercase tracking-wide text-cyan-300/80 rounded-md bg-cyan-300/[0.08] px-1.5 py-0.5">
                            embedded
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="text-2xs text-muted-foreground/50 truncate flex items-center gap-1.5">
                      <span>{workingDirName}</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span className="font-mono tabular-nums">{startTime}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-2xs text-primary hover:text-primary hover:bg-primary/[0.08]"
                    onClick={() => focusSession(session.id)}
                  >
                    <Eye className="w-3 h-3 mr-1" />
                    {t('workspace.focus')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-2xs text-destructive/70 hover:text-destructive hover:bg-destructive/[0.08]"
                    onClick={() => closeSession(session.id)}
                  >
                    <X className="w-3 h-3 mr-1" />
                    {t('workspace.close')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
