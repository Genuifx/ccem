import type {
  ConversationContentBlock,
  ConversationMessageData,
} from '@/features/conversations/types';

export interface TeammateMessage {
  id: string;
  color: string;
  summary?: string;
  content: string;
  notification?: { type: string; idleReason?: string; failureReason?: string };
}

export interface ParsedText {
  cleanText: string;
  command?: { name: string; output?: string; message?: string; args?: string };
  teammateMessages: TeammateMessage[];
}

const TEAMMATE_RE = /<teammate-message\s+teammate_id="([^"]*)"(?:\s+color="([^"]*)")?(?:\s+summary="([^"]*)")?\s*>([\s\S]*?)<\/teammate-message>/g;
const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;
const PARSED_TEXT_CACHE_LIMIT = 500;
const parsedTextCache = new Map<string, ParsedText>();

function rememberParsedText(raw: string, parsed: ParsedText): ParsedText {
  if (parsedTextCache.has(raw)) {
    parsedTextCache.delete(raw);
  }

  parsedTextCache.set(raw, parsed);
  if (parsedTextCache.size > PARSED_TEXT_CACHE_LIMIT) {
    const oldestKey = parsedTextCache.keys().next().value;
    if (oldestKey) {
      parsedTextCache.delete(oldestKey);
    }
  }

  return parsed;
}

export function parseMessageText(raw: string): ParsedText {
  const cached = parsedTextCache.get(raw);
  if (cached) {
    parsedTextCache.delete(raw);
    parsedTextCache.set(raw, cached);
    return cached;
  }

  let text = raw;

  const cmdMatch = text.match(/<command-name>\/?([\s\S]*?)<\/command-name>/);
  const cmdMessageMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/);
  const cmdArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);

  const commandName = cmdMatch?.[1]?.trim() || cmdMessageMatch?.[1]?.trim();
  const command = commandName
    ? {
      name: commandName,
      output: stdoutMatch?.[1]?.trim(),
      message: cmdMessageMatch?.[1]?.trim(),
      args: cmdArgsMatch?.[1]?.trim(),
    }
    : undefined;

  const teammateMessages: TeammateMessage[] = [];
  TEAMMATE_RE.lastIndex = 0;
  for (const match of text.matchAll(TEAMMATE_RE)) {
    const [, id, color, summary, content] = match;
    const trimmed = content.trim();
    let notification: TeammateMessage['notification'];
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed.type) {
        notification = parsed;
      }
    } catch {
      // Ignore non-JSON teammate payloads.
    }
    teammateMessages.push({ id, color: color || 'blue', summary, content: trimmed, notification });
  }
  text = text.replace(TEAMMATE_RE, '');

  const tagPatterns = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
    /<command-name>[\s\S]*?<\/command-name>/g,
    /<command-message>[\s\S]*?<\/command-message>/g,
    /<command-args>[\s\S]*?<\/command-args>/g,
    /<synthetic>[\s\S]*?<\/synthetic>/g,
    /<synthetic\s*\/?>/g,
    /<task-notification>[\s\S]*?<\/task-notification>/g,
    /<task-id>[\s\S]*?<\/task-id>/g,
    /<tool_use_error>[\s\S]*?<\/tool_use_error>/g,
    /<local-command>[\s\S]*?<\/local-command>/g,
    /<direct-parameter>[\s\S]*?<\/direct-parameter>/g,
    /<responds-to>[\s\S]*?<\/responds-to>/g,
    /<retrieval_status>[\s\S]*?<\/retrieval_status>/g,
  ];
  for (const pattern of tagPatterns) {
    text = text.replace(pattern, '');
  }

  text = text.replace(/^Caveat:.*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return rememberParsedText(raw, { cleanText: text, command, teammateMessages });
}

export function isCommandOnlyText(text: string): boolean {
  const { cleanText, command } = parseMessageText(text);
  const args = command?.args?.trim() || '';
  return !!(command && !cleanText && !args);
}

export function stringifyUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractTextForCopy(raw: string): string {
  const { cleanText, command } = parseMessageText(raw);
  if (!command) return cleanText;

  const lines: string[] = [`/${command.name}`];
  const args = command.args?.trim() || '';
  const body = (cleanText || args).trim();
  if (body) lines.push(body);
  return lines.join('\n');
}

function blockToCopyText(block: ConversationContentBlock): string {
  if (block.type === 'text') {
    return extractTextForCopy(block.text || '');
  }
  if (block.type === 'thinking') {
    return block.thinking || block.text || '';
  }
  if (block.type === 'image') {
    return typeof block.placeholder === 'string' && block.placeholder.trim()
      ? block.placeholder.trim()
      : '[Image]';
  }
  if (block.type === 'tool_use') {
    const parts: string[] = [`[Tool] ${block.name || 'Tool'}`];
    const input = stringifyUnknown(block.input);
    if (input) parts.push(`Input:\n${input}`);
    if ('_result' in block) {
      const output = stringifyUnknown(block._result);
      if (output) parts.push(`Output:\n${output}`);
    }
    return parts.join('\n\n');
  }
  return '';
}

export function getMessageCopyText(
  message: ConversationMessageData,
  t: (key: string) => string,
): string {
  if (message.planContent) {
    return message.planContent;
  }
  if (message.isCompactBoundary) {
    return t('history.compactBoundary');
  }
  if (message.msgType === 'summary') {
    return message.summary || t('history.summaryLabel');
  }

  const content = message.content;
  if (typeof content === 'string') {
    return extractTextForCopy(content);
  }
  if (Array.isArray(content)) {
    return content
      .map(blockToCopyText)
      .map((item) => item.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  if (content && typeof content === 'object') {
    return blockToCopyText(content as ConversationContentBlock).trim();
  }
  return '';
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return '';
}

export function extractToolSummary(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      const fp = pickString(obj, 'file_path', 'Path', 'path', 'summary');
      if (!fp) return '';
      const parts = fp.split(/[/\\]/);
      return parts.length > 2 ? parts.slice(-2).join('/') : fp;
    }
    case 'Bash':
    case 'run_command': {
      const cmd = pickString(obj, 'toolSummary', 'command', 'CommandLine', 'summary');
      return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
    }
    case 'Glob':
    case 'Grep': {
      return pickString(obj, 'pattern', 'summary');
    }
    case 'Task':
    case 'invoke_subagent': {
      const desc = pickString(obj, 'Role', 'description', 'prompt', 'Prompt', 'summary');
      return desc.length > 50 ? `${desc.slice(0, 47)}...` : desc;
    }
    case 'WebFetch':
    case 'search_web': {
      const target = pickString(obj, 'url', 'query', 'summary');
      return target.length > 50 ? `${target.slice(0, 47)}...` : target;
    }
    default: {
      for (const val of Object.values(obj)) {
        if (typeof val === 'string' && val.length > 0) {
          return val.length > 50 ? `${val.slice(0, 47)}...` : val;
        }
      }
      return '';
    }
  }
}

export function splitThinkBlocks(text: string): Array<{ type: 'md' | 'think'; content: string }> {
  const parts: Array<{ type: 'md' | 'think'; content: string }> = [];
  let lastIndex = 0;

  THINK_RE.lastIndex = 0;
  for (const match of text.matchAll(THINK_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) parts.push({ type: 'md', content: before });
    parts.push({ type: 'think', content: match[1] || '' });
    lastIndex = match.index! + match[0].length;
  }

  const after = text.slice(lastIndex);
  if (after.trim()) parts.push({ type: 'md', content: after });

  return parts;
}
