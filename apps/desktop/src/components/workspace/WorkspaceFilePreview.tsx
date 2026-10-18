import { FileDiff } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/locales';
import type {
  WorkspaceFileDiff,
  WorkspaceMediaKind,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';

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

export function basename(path: string) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function mediaKindForPath(filePath: string): WorkspaceMediaKind | null {
  const extension = filePath.toLowerCase().split('.').pop() ?? '';
  return MEDIA_EXTENSION_KIND[extension] ?? null;
}

export function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdown)$/i.test(path);
}

export function formatByteSize(bytes: number): string {
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

export function DiffPreview({
  diff,
  loading,
  error,
  onViewSource,
  sourceLabel,
}: {
  diff: WorkspaceFileDiff | null;
  loading: boolean;
  error: string | null;
  onViewSource?: () => void;
  sourceLabel?: string;
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
  if (error) return <p role="alert" className="px-4 py-4 text-xs text-destructive">{error}</p>;
  if (!diff) return null;
  if (!diff.is_repo) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{diff.error || t('workspace.reviewNotGitRepo')}</p>;
  }
  if (diff.is_binary) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">{t('workspace.reviewBinaryUnavailable')}</p>;
  }
  if (diff.lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <FileDiff className="h-5 w-5 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">{diff.error || t('workspace.reviewNoDiff')}</p>
        {onViewSource ? (
          <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-[10px]" onClick={onViewSource}>
            {sourceLabel ?? t('workspace.filesSource')}
          </Button>
        ) : null}
      </div>
    );
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
            <span className="w-7 shrink-0 select-none pr-1 text-right text-[9px] tabular-nums text-muted-foreground/35">
              {hunk || meta ? '' : line.old_line ?? ''}
            </span>
            <span className="w-7 shrink-0 select-none border-r border-border-subtle/40 pr-1.5 text-right text-[9px] tabular-nums text-muted-foreground/35">
              {hunk || meta ? '' : line.new_line ?? ''}
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

export function MediaPreview({
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
  if (error) return <p role="alert" className="px-4 py-4 text-xs text-destructive">{error}</p>;
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
