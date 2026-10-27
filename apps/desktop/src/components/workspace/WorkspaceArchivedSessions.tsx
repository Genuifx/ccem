import { useCallback, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Search } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getHistorySessionDisplay } from '@/components/history/historySession';
import type { HistorySessionItem } from '@/features/conversations/types';
import { filterArchivedSessions } from './sessionArchive';
import { SessionTreeItemIcon } from './sessionTreeIcons';

type ArchiveLoadState = 'idle' | 'loading' | 'ready' | 'error';

interface WorkspaceArchivedSessionsProps {
  loadArchivedSessions: () => Promise<HistorySessionItem[]>;
  onUnarchive: (session: HistorySessionItem) => Promise<void>;
  onOpen: (session: HistorySessionItem) => void;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: string) => string;
}

export function WorkspaceArchivedSessions({
  loadArchivedSessions,
  onUnarchive,
  onOpen,
  formatRelativeTime,
  t,
}: WorkspaceArchivedSessionsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<HistorySessionItem[]>([]);
  const [loadState, setLoadState] = useState<ArchiveLoadState>('idle');
  const [restoringKey, setRestoringKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadState('loading');
    try {
      setSessions(await loadArchivedSessions());
      setLoadState('ready');
    } catch (error) {
      console.error('Failed to load archived sessions:', error);
      setLoadState('error');
    }
  }, [loadArchivedSessions]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery('');
      void reload();
    }
  }, [reload]);

  const visible = useMemo(() => filterArchivedSessions(sessions, query), [query, sessions]);

  const restore = useCallback(async (session: HistorySessionItem) => {
    const key = `${session.source}:${session.id}`;
    setRestoringKey(key);
    try {
      await onUnarchive(session);
      setSessions((previous) => previous.filter((item) => `${item.source}:${item.id}` !== key));
    } catch (error) {
      console.error('Failed to unarchive session:', error);
    } finally {
      setRestoringKey(null);
    }
  }, [onUnarchive]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="workspace-archived-trigger"
          className={cn(
            'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground/70',
            'hover:bg-muted/60 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
            open && 'bg-muted/60 text-foreground'
          )}
        >
          <Archive className="h-3.5 w-3.5" />
          {t('workspace.archivedSessions')}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="flex w-[320px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover p-0 shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle/40 px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('workspace.archivedSearchPlaceholder')}
            className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
          />
          {loadState === 'ready' && (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">{sessions.length}</span>
          )}
        </div>
        <ScrollArea className="max-h-[360px]">
          <div className="p-1">
            {loadState === 'loading' && sessions.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('workspace.archivedLoading')}</p>
            )}
            {loadState === 'error' && (
              <p className="px-3 py-6 text-center text-xs text-destructive">{t('workspace.archivedLoadFailed')}</p>
            )}
            {loadState === 'ready' && visible.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {sessions.length === 0 ? t('workspace.archivedEmpty') : t('workspace.archivedNoMatch')}
              </p>
            )}
            {visible.map((session) => {
              const key = `${session.source}:${session.id}`;
              return (
                <div
                  key={key}
                  data-archived-session-key={key}
                  className="group/archived relative flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpen(session);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
                      <SessionTreeItemIcon session={session} isSelected={false} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium text-foreground">
                        {getHistorySessionDisplay(session, t('history.untitledSession'))}
                      </span>
                      <span className="truncate text-[10px] text-muted-foreground/70">
                        {session.projectName} · {formatRelativeTime(session.timestamp)}
                      </span>
                    </span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={restoringKey === key}
                        onClick={() => void restore(session)}
                        aria-label={t('workspace.unarchiveSession')}
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground/70',
                          'opacity-0 transition-opacity group-hover/archived:opacity-100 focus:opacity-100',
                          'hover:bg-muted hover:text-foreground disabled:opacity-50'
                        )}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={6} className="whitespace-nowrap">
                      {t('workspace.unarchiveSession')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
