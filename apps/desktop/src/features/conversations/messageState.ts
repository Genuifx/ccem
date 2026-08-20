import type {
  ConversationContentBlock,
  ConversationMessageList,
  ConversationMessageData,
} from './types';

export interface SessionTokenUsage {
  input: number;
  output: number;
  total: number;
}

// Cached merge outputs keyed by the original message object. Re-merging an
// unchanged message list (every poll / streaming event rebuilds the array)
// returns the same object references so memoized transcript bubbles skip
// re-renders and the DOM text nodes behind user selections stay alive.
const mergedAssistantCache = new WeakMap<
  ConversationMessageData,
  { merged: ConversationMessageData }
>();
const mergedUserCache = new WeakMap<
  ConversationMessageData,
  {
    dropped: boolean;
    merged?: ConversationMessageData;
    matches: Array<[string, ConversationContentBlock]>;
  }
>();

interface ToolResultMatch {
  content: unknown;
  isError: boolean;
  block: ConversationContentBlock;
}

export function mergeToolResults(msgs: ConversationMessageData[]): ConversationMessageData[] {
  if ((msgs as ConversationMessageList).toolResultsMerged) {
    return msgs;
  }

  // Pass 1: collect tool_result payloads. Matches replicate the original
  // in-order semantics — a result only matches a tool_use that appeared
  // earlier in the list.
  const toolUseSeen = new Set<string>();
  const resultByToolUseId = new Map<string, ToolResultMatch>();
  for (const msg of msgs) {
    if ((msg.msgType === 'assistant' || msg.msgType === 'ai') && Array.isArray(msg.content)) {
      for (const block of msg.content as ConversationContentBlock[]) {
        if (block.type === 'tool_use' && block.id) {
          toolUseSeen.add(block.id);
        }
      }
    } else if ((msg.msgType === 'user' || msg.msgType === 'human') && Array.isArray(msg.content)) {
      for (const block of msg.content as ConversationContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id && toolUseSeen.has(block.tool_use_id)) {
          resultByToolUseId.set(block.tool_use_id, {
            content: block.content,
            isError: block.is_error === true,
            block,
          });
        }
      }
    }
  }

  // Pass 2: assistant messages — reuse the cached merged object when every
  // tool_use block already carries the current result payload.
  const toolUseMap = new Map<string, ConversationContentBlock>();
  const prepared = msgs.map((msg) => {
    if ((msg.msgType === 'assistant' || msg.msgType === 'ai') && Array.isArray(msg.content)) {
      const blocks = msg.content as ConversationContentBlock[];
      const hasToolUse = blocks.some((block) => block.type === 'tool_use' && block.id);
      if (!hasToolUse) {
        return msg;
      }

      const cached = mergedAssistantCache.get(msg);
      if (cached) {
        const cachedBlocks = cached.merged.content as ConversationContentBlock[];
        const upToDate = cachedBlocks.length === blocks.length && blocks.every((block, index) => {
          const cachedBlock = cachedBlocks[index];
          if (block.type !== 'tool_use' || !block.id) {
            return cachedBlock === block;
          }
          const match = resultByToolUseId.get(block.id);
          return cachedBlock.type === 'tool_use'
            && cachedBlock.id === block.id
            && cachedBlock._result === (match ? match.content : undefined)
            && cachedBlock._resultError === (match ? match.isError : undefined);
        });
        if (upToDate) {
          for (const block of cachedBlocks) {
            if (block.type === 'tool_use' && block.id) {
              toolUseMap.set(block.id, block);
            }
          }
          return cached.merged;
        }
      }

      const nextBlocks = [...blocks];
      blocks.forEach((block, index) => {
        if (block.type !== 'tool_use' || !block.id) return;
        const match = resultByToolUseId.get(block.id);
        const clonedBlock = { ...block } as ConversationContentBlock;
        if (match) {
          clonedBlock._result = match.content;
          clonedBlock._resultError = match.isError;
        }
        nextBlocks[index] = clonedBlock;
        toolUseMap.set(block.id, clonedBlock);
      });

      const merged = {
        ...msg,
        content: nextBlocks as ConversationMessageData['content'],
      };
      mergedAssistantCache.set(msg, { merged });
      return merged;
    }

    return msg;
  });

  // Pass 3: user messages — strip merged tool_result blocks; reuse cached
  // outcomes when the same result blocks matched last time.
  const result: ConversationMessageData[] = [];
  for (const msg of prepared) {
    if ((msg.msgType === 'user' || msg.msgType === 'human') && Array.isArray(msg.content)) {
      const blocks = msg.content as ConversationContentBlock[];
      const matches: Array<[string, ConversationContentBlock]> = [];
      let stripped = false;
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id && toolUseMap.has(block.tool_use_id)) {
          matches.push([block.tool_use_id, block]);
          stripped = true;
        }
      }

      if (stripped) {
        const cached = mergedUserCache.get(msg);
        const cacheValid = !!cached
          && cached.matches.length === matches.length
          && cached.matches.every(([id, block], index) => (
            matches[index][0] === id && matches[index][1] === block
          ));

        if (cacheValid && cached) {
          if (cached.dropped) continue;
          result.push(cached.merged!);
          continue;
        }

        const remaining = blocks.filter((block) => !(
          block.type === 'tool_result'
          && block.tool_use_id
          && toolUseMap.has(block.tool_use_id)
        ));
        const dropped = remaining.length === 0;
        const merged = dropped ? undefined : {
          ...msg,
          content: remaining as ConversationMessageData['content'],
        };
        mergedUserCache.set(msg, { dropped, merged, matches });
        if (dropped) continue;
        result.push(merged!);
        continue;
      }
    }
    result.push(msg);
  }

  return result;
}

export function getSessionTokenUsage(messages: ConversationMessageData[]): SessionTokenUsage {
  const usage = messages.reduce(
    (acc, msg) => {
      acc.input += msg.inputTokens ?? 0;
      acc.output += msg.outputTokens ?? 0;
      return acc;
    },
    { input: 0, output: 0 }
  );

  return {
    ...usage,
    total: usage.input + usage.output,
  };
}
