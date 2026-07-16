import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  Copy,
  ImageIcon,
  LoaderCircle,
  Scissors,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';
import {
  extractToolSummary,
  getMessageCopyText,
  isCommandOnlyText,
  parseMessageText,
  splitThinkBlocks,
  stringifyUnknown,
  type TeammateMessage,
} from '@/components/conversation/messageContentUtils';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { useLocale } from '@/locales';
import type {
  ConversationContentBlock,
  ConversationMessageData,
} from '@/features/conversations/types';
import {
  COMPACT_FAILED_SUMMARY_TOKEN,
  COMPACTING_SUMMARY_TOKEN,
  TRANSCRIPT_GAP_SUMMARY_TOKEN,
} from './workspaceEventTranscript';
import { stripRenderedImageMarkers } from './transcriptIdentity';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';

interface WorkspaceMessageBubbleProps {
  message: ConversationMessageData;
  prevRole?: string | null;
}

export interface WorkspaceThinkingEntry {
  key: string;
  content: string;
  segmentCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ToolDigestEntry {
  type: 'tool_use' | 'thinking';
  block?: ConversationContentBlock;
  thinking?: WorkspaceThinkingEntry;
}

export interface MessageSegment {
  type: 'text' | 'tool-group';
  message?: ConversationMessageData;
  entries: ToolDigestEntry[];
}

function toFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatProcessDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getDigestTimeRange(entries: ToolDigestEntry[]) {
  let startedAt: number | undefined;
  let completedAt: number | undefined;

  entries.forEach((entry) => {
    const entryStartedAt = entry.type === 'thinking'
      ? entry.thinking?.startedAt
      : toFiniteTimestamp(entry.block?._startedAt);
    const entryCompletedAt = entry.type === 'thinking'
      ? entry.thinking?.completedAt
      : toFiniteTimestamp(entry.block?._completedAt);

    if (entryStartedAt != null) {
      startedAt = startedAt == null ? entryStartedAt : Math.min(startedAt, entryStartedAt);
    }
    if (entryCompletedAt != null) {
      completedAt = completedAt == null ? entryCompletedAt : Math.max(completedAt, entryCompletedAt);
    }
  });

  return startedAt == null ? null : { startedAt, completedAt };
}

function toContentBlocks(content: ConversationMessageData['content']): ConversationContentBlock[] {
  if (Array.isArray(content)) {
    return content;
  }

  if (content && typeof content === 'object') {
    return [content as ConversationContentBlock];
  }

  return [];
}

export function getWorkspaceToolBlocks(message: ConversationMessageData): ConversationContentBlock[] {
  if (message.isCompactBoundary || message.planContent || message.msgType === 'summary') {
    return [];
  }

  return toContentBlocks(message.content).filter((block) => block.type === 'tool_use');
}

export function isWorkspaceToolOnlyMessage(message: ConversationMessageData): boolean {
  const blocks = toContentBlocks(message.content);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_use' || block.type === 'tool_result');
}

function extractThinkingFromText(
  raw: string,
  keyBase: string,
): { visibleText: string; thinkingEntries: WorkspaceThinkingEntry[] } {
  const thinkingEntries: WorkspaceThinkingEntry[] = [];
  const visibleParts: string[] = [];

  splitThinkBlocks(raw).forEach((part, index) => {
    if (part.type === 'think') {
      const content = part.content.trim();
      if (content) {
        thinkingEntries.push({
          key: `${keyBase}-think-${index}`,
          content,
        });
      }
      return;
    }

    if (part.content.trim()) {
      visibleParts.push(part.content.trim());
    }
  });

  return {
    visibleText: visibleParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    thinkingEntries,
  };
}

function extractProcessFromBlocks(
  blocks: ConversationContentBlock[],
  keyBase: string,
): {
  visibleBlocks: ConversationContentBlock[];
  toolBlocks: ConversationContentBlock[];
  thinkingEntries: WorkspaceThinkingEntry[];
} {
  const visibleBlocks: ConversationContentBlock[] = [];
  const toolBlocks: ConversationContentBlock[] = [];
  const thinkingEntries: WorkspaceThinkingEntry[] = [];

  blocks.forEach((block, index) => {
    const blockKey = `${keyBase}-${index}`;

    if (block.type === 'tool_use') {
      toolBlocks.push(block);
      return;
    }

    if (block.type === 'tool_result') {
      return;
    }

    if (block.type === 'thinking') {
      const content = (block.thinking || block.text || '').trim();
      if (content) {
        thinkingEntries.push({
          key: `${blockKey}-thinking`,
          content,
          startedAt: toFiniteTimestamp(block._startedAt),
          completedAt: toFiniteTimestamp(block._completedAt),
        });
      }
      return;
    }

    if (block.type === 'text') {
      const { visibleText, thinkingEntries: extractedThinking } = extractThinkingFromText(block.text || '', `${blockKey}-text`);
      thinkingEntries.push(...extractedThinking);
      if (visibleText) {
        visibleBlocks.push({
          ...block,
          text: visibleText,
        });
      }
      return;
    }

    visibleBlocks.push(block);
  });

  return { visibleBlocks, toolBlocks, thinkingEntries };
}

export function extractWorkspaceProcessData(
  message: ConversationMessageData,
  messageKey: string,
): {
  visibleMessage: ConversationMessageData | null;
  toolBlocks: ConversationContentBlock[];
  thinkingEntries: WorkspaceThinkingEntry[];
} {
  if (message.isCompactBoundary || message.planContent || message.msgType === 'summary') {
    return {
      visibleMessage: message,
      toolBlocks: [],
      thinkingEntries: [],
    };
  }

  if (typeof message.content === 'string') {
    const { visibleText, thinkingEntries } = extractThinkingFromText(message.content, messageKey);
    return {
      visibleMessage: visibleText
        ? {
          ...message,
          content: visibleText,
        }
        : null,
      toolBlocks: [],
      thinkingEntries,
    };
  }

  if (Array.isArray(message.content)) {
    const { visibleBlocks, toolBlocks, thinkingEntries } = extractProcessFromBlocks(message.content, messageKey);
    return {
      visibleMessage: visibleBlocks.length > 0
        ? {
          ...message,
          content: visibleBlocks,
        }
        : null,
      toolBlocks,
      thinkingEntries,
    };
  }

  if (message.content && typeof message.content === 'object') {
    const { visibleBlocks, toolBlocks, thinkingEntries } = extractProcessFromBlocks([message.content as ConversationContentBlock], messageKey);
    const visibleContent = visibleBlocks.length === 0
      ? null
      : visibleBlocks.length === 1
        ? visibleBlocks[0]
        : visibleBlocks;
    return {
      visibleMessage: visibleContent
        ? {
          ...message,
          content: visibleContent,
        }
        : null,
      toolBlocks,
      thinkingEntries,
    };
  }

  return {
    visibleMessage: null,
    toolBlocks: [],
    thinkingEntries: [],
  };
}


export function processMessageBlocks(
  message: ConversationMessageData,
  messageKey: string,
): MessageSegment[] {
  if (message.isCompactBoundary || message.planContent || message.msgType === 'summary') {
    return [{ type: 'text', message, entries: [] }];
  }

  const segments: MessageSegment[] = [];
  const blocks = toContentBlocks(message.content);

  const currentEntries: ToolDigestEntry[] = [];
  let seenToolContent = false;

  const flushToolGroup = () => {
    if (currentEntries.length > 0) {
      segments.push({ type: 'tool-group', entries: [...currentEntries] });
      currentEntries.length = 0;
    }
  };

  if (typeof message.content === 'string') {
    const { visibleText, thinkingEntries } = extractThinkingFromText(message.content, messageKey);
    if (thinkingEntries.length > 0) {
      const entries: ToolDigestEntry[] = thinkingEntries.map((e) => ({
        type: 'thinking',
        thinking: e,
      }));
      segments.push({ type: 'tool-group', entries });
    }
    if (visibleText) {
      segments.push({
        type: 'text',
        message: { ...message, content: visibleText },
        entries: [],
      });
    }
    return segments;
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const blockKey = `${messageKey}-${index}`;

    if (block.type === 'tool_use') {
      seenToolContent = true;
      currentEntries.push({ type: 'tool_use', block });
      continue;
    }

    if (block.type === 'tool_result') {
      continue;
    }

    if (block.type === 'thinking') {
      seenToolContent = true;
      const content = (block.thinking || block.text || '').trim();
      if (content) {
        currentEntries.push({
          type: 'thinking',
          thinking: {
            key: `${blockKey}-thinking`,
            content,
            startedAt: toFiniteTimestamp(block._startedAt),
            completedAt: toFiniteTimestamp(block._completedAt),
          },
        });
      }
      continue;
    }

    if (block.type === 'text') {
      const { visibleText, thinkingEntries: extractedThinking } = extractThinkingFromText(
        block.text || '',
        `${blockKey}-text`,
      );
      const hasEmbeddedThinking = extractedThinking.length > 0;

      if (hasEmbeddedThinking) {
        seenToolContent = true;
        for (const e of extractedThinking) {
          currentEntries.push({ type: 'thinking', thinking: e });
        }
      }

      if (visibleText) {
        if (seenToolContent && !hasEmbeddedThinking) {
          flushToolGroup();
        }
        segments.push({
          type: 'text',
          message: { ...message, content: [{ ...block, text: visibleText }] },
          entries: [],
        });
      }
      continue;
    }

    if (seenToolContent) {
      flushToolGroup();
    }
    segments.push({
      type: 'text',
      message: { ...message, content: [block] },
      entries: [],
    });
  }

  flushToolGroup();

  return segments;
}
function DisclosureCard({
  icon: Icon,
  label,
  summary,
  defaultOpen = false,
  children,
  className,
  headerClassName,
  summaryClassName,
  contentClassName,
}: {
  icon: typeof Brain;
  label: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
  summaryClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hasRenderedBody, setHasRenderedBody] = useState(defaultOpen);

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            if (!current && !hasRenderedBody) {
              startTransition(() => setHasRenderedBody(true));
            }
            return !current;
          });
        }}
        className={cn(
          'flex w-full items-center gap-2 text-left transition-colors',
          headerClassName,
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="text-[12px] font-medium text-foreground/75">{label}</span>
        {summary ? (
          <span className={cn('min-w-0 truncate text-[11px] text-muted-foreground/60', summaryClassName)}>
            {summary}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 ease-out',
            open && 'rotate-180',
          )}
        />
      </button>
      {hasRenderedBody ? (
        <div
          className={cn(
            'grid transition-all duration-250 ease-out',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className={cn('pl-5 pt-2', contentClassName)}>
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CommandPill({
  name,
  output,
  subtle = false,
}: {
  name: string;
  output?: string;
  subtle?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px]',
          subtle
            ? 'border border-border/40 bg-[hsl(var(--chat-assistant-bg)/0.6)] text-foreground/78'
            : 'border border-primary/20 bg-primary/8 text-primary'
        )}
      >
        <Terminal className="h-3 w-3" />
        <span>/{name}</span>
      </div>
      {output ? (
        <span className="min-w-0 truncate text-[11px] text-foreground/52">{output}</span>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ content, label }: { content: string; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const handleScroll = () => {
      stickToBottomRef.current =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !stickToBottomRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [content]);

  return (
    <DisclosureCard icon={Brain} label={label}>
      <ScrollArea viewportRef={viewportRef} className="max-h-[260px]">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-6 text-muted-foreground/80">
          {content.trim()}
        </pre>
      </ScrollArea>
    </DisclosureCard>
  );
}

const ToolPayloadPanel = memo(function ToolPayloadPanel({
  value,
}: {
  value: unknown;
}) {
  const text = useMemo(() => stringifyUnknown(value), [value]);

  if (!text) {
    return null;
  }

  return (
    <div className="workspace-tool-payload-virtualized rounded-md bg-[hsl(var(--tool-input-bg))] px-2.5 py-2">
      <ScrollArea className="max-h-[120px]">
        <pre className="whitespace-pre-wrap font-mono text-[10px] leading-[1.45] text-muted-foreground/70">
          {text}
        </pre>
      </ScrollArea>
    </div>
  );
}, (prevProps, nextProps) => prevProps.value === nextProps.value);

function isSubagentToolName(name?: string): boolean {
  return name === 'Agent' || name === 'Task';
}

function toToolResultMarkdown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  return stringifyUnknown(value).trim();
}

const SubagentResultPanel = memo(function SubagentResultPanel({
  value,
}: {
  value: unknown;
}) {
  const markdown = useMemo(() => toToolResultMarkdown(value), [value]);

  if (!markdown) {
    return null;
  }

  return (
    <div className="workspace-tool-payload-virtualized rounded-md border border-border/35 bg-[hsl(var(--tool-input-bg))] px-3 py-2.5">
      <ScrollArea className="max-h-[60vh] sm:max-h-[520px]">
        <MarkdownRenderer
          content={markdown}
          className="pr-3 text-[13px] leading-6 text-foreground/82"
          codeTone="reading"
        />
      </ScrollArea>
    </div>
  );
}, (prevProps, nextProps) => prevProps.value === nextProps.value);

const ThinkingEntryPanel = memo(function ThinkingEntryPanel({
  entry,
  index,
  label,
}: {
  entry: WorkspaceThinkingEntry;
  index: number;
  label: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const segmentCount = entry.segmentCount ?? 1;
  const headerLabel = segmentCount > 1
    ? `${index === 0 ? label : `${label} ${index + 1}`} · ${segmentCount}`
    : index === 0
      ? label
      : `${label} ${index + 1}`;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const handleScroll = () => {
      stickToBottomRef.current =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !stickToBottomRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [entry.content]);

  return (
    <div className="workspace-tool-payload-virtualized rounded-lg bg-[hsl(var(--tool-input-bg))] px-3 py-2.5">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/50">
        {headerLabel}
      </p>
      <ScrollArea viewportRef={viewportRef} className="max-h-[160px]">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-muted-foreground/75">
          {entry.content}
        </pre>
      </ScrollArea>
    </div>
  );
}, (prevProps, nextProps) => prevProps.entry === nextProps.entry && prevProps.index === nextProps.index && prevProps.label === nextProps.label);

function ToolInputContext({ block }: { block: ConversationContentBlock }) {
  const input = block.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return null;

  const summaryStr = typeof input.summary === 'string' && input.summary.length > 0 ? input.summary : undefined;
  const fields: { label: string; value: string }[] = [];

  switch (block.name) {
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const path = typeof input.path === 'string' ? input.path : '';
      const glob = typeof input.glob === 'string' ? input.glob : '';
      if (pattern) fields.push({ label: 'pattern', value: pattern });
      else if (summaryStr) fields.push({ label: 'summary', value: summaryStr });
      if (path) fields.push({ label: 'in', value: path });
      if (glob) fields.push({ label: 'filter', value: glob });
      break;
    }
    case 'Read': {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      if (fp) fields.push({ label: 'file', value: fp });
      else if (summaryStr) fields.push({ label: 'file', value: summaryStr });
      if (offset !== undefined) fields.push({ label: 'offset', value: String(offset) });
      if (limit !== undefined) fields.push({ label: 'limit', value: String(limit) });
      break;
    }
    case 'Write': {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (fp) fields.push({ label: 'file', value: fp });
      else if (summaryStr) fields.push({ label: 'file', value: summaryStr });
      break;
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const path = typeof input.path === 'string' ? input.path : '';
      if (pattern) fields.push({ label: 'pattern', value: pattern });
      else if (summaryStr) fields.push({ label: 'summary', value: summaryStr });
      if (path) fields.push({ label: 'in', value: path });
      break;
    }
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (cmd && cmd.length > 120) {
        fields.push({ label: 'command', value: `${cmd.slice(0, 117)}...` });
      } else if (cmd) {
        fields.push({ label: 'command', value: cmd });
      } else if (summaryStr) {
        fields.push({ label: 'command', value: summaryStr });
      }
      break;
    }
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : '';
      if (url) fields.push({ label: 'url', value: url });
      else if (summaryStr) fields.push({ label: 'url', value: summaryStr });
      break;
    }
    case 'Agent':
    case 'Task': {
      // Sub-agent dispatch: input = { subagent_type, description, prompt }.
      const st = typeof input.subagent_type === 'string' ? input.subagent_type : '';
      const desc = typeof input.description === 'string' ? input.description : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (desc) {
        fields.push({ label: st || 'agent', value: desc });
      } else if (prompt) {
        fields.push({ label: st || 'agent', value: prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt });
      } else if (st) {
        fields.push({ label: 'type', value: st });
      } else if (summaryStr) {
        fields.push({ label: 'input', value: summaryStr });
      }
      break;
    }
    default:
      if (summaryStr) fields.push({ label: 'input', value: summaryStr });
      break;
  }

  if (fields.length === 0) return null;

  return (
    <div className="workspace-tool-payload-virtualized rounded-md bg-[hsl(var(--tool-input-bg))] mb-1.5 px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[10px] leading-[1.5]">
        {fields.map((f) => (
          <span key={f.label}>
            <span className="text-muted-foreground/45">{f.label}: </span>
            <span className="text-muted-foreground/70">{f.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const MAX_DIFF_CHARS = 800;

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const total = oldText.length + newText.length;
  const truncated = total > MAX_DIFF_CHARS;
  const displayOld = truncated ? oldText.slice(0, MAX_DIFF_CHARS / 2) : oldText;
  const displayNew = truncated ? newText.slice(0, MAX_DIFF_CHARS / 2) : newText;

  return (
    <div className="workspace-tool-payload-virtualized overflow-hidden rounded-md bg-[hsl(var(--tool-input-bg))]">
      {displayOld ? (
        <div className="border-b border-destructive/10 px-2.5 py-1.5">
          <pre className="whitespace-pre-wrap font-mono text-[10px] leading-[1.45] text-muted-foreground/55 line-through">
            {displayOld}{truncated ? '…' : ''}
          </pre>
        </div>
      ) : null}
      <div className="px-2.5 py-1.5">
        <pre className="whitespace-pre-wrap font-mono text-[10px] leading-[1.45] text-success/75">
          {displayNew}{truncated ? '…' : ''}
        </pre>
      </div>
      {truncated ? (
        <div className="border-t border-border/20 px-2.5 py-1.5 text-[10px] text-muted-foreground/50">
          Diff too large — open in editor to review
        </div>
      ) : null}
    </div>
  );
}

const ToolCallRow = memo(function ToolCallRow({
  block,
}: {
  block: ConversationContentBlock;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [hasRenderedBody, setHasRenderedBody] = useState(false);
  const detailBodyRef = useRef<HTMLDivElement | null>(null);
  const hasResult = '_result' in block;
  const isError = block._resultError === true;
  const detail = useMemo(() => extractToolSummary(block.name, block.input), [block.input, block.name]);
  const isEdit = block.name === 'Edit';
  const isSubagentTool = isSubagentToolName(block.name);
  const isSearchTool = block.name === 'Grep' || block.name === 'Glob' || block.name === 'Bash' || block.name === 'WebFetch'
    || block.name === 'Read' || block.name === 'Write';
  const editDiff = useMemo(() => {
    if (!isEdit || !block.input || typeof block.input !== 'object') return null;
    const input = block.input as Record<string, unknown>;
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    if (!oldStr && !newStr) return null;
    return { oldText: oldStr, newText: newStr };
  }, [isEdit, block.input]);

  const toolLabel = detail
    ? `${block.name || 'Tool'}(${detail})`
    : (block.name || 'Tool');

  useGSAP(() => {
    const body = detailBodyRef.current;
    if (!body || !open) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(body);
      return;
    }

    gsap.fromTo(
      body,
      { autoAlpha: 0, y: -4 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.soft,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [open, hasRenderedBody], scope: detailBodyRef });

  return (
    <div className="workspace-tool-row-virtualized">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!hasResult) return;
          setOpen((current) => {
            if (!current && !hasRenderedBody) {
              startTransition(() => setHasRenderedBody(true));
            }
            return !current;
          });
        }}
        className={cn(
          'flex w-full items-center gap-1.5 py-0.5 text-left transition-colors',
          hasResult && 'cursor-pointer',
        )}
      >
        <Circle
          className={cn(
            'h-1.5 w-1.5 shrink-0 fill-current',
            isError ? 'text-destructive/65' : hasResult ? 'text-success/60' : 'text-muted-foreground/30',
          )}
        />
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/60">
          {toolLabel}
        </span>
        {hasResult ? (
          <span
            className={cn(
              'shrink-0 text-[10px]',
              isError ? 'text-destructive/65' : 'text-success/55',
            )}
          >
            {isError ? t('workspace.toolFailedState') : t('workspace.toolDone')}
          </span>
        ) : null}
        {hasResult ? (
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground/30 transition-transform duration-200 ease-out',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      {hasRenderedBody ? (
        <div
          className={cn(
            'grid transition-all duration-250 ease-out',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div ref={detailBodyRef} className="overflow-hidden pt-1">
            {editDiff ? (
              <EditDiff oldText={editDiff.oldText} newText={editDiff.newText} />
            ) : (
              <>
                {(isSearchTool || isSubagentTool) ? <ToolInputContext block={block} /> : null}
                {isSubagentTool
                  ? <SubagentResultPanel value={block._result} />
                  : <ToolPayloadPanel value={block._result} />}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}, (prevProps, nextProps) => prevProps.block === nextProps.block);

function WorkspaceToolDigestComponent({
  entries,
  className,
  autoExpanded = false,
  isActive = false,
}: {
  entries: ToolDigestEntry[];
  className?: string;
  autoExpanded?: boolean;
  isActive?: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [hasRenderedBody, setHasRenderedBody] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const previousAutoExpandedRef = useRef(autoExpanded);
  const digestBodyRef = useRef<HTMLDivElement | null>(null);
  const { summary, toolCount, thinkingCount } = useMemo(() => {
    const toolEntries = entries.filter((e) => e.type === 'tool_use');
    const thinkingEntriesList = entries.filter((e) => e.type === 'thinking');
    const toolNames = Array.from(new Set(toolEntries.map((e) => e.block?.name || 'Tool')));
    const visibleToolNames = toolNames.slice(0, 3).join(' · ');
    const hiddenToolCount = Math.max(0, toolNames.length - 3);

    const summaryParts = [];
    if (toolEntries.length > 0) {
      summaryParts.push(`${toolEntries.length} ${t('workspace.toolCalls')}`);
    }
    if (thinkingEntriesList.length > 0) {
      summaryParts.push(`${thinkingEntriesList.length} ${t('workspace.thinkingNotes')}`);
    }
    if (visibleToolNames) {
      summaryParts.push(visibleToolNames);
    }
    if (hiddenToolCount > 0) {
      summaryParts.push(`+${hiddenToolCount}`);
    }

    return {
      summary: summaryParts.join(' · '),
      toolCount: toolEntries.length,
      thinkingCount: thinkingEntriesList.length,
    };
  }, [entries, t]);
  const timeRange = useMemo(() => getDigestTimeRange(entries), [entries]);
  const durationLabel = useMemo(() => {
    if (!timeRange) {
      return null;
    }

    const end = timeRange.completedAt ?? (isActive ? now : undefined);
    if (end == null) {
      return null;
    }

    return formatProcessDuration(end - timeRange.startedAt);
  }, [isActive, now, timeRange]);

  useEffect(() => {
    if (autoExpanded && (thinkingCount > 0 || toolCount > 0)) {
      setHasRenderedBody(true);
      setOpen(true);
    } else if (previousAutoExpandedRef.current && !autoExpanded) {
      setOpen(false);
    }

    previousAutoExpandedRef.current = autoExpanded;
  }, [autoExpanded, toolCount, thinkingCount]);

  useEffect(() => {
    if (!isActive || !timeRange) {
      return undefined;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isActive, timeRange]);

  useGSAP(() => {
    const body = digestBodyRef.current;
    if (!body || !open) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(body);
      return;
    }

    gsap.fromTo(
      body,
      { autoAlpha: 0, y: -6 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.soft,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [open, hasRenderedBody], scope: digestBodyRef });

  return (
    <div className={cn('max-w-[760px]', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            if (!current && !hasRenderedBody) {
              startTransition(() => setHasRenderedBody(true));
            }
            return !current;
          });
        }}
        className="group flex w-full items-center gap-3 py-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
          <span className="shrink-0 text-[12px] font-medium text-foreground/75">
            {t('workspace.processedLabel')}
          </span>
          {durationLabel ? (
            <span className="shrink-0 whitespace-nowrap text-[12px] font-normal text-muted-foreground/55">{durationLabel}</span>
          ) : null}
          <span className="min-w-0 truncate text-[12px] text-muted-foreground/55">{summary}</span>
        </div>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 ease-out',
            open && 'rotate-180',
          )}
        />
      </button>
      <div className="h-px bg-border/45" />
      {hasRenderedBody ? (
        <div
          className={cn(
            'grid transition-all duration-250 ease-out',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div ref={digestBodyRef} className="pt-3 space-y-2.5">
              {entries.map((entry, entryIndex) => {
                if (entry.type === 'thinking' && entry.thinking) {
                  return (
                    <ThinkingEntryPanel
                      key={entry.thinking.key}
                      entry={entry.thinking}
                      index={entryIndex}
                      label={t('history.thinking')}
                    />
                  );
                }
                if (entry.type === 'tool_use' && entry.block) {
                  return (
                    <ToolCallRow
                      key={entry.block.id || `${entry.block.name || 'tool'}-${entryIndex}`}
                      block={entry.block}
                    />
                  );
                }
                return null;
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const WorkspaceToolDigest = memo(
  WorkspaceToolDigestComponent,
  (prevProps, nextProps) => (
    prevProps.className === nextProps.className
    && prevProps.entries === nextProps.entries
    && prevProps.autoExpanded === nextProps.autoExpanded
    && prevProps.isActive === nextProps.isActive
  )
);

export const WorkspacePendingResponse = memo(function WorkspacePendingResponse() {
  const { t } = useLocale();
  const pendingRef = useRef<HTMLDivElement | null>(null);

  useGSAP(() => {
    const pending = pendingRef.current;
    if (!pending) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(pending);
      return;
    }

    gsap.fromTo(
      pending,
      { autoAlpha: 0, y: 6 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { scope: pendingRef });

  return (
    <div ref={pendingRef} className="flex items-center gap-2.5 py-1">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground/50" />
      <span className="text-[12px] text-muted-foreground/60">
        {t('workspace.nativeThinking')}
      </span>
    </div>
  );
});

function AgentNoteBlock({ msg, label }: { msg: TeammateMessage; label: string }) {
  const notification = msg.notification;
  const summary = notification
    ? `${msg.id} · ${notification.idleReason || 'idle'}`
    : `${msg.id}${msg.summary ? ` · ${msg.summary}` : ''}`;

  return (
    <DisclosureCard
      icon={(notification ? AlertCircle : ClipboardList) as typeof Brain}
      label={label}
      summary={summary}
    >
      {notification ? (
        <p className="text-[12px] leading-6 text-muted-foreground/80">
          {notification.failureReason || notification.idleReason || msg.content}
        </p>
      ) : (
        <MarkdownRenderer content={msg.content} className="text-[14px] leading-7" codeTone="reading" />
      )}
    </DisclosureCard>
  );
}

function PlanBlock({ content, label }: { content: string; label: string }) {
  const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)$/m);
  const title = titleMatch?.[1]?.trim();

  return (
    <DisclosureCard
      icon={ClipboardList as typeof Brain}
      label={label}
      summary={title}
    >
      <MarkdownRenderer content={content} className="text-[14px] leading-7" codeTone="reading" />
    </DisclosureCard>
  );
}

function formatMessageTime(ts?: number): string | null {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const MessageMetaBar = memo(function MessageMetaBar({
  message,
  isUser,
  visible,
  t,
}: {
  message: ConversationMessageData;
  isUser: boolean;
  visible: boolean;
  t: (key: string) => string;
}) {
  const [copied, setCopied] = useState(false);
  const timeLabel = formatMessageTime(message.timestamp);

  const handleCopy = useCallback(async () => {
    const text = getMessageCopyText(message, t).trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [message, t]);

  return (
    <div
      className={cn(
        'absolute bottom-0 z-10 flex items-center gap-1 select-none transition-opacity duration-150',
        visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        isUser ? 'right-0 justify-end' : 'left-0 justify-start',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={copied ? t('workspace.copied') : t('workspace.copyMessage')}
            onClick={handleCopy}
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
              isUser
                ? 'text-foreground/50 hover:bg-foreground/10'
                : 'text-muted-foreground/50 hover:bg-muted/50',
            )}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
      <TooltipContent>
        {copied ? t('workspace.copied') : t('workspace.copyMessage')}
      </TooltipContent>
    </Tooltip>
      {timeLabel ? (
        <span className="text-[10px] tabular-nums text-muted-foreground/40">
          {timeLabel}
        </span>
      ) : null}
    </div>
  );
}, (prev, next) => (
  prev.message === next.message
  && prev.isUser === next.isUser
  && prev.visible === next.visible
  && prev.t === next.t
));

function renderAssistantMarkdown(text: string) {
  return (
    <MarkdownRenderer
      content={text}
      className="text-[14px] leading-7 text-foreground/88 [&_p]:my-0 [&_p+*]:mt-3"
      codeTone="reading"
    />
  );
}

function renderUserMarkdown(text: string) {
  return (
    <MarkdownRenderer
      content={text}
      className="text-[14px] leading-7 text-foreground/94 [&_p]:my-0 [&_p+*]:mt-3"
      codeTone="reading"
    />
  );
}

function imageBlockMediaType(block: ConversationContentBlock): string {
  return typeof block.mediaType === 'string'
    ? block.mediaType
    : typeof block.media_type === 'string'
      ? block.media_type
      : '';
}

function imageBlockInlineSrc(block: ConversationContentBlock): string | null {
  const mediaType = imageBlockMediaType(block);
  const base64Data = typeof block.base64Data === 'string'
    ? block.base64Data
    : typeof block.base64_data === 'string'
      ? block.base64_data
      : '';

  if (!mediaType.startsWith('image/') || !base64Data) {
    return null;
  }

  return `data:${mediaType};base64,${base64Data}`;
}

function imageBlockStoragePath(block: ConversationContentBlock): string {
  return typeof block.storagePath === 'string'
    ? block.storagePath
    : typeof block.storage_path === 'string'
      ? block.storage_path
      : '';
}

function useImageBlockSrc(block: ConversationContentBlock): {
  src: string | null;
  loading: boolean;
  failed: boolean;
} {
  const inlineSrc = imageBlockInlineSrc(block);
  const mediaType = imageBlockMediaType(block);
  const storagePath = imageBlockStoragePath(block);
  const [src, setSrc] = useState<string | null>(inlineSrc);
  const [loading, setLoading] = useState(!inlineSrc && !!storagePath);
  const [failed, setFailed] = useState(!inlineSrc && !storagePath);

  useEffect(() => {
    let cancelled = false;

    if (inlineSrc) {
      setSrc(inlineSrc);
      setLoading(false);
      setFailed(false);
      return () => {
        cancelled = true;
      };
    }

    if (!mediaType.startsWith('image/') || !storagePath) {
      setSrc(null);
      setLoading(false);
      setFailed(true);
      return () => {
        cancelled = true;
      };
    }

    setSrc(null);
    setLoading(true);
    setFailed(false);
    invoke<string>('read_prompt_image_attachment', {
      storagePath,
      mediaType,
    })
      .then((resolved) => {
        if (!cancelled) {
          setSrc(resolved);
          setLoading(false);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
          setLoading(false);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inlineSrc, mediaType, storagePath]);

  return { src, loading, failed };
}

function WorkspaceImageLightbox({
  blocks,
  initialIndex,
  onClose,
  onIndexChange,
  t,
}: {
  blocks: ConversationContentBlock[];
  initialIndex: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [index, setIndex] = useState(initialIndex);
  const hasMultiple = blocks.length > 1;

  useEffect(() => {
    onIndexChange(index);
  }, [index, onIndexChange]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'ArrowLeft' && hasMultiple) {
        setIndex((prev) => (prev - 1 + blocks.length) % blocks.length);
      } else if (event.key === 'ArrowRight' && hasMultiple) {
        setIndex((prev) => (prev + 1) % blocks.length);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blocks.length, hasMultiple, onClose]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          className="max-h-[92vh] max-w-[92vw] gap-0 overflow-hidden rounded-xl border-none bg-transparent p-0 shadow-black/40 shadow-2xl sm:max-h-[92vh] sm:max-w-[92vw]"
          showCloseButton={false}
        >
          <WorkspaceLightboxImage block={blocks[index]} index={index} t={t} />
          {hasMultiple ? (
            <>
              <button
                type="button"
                aria-label={t('workspace.imageLightboxPrev')}
                onClick={() => setIndex((prev) => (prev - 1 + blocks.length) % blocks.length)}
                className="absolute left-2 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-sm transition hover:bg-black/65 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label={t('workspace.imageLightboxNext')}
                onClick={() => setIndex((prev) => (prev + 1) % blocks.length)}
                className="absolute right-2 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-sm transition hover:bg-black/65 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <span className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium tabular-nums text-white/90">
                {t('workspace.imageStripCounter', { current: index + 1, total: blocks.length })}
              </span>
            </>
          ) : null}
          <button
            type="button"
            aria-label={t('workspace.imageLightboxClose')}
            onClick={onClose}
            className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-sm transition hover:bg-black/65 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function WorkspaceLightboxImage({
  block,
  index,
  t,
}: {
  block: ConversationContentBlock;
  index: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { src, loading, failed } = useImageBlockSrc(block);
  const altKey = t('workspace.imageThumbnailAlt', { index: index + 1 });

  if (loading) {
    return (
      <div className="flex h-[60vh] w-[80vw] max-w-[1100px] items-center justify-center rounded-xl bg-black/70">
        <LoaderCircle className="h-6 w-6 animate-spin text-white/70" />
      </div>
    );
  }

  if (failed || !src) {
    return (
      <div className="flex h-[40vh] w-[60vw] max-w-[800px] flex-col items-center justify-center gap-2 rounded-xl bg-black/70 px-6 text-center">
        <ImageIcon className="h-7 w-7 text-white/40" />
        <span className="text-[12px] text-white/60">{t('workspace.imageLoadFailed')}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={altKey}
      loading="lazy"
      className="block max-h-[88vh] max-w-[88vw] rounded-xl object-contain"
    />
  );
}

function WorkspaceImageThumbnail({
  block,
  index,
  active,
  onSelect,
  t,
}: {
  block: ConversationContentBlock;
  index: number;
  active: boolean;
  onSelect: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { src, loading, failed } = useImageBlockSrc(block);
  const altLabel = t('workspace.imageThumbnailAlt', { index: index + 1 });

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={altLabel}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex h-[68px] w-[68px] shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-surface/80 backdrop-blur-sm transition',
        active
          ? 'border-primary/70 ring-2 ring-primary/30'
          : 'border-border/40 hover:border-border/70 hover:bg-surface',
      )}
    >
      {src ? (
        <img
          src={src}
          alt={altLabel}
          loading="lazy"
          className="h-full w-full object-cover transition group-hover:scale-[1.03]"
        />
      ) : loading ? (
        <div className="h-full w-full animate-pulse bg-muted/30" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground/70">
          <ImageIcon className="h-4 w-4" />
          {failed ? <span className="text-[9px] tabular-nums">{index + 1}</span> : null}
        </div>
      )}
      <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/55 to-transparent px-1 py-0.5 text-left text-[9px] font-medium tabular-nums text-white/85 opacity-0 transition group-hover:opacity-100">
        {index + 1}
      </span>
    </button>
  );
}

function WorkspaceImageStrip({
  blocks,
  isUser,
  t,
}: {
  blocks: ConversationContentBlock[];
  isUser: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const hasMultiple = blocks.length > 1;

  useEffect(() => {
    if (activeIndex >= blocks.length) {
      setActiveIndex(0);
    }
  }, [blocks.length, activeIndex]);

  useEffect(() => {
    if (!lightboxOpen) {
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [lightboxOpen]);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          'mt-2 flex items-center gap-1.5',
          isUser ? 'justify-end' : 'justify-start',
        )}
      >
        {hasMultiple ? (
          <button
            type="button"
            aria-label={t('workspace.imageStripPrev')}
            onClick={() => setActiveIndex((prev) => (prev - 1 + blocks.length) % blocks.length)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-surface/70 text-muted-foreground transition hover:border-border/70 hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : null}

        <div
          className={cn(
            'flex items-center gap-1.5 overflow-x-auto',
            hasMultiple ? 'max-w-[260px]' : 'max-w-[260px]',
          )}
        >
          {blocks.map((block, index) => (
            <WorkspaceImageThumbnail
              key={`img-thumb-${index}`}
              block={block}
              index={index}
              active={index === activeIndex}
              onSelect={() => {
                setActiveIndex(index);
                setLightboxOpen(true);
              }}
              t={t}
            />
          ))}
        </div>

        {hasMultiple ? (
          <button
            type="button"
            aria-label={t('workspace.imageStripNext')}
            onClick={() => setActiveIndex((prev) => (prev + 1) % blocks.length)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border/40 bg-surface/70 text-muted-foreground transition hover:border-border/70 hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}

        {hasMultiple ? (
          <span className="ml-1 text-[11px] tabular-nums text-muted-foreground/70">
            {t('workspace.imageStripCounter', { current: activeIndex + 1, total: blocks.length })}
          </span>
        ) : null}
      </div>

      {lightboxOpen ? (
        <WorkspaceImageLightbox
          blocks={blocks}
          initialIndex={Math.min(activeIndex, blocks.length - 1)}
          onClose={() => setLightboxOpen(false)}
          onIndexChange={(next) => setActiveIndex(next)}
          t={t}
        />
      ) : null}
    </>
  );
}

function renderTextBlock(text: string, isUser: boolean, t: (key: string) => string) {
  const { cleanText, command } = parseMessageText(text);
  const commandArgs = command?.args?.trim() || '';
  const commandBody = cleanText || commandArgs;

  if (command && !commandBody) {
    return <CommandPill name={command.name} output={command.output} subtle={isUser} />;
  }

  if (command && commandBody) {
    return (
      <div className="space-y-3">
        <CommandPill name={command.name} output={command.output} subtle={isUser} />
        {isUser ? (
          renderUserMarkdown(commandBody)
        ) : (
          renderAssistantMarkdown(commandBody)
        )}
      </div>
    );
  }

  if (!cleanText) return null;

  if (!isUser && /<think>/i.test(cleanText)) {
    return (
      <div className="space-y-3">
        {splitThinkBlocks(cleanText).map((part, index) =>
          part.type === 'think' ? (
            <ThinkingBlock key={`think-${index}`} content={part.content} label={t('history.thinking')} />
          ) : (
            <div key={`think-md-${index}`}>{renderAssistantMarkdown(part.content.trim())}</div>
          )
        )}
      </div>
    );
  }

  return isUser
    ? renderUserMarkdown(cleanText)
    : renderAssistantMarkdown(cleanText);
}

function renderContentBlocks(
  blocks: ConversationContentBlock[],
  isUser: boolean,
  t: (key: string) => string,
): { content: React.ReactNode[]; images: ConversationContentBlock[] } {
  const result: React.ReactNode[] = [];
  const imageBlocks = blocks.filter((block) => block.type === 'image');
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];

    if (block.type === 'tool_use') {
      const toolBlocks: ConversationContentBlock[] = [];
      while (index < blocks.length && blocks[index].type === 'tool_use') {
        toolBlocks.push(blocks[index]);
        index += 1;
      }
      result.push(
        <WorkspaceToolDigest
          key={`tool-group-${toolBlocks[0].id || index}`}
          entries={toolBlocks.map((b) => ({ type: 'tool_use' as const, block: b }))}
        />
      );
      continue;
    }

    switch (block.type) {
      case 'text': {
        const visibleText = isUser && imageBlocks.length > 0
          ? stripRenderedImageMarkers(block.text || '', imageBlocks)
          : block.text || '';
        if (visibleText.trim()) {
          result.push(<div key={`text-${index}`}>{renderTextBlock(visibleText, isUser, t)}</div>);
        }
        break;
      }
      case 'image':
        break;
      case 'thinking':
        result.push(
          <ThinkingBlock
            key={`thinking-${index}`}
            content={block.thinking || block.text || ''}
            label={t('history.thinking')}
          />
        );
        break;
      case 'tool_result':
        break;
      default:
        break;
    }
    index += 1;
  }

  return { content: result, images: imageBlocks };
}

function WorkspaceMessageBubbleComponent({ message, prevRole }: WorkspaceMessageBubbleProps) {
  const { t } = useLocale();
  const [isActionHovering, setIsActionHovering] = useState(false);
  const [isActionFocusWithin, setIsActionFocusWithin] = useState(false);
  const isUser = message.msgType === 'user' || message.msgType === 'human';
  const isSummary = message.msgType === 'summary';
  const isCompactingSummary = message.summary === COMPACTING_SUMMARY_TOKEN;
  const summaryLabel = isCompactingSummary
    ? t('history.compactInProgress')
    : message.summary === COMPACT_FAILED_SUMMARY_TOKEN
      ? t('history.compactFailed')
      : message.summary === TRANSCRIPT_GAP_SUMMARY_TOKEN
        ? t('history.transcriptGap')
        : message.summary || t('history.summaryLabel');
  const currentRole = isUser ? 'user' : 'assistant';
  const spacingClass = prevRole == null ? 'mt-0' : prevRole === currentRole ? 'mt-4' : 'mt-8';

  const { renderedContent, teammateMessages, imageBlocks } = useMemo(() => {
    if (isSummary || message.isCompactBoundary || message.planContent) {
      return {
        renderedContent: null as React.ReactNode,
        teammateMessages: [] as TeammateMessage[],
        imageBlocks: [] as ConversationContentBlock[],
      };
    }

    const collected: TeammateMessage[] = [];
    const collect = (text: string) => {
      const parsed = parseMessageText(text);
      if (parsed.teammateMessages.length > 0) {
        collected.push(...parsed.teammateMessages);
      }
    };

    const content = message.content;
    let nextRenderedContent: React.ReactNode = null;
    let nextImageBlocks: ConversationContentBlock[] = [];

    if (typeof content === 'string') {
      collect(content);
      nextRenderedContent = renderTextBlock(content, isUser, t);
    } else if (Array.isArray(content)) {
      content.forEach((block) => {
        if (block.type === 'text' && block.text) {
          collect(block.text);
        }
      });
      const textBlocks = content.filter((block) => block.type === 'text');
      if (textBlocks.length === 1 && textBlocks.length === content.length && isCommandOnlyText(textBlocks[0].text || '')) {
        nextRenderedContent = renderTextBlock(textBlocks[0].text || '', isUser, t);
      } else {
        const rendered = renderContentBlocks(content, isUser, t);
        nextRenderedContent = rendered.content;
        nextImageBlocks = rendered.images;
      }
    } else if (content && typeof content === 'object') {
      const rendered = renderContentBlocks([content as ConversationContentBlock], isUser, t);
      nextRenderedContent = rendered.content;
      nextImageBlocks = rendered.images;
    }

    return {
      renderedContent: nextRenderedContent,
      teammateMessages: collected,
      imageBlocks: nextImageBlocks,
    };
  }, [isSummary, isUser, message.content, message.isCompactBoundary, message.planContent, t]);

  const handleActionRegionBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsActionFocusWithin(false);
    }
  }, []);

  if (isSummary) {
    return (
      <div className="my-6 flex justify-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-surface px-3 py-1.5 text-[11px] text-muted-foreground/80">
          {isCompactingSummary ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
          {summaryLabel}
        </div>
      </div>
    );
  }

  if (message.isCompactBoundary) {
    return (
      <div className="my-8 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/50" />
        <div className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-surface px-3 py-1 text-[11px] text-muted-foreground/80">
          <Scissors className="h-3 w-3" />
          {t('history.compactBoundary')}
        </div>
        <div className="h-px flex-1 bg-border/50" />
      </div>
    );
  }

  if (message.planContent) {
    return (
      <div className={spacingClass}>
        <PlanBlock content={message.planContent} label={t('history.plan')} />
      </div>
    );
  }

  const hasMainContent = renderedContent && !(Array.isArray(renderedContent) && renderedContent.length === 0);
  const hasImages = imageBlocks.length > 0;
  const showMessageActions = isActionHovering || isActionFocusWithin;

  if (!hasMainContent && !hasImages && teammateMessages.length === 0) {
    return null;
  }

  return (
    <div className={cn(spacingClass, 'workspace-msg-virtualized')}>
      {isUser && (hasMainContent || hasImages) ? (
          <div
            className="relative ml-auto max-w-[78%] min-w-[220px] pb-6"
            onPointerEnter={() => setIsActionHovering(true)}
            onPointerLeave={() => setIsActionHovering(false)}
            onFocusCapture={() => setIsActionFocusWithin(true)}
            onBlurCapture={handleActionRegionBlur}
          >
            <div className="rounded-[24px] border border-border/30 bg-[hsl(var(--chat-assistant-bg)/0.7)] px-5 py-4 text-foreground">
              {renderedContent}
              {hasImages ? <WorkspaceImageStrip blocks={imageBlocks} isUser t={t} /> : null}
            </div>
            <MessageMetaBar message={message} isUser visible={showMessageActions} t={t} />
          </div>
      ) : null}

      {!isUser && hasMainContent ? (
          <div
            className="relative w-fit max-w-full pb-6"
            onPointerEnter={() => setIsActionHovering(true)}
            onPointerLeave={() => setIsActionHovering(false)}
            onFocusCapture={() => setIsActionFocusWithin(true)}
            onBlurCapture={handleActionRegionBlur}
          >
            <div className="space-y-3">{renderedContent}</div>
            <MessageMetaBar message={message} isUser={false} visible={showMessageActions} t={t} />
          </div>
      ) : null}

      {!isUser && hasImages ? (
        <div
          className={cn(
            hasMainContent ? 'mt-1' : '',
            'flex justify-start',
          )}
        >
          <WorkspaceImageStrip blocks={imageBlocks} isUser={false} t={t} />
        </div>
      ) : null}

      {teammateMessages.length > 0 ? (
        <div className={cn('space-y-3', (hasMainContent || hasImages) && 'mt-3')}>
          {teammateMessages.map((msg, index) => (
            <AgentNoteBlock key={`${msg.id}-${index}`} msg={msg} label={t('workspace.agentNotes')} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const WorkspaceMessageBubble = memo(
  WorkspaceMessageBubbleComponent,
  (prevProps, nextProps) => prevProps.prevRole === nextProps.prevRole && prevProps.message === nextProps.message
);
