import type { ConversationMessageData } from '@/features/conversations/types';
import type { WorkspaceTodos } from './workspaceTodos';

export interface NextStepSuggestion {
  title: string;
  prompt: string;
}

export interface WorkspaceNextSteps {
  /** Last assistant message of the finished turn; suggestions are stale once it changes. */
  anchorKey: string;
  suggestions: NextStepSuggestion[];
}

const USER_MAX_CHARS = 2_000;
const REPLY_MAX_CHARS = 4_000;
const STORAGE_PREFIX = 'ccem.workspace.nextSteps.';

function isUserMessage(message: ConversationMessageData) {
  return message.msgType === 'user' || message.msgType === 'human';
}

export function workspaceMessageText(message: ConversationMessageData): string {
  const { content } = message;
  if (typeof content === 'string') return content.trim();
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
}

function clipTail(value: string, max: number) {
  return value.length > max ? `…${value.slice(value.length - max)}` : value;
}

export function nextStepsAnchorKey(messages: ConversationMessageData[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isUserMessage(message)) return null;
    if (workspaceMessageText(message)) {
      return message.uuid ?? `index-${index}-${message.timestamp ?? 'untimed'}`;
    }
  }
  return null;
}

/**
 * Context for the suggestion query: the last user request, the assistant's
 * text after it, and open todos. Null when the turn produced no reply text.
 */
export function buildNextStepsContext(
  messages: ConversationMessageData[],
  todos: WorkspaceTodos | null | undefined,
): { anchorKey: string; context: string } | null {
  const anchorKey = nextStepsAnchorKey(messages);
  if (!anchorKey) return null;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(messages[index]!) && workspaceMessageText(messages[index]!)) {
      lastUserIndex = index;
      break;
    }
  }
  const request = lastUserIndex >= 0 ? workspaceMessageText(messages[lastUserIndex]!) : '';
  const reply = messages
    .slice(lastUserIndex + 1)
    .filter((message) => !isUserMessage(message))
    .map(workspaceMessageText)
    .filter(Boolean)
    .join('\n\n');
  if (!reply) return null;
  const sections = [
    `用户请求：\n${request.slice(0, USER_MAX_CHARS) || '（无）'}`,
    `助手本轮回复：\n${clipTail(reply, REPLY_MAX_CHARS)}`,
  ];
  if (todos && todos.items.length > 0) {
    const marks: Record<string, string> = { completed: 'x', in_progress: '~', failed: '!', pending: ' ' };
    sections.push(`任务清单：\n${todos.items.map((item) => `- [${marks[item.status] ?? ' '}] ${item.text}`).join('\n')}`);
  }
  return { anchorKey, context: sections.join('\n\n') };
}

/** Stable id per suggestion, used as the lineage proposal id when started. */
export function nextStepSuggestionId(anchorKey: string, index: number) {
  return `next:${anchorKey}:${index}`;
}

export function readCachedNextSteps(runtimeId: string): WorkspaceNextSteps | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${runtimeId}`);
    const parsed = raw ? JSON.parse(raw) as WorkspaceNextSteps : null;
    return parsed && typeof parsed.anchorKey === 'string' && Array.isArray(parsed.suggestions) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedNextSteps(runtimeId: string, value: WorkspaceNextSteps) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${runtimeId}`, JSON.stringify(value));
  } catch {
    // Suggestions are optional; a full or blocked store just skips the cache.
  }
}
