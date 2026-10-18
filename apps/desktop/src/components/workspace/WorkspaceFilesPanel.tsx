import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  FileCode,
  FileDiff,
  FilePenLine,
  FileText,
  FolderClosed,
  GitBranch,
  PanelLeft,
  RefreshCw,
  Search,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';
import { useLocale } from '@/locales';
import type {
  NativeSessionSummary,
  WorkspaceFileDiff,
  WorkspaceFilePreview,
  WorkspaceFileSuggestion,
  WorkspaceGitSnapshot,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';
import type { ReviewChangedFile, ReviewSource, WorkspaceReviewModel } from './workspaceReview';
import { WorkspaceFileLinkContext, useWorkspaceFileLinks } from './WorkspaceFileLinkContext';
import { useWorkspaceSidePanel } from './WorkspaceSidePanel';
import { DiffPreview, MediaPreview, basename, isMarkdownPath, mediaKindForPath } from './WorkspaceFilePreview';

export interface WorkspaceFilesPanelProps {
  session: NativeSessionSummary;
  model: WorkspaceReviewModel;
  onLoadDiff: (filePath: string) => Promise<WorkspaceFileDiff>;
  onLoadMediaPreview?: (filePath: string) => Promise<WorkspaceMediaPreview>;
  gitSnapshot?: WorkspaceGitSnapshot | null;
  requestedPath?: string;
  requestRevision?: number;
  requestedMode?: FileMode;
  onRefreshGit?: () => void;
  isRefreshingGit?: boolean;
  /** When provided, the internal scope tab bar is hidden and this scope is used directly. */
  externalScope?: 'changes' | 'browse';
}

type FileMode = 'preview' | 'source' | 'diff';
type ChangeSourceFilter = 'all' | 'session' | 'git';

const COMPACT_PANEL_WIDTH = 620;

function dirnameOf(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

function shortDirectory(directory: string, projectName: string) {
  if (!directory) return projectName;
  const parts = directory.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : directory;
}

function statusMark(status: string) {
  const value = status.toLowerCase();
  if (value.includes('add') || value.includes('untrack') || value === 'a' || value === '??') {
    return { letter: 'A', className: 'text-success' };
  }
  if (value.includes('delet') || value === 'd') {
    return { letter: 'D', className: 'text-destructive' };
  }
  if (value.includes('renam') || value === 'r') {
    return { letter: 'R', className: 'text-primary' };
  }
  return { letter: 'M', className: 'text-warning' };
}

function browseDefaultMode(path: string, file?: ReviewChangedFile): FileMode {
  if (file && statusMark(file.status).letter === 'D') return 'diff';
  return isMarkdownPath(path) || mediaKindForPath(path) ? 'preview' : 'source';
}

function groupChangedFiles(files: ReviewChangedFile[]) {
  const groups = new Map<string, ReviewChangedFile[]>();
  for (const file of files) {
    const directory = dirnameOf(file.path);
    const bucket = groups.get(directory);
    if (bucket) bucket.push(file);
    else groups.set(directory, [file]);
  }
  for (const bucket of groups.values()) {
    bucket.sort((left, right) => basename(left.path).localeCompare(basename(right.path)));
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function SourceMark({ source }: { source: ReviewSource }) {
  const { t } = useLocale();
  if (source === 'matched') {
    return (
      <span
        className="flex shrink-0 items-center gap-0.5 text-muted-foreground/55"
        title={t('workspace.changesSourceBoth')}
        aria-label={t('workspace.changesSourceBoth')}
      >
        <GitBranch className="h-2.5 w-2.5" />
        <FilePenLine className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (source === 'sdk') {
    return (
      <span className="shrink-0 text-primary/55" title={t('workspace.changesSourceSession')} aria-label={t('workspace.changesSourceSession')}>
        <FilePenLine className="h-2.5 w-2.5" />
      </span>
    );
  }
  return (
    <span className="shrink-0 text-muted-foreground/40" title={t('workspace.changesSourceGit')} aria-label={t('workspace.changesSourceGit')}>
      <GitBranch className="h-2.5 w-2.5" />
    </span>
  );
}

function FileStat({ additions, deletions }: { additions?: number | null; deletions?: number | null }) {
  const hasAdditions = typeof additions === 'number' && additions > 0;
  const hasDeletions = typeof deletions === 'number' && deletions > 0;
  if (!hasAdditions && !hasDeletions) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] tabular-nums">
      {hasAdditions ? <span className="text-success/80">+{additions}</span> : null}
      {hasDeletions ? <span className="text-destructive/75">−{deletions}</span> : null}
    </span>
  );
}

export function WorkspaceFilesPanel({
  session,
  model,
  onLoadDiff,
  onLoadMediaPreview,
  gitSnapshot,
  requestedPath,
  requestRevision,
  requestedMode,
  onRefreshGit,
  isRefreshingGit,
  externalScope,
}: WorkspaceFilesPanelProps) {
  const { t } = useLocale();
  const fileLinks = useWorkspaceFileLinks();
  const sidePanel = useWorkspaceSidePanel();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<FileMode>('source');
  const [internalScope, setInternalScope] = useState<'changes' | 'browse'>('changes');
  const scope = externalScope ?? internalScope;
  const [sourceFilter, setSourceFilter] = useState<ChangeSourceFilter>('all');
  const [showList, setShowList] = useState(!requestedPath);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<WorkspaceFileSuggestion[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [browseDir, setBrowseDir] = useState('');
  const [browseDirEntries, setBrowseDirEntries] = useState<WorkspaceFileSuggestion[]>([]);
  const [browseDirLoading, setBrowseDirLoading] = useState(false);
  const [browseDirError, setBrowseDirError] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceMediaPreview | null>(null);
  const [textPreview, setTextPreview] = useState<WorkspaceFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileRequestSeqRef = useRef(0);
  const loaders = useRef({ onLoadDiff, onLoadMediaPreview });
  loaders.current = { onLoadDiff, onLoadMediaPreview };
  const changedFileByPath = useMemo(
    () => new Map(model.changedFiles.map((file) => [file.path, file])),
    [model.changedFiles],
  );
  const changedFileByPathRef = useRef(changedFileByPath);
  changedFileByPathRef.current = changedFileByPath;
  const projectName = basename(session.project_dir);
  const compact = paneWidth > 0 && paneWidth < COMPACT_PANEL_WIDTH;

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') setPaneWidth(width);
    });
    observer.observe(node);
    setPaneWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => { fileRequestSeqRef.current += 1; }, []);

  const resetPreviewState = useCallback(() => {
    setDiff(null);
    setTextPreview(null);
    setMediaPreview(null);
    setError(null);
  }, []);

  // Reset view state when scope (tab) changes.
  const prevScopeRef = useRef(scope);
  useEffect(() => {
    if (prevScopeRef.current === scope) return;
    prevScopeRef.current = scope;
    setSelectedPath(null);
    setShowList(true);
    setQuery('');
    resetPreviewState();
  }, [resetPreviewState, scope]);

  const selectFile = useCallback(async (path: string, requestedMode?: FileMode) => {
    const file = changedFileByPathRef.current.get(path);
    // Changes is a diff-review surface: selecting a file must stay here and
    // open its diff. Source/preview live in the Browse tab.
    const nextMode = scope === 'changes' ? 'diff' : requestedMode ?? browseDefaultMode(path, file);
    const requestSeq = ++fileRequestSeqRef.current;
    setSelectedPath(path);
    setMode(nextMode);
    setDiff(null);
    setTextPreview(null);
    setMediaPreview(null);
    setError(null);
    setLoading(true);
    try {
      if (nextMode === 'diff') {
        const next = await loaders.current.onLoadDiff(path);
        if (requestSeq !== fileRequestSeqRef.current) return;
        setDiff(next);
      } else if (mediaKindForPath(path) && loaders.current.onLoadMediaPreview) {
        const next = await loaders.current.onLoadMediaPreview(path);
        if (requestSeq !== fileRequestSeqRef.current) return;
        setMediaPreview(next);
      } else {
        const next = await invoke<WorkspaceFilePreview>('get_workspace_file_preview', { workingDir: session.project_dir, filePath: path });
        if (requestSeq !== fileRequestSeqRef.current) return;
        setTextPreview(next);
      }
    } catch (requestError) {
      if (requestSeq !== fileRequestSeqRef.current) return;
      setError(String(requestError));
    } finally {
      if (requestSeq === fileRequestSeqRef.current) setLoading(false);
    }
  }, [resetPreviewState, scope, session.project_dir]);

  useEffect(() => {
    if (!requestedPath) return;
    setShowList(false);
    void selectFile(requestedPath, requestedMode);
  }, [requestedMode, requestedPath, requestRevision, selectFile]);

  const openSourceInBrowse = useCallback((path: string) => {
    if (sidePanel) sidePanel.open('browse', path, undefined, 'source');
    else fileLinks?.openFile(path);
  }, [fileLinks, sidePanel]);

  useEffect(() => {
    if (scope !== 'browse') return;
    let cancelled = false;
    if (query.trim()) {
      setSearching(true);
      setSearchError(null);
      const timer = window.setTimeout(() => {
        void invoke<WorkspaceFileSuggestion[]>('search_workspace_files', { workingDir: session.project_dir, query, limit: 40 })
          .then((files) => { if (!cancelled) setSuggestions(files); })
          .catch((err) => { if (!cancelled) { setSuggestions([]); setSearchError(String(err)); } })
          .finally(() => { if (!cancelled) setSearching(false); });
      }, 180);
      return () => { cancelled = true; window.clearTimeout(timer); };
    }
    setSuggestions([]);
    setSearching(false);
    return undefined;
  }, [query, scope, session.project_dir]);

  useEffect(() => {
    if (scope !== 'browse') return;
    let cancelled = false;
    setBrowseDirLoading(true);
    setBrowseDirError(null);
    void invoke<WorkspaceFileSuggestion[]>('list_workspace_dir', { workingDir: session.project_dir, relativeDir: browseDir || null })
      .then((entries) => { if (!cancelled) setBrowseDirEntries(entries); })
      .catch((err) => { if (!cancelled) { setBrowseDirEntries([]); setBrowseDirError(String(err)); } })
      .finally(() => { if (!cancelled) setBrowseDirLoading(false); });
    return () => { cancelled = true; };
  }, [browseDir, scope, session.project_dir]);

  const openInEditor = async (path: string) => {
    try {
      await invoke<boolean>('open_file_in_workspace', { workingDir: session.project_dir, filePath: path });
    } catch (err) {
      const message = String(err);
      if (message.includes('escapes working dir')) toast.error(t('workspace.reviewPathOutsideWorkspace'));
      else toast.error(message);
    }
  };

  const sourceCounts = useMemo(() => ({
    total: model.changedFiles.length,
    session: model.changedFiles.filter((file) => file.source !== 'git').length,
    git: model.changedFiles.filter((file) => file.source !== 'sdk').length,
  }), [model.changedFiles]);

  const filteredChanges = useMemo(() => {
    const term = query.trim().toLowerCase();
    return model.changedFiles.filter((file) => {
      if (sourceFilter === 'session' && file.source === 'git') return false;
      if (sourceFilter === 'git' && file.source === 'sdk') return false;
      if (term && !file.path.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [model.changedFiles, query, sourceFilter]);

  const groupedChanges = useMemo(
    () => groupChangedFiles(filteredChanges),
    [filteredChanges],
  );

  const gitStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of model.changedFiles) {
      if (file.source === 'sdk') continue;
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
    return { additions, deletions };
  }, [model.changedFiles]);

  // Do not keep previewing a file that the active filter hides.
  useEffect(() => {
    if (scope !== 'changes' || !selectedPath) return;
    if (filteredChanges.some((file) => file.path === selectedPath)) return;
    setSelectedPath(null);
    resetPreviewState();
  }, [filteredChanges, resetPreviewState, scope, selectedPath]);

  const selectedFile = selectedPath ? changedFileByPath.get(selectedPath) : undefined;
  const selectedMark = selectedFile ? statusMark(selectedFile.status) : null;
  const isDeleted = selectedMark?.letter === 'D';
  const isMedia = selectedPath ? mediaKindForPath(selectedPath) : null;
  const canPreview = selectedPath ? isMarkdownPath(selectedPath) || Boolean(isMedia) : false;
  const modeOptions = useMemo(() => {
    if (!selectedPath) return [] as Array<{ key: FileMode; label: string; icon: typeof FileDiff }>;
    if (isDeleted) return [{ key: 'diff' as const, label: t('workspace.filesDiffShort'), icon: FileDiff }];
    const options: Array<{ key: FileMode; label: string; icon: typeof FileDiff }> = [
      { key: 'diff', label: t('workspace.filesDiffShort'), icon: FileDiff },
    ];
    if (!isMedia) options.push({ key: 'source', label: t('workspace.filesSource'), icon: FileCode });
    if (canPreview) options.push({ key: 'preview', label: t('workspace.filesPreview'), icon: Eye });
    return options;
  }, [canPreview, isDeleted, isMedia, selectedPath, t]);

  const selectedAdditions = diff?.additions ?? selectedFile?.additions ?? 0;
  const selectedDeletions = diff?.deletions ?? selectedFile?.deletions ?? 0;
  const branchLabel = gitSnapshot?.is_repo
    ? gitSnapshot.branch || gitSnapshot.sha?.slice(0, 7) || null
    : null;
  const gitErrorMessage = gitSnapshot && !gitSnapshot.is_repo ? gitSnapshot.error || t('workspace.changesGitUnavailable') : null;
  const listVisible = compact ? !selectedPath : selectedPath ? showList : true;
  const previewVisible = compact ? Boolean(selectedPath) : true;
  const browseHasQuery = scope === 'browse' && query.trim().length > 0;
  const browseListItems = browseHasQuery ? suggestions : browseDirEntries;
  const browseIsLoading = browseHasQuery ? searching : browseDirLoading;
  const browseError = browseHasQuery ? searchError : browseDirError;
  const breadcrumbSegments = browseDir ? browseDir.split('/') : [];
  const showChangesFilter = scope === 'changes' && (sourceCounts.total > 8 || query.trim().length > 0);
  const isChangesEmpty = scope === 'changes' && sourceCounts.total === 0;

  const changeFilterChips: Array<{ key: ChangeSourceFilter; label: string; count: number }> = [
    { key: 'all', label: t('workspace.changesFilterAll'), count: sourceCounts.total },
    { key: 'session', label: t('workspace.changesFilterSession'), count: sourceCounts.session },
    { key: 'git', label: t('workspace.changesFilterGit'), count: sourceCounts.git },
  ];

  const previewHeader = (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle/40 px-1.5">
      {selectedPath ? (
        compact ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t('workspace.changesBackToList')}
            title={t('workspace.changesBackToList')}
            onClick={() => setSelectedPath(null)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t('workspace.filesToggleList')}
            aria-pressed={showList}
            title={t('workspace.filesToggleList')}
            onClick={() => setShowList(!showList)}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>
        )
      ) : null}
      {selectedPath ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {scope === 'browse' ? (
            <button
              type="button"
              onClick={() => setBrowseDir('')}
              className="shrink-0 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              {projectName}
            </button>
          ) : (
            <span className="shrink-0 text-[10px] text-muted-foreground/55">{projectName}</span>
          )}
          {dirnameOf(selectedPath) ? (
            <>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/35" />
              {scope === 'browse' ? (
                <button
                  type="button"
                  onClick={() => setBrowseDir(dirnameOf(selectedPath))}
                  className="min-w-0 truncate text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
                  title={dirnameOf(selectedPath)}
                >
                  {dirnameOf(selectedPath)}
                </button>
              ) : (
                <span className="min-w-0 truncate text-[10px] text-muted-foreground/60" title={dirnameOf(selectedPath)}>
                  {dirnameOf(selectedPath)}
                </span>
              )}
            </>
          ) : null}
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/35" />
          <span className="shrink-0 text-[11px] font-medium text-foreground">{basename(selectedPath)}</span>
          {selectedMark?.letter === 'A' ? (
            <span className="shrink-0 rounded bg-success/10 px-1 py-px text-[9px] font-medium text-success">{t('workspace.changesNewFile')}</span>
          ) : isDeleted ? (
            <span className="shrink-0 rounded bg-destructive/10 px-1 py-px text-[9px] font-medium text-destructive">{t('workspace.changesDeletedFile')}</span>
          ) : null}
        </div>
      ) : (
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t('workspace.sidePanelFiles')}</p>
      )}
      {selectedPath ? (
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <FileStat additions={selectedAdditions} deletions={selectedDeletions} />
          {scope === 'browse' ? <div className="flex items-center rounded-md bg-muted/35 p-0.5" role="group" aria-label={t('workspace.filesView')}>
            {modeOptions.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                aria-label={label}
                title={label}
                onClick={() => void selectFile(selectedPath, key)}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors',
                  mode === key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3 w-3" />
                {compact ? null : <span>{label}</span>}
              </button>
            ))}
          </div> : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t('workspace.filesRefreshPreview')}
            title={t('workspace.filesRefreshPreview')}
            onClick={() => void selectFile(selectedPath, mode)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          {scope === 'changes' && fileLinks ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={t('workspace.viewInBrowse')}
              title={t('workspace.viewInBrowse')}
              onClick={() => openSourceInBrowse(selectedPath)}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className={cn('h-7 shrink-0 gap-1 rounded-full px-2 text-[10px]', compact && 'w-7 px-0')}
            aria-label={t('workspace.reviewOpenInEditor')}
            title={t('workspace.reviewOpenInEditor')}
            onClick={() => void openInEditor(selectedPath)}
          >
            <ExternalLink className="h-3 w-3" />
            {compact ? null : <span>{t('workspace.changesOpen')}</span>}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div ref={rootRef} data-review-page="files" data-changes-layout={compact ? 'compact' : 'split'} className="flex min-h-0 flex-1 flex-col">
      {!externalScope ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle/50 px-2">
          <button
            type="button"
            aria-pressed={scope === 'changes'}
            onClick={() => setInternalScope('changes')}
            className={cn('rounded px-2 py-1 text-[11px]', scope === 'changes' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
          >
            {t('workspace.sidePanelChanges')} {sourceCounts.total}
          </button>
          <button
            type="button"
            aria-pressed={scope === 'browse'}
            onClick={() => setInternalScope('browse')}
            className={cn('rounded px-2 py-1 text-[11px]', scope === 'browse' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
          >
            {t('workspace.scopeBrowseShort')}
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            aria-label={t('workspace.reviewRefresh')}
            disabled={isRefreshingGit}
            onClick={onRefreshGit}
          >
            <RefreshCw className={cn('h-3 w-3', isRefreshingGit && 'animate-spin')} />
          </Button>
        </div>
      ) : null}

      {isChangesEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle/50 bg-surface-raised/30">
            <FileDiff className="h-5 w-5 text-muted-foreground/35" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground/80">{t('workspace.changesEmptyTitle')}</p>
            <p className="max-w-[260px] text-[10px] leading-relaxed text-muted-foreground/65">{t('workspace.changesEmptyBody')}</p>
          </div>
          {onRefreshGit ? (
            <Button variant="outline" size="sm" className="h-7 gap-1.5 rounded-full px-2.5 text-[10px]" onClick={onRefreshGit}>
              <RefreshCw className={cn('h-3 w-3', isRefreshingGit && 'animate-spin')} />
              {t('workspace.reviewRefresh')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {listVisible ? (
            <div className={cn(
              'flex min-h-0 shrink-0 flex-col',
              compact ? 'w-full' : 'w-[clamp(220px,31%,340px)] border-r border-border-subtle/50',
            )}>
              {scope === 'changes' ? (
                <>
                  <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border-subtle/40 px-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" role="group" aria-label={t('workspace.fileSources')}>
                      {changeFilterChips.map(({ key, label, count }) => (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={sourceFilter === key}
                          disabled={key !== 'all' && count === 0}
                          onClick={() => setSourceFilter(key)}
                          className={cn(
                            'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-colors',
                            sourceFilter === key
                              ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/20'
                              : 'text-muted-foreground hover:bg-surface-raised/60 hover:text-foreground',
                            key !== 'all' && count === 0 && 'opacity-40 hover:bg-transparent hover:text-muted-foreground',
                          )}
                        >
                          {label}
                          <span className={cn('tabular-nums', sourceFilter === key ? 'text-primary/65' : 'text-muted-foreground/50')}>{count}</span>
                        </button>
                      ))}
                    </div>
                    {onRefreshGit ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        aria-label={t('workspace.reviewRefresh')}
                        title={t('workspace.reviewRefresh')}
                        disabled={isRefreshingGit}
                        onClick={onRefreshGit}
                      >
                        <RefreshCw className={cn('h-3 w-3', isRefreshingGit && 'animate-spin')} />
                      </Button>
                    ) : null}
                  </div>
                  {showChangesFilter ? (
                    <div className="relative shrink-0 border-b border-border-subtle/30 px-2 py-1">
                      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
                      <Input
                        aria-label={t('workspace.changesFilterPlaceholder')}
                        placeholder={t('workspace.changesFilterPlaceholder')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        className="h-6 rounded-md border-0 bg-surface-raised/30 pl-6 pr-2 text-[10px] shadow-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>
                  ) : null}
                  <ScrollArea className="min-h-0 flex-1">
                    {gitErrorMessage ? (
                      <p className="px-3 pt-2 text-[10px] text-muted-foreground/60" title={gitErrorMessage}>{t('workspace.changesGitUnavailable')}</p>
                    ) : null}
                    {groupedChanges.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                        <p className="text-[11px] text-muted-foreground">{t('workspace.changesNoMatch')}</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 rounded-full px-2 text-[10px]"
                          onClick={() => { setQuery(''); setSourceFilter('all'); }}
                        >
                          {t('workspace.changesClearFilter')}
                        </Button>
                      </div>
                    ) : groupedChanges.map(([directory, files]) => (
                      <div key={directory || 'root'}>
                        <div
                          className="sticky top-0 z-10 flex h-6 items-center border-b border-border-subtle/25 bg-background/90 px-2 font-mono text-[9px] text-muted-foreground/55 backdrop-blur-sm"
                          title={directory || projectName}
                        >
                          <span className="truncate">{shortDirectory(directory, projectName)}</span>
                          <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted-foreground/35">{files.length}</span>
                        </div>
                        {files.map((file) => {
                          const mark = statusMark(file.status);
                          const active = file.path === selectedPath;
                          return (
                            <button
                              key={file.path}
                              type="button"
                              data-ccem-change-file={file.path}
                              aria-pressed={active}
                              title={file.path}
                              onClick={() => void selectFile(file.path)}
                              className={cn(
                                'flex w-full items-center gap-1.5 border-l-2 px-2 py-[5px] text-left text-[11px] leading-4 transition-colors',
                                active
                                  ? 'border-primary/60 bg-primary/[0.08] text-foreground'
                                  : 'border-transparent text-foreground/85 hover:bg-surface-raised/55',
                              )}
                            >
                              <span className={cn('w-3 shrink-0 text-center font-mono text-[9px] font-semibold', mark.className)}>{mark.letter}</span>
                              <span className="min-w-0 flex-1 truncate">{basename(file.path)}</span>
                              <SourceMark source={file.source} />
                              <FileStat additions={file.additions} deletions={file.deletions} />
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </ScrollArea>
                </>
              ) : (
                <>
                  <div className="relative shrink-0 border-b border-border-subtle/40 px-2 py-1.5">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
                    <Input
                      aria-label={t('workspace.filesSearch')}
                      placeholder={t('workspace.filesSearch')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="h-7 rounded-md border-0 bg-surface-raised/30 pl-6 pr-2 text-[10px] shadow-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                  {!browseHasQuery ? (
                    <div className="flex min-h-0 shrink-0 items-center overflow-x-auto border-b border-border-subtle/30 px-2 py-1">
                      <button type="button" onClick={() => setBrowseDir('')} className={cn('shrink-0 rounded px-1 py-0.5 text-[10px] font-medium transition-colors', browseDir === '' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>{projectName}</button>
                      {breadcrumbSegments.map((segment, index) => {
                        const path = breadcrumbSegments.slice(0, index + 1).join('/');
                        const isLast = index === breadcrumbSegments.length - 1;
                        return (
                          <span key={path} className="flex shrink-0 items-center">
                            <ChevronRight className="h-3 w-3 text-muted-foreground/35" />
                            <button type="button" onClick={() => setBrowseDir(path)} className={cn('rounded px-1 py-0.5 text-[10px] font-medium transition-colors', isLast ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>{segment}</button>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <ScrollArea className="min-h-0 flex-1">
                    {browseError ? <p className="px-3 py-3 text-[11px] text-destructive">{browseError}</p> : null}
                    {browseIsLoading ? <p className="px-3 py-4 text-[11px] text-muted-foreground">{t('workspace.reviewLoading')}</p>
                      : browseListItems.length === 0 ? <p className="px-3 py-4 text-[11px] text-muted-foreground">{t('workspace.filesEmpty')}</p>
                        : browseListItems.map((item) => (
                          <button
                            key={item.relative_path}
                            type="button"
                            data-review-file-row
                            title={item.relative_path}
                            onClick={() => {
                              if (item.is_dir) { setBrowseDir(item.relative_path); setQuery(''); return; }
                              void selectFile(item.relative_path);
                            }}
                            className={cn(
                              'flex w-full items-center gap-1.5 px-2 py-[5px] text-left text-[11px] transition-colors',
                              selectedPath === item.relative_path
                                ? 'bg-primary/[0.08] text-foreground ring-1 ring-inset ring-primary/20'
                                : 'hover:bg-surface-raised/55',
                            )}
                          >
                            {item.is_dir
                              ? <><ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/45" /><FolderClosed className="h-3.5 w-3.5 shrink-0 opacity-45" /></>
                              : <><span className="w-3 shrink-0" /><FileText className="h-3.5 w-3.5 shrink-0 opacity-45" /></>}
                            <span className="min-w-0 flex-1 truncate">{item.display_name}</span>
                          </button>
                        ))}
                  </ScrollArea>
                </>
              )}
            </div>
          ) : null}

          {previewVisible ? (
            <div className={cn('flex min-w-0 flex-1 flex-col', compact && 'w-full')}>
              {previewHeader}
              {selectedPath ? (
                <ScrollArea className="min-h-0 flex-1">
                  {mode === 'diff' ? (
                    <DiffPreview
                      diff={diff}
                      loading={loading}
                      error={error}
                      onViewSource={scope === 'changes'
                        ? sidePanel || fileLinks ? () => openSourceInBrowse(selectedPath) : undefined
                        : isMedia ? undefined : () => void selectFile(selectedPath, 'source')}
                      sourceLabel={scope === 'changes' ? t('workspace.viewInBrowse') : t('workspace.filesSource')}
                    />
                  ) : isMedia ? (
                    <MediaPreview preview={mediaPreview} loading={loading} error={error} />
                  ) : loading ? (
                    <p role="status" className="p-4 text-xs text-muted-foreground">{t('workspace.reviewLoading')}</p>
                  ) : error ? (
                    <p role="alert" className="p-4 text-xs text-destructive">{error}</p>
                  ) : textPreview?.is_binary ? (
                    <p className="p-4 text-xs text-muted-foreground">{t('workspace.reviewBinaryUnavailable')}</p>
                  ) : textPreview ? (
                    <>
                      {textPreview.truncated ? <p className="p-3 text-[10px] text-warning">{t('workspace.filesTruncated')}</p> : null}
                      {mode === 'preview' && isMarkdownPath(selectedPath) ? (
                        <WorkspaceFileLinkContext.Provider value={fileLinks ? { ...fileLinks, documentPath: selectedPath } : null}>
                          <div data-ccem-markdown-preview className="p-5">
                            <MarkdownRenderer content={textPreview.content} codeTone="reading" />
                          </div>
                        </WorkspaceFileLinkContext.Provider>
                      ) : (
                        <pre data-ccem-file-source className="whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed">{textPreview.content}</pre>
                      )}
                    </>
                  ) : null}
                </ScrollArea>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle/50 bg-surface-raised/30">
                    <FileDiff className="h-5 w-5 text-muted-foreground/35" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground/75">{t('workspace.reviewSelectFile')}</p>
                    <p className="text-[10px] text-muted-foreground/60">
                      {branchLabel ? `${branchLabel} · ` : ''}
                      {t('workspace.reviewFilesCount', { count: sourceCounts.total })}
                    </p>
                    {gitStats.additions > 0 || gitStats.deletions > 0 ? (
                      <p className="flex items-center justify-center gap-1.5 font-mono text-[10px] tabular-nums">
                        <span className="text-success/80">+{gitStats.additions}</span>
                        <span className="text-destructive/75">−{gitStats.deletions}</span>
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
