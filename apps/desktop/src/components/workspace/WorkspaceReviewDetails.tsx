import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileDiff,
  FileText,
  LoaderCircle,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import type {
  NativeSessionSummary,
  WorkspaceFileDiff,
  WorkspaceMediaKind,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';
import type {
  ConversationMessageData,
  SessionSubagentsPayload,
  SubagentMeta,
} from '@/features/conversations/types';
import { WorkspaceTranscriptList } from './WorkspaceTranscriptList';
import type { WorkspaceReviewModel } from './workspaceReview';
import { getSubagentDisplayMeta, resolveSubagentSelection } from './workspaceSubagents';

export type WorkspaceReviewDetailPage = 'files' | 'agents';

interface WorkspaceReviewDetailsProps {
  page: WorkspaceReviewDetailPage;
  session: NativeSessionSummary;
  model: WorkspaceReviewModel;
  onLoadDiff: (filePath: string) => Promise<WorkspaceFileDiff>;
  onLoadMediaPreview?: (filePath: string) => Promise<WorkspaceMediaPreview>;
  onLoadSubagents?: (detailAgentId: string | null) => Promise<SessionSubagentsPayload>;
  isLive?: boolean;
}

const MEDIA_EXTENSION_KIND: Record<string, WorkspaceMediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  avif: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
};

function basename(path: string) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function mediaKindForPath(filePath: string): WorkspaceMediaKind | null {
  const extension = filePath.toLowerCase().split('.').pop() ?? '';
  return MEDIA_EXTENSION_KIND[extension] ?? null;
}

function formatByteSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? Math.round(value) : value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
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

function DiffPreview({
  diff,
  loading,
  error,
}: {
  diff: WorkspaceFileDiff | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useLocale();
  if (loading) {
    return (
      <div className="space-y-2 px-4 py-4" aria-label={t('workspace.reviewLoading')}>
        {Array.from({ length: 9 }).map((_, index) => (
          <div
            key={index}
            className="h-3 rounded bg-surface-raised/60"
            style={{ width: `${58 + ((index * 29) % 39)}%` }}
          />
        ))}
      </div>
    );
  }
  if (error) return <p className="px-4 py-4 text-xs text-destructive">{error}</p>;
  if (!diff) return null;
  if (!diff.is_repo) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{diff.error || t('workspace.reviewNotGitRepo')}</p>;
  }
  if (diff.is_binary) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{t('workspace.reviewBinaryUnavailable')}</p>;
  }
  if (diff.lines.length === 0) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{t('workspace.reviewNoDiff')}</p>;
  }

  return (
    <div className="py-1 font-mono text-[11px] leading-[1.55]">
      {diff.lines.map((line, index) => {
        const addition = line.kind === 'addition';
        const deletion = line.kind === 'deletion';
        const hunk = line.kind === 'hunk';
        const meta = line.kind === 'meta';
        return (
          <div
            key={`${index}:${line.text}`}
            className={cn(
              'flex min-w-0',
              addition && 'bg-success/10',
              deletion && 'bg-destructive/10',
              hunk && 'bg-primary/8 text-primary/80',
              meta && 'text-muted-foreground/50',
            )}
          >
            <span className="w-10 shrink-0 select-none border-r border-border-subtle/40 pr-1.5 text-right text-[10px] tabular-nums text-muted-foreground/45">
              {line.new_line ?? line.old_line ?? ''}
            </span>
            {!hunk && !meta ? (
              <span className={cn('w-4 shrink-0 select-none text-center', addition && 'text-success', deletion && 'text-destructive')}>
                {addition ? '+' : deletion ? '-' : ' '}
              </span>
            ) : null}
            <span
              className={cn(
                'min-w-0 flex-1 whitespace-pre-wrap break-words px-1 pr-3',
                addition && 'text-success',
                deletion && 'text-muted-foreground line-through decoration-destructive/40',
                !addition && !deletion && !hunk && !meta && 'text-foreground/80',
              )}
            >
              {line.text || ' '}
            </span>
          </div>
        );
      })}
      {diff.truncated ? (
        <p className="px-4 py-2 text-[10px] text-muted-foreground/60">{t('workspace.reviewDiffTruncated')}</p>
      ) : null}
    </div>
  );
}

function MediaPreview({
  preview,
  loading,
  error,
}: {
  preview: WorkspaceMediaPreview | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useLocale();
  if (loading) {
    return <div className="m-4 h-36 animate-pulse rounded-xl bg-surface-raised/60" />;
  }
  if (error) return <p className="px-4 py-4 text-xs text-destructive">{error}</p>;
  if (!preview) return null;
  if (preview.error || !preview.data_url) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{preview.error || t('workspace.reviewMediaUnavailable')}</p>;
  }

  const metadata = (
    <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="truncate">{preview.media_type}</span>
      <span className="ml-auto font-mono tabular-nums">{formatByteSize(preview.byte_size)}</span>
    </div>
  );
  if (preview.kind === 'image') {
    return (
      <div className="p-4">
        <img
          src={preview.data_url}
          alt={basename(preview.path)}
          className="mx-auto block max-h-[420px] max-w-full rounded-lg border border-border-subtle/40 bg-background/40 object-contain"
        />
        {metadata}
      </div>
    );
  }
  if (preview.kind === 'audio') {
    return (
      <div className="p-4">
        <audio controls src={preview.data_url} className="w-full" />
        {metadata}
      </div>
    );
  }
  if (preview.kind === 'video') {
    return (
      <div className="p-4">
        <video controls src={preview.data_url} className="max-h-[420px] w-full rounded-lg bg-black" />
        {metadata}
      </div>
    );
  }
  return <p className="px-4 py-4 text-xs text-muted-foreground">{t('workspace.reviewBinaryUnavailable')}</p>;
}

function FilesDetail({
  session,
  model,
  onLoadDiff,
  onLoadMediaPreview,
}: Pick<WorkspaceReviewDetailsProps, 'session' | 'model' | 'onLoadDiff' | 'onLoadMediaPreview'>) {
  const { t } = useLocale();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceMediaPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRequestSeqRef = useRef(0);

  useEffect(() => () => {
    fileRequestSeqRef.current += 1;
  }, []);

  const selectFile = useCallback(async (path: string) => {
    const requestSeq = fileRequestSeqRef.current + 1;
    fileRequestSeqRef.current = requestSeq;
    setSelectedPath(path);
    setDiff(null);
    setMediaPreview(null);
    setError(null);
    setLoading(true);
    try {
      const mediaKind = mediaKindForPath(path);
      if (mediaKind && onLoadMediaPreview) {
        const preview = await onLoadMediaPreview(path);
        if (requestSeq !== fileRequestSeqRef.current) return;
        setMediaPreview(preview);
      } else {
        const nextDiff = await onLoadDiff(path);
        if (requestSeq !== fileRequestSeqRef.current) return;
        setDiff(nextDiff);
      }
    } catch (requestError) {
      if (requestSeq !== fileRequestSeqRef.current) return;
      setError(String(requestError));
    } finally {
      if (requestSeq === fileRequestSeqRef.current) setLoading(false);
    }
  }, [onLoadDiff, onLoadMediaPreview]);

  const openInEditor = async (path: string) => {
    try {
      await invoke<boolean>('open_file_in_workspace', {
        workingDir: session.project_dir,
        filePath: path,
      });
    } catch (openError) {
      const message = String(openError);
      if (message.includes('escapes working dir')) {
        toast.error(t('workspace.reviewPathOutsideWorkspace'));
      } else {
        toast.error(`${t('workspace.reviewOpenFailed')}：${message}`);
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1" data-review-page="files">
      <div className="flex w-[min(290px,38%)] shrink-0 flex-col border-r border-border-subtle/50">
        <ScrollArea className="min-h-0 flex-1">
          {model.changedFiles.length === 0 ? (
            <p className="px-4 py-5 text-xs text-muted-foreground">{t('workspace.reviewNoChangedFiles')}</p>
          ) : (
            <div className="py-1.5">
              {model.changedFiles.map((file) => {
                const mark = statusMark(file.status);
                const active = selectedPath === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    data-review-file-row
                    onClick={() => void selectFile(file.path)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'hover:bg-surface-raised/55',
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-[12px]" title={file.path}>{file.path}</span>
                    {file.additions != null || file.deletions != null ? (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums">
                        <span className="text-success">+{file.additions ?? 0}</span>{' '}
                        <span className="text-destructive">-{file.deletions ?? 0}</span>
                      </span>
                    ) : null}
                    <span className={cn('w-3 font-mono text-[10px] font-semibold', mark.className)}>{mark.letter}</span>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedPath ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle/40 px-3">
              <p className="min-w-0 flex-1 truncate text-xs font-medium" title={selectedPath}>{basename(selectedPath)}</p>
              {diff && !diff.is_binary ? (
                <span className="font-mono text-[10px] tabular-nums">
                  <span className="text-success">+{diff.additions}</span>{' '}
                  <span className="text-destructive">-{diff.deletions}</span>
                </span>
              ) : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 rounded-full"
                aria-label={t('workspace.reviewOpenInEditor')}
                onClick={() => void openInEditor(selectedPath)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              {onLoadMediaPreview && mediaKindForPath(selectedPath) ? (
                <MediaPreview preview={mediaPreview} loading={loading} error={error} />
              ) : (
                <DiffPreview diff={diff} loading={loading} error={error} />
              )}
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FileDiff className="h-6 w-6 text-muted-foreground/35" />
            <p className="text-xs text-muted-foreground">{t('workspace.reviewSelectFile')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentsDetail({
  onLoadSubagents,
  isLive,
}: Pick<WorkspaceReviewDetailsProps, 'onLoadSubagents' | 'isLive'>) {
  const { t } = useLocale();
  const [subagents, setSubagents] = useState<SubagentMeta[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<ConversationMessageData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const loadRef = useRef(onLoadSubagents);

  useEffect(() => {
    loadRef.current = onLoadSubagents;
  }, [onLoadSubagents]);

  const load = useCallback(async (agentId: string | null) => {
    const loader = loadRef.current;
    if (!loader) return;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    try {
      const payload = await loader(agentId);
      if (requestSeq !== requestSeqRef.current) return;
      setSubagents(payload.subagents ?? []);
      if (agentId) setAgentDetail(payload.detail ?? []);
      setError(null);
    } catch (loadError) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(String(loadError));
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
    return () => {
      requestSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const next = resolveSubagentSelection(subagents, selectedAgentId);
    if (next && next !== selectedAgentId) {
      setSelectedAgentId(next);
      setAgentDetail(null);
      void load(next);
    }
  }, [load, selectedAgentId, subagents]);

  const hasRunningAgent = subagents.some((agent) => agent.status === 'running');
  useEffect(() => {
    if (!isLive || !hasRunningAgent) return;
    const intervalId = window.setInterval(() => void load(selectedAgentId), 1500);
    return () => window.clearInterval(intervalId);
  }, [hasRunningAgent, isLive, load, selectedAgentId]);

  const selectedIndex = subagents.findIndex((agent) => agent.agentId === selectedAgentId);
  const selected = selectedIndex >= 0 ? subagents[selectedIndex] : null;
  const selectedDisplay = selected ? getSubagentDisplayMeta(selected, selectedIndex) : null;

  return (
    <div className="flex min-h-0 flex-1" data-review-page="agents">
      <div className="flex w-[min(290px,38%)] shrink-0 flex-col border-r border-border-subtle/50">
        <ScrollArea className="min-h-0 flex-1">
          {error && subagents.length === 0 ? (
            <p className="px-4 py-5 text-xs text-destructive">{error}</p>
          ) : subagents.length === 0 ? (
            <p className="px-4 py-5 text-xs text-muted-foreground">
              {loading ? t('workspace.reviewLoading') : t('workspace.reviewNoSubagents')}
            </p>
          ) : (
            <div className="py-1.5">
              {subagents.map((agent, index) => {
                const display = getSubagentDisplayMeta(agent, index);
                const active = agent.agentId === selectedAgentId;
                return (
                  <button
                    key={agent.agentId}
                    type="button"
                    onClick={() => {
                      setSelectedAgentId(agent.agentId);
                      setAgentDetail(null);
                      void load(agent.agentId);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-primary/10' : 'hover:bg-surface-raised/55',
                    )}
                  >
                    {display.running ? (
                      <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : display.failed ? (
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{display.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{display.subtitle}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected && selectedDisplay ? (
          <>
            <div className="shrink-0 border-b border-border-subtle/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedDisplay.name}</p>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  selected.status === 'running' && 'bg-primary/10 text-primary',
                  selected.status === 'completed' && 'bg-success/10 text-success',
                  selected.status === 'failed' && 'bg-destructive/10 text-destructive',
                )}>
                  {selectedDisplay.statusLabel}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{selectedDisplay.detail}</p>
              {selected.resultSummary ? <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">{selected.resultSummary}</p> : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-3">
                {agentDetail && agentDetail.length > 0 ? (
                  <WorkspaceTranscriptList messages={agentDetail} isAwaitingResponse={selected.status === 'running'} />
                ) : error ? (
                  <p className="py-6 text-center text-xs text-destructive">{error}</p>
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    {loading ? t('workspace.reviewLoading') : t('workspace.reviewNoAgentTrace')}
                  </p>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Users className="h-6 w-6 text-muted-foreground/35" />
            <p className="text-xs text-muted-foreground">{t('workspace.reviewSelectSubagent')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkspaceReviewDetails(props: WorkspaceReviewDetailsProps) {
  if (props.page === 'files') {
    return <FilesDetail {...props} />;
  }
  return <AgentsDetail {...props} />;
}
