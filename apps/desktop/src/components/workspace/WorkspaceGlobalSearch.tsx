import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FolderClosed,
  MessageSquare,
  Search,
  X,
} from '@/lib/lucide-react';
import { cn, getProjectName } from '@/lib/utils';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { useLocale } from '@/locales';
import { getHistorySessionDisplay } from '@/components/history/historySession';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HistorySessionItem } from '@/features/conversations/types';

interface WorkspaceGlobalSearchProps {
  sessions: HistorySessionItem[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (session: HistorySessionItem) => void;
  onSelectProject: (projectPath: string) => void;
}

interface ProjectResult {
  type: 'project';
  path: string;
  name: string;
  sessionCount: number;
}

interface SessionResult {
  type: 'session';
  session: HistorySessionItem;
}

type SearchResult = ProjectResult | SessionResult;

function formatRelativeTime(timestamp: number, t: (key: string) => string): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const tr = (key: string, n: number) => t(key).replace('{n}', String(n));
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return tr('time.minutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr('time.hours', hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return tr('time.days', days);
  const weeks = Math.floor(days / 7);
  return tr('time.weeks', weeks);
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sessionMatchesQuery(session: HistorySessionItem, query: string): boolean {
  const haystack = [
    getHistorySessionDisplay(session, ''),
    session.projectName,
    session.project,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export const WorkspaceGlobalSearch = memo(function WorkspaceGlobalSearch({
  sessions,
  isOpen,
  onOpenChange,
  onSelectSession,
  onSelectProject,
}: WorkspaceGlobalSearchProps) {
  const { t } = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchMotionRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const normalizedQuery = normalizeQuery(query);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen]);

  const results = useMemo<SearchResult[]>(() => {
    if (!normalizedQuery) {
      return [];
    }

    const projectMap = new Map<string, HistorySessionItem[]>();
    for (const session of sessions) {
      const list = projectMap.get(session.project) ?? [];
      list.push(session);
      projectMap.set(session.project, list);
    }

    const projectResults: ProjectResult[] = [];
    const sessionResults: SessionResult[] = [];
    const seenProjectPaths = new Set<string>();

    for (const session of sessions) {
      if (sessionMatchesQuery(session, normalizedQuery)) {
        sessionResults.push({ type: 'session', session });
      }

      if (!seenProjectPaths.has(session.project)) {
        seenProjectPaths.add(session.project);
        const projectName = session.projectName || getProjectName(session.project);
        if (
          projectName.toLowerCase().includes(normalizedQuery) ||
          session.project.toLowerCase().includes(normalizedQuery)
        ) {
          projectResults.push({
            type: 'project',
            path: session.project,
            name: projectName,
            sessionCount: projectMap.get(session.project)?.length ?? 0,
          });
        }
      }
    }

    return [...projectResults, ...sessionResults];
  }, [sessions, normalizedQuery]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % results.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const result = results[selectedIndex];
        if (!result) return;
        if (result.type === 'project') {
          onSelectProject(result.path);
        } else {
          onSelectSession(result.session);
        }
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, results, selectedIndex, onSelectProject, onSelectSession, onOpenChange]);

  useGSAP(() => {
    const root = searchMotionRef.current;
    if (!isOpen || !root) {
      return;
    }

    const sections = gsap.utils.toArray<HTMLElement>(
      '[data-spotlight-field], [data-spotlight-results], [data-spotlight-footer]',
      root
    );
    if (shouldReduceMotion()) {
      clearMotionProps(sections);
      return;
    }

    gsap.fromTo(
      sections,
      { autoAlpha: 0, y: 8 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        stagger: 0.035,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(sections),
      }
    );
  }, { scope: searchMotionRef, dependencies: [isOpen] });

  useGSAP(() => {
    const root = searchMotionRef.current;
    if (!isOpen || !root || !normalizedQuery) {
      return;
    }

    const items = gsap.utils.toArray<HTMLElement>('[data-spotlight-result-item]', root);
    if (items.length === 0) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(items);
      return;
    }

    gsap.fromTo(
      items,
      { autoAlpha: 0, y: 5 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.soft,
        stagger: 0.018,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(items),
      }
    );
  }, { scope: searchMotionRef, dependencies: [isOpen, normalizedQuery, results.length] });

  useGSAP(() => {
    const root = searchMotionRef.current;
    if (!isOpen || !root || shouldReduceMotion()) {
      return;
    }

    const activeItem = root.querySelector<HTMLElement>('[data-spotlight-result-active="true"]');
    if (!activeItem) {
      return;
    }
    gsap.fromTo(
      activeItem,
      { x: -2 },
      {
        x: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.soft,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(activeItem),
      }
    );
  }, { scope: searchMotionRef, dependencies: [isOpen, selectedIndex] });

  const groupedResults = useMemo(() => {
    const projects: Array<{ result: SearchResult; flatIndex: number }> = [];
    const conversations: Array<{ result: SearchResult; flatIndex: number }> = [];
    results.forEach((result, index) => {
      if (result.type === 'project') {
        projects.push({ result, flatIndex: index });
      } else {
        conversations.push({ result, flatIndex: index });
      }
    });
    return { projects, conversations };
  }, [results]);

  const renderProjectResult = (entry: { result: SearchResult; flatIndex: number }) => {
    const result = entry.result as ProjectResult;
    const isSelected = entry.flatIndex === selectedIndex;
    return (
      <button
        key={`project:${result.path}`}
        type="button"
        data-spotlight-result-item
        data-spotlight-result-active={isSelected ? 'true' : undefined}
        onClick={() => {
          onSelectProject(result.path);
          onOpenChange(false);
        }}
        onMouseEnter={() => setSelectedIndex(entry.flatIndex)}
        className={cn(
          'group relative flex w-full items-center gap-3 rounded-lg py-2.5 pl-3 pr-4 text-left transition-colors',
          isSelected ? 'bg-primary/10' : 'hover:bg-muted'
        )}
      >
        {isSelected && (
          <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-primary" />
        )}
        <span className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
          isSelected
            ? 'bg-primary/15 text-primary'
            : 'bg-muted text-muted-foreground group-hover:bg-muted/70'
        )}>
          <FolderClosed className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight text-foreground">
            {result.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {result.sessionCount} {t('workspace.projectSessions')} · {result.path}
          </p>
        </div>
      </button>
    );
  };

  const renderSessionResult = (entry: { result: SearchResult; flatIndex: number }) => {
    const result = entry.result as SessionResult;
    const session = result.session;
    const isSelected = entry.flatIndex === selectedIndex;
    return (
      <button
        key={`session:${session.source}:${session.id}`}
        type="button"
        data-spotlight-result-item
        data-spotlight-result-active={isSelected ? 'true' : undefined}
        onClick={() => {
          onSelectSession(session);
          onOpenChange(false);
        }}
        onMouseEnter={() => setSelectedIndex(entry.flatIndex)}
        className={cn(
          'group relative flex w-full items-center gap-3 rounded-lg py-2.5 pl-3 pr-4 text-left transition-colors',
          isSelected ? 'bg-primary/10' : 'hover:bg-muted'
        )}
      >
        {isSelected && (
          <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-primary" />
        )}
        <span className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
          isSelected
            ? 'bg-primary/15 text-primary'
            : 'bg-muted text-muted-foreground group-hover:bg-muted/70'
        )}>
          <MessageSquare className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight text-foreground">
            {getHistorySessionDisplay(session, t('history.untitledSession'))}
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {session.projectName || getProjectName(session.project)} · {formatRelativeTime(session.timestamp, t)}
          </p>
        </div>
      </button>
    );
  };

  const renderSectionHeader = (label: string, count: number, withTopMargin?: boolean) => (
    <div className={cn('flex items-center gap-2.5 px-4', withTopMargin && 'mt-2')}>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        ref={searchMotionRef}
        showCloseButton={false}
        className={cn(
          'max-w-2xl gap-0 overflow-hidden rounded-2xl border border-border bg-popover p-0 shadow-xl',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'
        )}
      >
        <DialogTitle className="sr-only">{t('workspace.globalSearchTitle')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('workspace.globalSearchHint')}
        </DialogDescription>

        {/* Input area */}
        <div data-spotlight-field className="flex items-center gap-3.5 px-5 py-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('workspace.globalSearchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[15px] leading-none text-foreground placeholder:text-muted-foreground outline-none"
          />
          <div className="flex shrink-0 items-center gap-2">
            <kbd className="hidden shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
              Esc
            </kbd>
            <DialogClose
              type="button"
              aria-label={t('common.close')}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            >
              <X className="h-3.5 w-3.5" />
            </DialogClose>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Results */}
        <div data-spotlight-results className="min-h-[200px] max-h-[460px]">
          {results.length > 0 ? (
            <ScrollArea className="h-full">
              <div className="space-y-1 py-2">
                {groupedResults.projects.length > 0 && (
                  <div className="space-y-0.5">
                    {renderSectionHeader(
                      t('workspace.globalSearchSectionProjects'),
                      groupedResults.projects.length
                    )}
                    <div className="px-2">
                      {groupedResults.projects.map(renderProjectResult)}
                    </div>
                  </div>
                )}
                {groupedResults.conversations.length > 0 && (
                  <div className="space-y-0.5">
                    {renderSectionHeader(
                      t('workspace.globalSearchSectionSessions'),
                      groupedResults.conversations.length,
                      groupedResults.projects.length > 0
                    )}
                    <div className="px-2">
                      {groupedResults.conversations.map(renderSessionResult)}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : normalizedQuery ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-12 text-center">
              <Search className="mb-3 h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">{t('workspace.globalSearchEmpty')}</p>
            </div>
          ) : (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-12 text-center">
              <Search className="mb-3 h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">{t('workspace.globalSearchHint')}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div data-spotlight-footer className="flex items-center justify-between border-t border-border px-5 py-2.5">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {results.length > 0 ? `${results.length} ${t('workspace.globalSearchResultsCount')}` : ''}
          </span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">↑</kbd>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">↓</kbd>
              <span>{t('workspace.globalSearchNavigate')}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">↵</kbd>
              <span>{t('workspace.globalSearchSelect')}</span>
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
