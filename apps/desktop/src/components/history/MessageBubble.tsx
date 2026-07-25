import { memo, startTransition, useMemo, useState } from 'react';
import { ChevronRight, Brain, CheckCircle2, XCircle, Circle, Scissors, ChevronsUpDown, ClipboardList, ChevronDown, Terminal, Sparkles, Users, AlertCircle, Copy, Check } from '@/lib/lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import {
  extractToolSummary,
  getMessageCopyText,
  isCommandOnlyText,
  parseMessageText,
  splitThinkBlocks,
  stringifyUnknown,
  type TeammateMessage,
} from '@/components/conversation/messageContentUtils';
import type {
  ConversationContentBlock as ContentBlock,
  ConversationMessageData,
} from '@/features/conversations/types';

/** Inline chip for slash commands — adapts to bubble background via isUser */
function CommandChip({ name, output, isUser, standalone }: { name: string; output?: string; isUser?: boolean; standalone?: boolean }) {
  // Standalone: command-only message, chip IS the bubble
  if (standalone) {
    return (
      <div className="flex items-center gap-2">
        <div className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl',
          'glass-subtle glass-noise',
          'border border-[hsl(var(--glass-border-light)/var(--glass-border-opacity))]',
          'shadow-[inset_0_0.5px_0_0_hsl(var(--glass-inset-highlight)/calc(var(--glass-inset-opacity)*0.6)),0_2px_8px_hsl(var(--glass-shadow-base)/0.08)]',
        )}>
          <Terminal className="w-3.5 h-3.5 text-primary/70" />
          <span className="text-[12px] font-mono font-medium text-primary">/{name}</span>
        </div>
        {output && (
          <span className="text-[11px] font-mono text-muted-foreground/50 truncate max-w-[250px]">
            {output}
          </span>
        )}
      </div>
    );
  }

  // Inline: inside a user or assistant bubble
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md',
        isUser
          ? 'bg-white/[0.12] border border-white/[0.18] shadow-[inset_0_0.5px_0_0_rgba(255,255,255,0.15)]'
          : 'bg-[hsl(var(--glass-bg)/calc(var(--glass-bg-opacity)*0.5))] border border-[hsl(var(--glass-border-light)/var(--glass-border-opacity))] shadow-[inset_0_0.5px_0_0_hsl(var(--glass-inset-highlight)/calc(var(--glass-inset-opacity)*0.5))]'
      )}>
        <Terminal className={cn('w-3 h-3', isUser ? 'text-white/60' : 'text-primary/60')} />
        <span className={cn('text-[11px] font-mono font-medium', isUser ? 'text-white/90' : 'text-primary')}>/{name}</span>
      </div>
      {output && (
        <span className={cn('text-[11px] font-mono truncate max-w-[250px]', isUser ? 'text-white/40' : 'text-muted-foreground/50')}>
          {output}
        </span>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: ConversationMessageData;
  prevRole?: string | null;
}

function CollapsibleBlock({
  icon: Icon,
  label,
  iconClassName,
  children,
  defaultOpen = false,
}: {
  icon: typeof Brain;
  label: string;
  iconClassName?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hasRenderedBody, setHasRenderedBody] = useState(defaultOpen);

  const handleToggle = () => {
    setOpen((current) => {
      if (!current && !hasRenderedBody) {
        startTransition(() => setHasRenderedBody(true));
      }
      return !current;
    });
  };

  return (
    <div className="rounded-lg border border-border/40 overflow-hidden my-1">
      <button
        onClick={handleToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-90')} />
        <Icon className={cn('w-3.5 h-3.5', iconClassName)} />
        <span className="truncate">{label}</span>
      </button>
      {open && !hasRenderedBody && (
        <div className="px-3 pb-3 pt-1">
          <div className="h-5 animate-pulse rounded bg-muted/30" />
        </div>
      )}
      {hasRenderedBody && (
        <div
          aria-hidden={!open}
          className={cn('px-3 pb-3 text-xs', !open && 'hidden')}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ block, t }: { block: ContentBlock; t: (key: string) => string }) {
  const [open, setOpen] = useState(false);
  const [hasRenderedBody, setHasRenderedBody] = useState(false);
  const summary = extractToolSummary(block.name, block.input);
  const hasResult = '_result' in block;
  const isError = block._resultError === true;
  const inputText = useMemo(
    () => (hasRenderedBody ? stringifyUnknown(block.input) : ''),
    [block.input, hasRenderedBody]
  );
  const resultText = useMemo(
    () => (hasRenderedBody && hasResult ? stringifyUnknown(block._result) : ''),
    [block._result, hasRenderedBody, hasResult]
  );

  const handleToggle = () => {
    setOpen((current) => {
      if (!current && !hasRenderedBody) {
        startTransition(() => setHasRenderedBody(true));
      }
      return !current;
    });
  };

  return (
    <div className="my-1">
      <button
        onClick={handleToggle}
        aria-expanded={open}
        className="w-full min-w-0 flex items-center gap-1.5 py-1 text-xs hover:bg-muted/30 rounded transition-colors group text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Circle className={cn(
          'w-[5px] h-[5px] shrink-0 fill-current',
          isError ? 'text-destructive' : 'text-primary'
        )} />
        <div className="min-w-0 flex-1 flex items-center gap-1.5">
          <span className="font-medium text-foreground/90 whitespace-nowrap truncate">
            {block.name || 'Tool'}
          </span>
          {summary && (
            <span className="text-muted-foreground font-mono text-[11px] whitespace-nowrap truncate">
              ({summary})
            </span>
          )}
        </div>
        <span className="ml-auto shrink-0 flex items-center gap-1">
          {hasResult && (
            isError
              ? <XCircle className="w-3 h-3 text-destructive/70" />
              : <CheckCircle2 className="w-3 h-3 text-success/70" />
          )}
          <ChevronRight className={cn(
            'w-3 h-3 text-muted-foreground/50 transition-transform opacity-0 group-hover:opacity-100',
            open && 'rotate-90 opacity-100'
          )} />
        </span>
      </button>

      {open && !hasRenderedBody && (
        <div className="ml-4 mt-1 mb-2">
          <div className="h-8 animate-pulse rounded-md bg-muted/30" />
        </div>
      )}

      {hasRenderedBody && (
        <div
          aria-hidden={!open}
          className={cn('ml-4 mt-1 mb-2 space-y-2', !open && 'hidden')}
        >
          {/* Input */}
          <div className="rounded-md p-2 bg-[hsl(var(--tool-input-bg))]">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">{t('history.toolInput')}</p>
            <pre className="text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-[200px] overflow-y-auto">
              {inputText}
            </pre>
          </div>
          {/* Result */}
          {hasResult && (
            <div className={cn('border-l-2 pl-3', isError ? 'border-destructive/30' : 'border-primary/35')}>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">{t('history.toolOutput')}</p>
              <pre className="text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-[200px] overflow-y-auto">
                {resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Groups 3+ tool_use blocks with expand/collapse all controls */
function ToolCallGroup({ blocks, t }: { blocks: ContentBlock[]; t: (key: string) => string }) {
  const [allExpanded, setAllExpanded] = useState(false);
  const label = t('history.toolCount').replace('{count}', String(blocks.length));

  return (
    <div className="my-1">
      <div className="flex items-center gap-2 py-1">
        <span className="text-[11px] text-muted-foreground/70">{label}</span>
        <button
          onClick={() => setAllExpanded(!allExpanded)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-1"
        >
          <ChevronsUpDown className="w-3 h-3" />
          {allExpanded ? t('history.collapseAll') : t('history.expandAll')}
        </button>
      </div>
      {blocks.map((block, i) => (
        <ToolCallBlock key={block.id || i} block={block} t={t} />
      ))}
    </div>
  );
}

function PlanCard({ content, t, spacingClass }: { content: string; t: (key: string) => string; spacingClass: string }) {
  const [expanded, setExpanded] = useState(false);

  // Extract plan title from first # heading
  const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)$/m);
  const title = titleMatch?.[1]?.trim();

  return (
    <div className={cn('max-w-[90%] mx-auto', spacingClass)}>
      <div className="glass-card glass-noise rounded-2xl overflow-hidden border-l-[3px] border-primary">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40">
          <ClipboardList className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium text-primary">{t('history.plan')}</span>
          {title && (
            <span className="text-xs text-muted-foreground truncate">{title}</span>
          )}
        </div>
        {/* Content */}
        <div className="relative">
          <div
            className={cn('px-4 py-3', !expanded && 'max-h-[400px] overflow-hidden')}
            style={!expanded ? {
              maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
            } : undefined}
          >
            <MarkdownRenderer content={content} />
          </div>
          {!expanded && (
            <div className="flex justify-center pb-3 -mt-4 relative">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 px-3 py-1 rounded-lg glass-subtle text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                {t('history.expandPlan')}
              </button>
            </div>
          )}
          {expanded && (
            <div className="flex justify-center pb-3">
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1 px-3 py-1 rounded-lg glass-subtle text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5 rotate-180" />
                {t('history.collapsePlan')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Matches insight blocks: backtick-wrapped ★ header line, content, backtick-wrapped closing line */
const INSIGHT_RE = /`★\s*Insight\s*─+`\n([\s\S]*?)\n`─+`/g;

/** Render an insight block as a frosted glass callout card */
function InsightBlock({ content }: { content: string }) {
  return (
    <div className={cn(
      'relative my-2.5 rounded-xl overflow-hidden',
      'glass-noise',
      'bg-[hsl(var(--primary)/0.08)]',
      'border-l-[3px] border-l-primary/70',
      'border border-primary/20',
      'shadow-[inset_0_1px_0_0_hsl(var(--glass-inset-highlight)/calc(var(--glass-inset-opacity)*0.8)),0_2px_12px_hsl(var(--glass-shadow-base)/0.1)]',
    )}>
      {/* Accent glow on left edge */}
      <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-primary/[0.08] to-transparent pointer-events-none" />
      {/* Header */}
      <div className="relative flex items-center gap-1.5 px-3 pt-2 pb-0.5">
        <Sparkles className="w-3 h-3 text-primary" />
        <span className="text-[10px] font-semibold text-primary uppercase tracking-widest">Insight</span>
      </div>
      {/* Body */}
      <div className="relative px-3 pb-2.5 text-[12.5px] leading-relaxed">
        <MarkdownRenderer content={content.trim()} />
      </div>
    </div>
  );
}

/** Color map for teammate badges */
const TEAMMATE_COLORS: Record<string, string> = {
  blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  green: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  yellow: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  red: 'bg-red-500/20 text-red-400 border-red-500/30',
};
const TEAMMATE_BORDER_COLORS: Record<string, string> = {
  blue: 'border-l-blue-400/70',
  green: 'border-l-emerald-400/70',
  yellow: 'border-l-amber-400/70',
  purple: 'border-l-purple-400/70',
  red: 'border-l-red-400/70',
};

/** Render a teammate message — either a full markdown deliverable or a status notification */
function TeammateMessageBlock({ msg }: { msg: TeammateMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [hasRenderedBody, setHasRenderedBody] = useState(false);
  const isNotification = !!msg.notification;
  const isFailed = msg.notification?.idleReason === 'failed';
  const colorClass = TEAMMATE_COLORS[msg.color] || TEAMMATE_COLORS.blue;
  const borderClass = TEAMMATE_BORDER_COLORS[msg.color] || TEAMMATE_BORDER_COLORS.blue;

  // Compact notification chip (idle/available/failed)
  if (isNotification) {
    return (
      <div className="my-1.5 flex items-center gap-2">
        <div className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px]',
          isFailed
            ? 'bg-destructive/10 border border-destructive/20'
            : 'bg-muted/80 border border-border/50',
        )}>
          {isFailed
            ? <AlertCircle className="w-3 h-3 text-destructive/70" />
            : <Users className="w-3 h-3 text-muted-foreground/60" />
          }
          <span className={cn('font-mono font-medium', colorClass, 'bg-transparent border-0')}>
            {msg.id}
          </span>
          <span className={cn('text-muted-foreground/70', isFailed && 'text-destructive/70')}>
            {isFailed ? 'failed' : msg.notification?.idleReason || 'idle'}
          </span>
        </div>
        {isFailed && msg.notification?.failureReason && (
          <span className="text-[10px] text-destructive/60 truncate max-w-[300px]">
            {msg.notification.failureReason}
          </span>
        )}
      </div>
    );
  }

  // Full content deliverable — collapsible card
  return (
    <div className={cn(
      'relative my-2.5 rounded-xl overflow-hidden',
      'glass-noise',
      'bg-[hsl(var(--glass-bg)/calc(var(--glass-bg-opacity)*0.8))]',
      'border-l-[3px]', borderClass,
      'border border-[hsl(var(--glass-border-light)/var(--glass-border-opacity))]',
      'shadow-[inset_0_0.5px_0_0_hsl(var(--glass-inset-highlight)/calc(var(--glass-inset-opacity)*0.6)),0_2px_8px_hsl(var(--glass-shadow-base)/0.08)]',
    )}>
      {/* Header */}
      <button
        onClick={() => {
          setExpanded((current) => {
            if (!current && !hasRenderedBody) {
              startTransition(() => setHasRenderedBody(true));
            }
            return !current;
          });
        }}
        aria-expanded={expanded}
        className="relative w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Users className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        <span className={cn(
          'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border',
          colorClass,
        )}>
          {msg.id}
        </span>
        {msg.summary && (
          <span className="text-[12px] text-muted-foreground truncate min-w-0">
            {msg.summary}
          </span>
        )}
        <ChevronRight className={cn(
          'w-3.5 h-3.5 text-muted-foreground/50 ml-auto shrink-0 transition-transform',
          expanded && 'rotate-90'
        )} />
      </button>
      {/* Expandable content */}
      {expanded && !hasRenderedBody && (
        <div className="px-3 pb-3 pt-2 border-t border-border/40">
          <div className="h-8 animate-pulse rounded bg-muted/30" />
        </div>
      )}
      {hasRenderedBody && (
        <div
          aria-hidden={!expanded}
          className={cn('px-3 pb-3 border-t border-border/40', !expanded && 'hidden')}
        >
          <div className="pt-2 max-h-[500px] overflow-y-auto">
            <MarkdownRenderer content={msg.content} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Returns an array of { type, content } for sequential rendering.
 */
function splitInsightBlocks(text: string): Array<{ type: 'md' | 'insight'; content: string }> {
  const parts: Array<{ type: 'md' | 'insight'; content: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INSIGHT_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) parts.push({ type: 'md', content: before });
    parts.push({ type: 'insight', content: match[1] });
    lastIndex = match.index! + match[0].length;
  }

  const after = text.slice(lastIndex);
  if (after.trim()) parts.push({ type: 'md', content: after });

  return parts;
}

function renderAssistantMarkdown(text: string, keyPrefix = 'md') {
  if (INSIGHT_RE.test(text)) {
    INSIGHT_RE.lastIndex = 0;
    const parts = splitInsightBlocks(text);
    return (
      <>
        {parts.map((part, i) =>
          part.type === 'insight'
            ? <InsightBlock key={`${keyPrefix}-insight-${i}`} content={part.content} />
            : <MarkdownRenderer key={`${keyPrefix}-md-${i}`} content={part.content.trim()} />
        )}
      </>
    );
  }

  return <MarkdownRenderer content={text} />;
}

function renderTextContent(text: string, t: (key: string) => string, isUser = false, standalone = false) {
  const { cleanText, command } = parseMessageText(text);
  const commandArgs = command?.args?.trim() || '';
  const commandBody = cleanText || commandArgs;

  if (command && !commandBody) {
    return <CommandChip name={command.name} output={command.output} isUser={isUser} standalone={standalone} />;
  }
  if (command && commandBody) {
    return (
      <div className="space-y-1.5">
        <CommandChip name={command.name} output={command.output} isUser={isUser} />
        {isUser
          ? <MarkdownRenderer content={commandBody} variant="user" />
          : renderAssistantMarkdown(commandBody, 'cmd')
        }
      </div>
    );
  }
  if (!cleanText) return null;

  // Render <think> blocks from history snapshots as collapsible thinking cards.
  if (!isUser && /<think>/i.test(cleanText)) {
    const thinkParts = splitThinkBlocks(cleanText);
    return (
      <>
        {thinkParts.map((part, i) =>
          part.type === 'think'
            ? (
              <CollapsibleBlock
                key={`think-${i}`}
                icon={Brain}
                label={t('history.thinking')}
                iconClassName="text-amber-400"
              >
                <pre className="text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-[300px] overflow-y-auto">
                  {part.content.trim()}
                </pre>
              </CollapsibleBlock>
            )
            : <div key={`think-md-${i}`}>{renderAssistantMarkdown(part.content.trim(), `think-${i}`)}</div>
        )}
      </>
    );
  }

  if (isUser) {
    return <MarkdownRenderer content={cleanText} variant="user" />;
  }

  return renderAssistantMarkdown(cleanText);
}

function renderContentBlocks(blocks: ContentBlock[], t: (key: string) => string, isUser = false) {
  const result: React.ReactNode[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    if (block.type === 'tool_use') {
      // Collect consecutive tool_use blocks
      const toolBlocks: ContentBlock[] = [];
      while (i < blocks.length && blocks[i].type === 'tool_use') {
        toolBlocks.push(blocks[i]);
        i++;
      }
      // 3+ consecutive tool calls → group them
      if (toolBlocks.length >= 3) {
        result.push(<ToolCallGroup key={`tg-${toolBlocks[0].id || i}`} blocks={toolBlocks} t={t} />);
      } else {
        toolBlocks.forEach((tb, j) => {
          result.push(<ToolCallBlock key={tb.id || `tc-${i}-${j}`} block={tb} t={t} />);
        });
      }
      continue;
    }

    switch (block.type) {
      case 'text':
        result.push(<div key={i}>{renderTextContent(block.text || '', t, isUser)}</div>);
        break;

      case 'thinking':
        result.push(
          <CollapsibleBlock
            key={i}
            icon={Brain}
            label={t('history.thinking')}
            iconClassName="text-amber-400"
          >
            <pre className="text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed max-h-[300px] overflow-y-auto">
              {block.thinking || block.text || ''}
            </pre>
          </CollapsibleBlock>
        );
        break;

      case 'tool_result':
        // Already merged into tool_use via _result — skip rendering
        break;

      default:
        break;
    }
    i++;
  }

  return result;
}

function MessageBubbleComponent({ message, prevRole }: MessageBubbleProps) {
  const { t } = useLocale();
  const isUser = message.msgType === 'user' || message.msgType === 'human';
  const isSummary = message.msgType === 'summary';
  const currentRole = isUser ? 'user' : 'assistant';
  const [copied, setCopied] = useState(false);
  const timeLabel = message.timestamp && message.timestamp > 0
    ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Dynamic spacing: same role → tight, role switch → wider
  const sameRole = prevRole === currentRole;
  const spacingClass = prevRole == null ? 'mt-0' : sameRole ? 'mt-1.5' : 'mt-5';
  const showRoleLabel = prevRole !== null && prevRole !== currentRole;
  const roleLabel = isUser ? t('history.you') : (message.model || t('history.assistant'));
  const { allTeammateMessages, renderedContent, isCommandOnly } = useMemo(() => {
    if (isSummary || message.isCompactBoundary || message.planContent) {
      return {
        allTeammateMessages: [] as TeammateMessage[],
        renderedContent: null as React.ReactNode,
        isCommandOnly: false,
      };
    }

    const teammateMessages: TeammateMessage[] = [];
    const collectTeammate = (text: string) => {
      const { teammateMessages: parsedTeammateMessages } = parseMessageText(text);
      if (parsedTeammateMessages.length > 0) {
        teammateMessages.push(...parsedTeammateMessages);
      }
    };

    const content = message.content;
    let nextRenderedContent: React.ReactNode = null;
    let nextIsCommandOnly = false;

    if (typeof content === 'string') {
      collectTeammate(content);
      nextIsCommandOnly = isCommandOnlyText(content);
      nextRenderedContent = renderTextContent(content, t, isUser, nextIsCommandOnly);
    } else if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text' && block.text) {
          collectTeammate(block.text);
        }
      }

      const textBlocks = (content as ContentBlock[]).filter((block) => block.type === 'text');
      if (textBlocks.length === 1 && textBlocks.length === content.length) {
        nextIsCommandOnly = isCommandOnlyText(textBlocks[0].text || '');
      }

      nextRenderedContent = nextIsCommandOnly
        ? renderTextContent((content as ContentBlock[])[0].text || '', t, isUser, true)
        : renderContentBlocks(content as ContentBlock[], t, isUser);
    } else if (content && typeof content === 'object') {
      nextRenderedContent = renderContentBlocks([content as ContentBlock], t, isUser);
    }

    return {
      allTeammateMessages: teammateMessages,
      renderedContent: nextRenderedContent,
      isCommandOnly: nextIsCommandOnly,
    };
  }, [isSummary, isUser, message.content, message.isCompactBoundary, message.planContent, t]);

  // Summary messages
  if (isSummary) {
    return (
      <div className="flex justify-center my-3">
        <div className="glass-subtle glass-noise rounded-lg px-4 py-2 max-w-[80%] text-center">
          <p className="text-[11px] text-muted-foreground italic">
            {message.summary || t('history.summaryLabel')}
          </p>
        </div>
      </div>
    );
  }

  // Compact boundary divider
  if (message.isCompactBoundary) {
    return (
      <div className="flex items-center gap-3 my-6 px-2">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
        <div className="glass-subtle glass-noise rounded-lg px-3 py-1.5 flex items-center gap-2 shrink-0">
          <Scissors className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">
            {t('history.compactBoundary')}
          </span>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      </div>
    );
  }

  // Plan execution card
  if (message.planContent) {
    return <PlanCard content={message.planContent} t={t} spacingClass={spacingClass} />;
  }

  // If message is ONLY teammate messages (no other content), render them standalone
  const hasMainContent = renderedContent && !(Array.isArray(renderedContent) && renderedContent.length === 0);
  if (!hasMainContent && allTeammateMessages.length > 0) {
    return (
      <div className={spacingClass}>
        {showRoleLabel && (
          <p className={cn(
            'mb-1.5 text-[10px] font-medium uppercase tracking-wider',
            isUser ? 'text-right text-primary/50' : 'text-muted-foreground/40'
          )}>
            {roleLabel}
          </p>
        )}
        <div className={cn(!isUser && 'ml-4')}>
          {allTeammateMessages.map((msg, i) => (
            <TeammateMessageBlock key={`tm-${msg.id}-${i}`} msg={msg} />
          ))}
        </div>
      </div>
    );
  }

  // Skip empty bubbles (e.g. message was only internal tags that got stripped)
  if (!hasMainContent) {
    return null;
  }

  const handleCopyMessage = async () => {
    const text = getMessageCopyText(message, t).trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  };

  return (
    <div className={spacingClass}>
      {showRoleLabel && (
        <p className={cn(
          'mb-1.5 text-[10px] font-medium uppercase tracking-wider',
          isUser ? 'text-right text-primary/50' : 'text-muted-foreground/40'
        )}>
          {roleLabel}
        </p>
      )}
      <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
        <div className={cn(
          'group/bubble min-w-0 break-words [overflow-wrap:anywhere]',
          isUser ? 'max-w-[75%]' : 'max-w-full',
          isCommandOnly
            ? 'px-0 py-0'
            : 'rounded-2xl px-3.5 py-2.5',
          isCommandOnly
            ? ''
            : isUser
              ? 'rounded-tr-md glass-chat-user text-primary-foreground'
              : 'rounded-tl-md glass-chat-assistant'
        )}>
          {renderedContent}
          <div className={cn('mt-1.5 flex items-center gap-2', isUser && 'justify-end')}>
            {(!isUser && message.model) && (
              <p className="text-[10px] text-muted-foreground/50 font-mono truncate">{message.model}</p>
            )}
            {timeLabel && (
              <p className={cn(
                'text-[10px] tabular-nums',
                isUser ? 'text-white/50' : 'text-muted-foreground/45'
              )}>
                {timeLabel}
              </p>
            )}
            <button
              onClick={handleCopyMessage}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                'opacity-0 group-hover/bubble:opacity-40 hover:!opacity-100 focus-visible:!opacity-100',
                !isUser && 'ml-auto',
                isUser
                  ? 'text-white/50 hover:text-white/90 hover:bg-white/[0.08]'
                  : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50'
              )}
              aria-label={copied ? t('history.copied') : t('history.copyMessage')}
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" />
                  {t('history.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  {t('history.copyMessage')}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      {/* Teammate messages rendered outside the bubble */}
      {allTeammateMessages.length > 0 && (
        <div className={cn('mt-1', !isUser && 'ml-4')}>
          {allTeammateMessages.map((msg, i) => (
            <TeammateMessageBlock key={`tm-${msg.id}-${i}`} msg={msg} />
          ))}
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleComponent, (prevProps, nextProps) => (
  prevProps.prevRole === nextProps.prevRole
  && prevProps.message === nextProps.message
));
