import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  ExternalLink,
  FileDiff,
  FileText,
  Folder,
  ListChecks,
  LoaderCircle,
  PanelRightClose,
  RefreshCw,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { useNativeSurfaceOcclusion } from '@/lib/nativeSurfaceOcclusion';
import type {
  NativeSessionSummary,
  WorkspaceFileDiff,
  WorkspaceGitSnapshot,
  WorkspaceMediaKind,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn, getEnvColorVar } from '@/lib/utils';
import type {
  ConversationMessageData,
  SessionSubagentsPayload,
  SubagentMeta,
} from '@/features/conversations/types';
import type { ReviewChangedFile, WorkspaceReviewModel } from './workspaceReview';
import {
  getSubagentEntryPreview,
  getSubagentDisplayMeta,
  resolveSubagentSelection,
  shouldShowSubagentEntry,
  type SubagentPersona,
} from './workspaceSubagents';
import { WorkspaceTranscriptList } from './WorkspaceTranscriptList';

interface WorkspaceReviewDrawerProps {
  session: NativeSessionSummary;
  model: WorkspaceReviewModel;
  gitSnapshot?: WorkspaceGitSnapshot | null;
  isOpen: boolean;
  isRefreshingGit: boolean;
  onOpenChange: (open: boolean) => void;
  onRefreshGit: () => void;
  onLoadDiff: (filePath: string) => Promise<WorkspaceFileDiff>;
  /** Fetch a media data-url preview for binary assets (images, audio, video). */
  onLoadMediaPreview?: (filePath: string) => Promise<WorkspaceMediaPreview>;
  /** Fetch sub-agent list (+ optional detail). When omitted, the 子 Agent entry is hidden. */
  onLoadSubagents?: (detailAgentId: string | null) => Promise<SessionSubagentsPayload>;
  /** Whether the session is live (enables auto-polling while agents run). */
  isLive?: boolean;
}

const MAIN_WIDTH = 440;
const FILES_MIN_WIDTH = 560;
const DEFAULT_FILES_WIDTH = 820;

function basename(path: string) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
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

function mediaKindForPath(filePath: string): WorkspaceMediaKind | null {
  const lower = filePath.toLowerCase();
  const ext = lower.split('.').pop() ?? '';
  return MEDIA_EXTENSION_KIND[ext] ?? null;
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
  const suffix = units[unitIndex];
  const display = unitIndex === 0 ? `${Math.round(value)}` : value.toFixed(value < 10 ? 1 : 0);
  return `${display} ${suffix}`;
}

function todoStatusClass(status: string) {
  switch (status) {
    case 'completed':
      return 'bg-success/12 text-success';
    case 'in_progress':
      return 'bg-primary/12 text-primary';
    case 'failed':
      return 'bg-destructive/12 text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function Section({
  icon: Icon,
  title,
  trailing,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section data-review-entry>
      <div className="mb-1.5 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {trailing ? <div className="ml-auto">{trailing}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={cn(
          'text-[15px] font-semibold tabular-nums text-foreground',
          tone === 'warn' && 'text-destructive',
        )}
      >
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-12 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[12px] text-foreground', mono && 'font-mono text-[11px]')}>
        {value}
      </span>
    </div>
  );
}

// --- Changed-file tree ---------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  file?: ReviewChangedFile;
  children: Map<string, TreeNode>;
}

function buildFileTree(files: ReviewChangedFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };
  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let node = root;
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          isFile: isLeaf,
          file: isLeaf ? file : undefined,
          children: new Map(),
        };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Collapse chains of single-child folders, VS Code-style (src/components/workspace). */
function compactFolder(node: TreeNode): { name: string; node: TreeNode } {
  let name = node.name;
  let current = node;
  while (current.children.size === 1) {
    const only = [...current.children.values()][0];
    if (only.isFile) {
      break;
    }
    name = `${name}/${only.name}`;
    current = only;
  }
  return { name, node: current };
}

function sortNodes(a: TreeNode, b: TreeNode): number {
  if (a.isFile !== b.isFile) {
    return a.isFile ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

function statusMark(status: string): { letter: string; cls: string } {
  const value = status.toLowerCase();
  if (value.includes('add') || value.includes('untrack') || value === 'a' || value === '??') {
    return { letter: 'A', cls: 'text-success' };
  }
  if (value.includes('delet') || value === 'd') {
    return { letter: 'D', cls: 'text-destructive' };
  }
  if (value.includes('renam') || value === 'r') {
    return { letter: 'R', cls: 'text-primary' };
  }
  return { letter: 'M', cls: 'text-warning' };
}

function TreeLevel({
  node,
  depth,
  collapsed,
  selectedPath,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const entries = [...node.children.values()].sort(sortNodes);
  return (
    <>
      {entries.map((child) => {
        if (child.isFile && child.file) {
          const mark = statusMark(child.file.status);
          const { additions, deletions } = child.file;
          const active = selectedPath === child.file.path;
          return (
            <button
              key={child.path}
              type="button"
              data-review-file-row
              onClick={() => onSelect(child.file!.path)}
              style={{ paddingLeft: depth * 12 + 8 }}
              className={cn(
                'group flex w-full items-center gap-1.5 py-1 pr-2 text-left transition-colors',
                active ? 'bg-primary/12' : 'hover:bg-surface-raised/60',
              )}
            >
              <span className="w-3.5 shrink-0" />
              <FileText className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground/55')} />
              <span className={cn('min-w-0 flex-1 truncate text-[12px]', active ? 'text-primary' : 'text-foreground')}>
                {child.name}
              </span>
              {additions != null || deletions != null ? (
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  <span className="text-success">+{additions ?? 0}</span>{' '}
                  <span className="text-destructive">-{deletions ?? 0}</span>
                </span>
              ) : null}
              <span className={cn('w-3 shrink-0 text-center font-mono text-[10px] font-semibold', mark.cls)}>
                {mark.letter}
              </span>
            </button>
          );
        }
        const { name, node: folder } = compactFolder(child);
        const isCollapsed = collapsed.has(folder.path);
        return (
          <div key={folder.path}>
            <button
              type="button"
              data-review-file-row
              onClick={() => onToggle(folder.path)}
              style={{ paddingLeft: depth * 12 + 8 }}
              className="flex w-full items-center gap-1 py-1 pr-2 text-left transition-colors hover:bg-surface-raised/40"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
              )}
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">{name}</span>
            </button>
            {!isCollapsed ? (
              <TreeLevel
                node={folder}
                depth={depth + 1}
                collapsed={collapsed}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function MediaPreviewView({
  preview,
  loading,
  error,
}: {
  preview: WorkspaceMediaPreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="px-4 py-6">
        <div className="h-32 rounded-lg bg-surface-raised/60" />
      </div>
    );
  }
  if (error) {
    return <p className="px-4 py-4 text-[12px] text-destructive">{error}</p>;
  }
  if (!preview) {
    return null;
  }
  if (preview.error || !preview.data_url) {
    return (
      <div className="px-4 py-4">
        <p className="text-[12px] text-muted-foreground">
          {preview.error || '无法生成多媒体预览。'}
        </p>
        {preview.byte_size > 0 ? (
          <p className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {formatByteSize(preview.byte_size)}
          </p>
        ) : null}
      </div>
    );
  }

  const sizeHint = (
    <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
      {formatByteSize(preview.byte_size)}
    </span>
  );

  if (preview.kind === 'image') {
    return (
      <div className="px-4 py-3">
        <div className="overflow-hidden rounded-lg border border-border-subtle/40 bg-background/40">
          <img
            src={preview.data_url}
            alt={basename(preview.path)}
            className="block max-h-[60vh] w-full object-contain"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">{preview.media_type}</span>
          {sizeHint}
        </div>
      </div>
    );
  }

  if (preview.kind === 'audio') {
    return (
      <div className="px-4 py-3">
        <audio controls src={preview.data_url} className="w-full" style={{ height: 32 }}>
          你的浏览器不支持音频预览。
        </audio>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">{preview.media_type}</span>
          {sizeHint}
        </div>
      </div>
    );
  }

  if (preview.kind === 'video') {
    return (
      <div className="px-4 py-3">
        <video
          controls
          src={preview.data_url}
          className="max-h-[60vh] w-full rounded-lg border border-border-subtle/40 bg-black"
        >
          你的浏览器不支持视频预览。
        </video>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">{preview.media_type}</span>
          {sizeHint}
        </div>
      </div>
    );
  }

  return (
    <p className="px-4 py-4 text-[12px] text-muted-foreground">二进制文件，无法显示差异。</p>
  );
}

function DiffView({
  diff,
  loading,
  error,
}: {
  diff: WorkspaceFileDiff | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 px-4 py-4">
        {Array.from({ length: 10 }).map((_, index) => (
          <div
            key={index}
            className="h-3.5 rounded bg-surface-raised/60"
            style={{ width: `${60 + ((index * 37) % 38)}%` }}
          />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="px-4 py-4 text-[12px] text-destructive">{error}</p>;
  }
  if (!diff) {
    return null;
  }
  if (!diff.is_repo) {
    return <p className="px-4 py-4 text-[12px] text-muted-foreground">{diff.error || '非 git 仓库'}</p>;
  }
  if (diff.is_binary) {
    return <p className="px-4 py-4 text-[12px] text-muted-foreground">二进制文件，无法显示差异。</p>;
  }
  if (diff.lines.length === 0) {
    return <p className="px-4 py-4 text-[12px] text-muted-foreground">该文件暂无差异（可能已暂存或无内容变化）。</p>;
  }

  return (
    <div className="py-1 font-mono text-[11px] leading-[1.55]">
      {diff.lines.map((line, index) => {
        const isAdd = line.kind === 'addition';
        const isDel = line.kind === 'deletion';
        const isHunk = line.kind === 'hunk';
        const isMeta = line.kind === 'meta';
        const sign = isAdd ? '+' : isDel ? '-' : ' ';
        return (
          <div
            key={index}
            className={cn(
              'flex',
              isAdd && 'bg-success/10',
              isDel && 'bg-destructive/10',
              isHunk && 'bg-primary/8 text-primary/80',
              isMeta && 'text-muted-foreground/50',
            )}
          >
            <span className="w-9 shrink-0 select-none border-r border-border-subtle/40 pr-1.5 text-right text-[10px] tabular-nums text-muted-foreground/45">
              {line.new_line ?? line.old_line ?? ''}
            </span>
            {!isHunk && !isMeta ? (
              <span
                className={cn(
                  'w-3 shrink-0 select-none text-center',
                  isAdd && 'text-success',
                  isDel && 'text-destructive',
                  !isAdd && !isDel && 'text-muted-foreground/30',
                )}
              >
                {sign}
              </span>
            ) : null}
            <span
              className={cn(
                'min-w-0 flex-1 whitespace-pre-wrap break-words pl-1 pr-3',
                isAdd && 'text-success',
                isDel && 'text-muted-foreground line-through decoration-destructive/40',
                !isAdd && !isDel && !isHunk && !isMeta && 'text-foreground/80',
              )}
            >
              {line.text || ' '}
            </span>
          </div>
        );
      })}
      {diff.truncated ? (
        <p className="px-4 py-2 text-[10px] text-muted-foreground/60">差异过长，仅显示前 2000 行。</p>
      ) : null}
    </div>
  );
}

const SUBAGENT_SIGIL_CELLS: Record<SubagentPersona['symbol'], number[]> = {
  blocks: [0, 1, 3, 4, 6],
  steps: [0, 3, 4, 6, 7, 8],
  frame: [0, 1, 2, 3, 5, 6, 7, 8],
  bridge: [0, 1, 2, 3, 4, 5],
  spark: [1, 3, 4, 5, 7],
  axis: [1, 3, 4, 5, 7],
  orbit: [1, 3, 4, 5, 7],
};

function SubagentSigil({
  symbol,
  accent,
  active = false,
  running = false,
  size = 'sm',
}: Pick<SubagentPersona, 'symbol' | 'accent'> & {
  active?: boolean;
  running?: boolean;
  size?: 'xs' | 'sm' | 'lg';
}) {
  const cells = SUBAGENT_SIGIL_CELLS[symbol];
  const dimensions =
    size === 'lg'
      ? 'h-7 w-7 gap-[3px] p-[5px]'
      : size === 'xs'
        ? 'h-4 w-4 gap-[2px] p-[3px]'
        : 'h-5 w-5 gap-[2px] p-[4px]';
  const cellSize = size === 'lg' ? 'h-[4px] w-[4px]' : 'h-[3px] w-[3px]';

  return (
    <span
      className={cn('relative grid shrink-0 grid-cols-3 rounded-md border transition-colors', dimensions)}
      style={{
        borderColor: `hsl(${accent} / ${active ? 0.46 : 0.24})`,
        backgroundColor: `hsl(${accent} / ${active ? 0.14 : 0.08})`,
        boxShadow: running ? `0 0 0 3px hsl(${accent} / 0.10)` : undefined,
      }}
      aria-hidden="true"
    >
      {Array.from({ length: 9 }).map((_, index) => (
        <span
          key={index}
          className={cn('rounded-[1px]', cellSize, cells.includes(index) ? 'opacity-100' : 'opacity-0')}
          style={{ backgroundColor: `hsl(${accent})` }}
        />
      ))}
      {running ? (
        <span
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background"
          style={{ backgroundColor: `hsl(${accent})` }}
        />
      ) : null}
    </span>
  );
}

function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${minutes}m${rem}s` : `${minutes}m`;
}

function SubagentPanel({
  subagents,
  selectedAgentId,
  agentDetail,
  agentsLoading,
  agentsError,
  onSelect,
}: {
  subagents: SubagentMeta[];
  selectedAgentId: string | null;
  agentDetail: ConversationMessageData[] | null;
  agentsLoading: boolean;
  agentsError: string | null;
  onSelect: (agentId: string) => void;
}) {
  const selected = useMemo(
    () => subagents.find((s) => s.agentId === selectedAgentId) ?? null,
    [subagents, selectedAgentId],
  );
  const selectedIndex = useMemo(
    () => subagents.findIndex((s) => s.agentId === selectedAgentId),
    [subagents, selectedAgentId],
  );
  const selectedDisplay = selected ? getSubagentDisplayMeta(selected, Math.max(selectedIndex, 0)) : null;
  const selectedRunning = selected?.status === 'running';

  return (
    <div data-review-motion-panel data-review-page="agents" className="flex min-h-0 flex-1">
      <div className="flex w-[clamp(220px,34%,320px)] shrink-0 flex-col border-r border-border-subtle/50">
        <ScrollArea className="min-h-0 flex-1">
          {agentsError && subagents.length === 0 ? (
            <p className="px-4 py-4 text-[12px] text-destructive">{agentsError}</p>
          ) : subagents.length === 0 ? (
            <p className="px-4 py-4 text-[12px] text-muted-foreground">
              {agentsLoading ? '加载中…' : '本会话未派发子 Agent。'}
            </p>
          ) : (
            <div className="py-1">
              {subagents.map((agent, index) => {
                const display = getSubagentDisplayMeta(agent, index);
                const isActive = agent.agentId === selectedAgentId;
                return (
                  <button
                    type="button"
                    key={agent.agentId}
                    data-review-entry
                    onClick={() => onSelect(agent.agentId)}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-raised/50',
                      isActive && 'bg-surface-raised/75',
                    )}
                  >
                    <SubagentSigil
                      symbol={display.symbol}
                      accent={display.accent}
                      active={isActive}
                      running={display.running}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-[13px] font-medium text-foreground">{display.name}</p>
                        {display.running || display.failed ? (
                          <span
                            className={cn(
                              'shrink-0 text-[10px] font-medium',
                              display.running && 'text-muted-foreground',
                              display.failed && 'text-destructive',
                            )}
                          >
                            {display.statusLabel}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground/85">{display.subtitle}</p>
                      <p className="truncate font-mono text-[10px] tabular-nums text-muted-foreground/55">
                        {display.detail}
                      </p>
                    </div>
                    {display.running ? (
                      <LoaderCircle className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
                    ) : display.failed ? (
                      <CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-destructive/70" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success/70" />
                    )}
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
              <div className="flex items-start gap-2.5">
                <SubagentSigil
                  symbol={selectedDisplay.symbol}
                  accent={selectedDisplay.accent}
                  active
                  running={selectedDisplay.running}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
                      {selectedDisplay.name}
                    </p>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        selected.status === 'running' && 'bg-muted text-muted-foreground',
                        selected.status === 'completed' && 'bg-success/12 text-success',
                        selected.status === 'failed' && 'bg-destructive/12 text-destructive',
                      )}
                    >
                      {selectedDisplay.statusLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground/90">
                    {selectedDisplay.subtitle}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {selectedDisplay.detail} · 耗时{' '}
                {formatDurationMs((selected.completedAt ?? Date.now()) - selected.startedAt)}
              </p>
              {selected.resultSummary ? (
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
                  {selected.resultSummary}
                </p>
              ) : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-3">
                {agentDetail && agentDetail.length > 0 ? (
                  <WorkspaceTranscriptList
                    messages={agentDetail}
                    isAwaitingResponse={selectedRunning}
                  />
                ) : agentsError ? (
                  <p className="py-6 text-center text-[12px] text-destructive">{agentsError}</p>
                ) : (
                  <p className="py-6 text-center text-[12px] text-muted-foreground">
                    {agentsLoading ? '加载执行过程…' : '暂无执行过程记录。'}
                  </p>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Users className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-[12px] text-muted-foreground">选择左侧子 Agent 查看执行过程</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SubagentEntryPreview({ subagents }: { subagents: SubagentMeta[] }) {
  const preview = getSubagentEntryPreview(subagents);

  if (preview.items.length === 0) {
    return null;
  }

  return (
    <span className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-1.5">
      {preview.items.map((item) => (
        <span
          key={item.key}
          className={cn(
            'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border-subtle/50 bg-surface/55 px-1.5 pr-2',
            'text-[11px] font-medium leading-none text-foreground/85 transition-colors group-hover:bg-surface-raised/70',
            item.failed && 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
          title={`${item.name} · ${item.statusLabel}`}
        >
          <SubagentSigil symbol={item.symbol} accent={item.accent} running={item.running} size="xs" />
          <span className="min-w-0 truncate">{item.name}</span>
        </span>
      ))}
      {preview.overflowCount > 0 ? (
        <span className="inline-flex h-6 min-w-0 items-center justify-center rounded-md border border-dashed border-border-subtle/70 px-2 font-mono text-[10px] leading-none text-muted-foreground">
          +{preview.overflowCount}
        </span>
      ) : null}
    </span>
  );
}

export function WorkspaceReviewDrawer({
  session,
  model,
  gitSnapshot,
  isOpen,
  isRefreshingGit,
  onOpenChange,
  onRefreshGit,
  onLoadDiff,
  onLoadMediaPreview,
  onLoadSubagents,
  isLive = false,
}: WorkspaceReviewDrawerProps) {
  const gatedOpen = useNativeSurfaceOcclusion(isOpen);
  const [page, setPage] = useState<'main' | 'files' | 'agents'>('main');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<WorkspaceMediaPreview | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filesWidth, setFilesWidth] = useState(DEFAULT_FILES_WIDTH);
  const [resizing, setResizing] = useState(false);

  // Sub-agent (Task/Agent sidechain) state for the 子 Agent panel.
  const [subagents, setSubagents] = useState<SubagentMeta[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<ConversationMessageData[] | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const subagentRequestSeqRef = useRef(0);
  const drawerMotionRef = useRef<HTMLElement>(null);

  const tree = useMemo(() => buildFileTree(model.changedFiles), [model.changedFiles]);
  const todoLabel = model.todoTotal > 0 ? `${model.todoCompleted}/${model.todoTotal}` : '0/0';
  const gitBranch = gitSnapshot?.branch || 'no branch';
  const gitSha = gitSnapshot?.sha ? `@${gitSnapshot.sha}` : '';
  const envColor = getEnvColorVar(session.env_name);

  const selectFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setDiff(null);
      setDiffError(null);
      setDiffLoading(true);
      setMediaPreview(null);
      setMediaError(null);
      const isMedia = onLoadMediaPreview && mediaKindForPath(path);
      if (isMedia) {
        setMediaLoading(true);
      }
      try {
        const result = await onLoadDiff(path);
        setDiff(result);
      } catch (loadError) {
        setDiffError(`加载差异失败：${String(loadError)}`);
      } finally {
        setDiffLoading(false);
      }
      if (onLoadMediaPreview && mediaKindForPath(path)) {
        try {
          const media = await onLoadMediaPreview(path);
          setMediaPreview(media);
        } catch (loadError) {
          setMediaError(`加载多媒体预览失败：${String(loadError)}`);
        } finally {
          setMediaLoading(false);
        }
      }
    },
    [onLoadDiff, onLoadMediaPreview],
  );

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const next = window.innerWidth - moveEvent.clientX;
      setFilesWidth(Math.min(Math.max(next, FILES_MIN_WIDTH), window.innerWidth - 64));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Closing the drawer resets navigation back to the main page.
  useEffect(() => {
    if (!gatedOpen) {
      setPage('main');
      setSelectedPath(null);
      setMediaPreview(null);
      setMediaError(null);
      setSubagents([]);
      setSelectedAgentId(null);
      setAgentDetail(null);
      setAgentsError(null);
    }
  }, [gatedOpen]);

  // Hold the latest onLoadSubagents in a ref so the parent's inline callback
  // (new identity each render) doesn't recreate loadSubagents and retrigger effects.
  const onLoadSubagentsRef = useRef(onLoadSubagents);
  useEffect(() => {
    onLoadSubagentsRef.current = onLoadSubagents;
  }, [onLoadSubagents]);

  // Fetch the sub-agent list (+ detail for the selected agent when provided).
  // Stable identity (empty deps) — reads the callback via ref.
  const loadSubagents = useCallback(async (detailAgentId: string | null) => {
    const fn = onLoadSubagentsRef.current;
    if (!fn) return;
    const requestSeq = subagentRequestSeqRef.current + 1;
    subagentRequestSeqRef.current = requestSeq;
    setAgentsLoading(true);
    try {
      const payload = await fn(detailAgentId);
      if (requestSeq !== subagentRequestSeqRef.current) {
        return;
      }
      setSubagents(payload.subagents ?? []);
      setAgentsError(null);
      if (detailAgentId) {
        setAgentDetail(payload.detail ?? []);
      }
    } catch (err) {
      if (requestSeq !== subagentRequestSeqRef.current) {
        return;
      }
      setAgentsError(`加载子 Agent 失败：${String(err)}`);
    } finally {
      if (requestSeq === subagentRequestSeqRef.current) {
        setAgentsLoading(false);
      }
    }
  }, []);

  // Initial list load when the drawer opens (drives the entry-button count).
  useEffect(() => {
    if (gatedOpen && onLoadSubagentsRef.current) {
      void loadSubagents(null);
    }
  }, [gatedOpen, loadSubagents]);

  // Auto-poll while on the agents page in a live session with a running agent.
  const hasRunningAgent = subagents.some((s) => s.status === 'running');
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!isLive || !gatedOpen || page !== 'agents' || !hasRunningAgent) {
      return;
    }
    pollRef.current = setInterval(() => {
      void loadSubagents(selectedAgentId);
    }, 1500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isLive, gatedOpen, page, hasRunningAgent, selectedAgentId, loadSubagents]);

  const selectAgent = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      setAgentDetail(null);
      void loadSubagents(agentId);
    },
    [loadSubagents],
  );

  useEffect(() => {
    if (page !== 'agents' || subagents.length === 0) {
      return;
    }
    const nextSelection = resolveSubagentSelection(subagents, selectedAgentId);
    if (nextSelection && nextSelection !== selectedAgentId) {
      selectAgent(nextSelection);
    }
  }, [page, selectedAgentId, selectAgent, subagents]);

  useGSAP(() => {
    const root = drawerMotionRef.current;
    if (!gatedOpen || !root) {
      return;
    }

    const panel = root.querySelector<HTMLElement>(`[data-review-page="${page}"]`);
    const entries = panel
      ? gsap.utils.toArray<HTMLElement>('[data-review-entry], [data-review-file-row]', panel)
      : [];
    if (!panel) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps([panel, ...entries]);
      return;
    }

    const timeline = gsap.timeline({ defaults: { ease: ccemMotion.ease.standard, overwrite: 'auto' } });
    timeline.fromTo(
      panel,
      { autoAlpha: 0, y: 8 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        onComplete: () => clearMotionProps(panel),
      }
    );
    if (entries.length > 0) {
      timeline.fromTo(
        entries.slice(0, 18),
        { autoAlpha: 0, y: 5 },
        {
          autoAlpha: 1,
          y: 0,
          duration: ccemMotion.duration.quick,
          stagger: 0.018,
          onComplete: () => clearMotionProps(entries),
        },
        '-=0.16'
      );
    }
  }, {
    scope: drawerMotionRef,
    dependencies: [
      gatedOpen,
      page,
      model.changedFiles.length,
      model.todos.length,
      subagents.length,
      agentsLoading,
    ],
  });

  useGSAP(() => {
    const root = drawerMotionRef.current;
    if (!gatedOpen || page !== 'files' || !selectedPath || !root) {
      return;
    }

    const preview = root.querySelector<HTMLElement>('[data-review-preview]');
    if (!preview) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(preview);
      return;
    }

    gsap.fromTo(
      preview,
      { autoAlpha: 0, y: 6 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.soft,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(preview),
      }
    );
  }, { scope: drawerMotionRef, dependencies: [gatedOpen, page, selectedPath, diffLoading, mediaLoading] });

  const openInEditor = async (path: string) => {
    try {
      await invoke<boolean>('open_file_in_workspace', {
        workingDir: session.project_dir,
        filePath: path,
      });
    } catch (error) {
      const message = String(error);
      // Rust guard rejections carry the phrase "escapes working dir" — surface
      // a workspace-boundary message instead of the raw IPC error so users
      // understand the path was blocked by policy, not by a missing editor.
      if (message.includes('escapes working dir')) {
        toast.error('路径超出工作区范围，已拒绝打开');
      } else {
        toast.error(`打开失败：${message}`);
      }
    }
  };

  if (!gatedOpen) {
    return null;
  }

  const inFiles = page === 'files';
  const inAgents = page === 'agents';
  const inSecondary = inFiles || inAgents;
  const width = inSecondary ? filesWidth : MAIN_WIDTH;
  const showSubagentEntry = shouldShowSubagentEntry({
    canLoad: Boolean(onLoadSubagents),
    loading: agentsLoading,
    error: agentsError,
    count: subagents.length,
  });
  const runningSubagentCount = subagents.filter((s) => s.status === 'running').length;

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="关闭审查抽屉"
        className="absolute inset-0 bg-background/40 backdrop-blur-[1px] animate-in fade-in duration-200"
        onClick={() => onOpenChange(false)}
      />
      <aside
        ref={drawerMotionRef}
        style={{ width: `min(${width}px, 100%)` }}
        className={cn(
          'absolute inset-y-0 right-0 flex flex-col border-l border-border-subtle/50 bg-surface/95 shadow-2xl backdrop-blur-xl animate-in slide-in-from-right duration-200 ease-out',
          resizing && 'select-none',
        )}
      >
        {inSecondary ? (
          <div
            onPointerDown={startResize}
            className={cn(
              'group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize',
              'after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-border-subtle/50 after:transition-colors',
              resizing ? 'after:bg-primary' : 'group-hover:after:bg-primary/60',
            )}
            aria-label="调整宽度"
            role="separator"
          />
        ) : null}

        {inSecondary ? (
          <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border-subtle/60 pl-1.5 pr-2.5">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 rounded-full text-muted-foreground"
              aria-label="返回总览"
              onClick={() => setPage('main')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-foreground">
                {inAgents ? '子 Agent' : '改动文件'}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {inAgents ? `${subagents.length} 个子 Agent` : `${model.changedFiles.length} 个文件`}
              </p>
            </div>
          </header>
        ) : (
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle/60 pl-4 pr-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${envColor})` }} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-foreground">{session.env_name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {session.provider} · {session.status}
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full text-muted-foreground"
              aria-label="刷新 git 状态"
              onClick={onRefreshGit}
              disabled={isRefreshingGit}
            >
              <RefreshCw className={cn('h-4 w-4', isRefreshingGit && 'animate-spin')} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full text-muted-foreground"
              aria-label="关闭审查抽屉"
              onClick={() => onOpenChange(false)}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </header>
        )}

        {inFiles ? (
          <div data-review-motion-panel data-review-page="files" className="flex min-h-0 flex-1">
            <div className="flex w-[clamp(220px,34%,320px)] shrink-0 flex-col border-r border-border-subtle/50">
              <ScrollArea className="min-h-0 flex-1">
                {model.changedFiles.length === 0 ? (
                  <p className="px-4 py-4 text-[12px] text-muted-foreground">暂无 SDK 或 git 改动。</p>
                ) : (
                  <div className="py-1">
                    <TreeLevel
                      node={tree}
                      depth={0}
                      collapsed={collapsed}
                      selectedPath={selectedPath}
                      onToggle={toggleFolder}
                      onSelect={(path) => void selectFile(path)}
                    />
                  </div>
                )}
              </ScrollArea>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {selectedPath ? (
                <>
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle/40 pl-3 pr-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-foreground" title={selectedPath}>
                        {basename(selectedPath)}
                      </p>
                    </div>
                    {selectedPath && mediaKindForPath(selectedPath) ? (
                      mediaPreview && mediaPreview.byte_size > 0 ? (
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatByteSize(mediaPreview.byte_size)}
                        </span>
                      ) : null
                    ) : diff && !diff.is_binary ? (
                      <span className="shrink-0 font-mono text-[11px] tabular-nums">
                        <span className="text-success">+{diff.additions}</span>{' '}
                        <span className="text-destructive">-{diff.deletions}</span>
                        {diff.is_untracked ? <span className="ml-1.5 text-muted-foreground">新文件</span> : null}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
                      aria-label="在编辑器中打开"
                      onClick={() => void openInEditor(selectedPath)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div data-review-preview>
                      {selectedPath && mediaKindForPath(selectedPath) ? (
                        <MediaPreviewView
                          preview={mediaPreview}
                          loading={mediaLoading}
                          error={mediaError}
                        />
                      ) : (
                        <DiffView diff={diff} loading={diffLoading} error={diffError} />
                      )}
                    </div>
                  </ScrollArea>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <FileDiff className="h-6 w-6 text-muted-foreground/40" />
                  <p className="text-[12px] text-muted-foreground">选择左侧文件查看差异</p>
                </div>
              )}
            </div>
          </div>
        ) : inAgents ? (
          <SubagentPanel
            subagents={subagents}
            selectedAgentId={selectedAgentId}
            agentDetail={agentDetail}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            onSelect={selectAgent}
          />
        ) : (
          <ScrollArea data-review-motion-panel data-review-page="main" className="min-h-0 flex-1">
            <div className="space-y-5 px-4 py-4">
              <Section icon={CheckCircle2} title="改动概览">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <Stat label="产物" value={model.artifacts.length} />
                  <Stat label="改动" value={model.changedFiles.length} />
                  {model.failedTools.length > 0 ? (
                    <Stat label="失败" value={model.failedTools.length} tone="warn" />
                  ) : null}
                </div>
              </Section>

              <Section icon={Circle} title="当前执行环境">
                <div className="-mt-0.5">
                  <MetaRow label="环境" value={session.env_name} />
                  <MetaRow label="权限" value={session.runtime_perm_mode || session.perm_mode} />
                  <MetaRow label="档位" value={session.effort || 'default'} />
                  <MetaRow
                    label="分支"
                    mono
                    value={gitSnapshot?.is_repo ? `${gitBranch}${gitSha}` : gitSnapshot?.error || '非 git 仓库'}
                  />
                  <MetaRow label="上游" mono value={gitSnapshot?.upstream || '—'} />
                </div>
              </Section>

              {showSubagentEntry ? (
                <button
                  type="button"
                  data-review-entry
                  onClick={() => setPage('agents')}
                  className="group w-full rounded-lg border border-border-subtle/50 bg-surface-raised/25 px-3 py-3 text-left transition-colors hover:bg-surface-raised/55"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-[13px] font-semibold text-foreground">子 Agent</span>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {subagents.length}
                    </span>
                    {runningSubagentCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                        <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
                        {runningSubagentCount} 运行中
                      </span>
                    ) : null}
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/45 transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <SubagentEntryPreview subagents={subagents} />
                </button>
              ) : null}

              {model.todos.length > 0 ? (
                <Section
                  icon={ListChecks}
                  title="TODO 进度"
                  trailing={
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{todoLabel}</span>
                  }
                >
                  <div className="space-y-0.5">
                    {model.todos.map((todo) => (
                      <div key={todo.id} className="flex items-start gap-2 py-0.5">
                        <CheckCircle2
                          className={cn(
                            'mt-0.5 h-3.5 w-3.5 shrink-0',
                            todo.status === 'completed' ? 'text-success' : 'text-muted-foreground/40',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-[12px] leading-snug text-foreground',
                              todo.status === 'completed' && 'text-muted-foreground line-through',
                            )}
                          >
                            {todo.text}
                          </p>
                          {todo.status !== 'completed' && todo.status !== 'pending' ? (
                            <span
                              className={cn(
                                'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                                todoStatusClass(todo.status),
                              )}
                            >
                              {todo.status}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              <button
                type="button"
                data-review-entry
                onClick={() => setPage('files')}
                disabled={model.changedFiles.length === 0}
                className="group flex w-full items-center gap-2 rounded-xl border border-border-subtle/50 bg-surface-raised/30 px-3 py-2.5 text-left transition-colors hover:bg-surface-raised/60 disabled:cursor-default disabled:opacity-50"
              >
                <FileDiff className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-[13px] font-medium text-foreground">改动文件</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {model.changedFiles.length}
                </span>
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/45 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </ScrollArea>
        )}
      </aside>
    </div>,
    document.body,
  );
}
